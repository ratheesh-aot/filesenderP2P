/**
 * Transfer Manager for FileSender P2P
 * Handles file transfer operations, chunking, and acknowledgments
 */
import { sendMessage } from './connectionManager.js';

// Connection manager reference
let connectionManager;

// Transfer settings
const CHUNK_SIZE = 64 * 1024; // 64KB chunks
const MAX_CHUNKS_IN_FLIGHT = 3; // Max outstanding unacknowledged chunks
const BUFFER_THRESHOLD = 512 * 1024; // Pause sending if WebRTC channel buffer exceeds 512KB
let chunksInFlight = 0;
let isTransferring = false; // True while a file is actively being transferred
let transferQueue = []; // Queue for files waiting to be sent
let pendingChunks = new Map(); // Track chunks that have been sent but not acknowledged

// Event callbacks
let callbacks = {
    onTransferStart: () => { },
    onTransferProgress: () => { },
    onTransferComplete: () => { },
    onTransferError: () => { },
    onChunkReceived: () => { }
};

// File manager reference
let fileManager;

/**
 * Initialize transfer manager
 * @param {object} options - Transfer manager options
 * @param {object} options.fileManager - File manager instance
 * @param {function} options.onTransferStart - Transfer start callback
 * @param {function} options.onTransferProgress - Transfer progress callback
 * @param {function} options.onTransferComplete - Transfer complete callback
 * @param {function} options.onTransferError - Transfer error callback
 * @param {function} options.onChunkReceived - Chunk received callback
 * @returns {object} Transfer manager API
 */
export function initializeTransferManager(options) {
    // Set callbacks and file manager
    callbacks = { ...callbacks, ...options };
    fileManager = options.fileManager;
    connectionManager = options.connectionManager;

    return {
        handleFiles,
        processTransferQueue,
        handleMessage,
        handleFileChunk,
        assembleAndSaveFile,
        retryFile
    };
}

/**
 * Handle files selected for sending
 * @param {FileList} fileList - List of files to send
 */
export function handleFiles(fileList) {
    if (!fileList || fileList.length === 0) return;

    console.log('Handling files:', fileList);

    // Add each file to the queue
    for (let i = 0; i < fileList.length; i++) {
        const file = fileList[i];
        const fileId = fileManager.addFileToSend(file);

        // Add to transfer queue
        transferQueue.push({
            fileId,
            file
        });
    }

    // Process the queue
    processTransferQueue();
}

/**
 * Process the transfer queue
 */
export function processTransferQueue() {
    if (transferQueue.length === 0 || isTransferring) {
        return;
    }

    if (!connectionManager || !connectionManager.isConnected()) {
        console.log('Cannot process transfer queue: No connection');
        return;
    }

    const { fileId, file } = transferQueue[0];
    isTransferring = true;
    sendFileMetadata(fileId, file);
}

/**
 * Send file metadata to peer
 * @param {string} fileId - File ID
 * @param {File} file - File object
 */
function sendFileMetadata(fileId, file) {
    const fileInfo = fileManager.getFileToSend(fileId);
    if (!fileInfo) return;

    // Update file status
    fileManager.updateFileStatus(fileId, 'send', { status: 'sending' });

    // Send metadata message
    sendMessage({
        type: 'file-metadata',
        fileId: fileId,
        name: file.name,
        size: file.size,
        fileType: file.type,
        chunks: Math.ceil(file.size / CHUNK_SIZE)
    });

    // Start sending chunks
    sendFileChunks(fileId, file);
}

/**
 * Send file chunks to peer
 * @param {string} fileId - File ID
 * @param {File} file - File object
 */
function sendFileChunks(fileId, file) {
    const fileInfo = fileManager.getFileToSend(fileId);
    if (!fileInfo) return;

    fileInfo.sentChunks = 0;
    chunksInFlight = 0; // Reset counter cleanly for this file
    continueSendingChunks(fileId);
}

