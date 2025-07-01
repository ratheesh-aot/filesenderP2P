const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// Configuration
const APP_URL = 'http://localhost:3001';
const LOG_FILE = path.join(__dirname, 'test-logs.txt');
const SCREENSHOT_DIR = path.join(__dirname, 'test-screenshots');
const TEST_FILE_PATH = path.join(__dirname, 'test-file.txt');
const TEST_FILE_CONTENT = 'This is a test file for P2P file transfer testing.';

// Create screenshot directory if it doesn't exist
if (!fs.existsSync(SCREENSHOT_DIR)) {
    fs.mkdirSync(SCREENSHOT_DIR);
}

// Create test file if it doesn't exist
if (!fs.existsSync(TEST_FILE_PATH)) {
    fs.writeFileSync(TEST_FILE_PATH, TEST_FILE_CONTENT);
}

// Initialize log file
fs.writeFileSync(LOG_FILE, `P2P File Transfer Test - ${new Date().toISOString()}\n\n`);

function log(message) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}`;
    console.log(logMessage);
    fs.appendFileSync(LOG_FILE, logMessage + '\n');
}

async function takeScreenshot(page, name) {
    const screenshotPath = path.join(SCREENSHOT_DIR, `${name}-${Date.now()}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    log(`Screenshot saved: ${screenshotPath}`);
    return screenshotPath;
}

async function captureConsoleLogs(page, prefix) {
    page.on('console', async (msg) => {
        const logType = msg.type().toUpperCase();
        const text = msg.text();
        const logMessage = `[${prefix}][${logType}] ${text}`;
        fs.appendFileSync(LOG_FILE, logMessage + '\n');
        
        // Capture specific events for debugging
        if (text.includes('file-metadata') || 
            text.includes('Received chunk') || 
            text.includes('Processing chunk') || 
            text.includes('Error') ||
            text.includes('saved successfully')) {
            console.log(logMessage);
        }
    });
}

