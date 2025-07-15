/**
 * File Manager for FileSender P2P
 * Handles file operations, tracking, and history
 */
import { formatBytes } from './utils.js';

// File tracking
const filesToSend = {};
const receivedFiles = {};
const AUTO_DOWNLOAD_ENABLED = true;
const MAX_FILES_TO_KEEP = 5;
const fileHistory = {
    sent: [],
    received: []
};

// Event callbacks
let callbacks = {
    onFileAdded: () => {},
    onFileStatusUpdate: () => {},
    onFileComplete: () => {}
};

/**
 * Initialize file manager
 * @param {object} options - File manager options
 * @param {function} options.onFileAdded - File added callback
 * @param {function} options.onFileStatusUpdate - File status update callback
 * @param {function} options.onFileComplete - File complete callback
 * @returns {object} File manager API
 */
export function initializeFileManager(options) {
    // Set callbacks
    callbacks = { ...callbacks, ...options };
    
    return {
        addFileToSend,
        getFileToSend,
        getAllFilesToSend,
        addReceivedFile,
        getReceivedFile,
        getAllReceivedFiles,
        updateFileStatus,
        completeFile,
        maintainFileLimit
    };
}

/**
 * Add a file to be sent
 * @param {File} file - File object
 * @returns {string} File ID
 */
function addFileToSend(file) {
    const fileId = `file-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    
    filesToSend[fileId] = {
        id: fileId,
        file: file,
        name: file.name,
        size: file.size,
        type: file.type,
        status: 'pending',
        progress: 0,
        chunks: Math.ceil(file.size / (64 * 1024)), // 64KB chunks
        sentChunks: 0,
        acknowledgedChunks: 0 // Track acknowledged chunks
    };
    
    callbacks.onFileAdded(fileId, file, 'send');
    
    // Add to history
    fileHistory.sent.push({
        id: fileId,
        name: file.name,
        size: file.size,
        timestamp: Date.now()
    });
    
    return fileId;
}

/**
 * Get a file to send by ID
 * @param {string} fileId - File ID
 * @returns {object} File info
 */
function getFileToSend(fileId) {
    return filesToSend[fileId];
}

/**
 * Get all files to send
 * @returns {object} Files to send
 */
function getAllFilesToSend() {
    return filesToSend;
}

/**
 * Add a received file
 * @param {string} fileId - File ID
 * @param {object} fileInfo - File info
 * @returns {object} File info
 */
function addReceivedFile(fileId, fileInfo) {
    receivedFiles[fileId] = {
        id: fileId,
        name: fileInfo.name,
        size: fileInfo.size,
        type: fileInfo.type,
        status: 'receiving',
        progress: 0,
        chunks: fileInfo.chunks,
        receivedChunks: 0,
        buffer: new Map(), // Store chunks in a Map
        completed: false
    };
    
    callbacks.onFileAdded(fileId, fileInfo, 'receive');
    
    // Add to history
    fileHistory.received.push({
        id: fileId,
        name: fileInfo.name,
        size: fileInfo.size,
        timestamp: Date.now()
    });
    
    return receivedFiles[fileId];
}

/**
 * Get a received file by ID
 * @param {string} fileId - File ID
 * @returns {object} File info
 */
function getReceivedFile(fileId) {
    return receivedFiles[fileId];
}

/**
 * Get all received files
 * @returns {object} Received files
 */
function getAllReceivedFiles() {
    return receivedFiles;
}

/**
 * Update file status
 * @param {string} fileId - File ID
 * @param {string} type - 'send' or 'receive'
 * @param {object} updates - Status updates
 */
function updateFileStatus(fileId, type, updates) {
    const files = type === 'send' ? filesToSend : receivedFiles;
    const file = files[fileId];
    
    if (!file) return;
    
    // Update file properties
    Object.assign(file, updates);
    
    // Calculate progress
    if (type === 'send') {
        file.progress = Math.floor((file.sentChunks / file.chunks) * 100);
    } else {
        file.progress = Math.floor((file.receivedChunks / file.chunks) * 100);
    }
    
    // Notify about status update
    callbacks.onFileStatusUpdate(fileId, type, file.status, file.progress);
}

/**
 * Mark a file as complete
 * @param {string} fileId - File ID
 * @param {string} type - 'send' or 'receive'
 * @param {object} options - Additional options
 */
function completeFile(fileId, type, options = {}) {
    const files = type === 'send' ? filesToSend : receivedFiles;
    const file = files[fileId];
    
    if (!file) return;
    
    // Update file status
    file.status = 'complete';
    file.progress = 100;
    
    if (type === 'receive' && options.blob) {
        file.blob = options.blob;
        file.url = URL.createObjectURL(options.blob);
        
        console.log(`File ${fileId} completed:`, {
            name: file.name,
            size: file.blob.size,
            type: file.blob.type,
            url: file.url
        });
    }
    
    // Notify about completion
    callbacks.onFileComplete(fileId, type, file);
    
    // Auto download if enabled (with a small delay to ensure blob is ready)
    if (type === 'receive' && AUTO_DOWNLOAD_ENABLED && file.url) {
        setTimeout(() => {
            triggerFileDownload(file.url, file.name);
        }, 100);
    }
    
    // Maintain file limit
    maintainFileLimit(type);
}

/**
 * Maintain file limit (remove old files)
 * @param {string} type - 'send' or 'receive'
 */
function maintainFileLimit(type) {
    const history = type === 'send' ? fileHistory.sent : fileHistory.received;
    const files = type === 'send' ? filesToSend : receivedFiles;
    
    // If we have more than MAX_FILES_TO_KEEP, remove the oldest ones
    if (history.length > MAX_FILES_TO_KEEP) {
        // Sort by timestamp (oldest first)
        history.sort((a, b) => a.timestamp - b.timestamp);
        
        // Remove oldest files until we're at the limit
        while (history.length > MAX_FILES_TO_KEEP) {
            const oldestFile = history.shift();
            
            // Clean up file data
            if (files[oldestFile.id]) {
                // Revoke object URL if it exists
                if (files[oldestFile.id].url) {
                    URL.revokeObjectURL(files[oldestFile.id].url);
                }
                
                // Delete file data
                delete files[oldestFile.id];
            }
        }
    }
}

/**
 * Trigger file download
 * @param {string} url - File URL
 * @param {string} fileName - File name
 */
function triggerFileDownload(url, fileName) {
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    
    // Don't revoke the URL immediately - let it persist for manual downloads
    // The URL will be cleaned up when the file is removed from history
    console.log(`Download triggered for: ${fileName}`);
}