/**
 * Send a single file chunk, with backpressure retry if the channel buffer is full
 * @param {string} fileId - File ID
 * @param {number} chunkIndex - Chunk index
 * @param {Blob} chunk - Chunk data
 */
function sendFileChunk(fileId, chunkIndex, chunk) {
    const chunkKey = `${fileId}-${chunkIndex}`;
    const reader = new FileReader();

    reader.onerror = (e) => {
        console.error(`Error reading chunk ${chunkIndex} for file ${fileId}:`, e);
        chunksInFlight--;
        pendingChunks.delete(chunkKey);
        fileManager.updateFileStatus(fileId, 'send', { status: 'error - read failed' });
        abortTransfer(fileId);
    };

    reader.onload = (e) => {
        const arrayBuffer = e.target.result;

        if (!connectionManager || !connectionManager.isConnected()) {
            console.error(`Cannot send chunk ${chunkIndex}: No connection`);
            chunksInFlight--;
            pendingChunks.delete(chunkKey);
            fileManager.updateFileStatus(fileId, 'send', { status: 'error - no connection' });
            abortTransfer(fileId);
            return;
        }

        // Convert ArrayBuffer to base64 for reliable transmission
        const uint8Array = new Uint8Array(arrayBuffer);
        let binaryString = '';
        for (let i = 0; i < uint8Array.length; i++) {
            binaryString += String.fromCharCode(uint8Array[i]);
        }
        const base64Data = btoa(binaryString);

        const message = {
            type: 'file-chunk',
            fileId: fileId,
            chunkIndex: chunkIndex,
            chunkSize: arrayBuffer.byteLength,
            chunk: base64Data
        };

        // Retry with backoff if the WebRTC channel buffer is too full
        const trySend = () => {
            if (!connectionManager || !connectionManager.isConnected()) {
                chunksInFlight--;
                pendingChunks.delete(chunkKey);
                fileManager.updateFileStatus(fileId, 'send', { status: 'error - no connection' });
                abortTransfer(fileId);
                return;
            }
            if (connectionManager.getBufferedAmount() > BUFFER_THRESHOLD) {
                setTimeout(trySend, 50);
                return;
            }
            const sent = sendMessage(message);
            if (!sent) {
                console.error(`Failed to send chunk ${chunkIndex} for file ${fileId}`);
                chunksInFlight--;
                pendingChunks.delete(chunkKey);
                fileManager.updateFileStatus(fileId, 'send', { status: 'error - send failed' });
                abortTransfer(fileId);
                return;
            }
            console.log(`Sent chunk ${chunkIndex} for file ${fileId} (${arrayBuffer.byteLength} bytes)`);
        };

        trySend();
    };

    reader.readAsArrayBuffer(chunk);
}

/**
 * Remove an errored file from the transfer queue and continue with the next one
 * @param {string} fileId - File ID that errored
 */
function abortTransfer(fileId) {
    transferQueue = transferQueue.filter(item => item.fileId !== fileId);
    isTransferring = false;
    if (transferQueue.length > 0) {
        processTransferQueue();
    }
}

/**
 * Handle message from peer
 * @param {object} message - Message object
 */
export function handleMessage(message) {
    if (!message || !message.type) return;

    switch (message.type) {
        case 'file-metadata':
            console.log('Received file metadata:', message);
            // Add file to received files
            fileManager.addReceivedFile(message.fileId, {
                name: message.name,
                size: message.size,
                type: message.fileType || 'application/octet-stream',
                chunks: message.chunks
            });
            break;

        case 'file-chunk':
            handleFileChunk(message);
            break;

        case 'chunk-ack':
            handleChunkAcknowledgment(message);
            break;

        case 'file-complete':
            console.log('Received file complete message:', message);
            assembleAndSaveFile(message.fileId);
            break;
    }
}

/**
 * Handle chunk acknowledgment
 * @param {object} message - Acknowledgment message
 */
