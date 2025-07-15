/**
 * UI Manager for FileSender P2P
 * Handles UI elements, events, and updates
 */
import { formatBytes, getFileTypeIcon } from './utils.js';

// DOM Elements
let connectionStatusEl;
let hostInfoEl;
let clientInfoEl;
let shareLinkInput;
let copyButton;
let dropZone;
let fileInput;
let filesToSendList;
let receivedFilesList;
let tabButtons;
let tabContents;

/**
 * Initialize UI elements
 */
export function initializeUI() {
    // Get DOM elements
    connectionStatusEl = document.getElementById('connection-status');
    hostInfoEl = document.getElementById('host-info');
    clientInfoEl = document.getElementById('client-info');
    shareLinkInput = document.getElementById('share-link');
    copyButton = document.getElementById('copy-button');
    dropZone = document.getElementById('drop-zone');
    fileInput = document.getElementById('file-input');
    filesToSendList = document.getElementById('files-to-send');
    receivedFilesList = document.getElementById('received-files');
    
    // Make sure file list containers are visible
    const fileListContainers = document.querySelectorAll('.list-container');
    fileListContainers.forEach(container => {
        container.style.display = 'block';
    });
    
    // Debug: Check if DOM elements are found
    console.log('DOM Elements found:', {
        filesToSendList: !!filesToSendList,
        receivedFilesList: !!receivedFilesList,
        dropZone: !!dropZone,
        fileInput: !!fileInput,
        hostInfoEl: !!hostInfoEl,
        shareLinkInput: !!shareLinkInput
    });

    // Initialize tabs
    initializeTabs();
    
    // Add empty state messages
    addEmptyStateMessages();
    
    // Return UI elements for external use
    return {
        connectionStatusEl,
        hostInfoEl,
        clientInfoEl,
        shareLinkInput,
        copyButton,
        dropZone,
        fileInput,
        filesToSendList,
        receivedFilesList
    };
}

/**
 * Update connection status in UI
 * @param {string} message - Status message
 * @param {boolean} isConnected - Whether connected
 */
export function updateStatus(message, isConnected = false) {
    if (connectionStatusEl) {
        connectionStatusEl.textContent = message;
        connectionStatusEl.className = isConnected ? 'connected' : 'disconnected';
    }
    console.log('Status update:', message);
}

/**
 * Setup UI event handlers
 * @param {object} handlers - Event handler functions
 */
export function setupUIEvents(handlers) {
    const { onFileSelect, onFileDrop } = handlers;
    
    // Copy button event
    if (copyButton && shareLinkInput) {
        copyButton.addEventListener('click', () => {
            shareLinkInput.select();
            navigator.clipboard.writeText(shareLinkInput.value).then(() => {
                copyButton.textContent = 'Copied!';
                setTimeout(() => {
                    copyButton.textContent = 'Copy';
                }, 2000);
            }).catch(() => {
                document.execCommand('copy');
                copyButton.textContent = 'Copied!';
                setTimeout(() => {
                    copyButton.textContent = 'Copy';
                }, 2000);
            });
        });
    }
    
    // File drop zone
    if (dropZone && fileInput) {
        dropZone.addEventListener('click', () => {
            fileInput.click();
        });

        dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropZone.classList.add('dragover');
        });

        dropZone.addEventListener('dragleave', () => {
            dropZone.classList.remove('dragover');
        });

        dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropZone.classList.remove('dragover');
            
            if (e.dataTransfer.files.length > 0) {
                onFileDrop(e.dataTransfer.files);
            }
        });

        fileInput.addEventListener('change', (e) => {
            if (e.target.files.length > 0) {
                onFileSelect(e.target.files);
            }
        });
    }
}

/**
 * Initialize tabs functionality
 */
export function initializeTabs() {
    tabButtons = document.querySelectorAll('.tab');
    tabContents = document.querySelectorAll('.list-container');
    
    if (tabButtons.length === 0 || tabContents.length === 0) {
        console.log('Tabs not found in DOM yet');
        return;
    }
    
    console.log('Initializing tabs');
    
    tabButtons.forEach(button => {
        button.addEventListener('click', () => {
            const tabId = button.getAttribute('data-tab');
            
            // Update active tab button
            tabButtons.forEach(btn => {
                btn.classList.remove('active');
            });
            button.classList.add('active');
            
            // Show selected tab content
            tabContents.forEach(content => {
                if (content.getAttribute('data-content') === tabId) {
                    content.classList.add('active');
                } else {
                    content.classList.remove('active');
                }
            });
        });
    });
    
    // Activate first tab by default
    if (tabButtons[0]) {
        tabButtons[0].click();
    }
}

/**
 * Ensure tabs are initialized (called after DOM is fully loaded)
 */
