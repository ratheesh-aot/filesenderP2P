/**
 * E2E test for FileSender P2P v2
 *
 * Scenario:
 *   1. Start the Node.js server on a test port (3002)
 *   2. Open host page in browser #1
 *   3. Open client page with ?host=<id> in browser #2
 *   4. Upload a known test file from host to client
 *   5. Wait for completion and verify SHA-256 hash match
 */

const { spawn } = require('child_process');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// --- Config -------------------------------------------------------
const TEST_PORT = 3002;
const TEST_DIR = path.join(__dirname, 'e2e-workspace');
const SERVER_SCRIPT = path.join(__dirname, '..', 'server.js');

// Test file to create and verify
const TEST_FILENAME = 'test-file.bin';
const TEST_FILE_SIZE = 256 * 1024; // 256 KB
let expectedHash = null;

// --- Helpers ------------------------------------------------------

function sha256Buffer(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

function sha256File(filepath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filepath)).digest('hex');
}

function createTestFile(size) {
    if (!fs.existsSync(TEST_DIR)) fs.mkdirSync(TEST_DIR, { recursive: true });
    const buffer = Buffer.alloc(size);
    for (let i = 0; i < size; i++) buffer[i] = (i * 7) & 0xff;
    const filepath = path.join(TEST_DIR, TEST_FILENAME);
    fs.writeFileSync(filepath, buffer);
    expectedHash = sha256Buffer(buffer);
    console.log(`[E2E] Created test file (${size} bytes) with SHA-256: ${expectedHash}`);
    return filepath;
}

function cleanup() {
    try {
        if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    } catch { /* ignore */ }
}

// --- Start test server --------------------------------------------