function handleChunkAcknowledgment(message) {
    const { fileId, chunkIndex } = message;
    const chunkKey = `${fileId}-${chunkIndex}`;

    // Remove from pending chunks
    if (pendingChunks.has(chunkKey)) {
        pendingChunks.delete(chunkKey);
    }

    // Decrement chunks in flight
    chunksInFlight--;

    // Update file info
    const fileInfo = fileManager.getFileToSend(fileId);
    if (fileInfo) {
        // Initialize acknowledgedChunks if not already done
        if (!fileInfo.acknowledgedChunks) {
            fileInfo.acknowledgedChunks = 0;
        }
        
        fileInfo.acknowledgedChunks++;
        
        // Update progress percentage
        const progress = Math.floor((fileInfo.acknowledgedChunks / fileInfo.chunks) * 100);
        fileManager.updateFileStatus(fileId, 'send', {
            acknowledgedChunks: fileInfo.acknowledgedChunks,
            progress: progress,
            status: 'sending'
        });

        console.log(`Chunk ${chunkIndex} acknowledged for file ${fileId}, progress: ${fileInfo.acknowledgedChunks}/${fileInfo.chunks} (${progress}%)`);

        // Check if all chunks have been acknowledged
        if (fileInfo.acknowledgedChunks === fileInfo.chunks) {
            console.log(`All chunks acknowledged for file ${fileId}, sending file-complete`);

            sendMessage({ type: 'file-complete', fileId: fileId });
            fileManager.completeFile(fileId, 'send');

            transferQueue = transferQueue.filter(item => item.fileId !== fileId);
            isTransferring = false;
            chunksInFlight = 0;

            if (transferQueue.length > 0) {
                processTransferQueue();
            }
        } else {
            // Continue sending chunks if we were paused and have capacity
            if (chunksInFlight < MAX_CHUNKS_IN_FLIGHT) {
                continueSendingChunks(fileId);
            }
        }
    }
}

/**
 * Continue sending chunks for a file
 * @param {string} fileId - File ID to continue sending
 */
function continueSendingChunks(fileId) {
    const fileInfo = fileManager.getFileToSend(fileId);
    if (!fileInfo || !fileInfo.file) {
        console.log(`Cannot continue sending chunks for ${fileId}: file not found`);
        return;
    }

    // Check if we need to send more chunks
    const nextChunkIndex = fileInfo.sentChunks;
    if (nextChunkIndex >= fileInfo.chunks) {
        console.log(`All chunks already sent for file ${fileId}`);
        return;
    }

    // Check connection
    if (!connectionManager || !connectionManager.isConnected()) {
        console.log(`Cannot continue sending chunks for ${fileId}: no connection`);
        return;
    }

    const file = fileInfo.file;

    while (chunksInFlight < MAX_CHUNKS_IN_FLIGHT && fileInfo.sentChunks < fileInfo.chunks) {
        const chunkIndex = fileInfo.sentChunks;
        const offset = chunkIndex * CHUNK_SIZE;
        const end = Math.min(offset + CHUNK_SIZE, file.size);
        const chunk = file.slice(offset, end);

        // Send this chunk
        sendFileChunk(fileId, chunkIndex, chunk);

        // Track this chunk
        pendingChunks.set(`${fileId}-${chunkIndex}`, {
            fileId,
            chunkIndex,
            timestamp: Date.now()
        });

        // Update counters
        fileInfo.sentChunks++;
        chunksInFlight++;

        // Update file status
        fileManager.updateFileStatus(fileId, 'send', {
            sentChunks: fileInfo.sentChunks,
            status: 'sending'
        });
    }
}

/**
 * Handle file chunk from peer
 * @param {object} data - Chunk data
 */