export function ensureTabsInitialized() {
    if (!tabButtons || tabButtons.length === 0) {
        console.log('Tabs not initialized yet, trying again');
        setTimeout(() => {
            initializeTabs();
            
            if (!tabButtons || tabButtons.length === 0) {
                console.log('Still no tabs found, trying one more time');
                setTimeout(initializeTabs, 500);
            }
        }, 100);
    }
}

/**
 * Add empty state messages to file lists
 */
export function addEmptyStateMessages() {
    if (filesToSendList) {
        const emptyMessage = document.createElement('div');
        emptyMessage.className = 'empty-state';
        emptyMessage.innerHTML = '<i class="fas fa-cloud-upload-alt"></i><p>Drop files here or click to select</p>';
        filesToSendList.appendChild(emptyMessage);
        
        // Set up observer to show/hide empty state
        setupEmptyStateObservers(filesToSendList, emptyMessage, 'fa-cloud-upload-alt');
    }
    
    if (receivedFilesList) {
        const emptyMessage = document.createElement('div');
        emptyMessage.className = 'empty-state';
        emptyMessage.innerHTML = '<i class="fas fa-cloud-download-alt"></i><p>No files received yet</p>';
        receivedFilesList.appendChild(emptyMessage);
        
        // Set up observer to show/hide empty state
        setupEmptyStateObservers(receivedFilesList, emptyMessage, 'fa-cloud-download-alt');
    }
}

/**
 * Set up observers for empty state messages
 * @param {HTMLElement} listElement - The list element to observe
 * @param {HTMLElement} emptyMessage - The empty state message element
 * @param {string} iconClass - Icon class for the empty state
 */
export function setupEmptyStateObservers(listElement, emptyMessage, iconClass) {
    // Initial check
    checkAndUpdateEmptyState(listElement);
    
    // Create a mutation observer to watch for changes
    const observer = new MutationObserver(() => {
        checkAndUpdateEmptyState(listElement);
    });
    
    // Start observing
    observer.observe(listElement, { 
        childList: true,
        subtree: true
    });
    
    function checkAndUpdateEmptyState(listElement) {
        // Count non-empty-state children
        let fileCount = 0;
        
        for (const child of listElement.children) {
            if (!child.classList.contains('empty-state')) {
                fileCount++;
            }
        }
        
        // Show/hide empty state based on file count
        if (fileCount === 0) {
            emptyMessage.style.display = 'flex';
        } else {
            emptyMessage.style.display = 'none';
        }
    }
}

/**
 * Create a file element for UI
 * @param {File|object} file - File object or file info
 * @param {string} type - 'send' or 'receive'
 * @returns {object} File element info
 */
export function createFileElement(file, type) {
    const fileId = file.id || `file-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    const fileName = file.name;
    const fileSize = file.size;
    
    const listElement = type === 'send' ? filesToSendList : receivedFilesList;
    
    return {
        fileId,
        element: addFileToUI(listElement, fileId, fileName, fileSize, type === 'send' ? 'pending' : 'receiving')
    };
}

/**
 * Add a file to the UI
 * @param {HTMLElement} listElement - List element to add to
 * @param {string} fileId - Unique file ID
 * @param {string} fileName - File name
 * @param {number} fileSize - File size in bytes
 * @param {string} status - File status
 * @returns {HTMLElement} The created file element
 */
export function addFileToUI(listElement, fileId, fileName, fileSize, status) {
    // Create file element
    const fileElement = document.createElement('div');
    fileElement.className = 'file-item';
    fileElement.dataset.fileId = fileId;
    
    // Get icon based on file type
    const iconClass = getFileTypeIcon(fileName);
    
    // Create file content
    fileElement.innerHTML = `
        <div class="file-icon">
            <i class="fas ${iconClass}"></i>
        </div>
        <div class="file-info">
            <div class="file-name">${fileName}</div>
            <div class="file-size">${formatBytes(fileSize)}</div>
            <div class="file-status">${status}</div>
            <div class="progress-container">
                <div class="progress-bar" style="width: 0%"></div>
            </div>
        </div>
        <div class="file-actions">
            <!-- Actions will be added based on status -->
        </div>
    `;
    
    // Add to list
    listElement.appendChild(fileElement);
    
    return fileElement;
}

/**
 * Update file status in UI
 * @param {HTMLElement} listElement - List element containing the file
 * @param {string} fileId - File ID
 * @param {string} status - New status
 * @param {number} progress - Progress percentage (0-100)
 * @param {string} downloadUrl - URL for download (optional)
 * @param {string} fileName - File name (optional)
 */
export function updateFileStatus(listElement, fileId, status, progress, downloadUrl = null, fileName = null) {
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
                triggerFileDownload(downloadUrl, fileName);
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

/**
 * Trigger file download
 * @param {string} url - File URL
 * @param {string} fileName - File name
 */
export function triggerFileDownload(url, fileName) {
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    
    // Revoke the object URL after download starts
    setTimeout(() => {
        URL.revokeObjectURL(url);
    }, 100);
}
