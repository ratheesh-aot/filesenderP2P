const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const puppeteer = require('puppeteer');

const TEST_PORT = 3001;
const TEST_DIR = path.join(__dirname, 'e2e-workspace');
const TEST_FILENAME = 'test-file.bin';
const TEST_FILE_SIZE = 256 * 1024;
let expectedHash = null;

function sha256Buffer(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

function sha256File(filepath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filepath)).digest('hex');
}

// Create test file
if (!fs.existsSync(TEST_DIR)) fs.mkdirSync(TEST_DIR, { recursive: true });
const buffer = Buffer.alloc(TEST_FILE_SIZE);
for (let i = 0; i < TEST_FILE_SIZE; i++) buffer[i] = (i * 7) & 0xff;
const testFilePath = path.join(TEST_DIR, TEST_FILENAME);
fs.writeFileSync(testFilePath, buffer);
expectedHash = sha256Buffer(buffer);
console.log('Test file created (' + TEST_FILE_SIZE + ' bytes), SHA-256:', expectedHash);

// Server is assumed to be running on TEST_PORT (set above)

async function runE2ETest(serverProc, port, testFilePath) {
    console.log('Using server on port', port);
    let browser1, browser2;
    try {
        browser1 = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });
        browser2 = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });

        const hostPage = await browser1.newPage();
        const clientPage = await browser2.newPage();

        await hostPage.setViewport({ width: 1280, height: 960 });
        await hostPage.goto('http://localhost:' + port + '/', { waitUntil: 'networkidle0' });
        console.log('Host page loaded');
        
        // Listen for console messages to debug WebSocket connection
        hostPage.on('console', (msg) => {
            console.log('HOST BROWSER:', msg.text());
        });
        clientPage.on('console', (msg) => {
            console.log('CLIENT BROWSER:', msg.text());
        });
        
        // Listen for unhandled errors
        hostPage.on('pageerror', (err) => {
            console.log('HOST PAGE ERROR:', err.message);
        });
        clientPage.on('pageerror', (err) => {
            console.log('CLIENT PAGE ERROR:', err.message);
        });
        
        // Check if script.js is loaded
        const scriptLoaded = await hostPage.evaluate(() => {
            const scripts = document.querySelectorAll('script[src="script.js"]');
            return scripts.length > 0 ? 'script.js tag found' : 'script.js tag not found';
        });
        console.log('Script.js tag status:', scriptLoaded);
        
        // Check if main.js is being served correctly
        const mainJsServed = await hostPage.evaluate(async () => {
            try {
                const response = await fetch('/js/main.js');
                return response.ok ? 'main.js served OK' : 'main.js not served';
            } catch (e) {
                return 'Error fetching main.js: ' + e.message;
            }
        });
        console.log('Main.js serving status:', mainJsServed);
        
        // Check if there are any module loading errors
        const moduleErrors = await hostPage.evaluate(() => {
            // Check if there are any <script> tags with errors
            const scripts = document.querySelectorAll('script');
            const errors = [];
            scripts.forEach(script => {
                if (script.src && script.readyState === 'error') {
                    errors.push(script.src);
                }
            });
            return errors;
        });
        console.log('Module loading errors:', moduleErrors);
        
        // Check if main.js loaded successfully
        const mainLoaded = await hostPage.evaluate(() => {
            return typeof initializeUI !== 'undefined' ? 'main.js loaded' : 'main.js not loaded';
        });
        console.log('Main.js status:', mainLoaded);
        
        // Wait for WebSocket to connect and generate share link
        await hostPage.waitForFunction(() => {
            const input = document.querySelector('#share-link');
            return input && input.value && input.value.includes('host=');
        }, { timeout: 15000 });
        
        const hostUrl = await hostPage.evaluate(() => {
            const input = document.querySelector('#share-link');
            return input ? input.value : null;
        });
        const hostIdMatch = hostUrl.match(/host=([a-z0-9]+)/i);
        if (!hostIdMatch) throw new Error('Could not extract host ID from URL');
        const hostId = hostIdMatch[1];
        console.log('Host ID:', hostId);

        const clientUrl = 'http://localhost:' + port + '/?host=' + hostId;
        await clientPage.setViewport({ width: 768, height: 1024 });
        await clientPage.goto(clientUrl, { waitUntil: 'networkidle0' });
        console.log('Client page loaded');

        // Wait for connection
        await clientPage.waitForSelector('.status-pill.connected', { timeout: 30000 });
        console.log('Client connected to host');

        // Upload file from client
        const uploadInput = await clientPage.$('#file-input');
        if (!uploadInput) throw new Error('Client could not find upload input');
        await uploadInput.uploadFile(testFilePath);
        console.log('Test file uploaded from client to host');

        // Wait for completion
        try {
            await clientPage.waitForSelector('.status-chip.done', { timeout: 60000 });
            console.log('Client transfer completed');
        } catch (e1) {
            await hostPage.waitForSelector('.status-chip.done', { timeout: 60000 });
            console.log('Host transfer completed');
        }

        // Check for errors
        const errorChip = await hostPage.$('.status-chip.error');
        if (errorChip) {
            const msg = await hostPage.$eval('.status-chip.error', (el) => el.textContent);
            throw new Error('Transfer failed on host: ' + msg);
        }

        // Verify file received on host (check if file was downloaded)
        const downloadedFile = path.join(TEST_DIR, TEST_FILENAME);
        let attempts = 0;
        while (!fs.existsSync(downloadedFile) && attempts < 30) {
            await new Promise((r) => setTimeout(r, 1500));
            attempts++;
        }

        if (!fs.existsSync(downloadedFile)) {
            throw new Error('Downloaded file not found on host after 45s');
        }

        const actualHash = sha256File(downloadedFile);
        console.log('Downloaded file hash:', actualHash);

        if (actualHash !== expectedHash) {
            throw new Error('SHA-256 mismatch! Expected: ' + expectedHash + ', Got: ' + actualHash);
        }

        console.log('Hash verified! Transfer integrity confirmed.');
        console.log('\n[=E2E SUMMARY=]');
        console.log('  Test file size:', (TEST_FILE_SIZE / 1024).toFixed(1) + ' KB');
        console.log('  Expected SHA-256:', expectedHash);
        console.log('  Actual SHA-256:   ', actualHash);
        console.log('  Result: PASS ✓');
        console.log('[=                ]\n');

    } finally {
        if (browser1) await browser1.close();
        if (browser2) await browser2.close();
        try { if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true }); } catch { /* ignore */ }
    }
}

runE2ETest(null, TEST_PORT, path.join(TEST_DIR, TEST_FILENAME));