export function handleFileChunk(data) {
    const { fileId, chunkIndex, chunk, chunkSize } = data;

    console.log(`Received chunk ${chunkIndex} for file ${fileId}:`, {
        chunkType: typeof chunk,
        chunkConstructor: chunk?.constructor?.name,
        chunkSize: chunk?.byteLength || chunk?.length || chunkSize || 'unknown',
        expectedSize: chunkSize,
        isBase64String: typeof chunk === 'string'
    });

    // Get file info
    const fileInfo = fileManager.getReceivedFile(fileId);
    if (!fileInfo) {
        console.error(`Received chunk for unknown file: ${fileId}`);
        return;
    }

    // Convert chunk to Uint8Array properly
    let chunkArray;
    if (chunk instanceof ArrayBuffer) {
        chunkArray = new Uint8Array(chunk);
    } else if (chunk instanceof Uint8Array) {
        chunkArray = chunk;
    } else if (typeof chunk === 'string') {
        // Decode base64 string to binary data
        try {
            console.log(`Decoding base64 chunk ${chunkIndex} (${chunk.length} chars)`);
            const binaryString = atob(chunk);
            chunkArray = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
                chunkArray[i] = binaryString.charCodeAt(i);
            }
            console.log(`Decoded chunk ${chunkIndex} to ${chunkArray.length} bytes`);
        } catch (error) {
            console.error(`Error decoding base64 chunk ${chunkIndex}:`, error);
            return;
        }
    } else {
        console.error('Unknown chunk type:', typeof chunk, chunk);
        return;
    }

    // Verify chunk size if provided
    if (chunkSize && chunkArray.length !== chunkSize) {
        console.warn(`Chunk size mismatch: expected ${chunkSize}, got ${chunkArray.length}`);
    }

    console.log(`Storing chunk ${chunkIndex} with size ${chunkArray.length} bytes`);

    // Store the chunk in the file's buffer
    fileInfo.buffer.set(chunkIndex, chunkArray);
    fileInfo.receivedChunks++;

    // Send acknowledgment
    sendMessage({
        type: 'chunk-ack',
        fileId: fileId,
        chunkIndex: chunkIndex
    });

    // Update progress
    const progress = Math.floor((fileInfo.receivedChunks / fileInfo.chunks) * 100);
    fileManager.updateFileStatus(fileId, 'receive', {
        receivedChunks: fileInfo.receivedChunks,
        progress: progress,
        status: 'receiving'
    });

    console.log(`File ${fileId} progress: ${fileInfo.receivedChunks}/${fileInfo.chunks} chunks (${progress}%)`);

    // Check if we've received all chunks
    if (fileInfo.receivedChunks === fileInfo.chunks) {
        console.log(`Received all chunks for file ${fileId}`);
        // We'll wait for the file-complete message before assembling
    }
}

/**
 * Assemble and save a completed file
 * @param {string} fileId - File ID
 */