function startServer(port) {
    return new Promise((resolve, reject) => {
        const proc = spawn(process.execPath, [SERVER_SCRIPT], {
            env: { ...process.env, PORT: String(port) },
            cwd: path.dirname(SERVER_SCRIPT),
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let serverReady = false;
        const timeout = setTimeout(() => {
            if (!serverReady) {
                proc.kill();
                reject(new Error('Server failed to start within 15s'));
            }
        }, 15000);

        const onData = (data) => {
            const str = data.toString();
            process.stdout.write(str);
            if (!serverReady && str.includes(`Server running at http://localhost:${port}/`)) {
                clearTimeout(timeout);
                serverReady = true;
                console.log('[E2E] Server started on port', port);
                resolve(proc);
            }
        };

        proc.stdout.on('data', onData);
        proc.stderr.on('data', onData);
        proc.on('error', reject);
        proc.on('exit', (code) => {
            if (!serverReady) reject(new Error(`Server exited before ready (code ${code})`));
        });
    });
}

function watchPage(page, label) {
    page.on('console', (msg) => console.log(`[${label}]`, msg.type(), msg.text()));
    page.on('pageerror', (err) => console.log(`[${label}] PAGEERROR`, err.message));
    page.on('requestfailed', (req) => console.log(`[${label}] REQUESTFAILED`, req.url(), req.failure()?.errorText));
}

// --- Main test ----------------------------------------------------

async function runTest() {
    cleanup();
    createTestFile(TEST_FILE_SIZE);

    // Start server
    const serverProc = await startServer(TEST_PORT);

    let browser1, browser2;
    try {
        // Launch two browsers (same device, different contexts)
        console.log('[E2E] Launching browser #1 (host)...');
        const launchArgs = [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-features=WebRtcHideLocalIpsWithMdns',
        ];
        browser1 = await puppeteer.launch({ headless: true, args: launchArgs });

        console.log('[E2E] Launching browser #2 (client)...');
        browser2 = await puppeteer.launch({ headless: true, args: launchArgs });

        const hostPage = await browser1.newPage();
        const clientPage = await browser2.newPage();
        watchPage(hostPage, 'HOST');
        watchPage(clientPage, 'CLIENT');
        await hostPage.evaluateOnNewDocument(() => localStorage.setItem('fs2p-auto-download', '0'));
        await clientPage.evaluateOnNewDocument(() => localStorage.setItem('fs2p-auto-download', '0'));

        // --- Host side ---
        await hostPage.setViewport({ width: 1280, height: 960 });
        await hostPage.goto(`http://localhost:${TEST_PORT}/`, { waitUntil: 'networkidle0' });
        console.log('[E2E] Host page loaded');

        // Wait for share card and generate host ID from URL
        await hostPage.waitForSelector('#host-info', { timeout: 20000 });
        const hostUrl = await hostPage.evaluate(() => {
            const input = document.querySelector('#share-link');
            return input ? input.value : null;
        });

        if (!hostUrl) {
            throw new Error('Host did not generate a share link');
        }
        const hostIdMatch = hostUrl.match(/host=([a-z0-9]+)/i);
        if (!hostIdMatch) {
            throw new Error('Could not extract host ID from URL');
        }
        const hostId = hostIdMatch[1];
        console.log('[E2E] Host ID:', hostId);

        // --- Client side ---
        const clientUrl = `http://localhost:${TEST_PORT}/?host=${hostId}`;
        console.log('[E2E] Client opening URL:', clientUrl);

        await clientPage.setViewport({ width: 768, height: 1024 });
        await clientPage.goto(clientUrl, { waitUntil: 'networkidle0' });
        console.log('[E2E] Client page loaded');

        // Wait for connection status indicating connected
        await clientPage.waitForSelector('.status-pill.connected', { timeout: 30000 });
        console.log('[E2E] Client connected to host');

        // --- Transfer test file ---
        const uploadInput = await clientPage.$('#file-input');
        if (!uploadInput) throw new Error('Client could not find upload input');

        const testFilePath = path.join(TEST_DIR, TEST_FILENAME);
        await uploadInput.uploadFile(testFilePath);
        console.log('[E2E] Test file uploaded from client to host');

        // The file is sent by the client and assembled on the host.
        await hostPage.waitForFunction(() => {
            const chip = document.querySelector('.file-row[data-direction="receive"] .status-chip');
            if (!chip) return false;
            if (chip.classList.contains('error')) {
                throw new Error('Receive failed: ' + chip.textContent);
            }
            return chip.classList.contains('done');
        }, { timeout: 60000 });
        console.log('[E2E] Host received the file');

        const received = await hostPage.evaluate(async () => {
            const row = document.querySelector('.file-row[data-direction="receive"]');
            const record = window.fs2p_refs.fileManager.getReceivedRecord(row.dataset.fileId);
            if (!record || !record.blob) return { error: 'received blob missing' };
            const digest = await crypto.subtle.digest('SHA-256', await record.blob.arrayBuffer());
            const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
            return { hex, size: record.blob.size, verified: record.verified };
        });
        if (received.error) throw new Error(received.error);
        if (received.verified === false) throw new Error('Receiver reported an integrity failure');
        console.log(`[E2E] Received blob (${received.size} bytes) SHA-256: ${received.hex}`);
        const actualHash = received.hex;

        if (actualHash !== expectedHash) {
            throw new Error(`SHA-256 mismatch! Expected: ${expectedHash}, Got: ${actualHash}`);
        }

        console.log(`[E2E] ✓ Hash verified! Transfer integrity confirmed.`);

        // --- Summary ---
        console.log('\n[=E2E SUMMARY=]');
        console.log(`  Test file size: ${formatBytes(TEST_FILE_SIZE)}`);
        console.log(`  Expected SHA-256: ${expectedHash}`);
        console.log(`  Actual SHA-256:   ${actualHash}`);
        console.log('  Result: PASS ✓');
        console.log('[=                ]\n');

    } finally {
        // Cleanup
        if (browser1) await browser1.close();
        if (browser2) await browser2.close();
        try { serverProc.kill('SIGTERM'); } catch { /* ignore */ }
        cleanup();
    }
}

function formatBytes(bytes, decimals = 1) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(decimals)) + ' ' + sizes[i];
}

// --- Run ----------------------------------------------------------

console.log('='.repeat(60));
console.log('FileSender P2P v2 — End-to-End Test');
console.log('='.repeat(60) + '\n');

runTest()
    .then(() => {
        console.log('\n[OK] E2E test passed.');
        process.exit(0);
    })
    .catch((err) => {
        console.error('\n[FAIL] E2E test failed:');
        console.error(err.message || err);
        process.exit(1);
    });
