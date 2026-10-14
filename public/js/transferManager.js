/**
 * Transfer Manager v2 for FileSender P2P
 *
 * Protocol:
 *  - Control messages travel as JSON strings over the data channel.
 *  - File chunks travel as raw binary frames (no base64 overhead):
 *      [u8 magic "FS2P"][u32 fileIndex LE][u32 chunkIndex LE][u8 flags]
 *      [u8[32] SHA-256 of payload][payload bytes...]
 *  - Chunks stay under 64 KB so they fit Chrome's default SCTP max-message-size.
 *  - Sender hashes each chunk (SHA-256) just before sending it, so transfers
 *    start immediately. The Merkle root over all chunk hashes travels in the
 *    final file-complete message. Receiver verifies each chunk hash on arrival
 *    and the full Merkle root at completion -> "verified" badge.
 */

import { sendMessage, sendBinary } from './connectionManager.js';

// --- Tunables -------------------------------------------------------------
const CHUNK_SIZE = 60 * 1024;           // stay under the 64 KB SCTP message limit
const MAGIC = [0x46, 0x53, 0x32, 0x50]; // "FS2P"
const HEADER_LEN = 4 + 4 + 4 + 1;       // magic + fileIndex + chunkIndex + flags
const HASH_LEN = 32;                    // SHA-256
const STATS_WINDOW_MS = 6000;           // rolling window for speed calculation
const STATS_TICK_MS = 500;              // how often stats are recomputed

// --- State ------------------------------------------------------------------
let fileManager = null;
let connectionManager = null;
let callbacks = {
    onStats: () => {},
    /** (fileId, {name,size,type}) when a send-side file is queued */
    onFileQueued: () => {},
    /** (fileId, meta) when an incoming file is announced by metadata */
    onIncoming: () => {},
};

/** @type {Map<string, object>} fileId -> send-side state */
const filesToSend = new Map();
/** @type {Map<string, object>} fileId -> receive-side state */
const receivedFiles = new Map();
/** fileIndex (wire id) -> fileId for incoming files */
const indexToReceivedId = new Map();

let transferQueue = [];                 // ordered list of fileIds waiting to send
let activeFileId = null;                // the file currently being sent
let nextFileIndex = 0;                  // sender-side wire ids, sequential per session
let chunksInFlight = 0;
let windowSize = 8;                     // adaptive in-flight chunk window
const pendingChunks = new Map();        // `${fileId}:${idx}` -> {sentAt}

// Rolling throughput samples: fileId+direction -> [{t, bytes}]
const statsSamples = new Map();
let statsTimer = null;

// --- Crypto helpers ---------------------------------------------------------
async function sha256(buffer) {
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return new Uint8Array(digest);
}

function concatBytes(a, b) {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
}

/** Build a Merkle root from an array of 32-byte leaf hashes. */
async function merkleRoot(leafHashes) {
    if (leafHashes.length === 0) return new Uint8Array(HASH_LEN);
    let level = leafHashes;
    while (level.length > 1) {
        const next = [];
        for (let i = 0; i < level.length; i += 2) {
            const left = level[i];
            const right = i + 1 < level.length ? level[i + 1] : level[i]; // duplicate last when odd
            next.push(await sha256(concatBytes(left, right)));
        }
        level = next;
    }
    return level[0];
}

// --- Binary frame helpers ----------------------------------------------------
function buildFrame(fileIndex, chunkIndex, hash, payload) {
    const frame = new ArrayBuffer(HEADER_LEN + HASH_LEN + payload.byteLength);
    const view = new DataView(frame);
    for (let i = 0; i < MAGIC.length; i++) view.setUint8(i, MAGIC[i]);
    view.setUint32(4, fileIndex, true);
    view.setUint32(8, chunkIndex, true);
    view.setUint8(12, 0); // flags (reserved)
    new Uint8Array(frame, HEADER_LEN, HASH_LEN).set(hash);
    new Uint8Array(frame, HEADER_LEN + HASH_LEN).set(new Uint8Array(payload));
    return frame;
}