export function assembleAndSaveFile(fileId) {
    const fileInfo = fileManager.getReceivedFile(fileId);
    if (!fileInfo || fileInfo.completed) return;

    console.log(`Assembling file ${fileId}`, {
        receivedChunks: fileInfo.receivedChunks,
        totalChunks: fileInfo.chunks,
        fileType: fileInfo.type,
        fileName: fileInfo.name
    });

    // Check if we have all chunks
    if (fileInfo.receivedChunks !== fileInfo.chunks) {
        console.error(`Cannot assemble file ${fileId}: missing chunks (${fileInfo.receivedChunks}/${fileInfo.chunks})`);
        return;
    }

    // Verify all chunks are present
    const missingChunks = [];
    for (let i = 0; i < fileInfo.chunks; i++) {
        if (!fileInfo.buffer.has(i)) {
            missingChunks.push(i);
        }
    }

    if (missingChunks.length > 0) {
        console.error(`Cannot assemble file ${fileId}: missing chunk indices:`, missingChunks);
        return;
    }

    try {
        // Create an array to hold all chunks in order
        const chunks = [];
        let totalSize = 0;

        // Add chunks in order and calculate total size
        for (let i = 0; i < fileInfo.chunks; i++) {
            const chunk = fileInfo.buffer.get(i);
            if (chunk && chunk instanceof Uint8Array) {
                chunks.push(chunk);
                totalSize += chunk.length;
            } else {
                console.error(`Invalid chunk at index ${i} for file ${fileId}:`, chunk);
                return;
            }
        }

        console.log(`Assembling ${chunks.length} chunks, total size: ${totalSize} bytes, expected: ${fileInfo.size} bytes`);

        // Determine the correct MIME type
        let mimeType = fileInfo.type;
        if (!mimeType || mimeType === 'application/octet-stream') {
            // Try to determine MIME type from file extension
            mimeType = getMimeTypeFromFileName(fileInfo.name) || 'application/octet-stream';
        }

        console.log(`Creating blob with MIME type: ${mimeType}`);

        // Create a blob from all chunks with proper MIME type
        const blob = new Blob(chunks, { type: mimeType });

        // Verify blob size
        if (blob.size !== fileInfo.size) {
            console.warn(`Blob size mismatch: expected ${fileInfo.size}, got ${blob.size}`);
        }

        // Mark file as complete
        fileInfo.completed = true;
        fileManager.completeFile(fileId, 'receive', { blob });

        console.log(`File ${fileId} assembled successfully:`, {
            name: fileInfo.name,
            size: blob.size,
            type: mimeType
        });

    } catch (error) {
        console.error(`Error assembling file ${fileId}:`, error);
        fileManager.updateFileStatus(fileId, 'receive', {
            status: 'error - assembly failed'
        });
        return;
    } finally {
        // Clear buffer to free memory
        fileInfo.buffer.clear();
    }
}

/**
 * Get MIME type from file name
 * @param {string} fileName - File name
 * @returns {string|null} MIME type or null
 */
function getMimeTypeFromFileName(fileName) {
    const extension = fileName.split('.').pop()?.toLowerCase();
    if (!extension) return null;

    const mimeTypes = {
        // Images
        'jpg': 'image/jpeg',
        'jpeg': 'image/jpeg',
        'png': 'image/png',
        'gif': 'image/gif',
        'svg': 'image/svg+xml',
        'webp': 'image/webp',
        'bmp': 'image/bmp',
        'ico': 'image/x-icon',

        // Documents
        'pdf': 'application/pdf',
        'doc': 'application/msword',
        'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'xls': 'application/vnd.ms-excel',
        'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'ppt': 'application/vnd.ms-powerpoint',
        'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'txt': 'text/plain',
        'rtf': 'application/rtf',

        // Archives
        'zip': 'application/zip',
        'rar': 'application/vnd.rar',
        '7z': 'application/x-7z-compressed',
        'tar': 'application/x-tar',
        'gz': 'application/gzip',

        // Code/Text
        'html': 'text/html',
        'css': 'text/css',
        'js': 'text/javascript',
        'json': 'application/json',
        'xml': 'text/xml',
        'csv': 'text/csv',

        // Audio
        'mp3': 'audio/mpeg',
        'wav': 'audio/wav',
        'ogg': 'audio/ogg',
        'flac': 'audio/flac',
        'm4a': 'audio/mp4',

        // Video
        'mp4': 'video/mp4',
        'avi': 'video/x-msvideo',
        'mov': 'video/quicktime',
        'wmv': 'video/x-ms-wmv',
        'flv': 'video/x-flv',
        'webm': 'video/webm',
        'mkv': 'video/x-matroska'
    };

    return mimeTypes[extension] || null;
}

/**
 * Retry sending a file
 * @param {string} fileId - File ID
 */
export function retryFile(fileId) {
    const fileInfo = fileManager.getFileToSend(fileId);
    if (!fileInfo) return;

    // Reset file status
    fileManager.updateFileStatus(fileId, 'send', {
        status: 'pending',
        progress: 0,
        sentChunks: 0,
        acknowledgedChunks: 0
    });

    // Add to transfer queue
    transferQueue.push({
        fileId,
        file: fileInfo.file
    });

    // Process the queue
    processTransferQueue();
}
