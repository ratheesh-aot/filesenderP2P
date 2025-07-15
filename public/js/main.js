/**
 * Main entry point for FileSender P2P
 * Imports and initializes all modules
 */
import { initializeUI, updateStatus, setupUIEvents, ensureTabsInitialized, addFileToUI } from './uiManager.js';
import { initializeConnectionManager } from './connectionManager.js';
import { initializeFileManager } from './fileManager.js';
import { initializeTransferManager, handleFiles, handleMessage } from './transferManager.js';

// Initialize the application when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM Content Loaded - Starting FileSender P2P initialization');

    // Initialize UI
    const ui = initializeUI();
    
    // Debug UI elements
    console.log('UI elements:', {
        hostInfoEl: ui.hostInfoEl ? true : false,
        clientInfoEl: ui.clientInfoEl ? true : false,
        shareLinkInput: ui.shareLinkInput ? true : false
    });
    
    // Initialize file manager
    const fileManager = initializeFileManager({
        onFileAdded: (fileId, file, type) => {
            console.log(`File added: ${fileId}, type: ${type}`);
            // Add file to UI
            const listElement = type === 'send' ? ui.filesToSendList : ui.receivedFilesList;
            addFileToUI(listElement, fileId, file.name, file.size, type === 'send' ? 'pending' : 'receiving');
        },
        onFileStatusUpdate: (fileId, type, status, progress) => {
            const listElement = type === 'send' ? ui.filesToSendList : ui.receivedFilesList;
            updateFileStatus(listElement, fileId, status, progress);
        },
        onFileComplete: (fileId, type, file) => {
            console.log(`File complete: ${fileId}, type: ${type}`);
            const listElement = type === 'send' ? ui.filesToSendList : ui.receivedFilesList;
            
            if (type === 'receive' && file.url) {
                updateFileStatus(listElement, fileId, 'complete', 100, file.url, file.name);
            } else {
                updateFileStatus(listElement, fileId, 'complete', 100);
            }
        }
    });
    
    // Initialize connection manager first
    const connectionManager = initializeConnectionManager({
        onStatusUpdate: (message, isConnected) => {
            updateStatus(message, isConnected);
            if (isConnected) {
                // Show/hide appropriate UI elements based on whether we're host or client
                const urlParams = new URLSearchParams(window.location.search);
                const hostId = urlParams.get('host');
                
                if (hostId) {
                    // Client mode
                    if (ui.hostInfoEl) ui.hostInfoEl.style.display = 'none';
                    if (ui.clientInfoEl) {
                        ui.clientInfoEl.style.display = 'block';
                        // Update client info text when connected
                        ui.clientInfoEl.innerHTML = '<p>Connected to host!</p>';
                    }
                } else {
                    // Host mode
                    if (ui.hostInfoEl) ui.hostInfoEl.style.display = 'block';
                    if (ui.clientInfoEl) ui.clientInfoEl.style.display = 'none';
                }
            }
        },
        onShareLinkGenerated: (shareUrl) => {
            console.log('Share link generated:', shareUrl);
            // Update the share link input field
            if (ui.shareLinkInput) {
                ui.shareLinkInput.value = shareUrl;
                console.log('Share link input updated');
            } else {
                console.log('Share link input element not found');
            }
            
            // Make sure host info is visible
            if (ui.hostInfoEl) {
                ui.hostInfoEl.style.display = 'block';
                console.log('Host info element display set to block');
            } else {
                console.log('Host info element not found');
            }
        },
        onConnected: () => {
            console.log('Connected to peer');
            // Process any pending transfers
            transferManager.processTransferQueue();
        },
        onDisconnected: () => {
            console.log('Disconnected from peer');
        },
        onDataReceived: (data) => {
            try {
                const message = JSON.parse(data);
                console.log('Received message:', message);
                handleMessage(message);
            } catch (err) {
                console.error('Error parsing message:', err);
            }
        }
    });
    
    // Initialize transfer manager after connectionManager
    const transferManager = initializeTransferManager({
        fileManager,
        connectionManager,
        onTransferStart: (fileId) => {
            console.log(`Transfer started: ${fileId}`);
        },
        onTransferProgress: (fileId, progress) => {
            console.log(`Transfer progress: ${fileId}, ${progress}%`);
        },
        onTransferComplete: (fileId) => {
            console.log(`Transfer complete: ${fileId}`);
        },
        onTransferError: (fileId, error) => {
            console.error(`Transfer error: ${fileId}`, error);
        },
        onChunkReceived: (fileId, chunkIndex, totalChunks) => {
            console.log(`Chunk received: ${fileId}, ${chunkIndex}/${totalChunks}`);
        }
    });
    
    
    // Set up UI events
    setupUIEvents({
        onFileSelect: (files) => {
            handleFiles(files);
        },
        onFileDrop: (files) => {
            handleFiles(files);
        }
    });
    
    // Listen for file retry events
    document.addEventListener('file-retry', (event) => {
        const { fileId } = event.detail;
        transferManager.retryFile(fileId);
    });
    
    // Connect to signaling server
    connectionManager.connect();
    
    // Ensure tabs are initialized
    ensureTabsInitialized();
    
    // Helper function to update file status in UI
    function updateFileStatus(listElement, fileId, status, progress, downloadUrl = null, fileName = null) {
        const fileElement = listElement.querySelector(`[data-file-id="${fileId}"]`);
        if (!fileElement) return;
        
        // Update status text
        const statusElement = fileElement.querySelector('.file-status');
        if (statusElement) {
            statusElement.textContent = status;
        }
        
        // Update progress bar
        const progressBar = fileElement.querySelector('.progress-bar');
        if (progressBar) {
            progressBar.style.width = `${progress}%`;
        }
        
        // Show/hide progress bar based on status
        const progressContainer = fileElement.querySelector('.progress-container');
        if (progressContainer) {
            if (status === 'complete' || status === 'error') {
                progressContainer.style.display = 'none';
            } else {
                progressContainer.style.display = 'block';
            }
        }
        
        // Update actions
        const actionsContainer = fileElement.querySelector('.file-actions');
        if (actionsContainer) {
            actionsContainer.innerHTML = '';
            
            if (status === 'complete' && downloadUrl) {
                // Add download button
                const downloadButton = document.createElement('button');
                downloadButton.className = 'download-button';
                downloadButton.innerHTML = '<i class="fas fa-download"></i>';
                downloadButton.title = 'Download';
                downloadButton.addEventListener('click', () => {
                    const a = document.createElement('a');
                    a.href = downloadUrl;
                    a.download = fileName || 'download';
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                });
                actionsContainer.appendChild(downloadButton);
            }
            
            if (status === 'error') {
                // Add retry button for sent files
                if (listElement.id === 'files-to-send') {
                    const retryButton = document.createElement('button');
                    retryButton.className = 'retry-button';
                    retryButton.innerHTML = '<i class="fas fa-redo"></i>';
                    retryButton.title = 'Retry';
                    retryButton.addEventListener('click', () => {
                        // Dispatch custom event for retry
                        const event = new CustomEvent('file-retry', { 
                            detail: { fileId } 
                        });
                        document.dispatchEvent(event);
                    });
                    actionsContainer.appendChild(retryButton);
                }
            }
        }
    }
});