/** Parse a binary frame. Returns {fileIndex, chunkIndex, hash, payload} or null. */
function parseFrame(data) {
    let u8;
    if (data instanceof ArrayBuffer) {
        u8 = new Uint8Array(data);
    } else if (data instanceof Uint8Array) {
        u8 = data;
    } else if (typeof Blob !== 'undefined' && data instanceof Blob) {
        return null; // handled by caller via arrayBuffer()
    } else {
        return null;
    }

    if (u8.byteLength < HEADER_LEN + HASH_LEN) return null;
    for (let i = 0; i < MAGIC.length; i++) {
        if (u8[i] !== MAGIC[i]) return null; // not one of our frames
    }
    const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const fileIndex = view.getUint32(4, true);
    const chunkIndex = view.getUint32(8, true);
    const hash = u8.slice(HEADER_LEN, HEADER_LEN + HASH_LEN);
    const payload = u8.slice(HEADER_LEN + HASH_LEN); // copy for safe storage
    return { fileIndex, chunkIndex, hash, payload };
}

// --- Stats -------------------------------------------------------------------
function sampleBytes(fileId, direction, bytes) {
    const key = `${direction}:${fileId}`;
    let samples = statsSamples.get(key);
    if (!samples) {
        samples = [];
        statsSamples.set(key, samples);
    }
    samples.push({ t: Date.now(), bytes });
}

function computeStats(fileId, direction) {
    const key = `${direction}:${fileId}`;
    const now = Date.now();
    let samples = (statsSamples.get(key) || []).filter(s => now - s.t <= STATS_WINDOW_MS);
    statsSamples.set(key, samples);
    if (samples.length === 0) return { speedBps: 0, etaSec: null };

    const totalBytes = samples.reduce((sum, s) => sum + s.bytes, 0);
    const spanMs = Math.max(now - samples[0].t, 250); // avoid divide-by-zero spikes
    const speedBps = (totalBytes / spanMs) * 1000;

    let remaining = 0;
    if (direction === 'send') {
        const f = filesToSend.get(fileId);
        remaining = f ? Math.max(0, f.size - f.ackedChunks * CHUNK_SIZE) : 0;
    } else {
        const f = receivedFiles.get(fileId);
        remaining = f ? Math.max(0, f.size - f.receivedChunks * CHUNK_SIZE) : 0;
    }
    const etaSec = speedBps > 0 && remaining > 0 ? remaining / speedBps : null;
    return { speedBps, etaSec };
}

function startStatsTicker() {
    if (statsTimer) return;
    statsTimer = setInterval(() => {
        for (const [fileId, f] of filesToSend.entries()) {
            if (f.status === 'sending' || f.status === 'hashing') {
                callbacks.onStats(fileId, 'send', computeStats(fileId, 'send'));
            }
        }
        for (const [fileId, f] of receivedFiles.entries()) {
            if (f.status === 'receiving') {
                callbacks.onStats(fileId, 'receive', computeStats(fileId, 'receive'));
            }
        }
    }, STATS_TICK_MS);
}

// --- Initialization -----------------------------------------------------------
/**
 * Initialize transfer manager.
 * @param {object} options
 * @param {object} options.fileManager - File manager instance (for status bookkeeping)
 * @param {object} options.connectionManager - Connection manager API
 * @param {function} [options.onStats] - (fileId, direction, {speedBps, etaSec})
 */
export function initializeTransferManager(options = {}) {
    fileManager = options.fileManager;
    connectionManager = options.connectionManager;
    callbacks = { ...callbacks, ...options };
    startStatsTicker();

    return {
        handleFiles,
        processTransferQueue,
        handleMessage,
        handleBinaryFrame,
        pauseFile,
        resumeFile,
        cancelFile,
        retryFile,
        getSendState: (fileId) => filesToSend.get(fileId),
        getReceiveState: (fileId) => receivedFiles.get(fileId),
    };
}

// --- Sender side ---------------------------------------------------------------
/**
 * Handle files selected for sending.
 * @param {FileList|File[]} fileList
 */