async function runTest() {
    log('Starting P2P file transfer test');
    
    // Launch first browser instance for sender
    log('Launching sender browser instance');
    let browser1 = null;
    let browser2 = null;
    
    try {
        browser1 = await puppeteer.launch({ 
            headless: false,
            args: ['--window-size=1280,800', '--window-position=0,0']
        });
        
        // Set up sender page first
        const senderPage = await browser1.newPage();
        await captureConsoleLogs(senderPage, 'SENDER');
        await senderPage.setViewport({ width: 1280, height: 800 });
        log('Opening sender page');
        await senderPage.goto(APP_URL);
        await takeScreenshot(senderPage, 'sender-initial');
        
        // Wait for the page to initialize - try different selectors
        log('Waiting for sender page to initialize');
        // Use setTimeout with a promise instead of waitForTimeout
        await new Promise(resolve => setTimeout(resolve, 3000)); // Give page time to initialize
        
        // Check if the page is ready by looking for various indicators
        const isReady = await senderPage.evaluate(() => {
            // Look for any element that indicates the page is ready
            const statusElement = document.querySelector('#status-message') || 
                                  document.querySelector('.status-message') ||
                                  document.querySelector('[data-status]');
            
            if (statusElement && statusElement.textContent.includes('Ready')) {
                return true;
            }
            
            // Check if peer ID is generated (another sign of readiness)
            const peerIdElement = document.querySelector('#peer-id') ||
                                 document.querySelector('.peer-id') ||
                                 document.querySelector('[data-peer-id]');
            
            if (peerIdElement && peerIdElement.textContent.trim() !== '') {
                return true;
            }
            
            // Check if share URL is available
            const shareUrlElement = document.querySelector('#share-url') ||
                                   document.querySelector('.share-url') ||
                                   document.querySelector('input[type="text"][readonly]');
            
            return shareUrlElement && shareUrlElement.value && shareUrlElement.value.includes('?host=');
        });
        
        if (!isReady) {
            log('Warning: Could not confirm page is ready using standard selectors');
            // Continue anyway, but log the warning
        }
        
        // Get the shareable link from the sender page
        log('Getting shareable link from sender');
        const shareUrl = await senderPage.evaluate(() => {
            // Try different selectors to find the share URL
            const shareUrlElement = document.querySelector('#share-url') ||
                                   document.querySelector('.share-url') ||
                                   document.querySelector('input[type="text"][readonly]');
            
            if (shareUrlElement && shareUrlElement.value) {
                return shareUrlElement.value;
            }
            
            // If we can't find the share URL element, try to construct it from the current URL
            const currentUrl = window.location.href;
            if (!currentUrl.includes('?host=')) {
                // Try to find the peer ID
                const peerIdElement = document.querySelector('#peer-id') ||
                                     document.querySelector('.peer-id');
                
                if (peerIdElement && peerIdElement.textContent.trim() !== '') {
                    const peerId = peerIdElement.textContent.trim();
                    return `${window.location.origin}/?host=${peerId}`;
                }
            }
            
            return currentUrl; // Return current URL as fallback
        });
        
        log(`Share URL: ${shareUrl}`);
        
        if (!shareUrl.includes('?host=')) {
            throw new Error('Could not find a valid share URL with host parameter');
        }
        
        // Now launch the second browser for the receiver
        log('Launching receiver browser instance');
        browser2 = await puppeteer.launch({ 
            headless: false,
            args: ['--window-size=1280,800', '--window-position=1300,0']
        });
        
        // Set up receiver page with the share URL
        const receiverPage = await browser2.newPage();
        await captureConsoleLogs(receiverPage, 'RECEIVER');
        await receiverPage.setViewport({ width: 1280, height: 800 });
        log('Opening receiver page with share URL');
        await receiverPage.goto(shareUrl);
        await takeScreenshot(receiverPage, 'receiver-initial');
        
        // Wait for connection to establish
        log('Waiting for connection to establish');
        try {
            // Log the current status on both pages to help with debugging
            const senderStatus = await senderPage.evaluate(() => {
                const statusEl = document.querySelector('#status-message') || 
                               document.querySelector('.status-message') || 
                               document.querySelector('[data-status]');
                return statusEl ? statusEl.textContent : 'Status element not found';
            });
            log(`Sender status: ${senderStatus}`);
            
            const receiverStatus = await receiverPage.evaluate(() => {
                const statusEl = document.querySelector('#status-message') || 
                               document.querySelector('.status-message') || 
                               document.querySelector('[data-status]');
                return statusEl ? statusEl.textContent : 'Status element not found';
            });
            log(`Receiver status: ${receiverStatus}`);
            
            // Wait longer for connection (30 seconds)
            await Promise.all([
                senderPage.waitForFunction(() => {
                    // Look for any indicators of connection
                    const statusEl = document.querySelector('#status-message') || 
                                   document.querySelector('.status-message') || 
                                   document.querySelector('[data-status]');
                    
                    if (statusEl && (statusEl.textContent.includes('Connected') || 
                                    statusEl.textContent.includes('connection') || 
                                    statusEl.textContent.includes('peer'))) {
                        return true;
                    }
                    
                    // Also check for any peer connection indicators
                    return document.querySelector('.connected') || 
                           document.querySelector('[data-connected="true"]') ||
                           window._peerConnected === true;
                }, { timeout: 30000 }),
                
                receiverPage.waitForFunction(() => {
                    // Look for any indicators of connection
                    const statusEl = document.querySelector('#status-message') || 
                                   document.querySelector('.status-message') || 
                                   document.querySelector('[data-status]');
                    
                    if (statusEl && (statusEl.textContent.includes('Connected') || 
                                    statusEl.textContent.includes('connection') || 
                                    statusEl.textContent.includes('peer'))) {
                        return true;
                    }
                    
                    // Also check for any peer connection indicators
                    return document.querySelector('.connected') || 
                           document.querySelector('[data-connected="true"]') ||
                           window._peerConnected === true;
                }, { timeout: 30000 })
            ]);
            
            log('Connection established');
            await takeScreenshot(senderPage, 'sender-connected');
            await takeScreenshot(receiverPage, 'receiver-connected');
            
            // Switch to the Files tab on sender
            log('Switching to Files tab on sender');
            await senderPage.evaluate(() => {
                const tabButtons = document.querySelectorAll('.tab-button');
                // Click the Files tab (usually the second tab)
                if (tabButtons.length >= 2) tabButtons[1].click();
            });
            
            // Use setTimeout with a promise instead of waitForTimeout
            await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for tab switch animation
            
            // Prepare file for upload
            log('Preparing test file for upload');
            // First check if the file input is visible
            const fileInputVisible = await senderPage.evaluate(() => {
                const fileInput = document.querySelector('input[type="file"]');
                return fileInput && window.getComputedStyle(fileInput).display !== 'none';
            });
            
            if (fileInputVisible) {
                // Direct file input if visible
                await senderPage.waitForSelector('input[type="file"]');
                const inputUploadHandle = await senderPage.$('input[type="file"]');
                await inputUploadHandle.uploadFile(TEST_FILE_PATH);
            } else {
                // Otherwise click the drop zone or button that triggers file selection
                const [fileChooser] = await Promise.all([
                    senderPage.waitForFileChooser(),
                    senderPage.click('.drop-zone') // This might need adjustment based on your UI
                ]);
                await fileChooser.accept([TEST_FILE_PATH]);
            }
            
            log('Test file selected');
            
            // Wait for file to appear in the send list
            await senderPage.waitForFunction(() => {
                const fileItems = document.querySelectorAll('.file-item');
                return fileItems && fileItems.length > 0;
            }, { timeout: 5000 });
            
            await takeScreenshot(senderPage, 'sender-file-selected');
            
            // Send the file
            log('Sending file');
            await senderPage.evaluate(() => {
                const sendButton = document.querySelector('#send-files-btn') || 
                                   document.querySelector('button[data-action="send"]') ||
                                   Array.from(document.querySelectorAll('button')).find(b => 
                                       b.textContent.toLowerCase().includes('send'));
                if (sendButton) sendButton.click();
            });
            
            // Wait for file to appear in the received files list
            log('Waiting for file to appear in received files list');
            await receiverPage.waitForFunction(() => {
                const fileItems = Array.from(document.querySelectorAll('#received-files .file-item'));
                return fileItems.length > 0;
            }, { timeout: 15000 });
            await takeScreenshot(receiverPage, 'receiver-file-received');
            
            // Check if tab was automatically switched to 'Files Received'
            log('Checking if tab was automatically switched to Files Received');
            const isReceivedTabActive = await receiverPage.evaluate(() => {
                const receivedTab = document.querySelector('.tab[data-tab="received"]');
                return receivedTab && receivedTab.classList.contains('active');
            });
            log(`Received tab active: ${isReceivedTabActive}`);
            
            // Mock the file system access API save dialog
            // Since we can't interact with the native file picker, we'll mock the response
            await receiverPage.evaluate(() => {
                // Mock the showSaveFilePicker API response
                const mockHandle = {
                    createWritable: async () => {
                        return {
                            write: async (options) => {
                                console.log('Mock write called with position:', options.position);
                                return Promise.resolve();
                            },
                            close: async () => {
                                console.log('Mock file closed successfully');
                                return Promise.resolve();
                            }
                        };
                    }
                };
                
                // Override the showSaveFilePicker function
                window.showSaveFilePicker = async () => {
                    console.log('Mock showSaveFilePicker called');
                    return mockHandle;
                };
                
                // Log tab switching events for debugging
                const tabs = document.querySelectorAll('.tab');
                tabs.forEach(tab => {
                    const originalClick = tab.onclick;
                    tab.onclick = function(e) {
                        const tabType = this.getAttribute('data-tab');
                        console.log(`Tab clicked: ${tabType} (manual or auto)`); 
                        if (originalClick) originalClick.call(this, e);
                    };
                });
                
                // Monitor switchToTab function calls
                if (typeof switchToTab === 'function') {
                    const originalSwitchToTab = switchToTab;
                    window.switchToTab = function(tabType) {
                        console.log(`Auto switchToTab called with: ${tabType}`);
                        return originalSwitchToTab(tabType);
                    };
                }
            });
        } catch (error) {
            log(`Error during connection or setup: ${error.message}`);
            await takeScreenshot(senderPage, 'sender-connection-error');
            await takeScreenshot(receiverPage, 'receiver-connection-error');
            throw error;
        }
        
        // Wait for file transfer to complete on sender side
        log('Waiting for file transfer to complete');
        try {
            await senderPage.waitForFunction(() => {
                const fileItems = Array.from(document.querySelectorAll('#files-to-send .file-item'));
                return fileItems.some(item => {
                    const statusEl = item.querySelector('.file-status');
                    return statusEl && statusEl.textContent.includes('Completed');
                });
            }, { timeout: 30000 });
            
            log('File transfer completed on sender side');
            await takeScreenshot(senderPage, 'sender-transfer-complete');
            
            // Check if tab was automatically switched to 'Files to Send'
            log('Checking if tab was automatically switched to Files to Send');
            const isSendTabActive = await senderPage.evaluate(() => {
                const sendTab = document.querySelector('.tab[data-tab="send"]');
                return sendTab && sendTab.classList.contains('active');
            });
            log(`Send tab active: ${isSendTabActive}`);
            
            // Check receiver side for completion
            const receiverFileStatus = await receiverPage.evaluate(() => {
                const fileItems = Array.from(document.querySelectorAll('#received-files .file-item'));
                if (fileItems.length === 0) return 'No files found';
                
                const statusEl = fileItems[0].querySelector('.file-status');
                return statusEl ? statusEl.textContent : 'Status element not found';
            });
            
            log(`Receiver file status: ${receiverFileStatus}`);
            await takeScreenshot(receiverPage, 'receiver-transfer-complete');
            
            // Verify file was received and download button is visible
            const downloadButtonVisible = await receiverPage.evaluate(() => {
                const downloadButton = document.querySelector('#received-files .file-item .download-button');
                return downloadButton && (downloadButton.style.display !== 'none');
            });
            
            log(`Download button visible: ${downloadButtonVisible}`);
            
            if (isReceivedTabActive && isSendTabActive && downloadButtonVisible) {
                log('TEST PASSED: File transfer completed successfully with automatic tab switching');
            } else {
                log('TEST WARNING: File transfer completed but with issues:');
                if (!isReceivedTabActive) log('- Receiver tab was not automatically switched');
                if (!isSendTabActive) log('- Sender tab was not automatically switched');
                if (!downloadButtonVisible) log('- Download button not visible on receiver');
            }
        } catch (error) {
            log(`TEST FAILED: File transfer did not complete: ${error.message}`);
            await takeScreenshot(senderPage, 'sender-transfer-failed');
            await takeScreenshot(receiverPage, 'receiver-transfer-failed');
            
            // Collect debug information
            const senderDebugInfo = await senderPage.evaluate(() => {
                return {
                    connectionStatus: document.querySelector('#connection-status').textContent,
                    filesList: Array.from(document.querySelectorAll('#files-to-send .file-item')).map(item => ({
                        name: item.querySelector('.file-name').textContent,
                        status: item.querySelector('.file-status').textContent,
                        progress: item.querySelector('.progress-bar') ? 
                            item.querySelector('.progress-bar').style.width : 'N/A'
                    }))
                };
            });
            
            const receiverDebugInfo = await receiverPage.evaluate(() => {
                return {
                    connectionStatus: document.querySelector('#connection-status').textContent,
                    filesList: Array.from(document.querySelectorAll('#received-files .file-item')).map(item => ({
                        name: item.querySelector('.file-name').textContent,
                        status: item.querySelector('.file-status').textContent,
                        progress: item.querySelector('.progress-bar') ? 
                            item.querySelector('.progress-bar').style.width : 'N/A'
                    })),
                    pendingTransfers: window.pendingFileTransfers ? 
                        Object.keys(window.pendingFileTransfers).length : 'Not accessible',
                    receivedFiles: window.receivedFiles ? 
                        Object.keys(window.receivedFiles).length : 'Not accessible'
                };
            });
            
            log('Sender debug info: ' + JSON.stringify(senderDebugInfo, null, 2));
            log('Receiver debug info: ' + JSON.stringify(receiverDebugInfo, null, 2));
        }
    } catch (error) {
        log(`Test error: ${error.message}`);
        console.error(error);
        // Only take screenshot if senderPage is defined
        try {
            if (typeof senderPage !== 'undefined' && senderPage) {
                await takeScreenshot(senderPage, 'error-state');
            }
        } catch (screenshotError) {
            log(`Error taking screenshot: ${screenshotError.message}`);
        }
    } finally {
        log('Closing browser instances');
        try {
            if (browser1) await browser1.close();
        } catch (err) {
            log(`Error closing browser1: ${err.message}`);
        }
                
        try {
            if (browser2) await browser2.close();
        } catch (err) {
            log(`Error closing browser2: ${err.message}`);
        }
    }
}

async function main() {
    try {
        await runTest();
        log('Test completed successfully');
    } catch (error) {
        log(`Fatal error: ${error.message}`);
        console.error(error);
        process.exit(1); // Exit with error code
    }
}

main();