export function handleFiles(fileList) {
    if (!fileList || fileList.length === 0) return;

    for (const file of Array.from(fileList)) {
        const fileId = `f-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        const chunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));
        filesToSend.set(fileId, {
            fileId,
            fileIndex: nextFileIndex++,
            file,
            name: file.name,
            size: file.size,
            type: file.type || 'application/octet-stream',
            chunks,
            status: 'queued',
            progress: 0,
            sentChunks: 0,
            ackedChunks: 0,
            hashes: new Array(chunks), // filled as chunks are sent
            rootHash: null,
            error: null,
            metadataSent: false,
        });
        transferQueue.push(fileId);
        if (fileManager && fileManager.registerSendFile) {
            fileManager.registerSendFile(fileId, {
                name: file.name,
                size: file.size,
                type: file.type || 'application/octet-stream',
            });
        }
        callbacks.onFileQueued?.(fileId, { name: file.name, size: file.size, type: file.type || 'application/octet-stream' });
        notifyStatus(fileId, 'send');
    }

    processTransferQueue();
}

function isConnected() {
    return !!(connectionManager && connectionManager.isConnected());
}

/** Start the next queued file if we have a connection and no active file. */
export function processTransferQueue() {
    if (activeFileId || transferQueue.length === 0) return;
    if (!isConnected()) return; // will be pumped again on connect

    const fileId = transferQueue.find(id => filesToSend.get(id)?.status === 'queued');
    if (!fileId) return;
    const f = filesToSend.get(fileId);
    if (!f) { transferQueue = transferQueue.filter(id => id !== fileId); return processTransferQueue(); }

    activeFileId = fileId;
    startSending(f).catch(err => {
        console.error('Send failed:', err);
        f.status = 'error';
        f.error = err.message || String(err);
        notifyStatus(fileId, 'send');
        finishActiveFile(fileId);
    });
}

function stopped(f) {
    return !f || f.status === 'cancelled' || f.status === 'paused';
}

/** Announce the file and start streaming chunks (each is hashed as it is sent). */
async function startSending(f) {
    if (stopped(f)) return;

    f.status = 'sending';
    f.progress = f.chunks ? Math.floor((f.ackedChunks / f.chunks) * 100) : 0;
    notifyStatus(f.fileId, 'send');

    if (!f.metadataSent) {
        const sent = sendMessage({
            type: 'file-metadata',
            fileId: f.fileId,
            fileIndex: f.fileIndex,
            name: f.name,
            size: f.size,
            fileType: f.type,
            chunks: f.chunks,
        });
        if (!sent) throw new Error('no connection');
        f.metadataSent = true;
    }

    pumpChunks(f);
}

/** Send as many chunks as the window allows. */
function pumpChunks(f) {
    if (f.status !== 'sending') return;
    while (chunksInFlight < windowSize && f.sentChunks < f.chunks) {
        const chunkIndex = f.sentChunks;
        const offset = chunkIndex * CHUNK_SIZE;
        const end = Math.min(offset + CHUNK_SIZE, f.size);

        sendChunkAsync(f, chunkIndex, end - offset).catch(err => {
            console.error('Chunk read failed:', err);
            chunksInFlight--;
            pendingChunks.delete(`${f.fileId}:${chunkIndex}`);
            if (f.status !== 'cancelled') {
                f.status = 'error';
                f.error = 'read failed';
                notifyStatus(f.fileId, 'send');
            }
        });

        pendingChunks.set(`${f.fileId}:${chunkIndex}`, { sentAt: Date.now() });
        chunksInFlight++;
        f.sentChunks++;
    }
}

async function sendChunkAsync(f, chunkIndex, length) {
    const slice = await f.file.slice(chunkIndex * CHUNK_SIZE, chunkIndex * CHUNK_SIZE + length).arrayBuffer();
    if (!isConnected()) throw new Error('no connection');

    const hash = await sha256(slice);
    f.hashes[chunkIndex] = hash;
    if (!isConnected()) throw new Error('no connection');

    const frame = buildFrame(f.fileIndex, chunkIndex, hash, slice);
    const sent = sendBinary(frame);
    if (!sent) throw new Error('send failed');
}

function handleChunkAck(message) {
    const { fileId, chunkIndex } = message;
    const key = `${fileId}:${chunkIndex}`;
    if (!pendingChunks.has(key)) return; // duplicate/stale ack
    pendingChunks.delete(key);
    chunksInFlight--;

    const f = filesToSend.get(fileId);
    if (!f) return;

    f.ackedChunks++;
    sampleBytes(fileId, 'send', CHUNK_SIZE);
    adaptWindow();

    if (f.ackedChunks >= f.chunks) {
        completeSend(f);
    } else {
        f.progress = Math.floor((f.ackedChunks / f.chunks) * 100);
        notifyStatus(fileId, 'send');
        pumpChunks(f);
    }
}

/** All chunks acked: send the Merkle root so the receiver can verify the whole file. */
async function completeSend(f) {
    try {
        f.rootHash = await merkleRoot(f.hashes);
        sendMessage({ type: 'file-complete', fileId: f.fileId, rootHash: Array.from(f.rootHash) });
        f.status = 'complete';
        f.progress = 100;
    } catch (err) {
        console.error('Completing send failed:', err);
        f.status = 'error';
        f.error = 'could not finalize';
    }
    notifyStatus(f.fileId, 'send');
    finishActiveFile(f.fileId);
}

/** Grow/shrink the in-flight window based on how fast ACKs are coming back. */
function adaptWindow() {
    if (pendingChunks.size === 0 && chunksInFlight < windowSize) {
        // Batch fully drained quickly -> we can push more.
        windowSize = Math.min(32, windowSize + 4);
    } else if (chunksInFlight >= windowSize && pendingChunks.size > windowSize / 2) {
        windowSize = Math.max(4, windowSize - 2);
    }
}

function finishActiveFile(fileId) {
    if (activeFileId === fileId) activeFileId = null;
    transferQueue = transferQueue.filter(id => id !== fileId);
    processTransferQueue();
}

// --- Receiver side ---------------------------------------------------------------
export function handleMessage(message) {
    if (!message || !message.type) return;

    switch (message.type) {
        case 'file-metadata':
            handleMetadata(message);
            break;
        case 'chunk-ack':
            handleChunkAck(message);
            break;
        case 'file-complete': {
            const rf = receivedFiles.get(message.fileId);
            if (rf && Array.isArray(message.rootHash)) rf.rootHash = new Uint8Array(message.rootHash);
            assembleAndSaveFile(message.fileId).catch(err => {
                console.error('Assembly failed:', err);
                const f = receivedFiles.get(message.fileId);
                if (f) {
                    f.status = 'error';
                    f.error = 'assembly failed';
                    notifyStatus(f.fileId, 'receive');
                }
            });
            break;
        }
        case 'file-cancelled':
            handleCancelled(message.fileId);
            break;
    }
}

function handleMetadata(meta) {
    const fileId = meta.fileId;
    if (receivedFiles.has(fileId)) return; // duplicate metadata

    receivedFiles.set(fileId, {
        fileId,
        fileIndex: meta.fileIndex,
        name: meta.name,
        size: meta.size,
        type: meta.fileType || 'application/octet-stream',
        chunks: meta.chunks,
        rootHash: null,         // arrives with file-complete
        status: 'receiving',
        progress: 0,
        receivedChunks: 0,
        buffer: new Map(),      // chunkIndex -> Uint8Array payload
        leafHashes: new Array(meta.chunks).fill(null),
        verified: null,         // true/false once complete
        error: null,
    });
    indexToReceivedId.set(meta.fileIndex, fileId);
    if (fileManager && fileManager.addReceivedFile) {
        fileManager.addReceivedFile(fileId, {
            name: meta.name,
            size: meta.size,
            type: meta.fileType || 'application/octet-stream',
        });
    }
    callbacks.onIncoming?.(fileId, meta);
    notifyStatus(fileId, 'receive');
}

/** Handle an incoming binary chunk frame. */
export async function handleBinaryFrame(data) {
    let u8 = data;
    if (data instanceof Blob) {
        try { u8 = new Uint8Array(await data.arrayBuffer()); } catch { return; }
    }
    const frame = parseFrame(u8);
    if (!frame) return;

    const fileId = indexToReceivedId.get(frame.fileIndex);
    const f = fileId ? receivedFiles.get(fileId) : null;
    if (!f || f.status !== 'receiving') return; // unknown or already finished/cancelled
    if (f.buffer.has(frame.chunkIndex)) return;

    let hashOk = false;
    try {
        hashOk = await verifyChunkHash(frame.hash, frame.payload);
    } catch (err) {
        console.warn('Chunk hash verification failed:', err);
    }
    if (!hashOk) {
        f.status = 'error';
        f.error = 'checksum mismatch';
        notifyStatus(f.fileId, 'receive');
        sendMessage({ type: 'chunk-ack', fileId, chunkIndex: frame.chunkIndex });
        return;
    }

    f.buffer.set(frame.chunkIndex, frame.payload);
    f.leafHashes[frame.chunkIndex] = frame.hash;
    f.receivedChunks++;
    sampleBytes(fileId, 'receive', frame.payload.byteLength);
    f.progress = Math.floor((f.receivedChunks / f.chunks) * 100);

    sendMessage({ type: 'chunk-ack', fileId, chunkIndex: frame.chunkIndex });
    notifyStatus(fileId, 'receive');
}

async function verifyChunkHash(expected, payload) {
    const actual = await sha256(payload);
    return bytesEqual(actual, expected);
}

function bytesEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

async function assembleAndSaveFile(fileId) {
    const f = receivedFiles.get(fileId);
    if (!f || f.status === 'complete' || f.status === 'cancelled') return;
    if (f.status === 'error') return; // already failed integrity check

    for (let i = 0; i < f.chunks; i++) {
        if (!f.buffer.has(i)) {
            f.status = 'error';
            f.error = `missing chunks (${f.receivedChunks}/${f.chunks})`;
            notifyStatus(fileId, 'receive');
            return;
        }
    }

    const parts = [];
    for (let i = 0; i < f.chunks; i++) parts.push(f.buffer.get(i));
    const blob = new Blob(parts, { type: f.type });
    f.buffer.clear(); // free chunk memory early

    if (blob.size !== f.size) {
        console.warn(`Blob size mismatch for ${fileId}: expected ${f.size}, got ${blob.size}`);
    }

    // Verify Merkle root over the leaf hashes we collected.
    try {
        const leaves = [];
        for (let i = 0; i < f.chunks; i++) {
            if (!f.leafHashes[i]) throw new Error('missing leaf hash');
            leaves.push(f.leafHashes[i]);
        }
        const root = await merkleRoot(leaves);
        f.verified = !!f.rootHash && bytesEqual(root, f.rootHash);
    } catch (err) {
        f.verified = false;
    }

    f.status = 'complete';
    f.progress = 100;
    if (!f.verified) f.error = 'integrity check failed';
    notifyStatus(fileId, 'receive');

    // Hand the blob to the file manager for download handling.
    if (fileManager && fileManager.completeReceivedFile) {
        fileManager.completeReceivedFile(fileId, blob);
    }
}

function handleCancelled(fileId) {
    const f = receivedFiles.get(fileId);
    if (!f) return;
    f.status = 'cancelled';
    f.error = null;
    f.buffer.clear();
    notifyStatus(fileId, 'receive');
}

// --- Controls -------------------------------------------------------------------
export function pauseFile(fileId) {
    const f = filesToSend.get(fileId);
    if (!f || !['sending', 'hashing', 'queued'].includes(f.status)) return;
    f.status = 'paused';
    notifyStatus(fileId, 'send');
}

export function resumeFile(fileId) {
    const f = filesToSend.get(fileId);
    if (!f || f.status !== 'paused') return;
    if (!isConnected()) return; // stays paused until connection returns
    f.status = 'queued';
    notifyStatus(fileId, 'send');
    if (activeFileId === fileId) activeFileId = null;
    processTransferQueue();
}

export function cancelFile(fileId) {
    const f = filesToSend.get(fileId);
    if (!f || ['complete', 'cancelled'].includes(f.status)) return;

    // Drop in-flight tracking for this file.
    for (const key of [...pendingChunks.keys()]) {
        if (key.startsWith(`${fileId}:`)) {
            pendingChunks.delete(key);
            chunksInFlight--;
        }
    }

    f.status = 'cancelled';
    notifyStatus(fileId, 'send');

    sendMessage({ type: 'file-cancelled', fileId });

    transferQueue = transferQueue.filter(id => id !== fileId);
    finishActiveFile(fileId);
}

/** Start a fresh send of a file that failed, was cancelled, or already completed. */
export function retryFile(fileId) {
    const f = filesToSend.get(fileId);
    if (!f || !['error', 'cancelled', 'complete'].includes(f.status)) return;
    if (!f.file) return;
    handleFiles([f.file]);
}

// --- Status bridge to file manager -------------------------------------------------
function notifyStatus(fileId, direction) {
    if (!fileManager || !fileManager.updateFileStatus) return;
    const f = direction === 'send' ? filesToSend.get(fileId) : receivedFiles.get(fileId);
    if (!f) return;
    fileManager.updateFileStatus(fileId, direction, {
        status: f.status,
        progress: f.progress,
        error: f.error || null,
        verified: 'verified' in f ? f.verified : undefined,
    });
}
