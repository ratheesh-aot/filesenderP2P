/**
 * File Manager v2 for FileSender P2P
 *
 * Lightweight bookkeeping layer on top of the transfer manager:
 *  - Tracks per-file UI state (status / progress / error / verified).
 *  - Owns received blobs + object URLs, auto-download behavior, and history.
 *  - Persists user settings (auto-download, device name) in localStorage.
 */

import { formatBytes } from './utils.js';

const MAX_RECEIVED_KEPT = 10; // completed received files kept in memory this session

// --- State --------------------------------------------------------------------
/** @type {Map<string, object>} fileId -> send-side record (UI state only) */
const sentFiles = new Map();
/** @type {Map<string, object>} fileId -> receive-side record incl. blob/url */
const receivedFiles = new Map();

let callbacks = {
    onFileAdded: () => {},
    onFileStatusUpdate: () => {},
    onFileComplete: () => {},
};

// --- Settings -------------------------------------------------------------------
export function getSettings() {
    return {
        autoDownload: getSetting('fs2p-auto-download', '1') === '1',
        deviceName: localStorage.getItem('fs2p-device-name') || '',
    };
}

function getSetting(key, fallback) {
    try {
        const v = localStorage.getItem(key);
        return v !== null ? v : fallback;
    } catch {
        return fallback;
    }
}

export function setAutoDownload(enabled) {
    try { localStorage.setItem('fs2p-auto-download', enabled ? '1' : '0'); } catch { /* ignore */ }
}

export function setDeviceName(name) {
    const trimmed = (name || '').trim().slice(0, 40);
    try {
        if (trimmed) localStorage.setItem('fs2p-device-name', trimmed);
        else localStorage.removeItem('fs2p-device-name');
    } catch { /* ignore */ }
}

// --- Initialization ---------------------------------------------------------------
/**
 * Initialize file manager.
 * @param {object} options - onFileAdded(fileId, record, direction),
 *                           onFileStatusUpdate(fileId, direction, state),
 *                           onFileComplete(fileId, direction, record)
 */
export function initializeFileManager(options = {}) {
    callbacks = { ...callbacks, ...options };
    return {
        registerSendFile,
        getSendRecord: (fileId) => sentFiles.get(fileId),
        addReceivedFile,
        getReceivedRecord: (fileId) => receivedFiles.get(fileId),
        updateFileStatus,
        completeReceivedFile,
        removeFile,
        clearCompleted,
    };
}

// --- Send side ----------------------------------------------------------------------
/** Register a file that the transfer manager will send. */
export function registerSendFile(fileId, { name, size, type }) {
    sentFiles.set(fileId, {
        id: fileId,
        direction: 'send',
        name,
        size,
        type: type || 'application/octet-stream',
        status: 'queued',
        progress: 0,
        error: null,
        verified: undefined,
    });
    callbacks.onFileAdded(fileId, sentFiles.get(fileId), 'send');
}

// --- Receive side ---------------------------------------------------------------------
/** Register an incoming file announced by metadata. */
export function addReceivedFile(fileId, { name, size, type }) {
    receivedFiles.set(fileId, {
        id: fileId,
        direction: 'receive',
        name,
        size,
        type: type || 'application/octet-stream',
        status: 'receiving',
        progress: 0,
        error: null,
        verified: undefined,
        blob: null,
        url: null,
    });
    callbacks.onFileAdded(fileId, receivedFiles.get(fileId), 'receive');
}

// --- Status updates ---------------------------------------------------------------------
/**
 * Apply a status update from the transfer manager.
 * @param {string} fileId
 * @param {'send'|'receive'} direction
 * @param {{status?: string, progress?: number, error?: string|null, verified?: boolean}} updates
 */
export function updateFileStatus(fileId, direction, updates = {}) {
    const record = (direction === 'send' ? sentFiles : receivedFiles).get(fileId);
    if (!record) return;

    if (updates.status !== undefined) record.status = updates.status;
    if (updates.progress !== undefined) record.progress = updates.progress;
    if (updates.error !== undefined) record.error = updates.error || null;
    if ('verified' in updates && updates.verified !== undefined) record.verified = updates.verified;

    callbacks.onFileStatusUpdate(fileId, direction, { ...record });
}

// --- Completion ---------------------------------------------------------------------
/**
 * Called by the transfer manager when a received file is fully assembled.
 * @param {string} fileId
 * @param {Blob} blob
 */
export function completeReceivedFile(fileId, blob) {
    const record = receivedFiles.get(fileId);
    if (!record) return;

    record.blob = blob;
    record.url = URL.createObjectURL(blob);

    callbacks.onFileComplete(fileId, 'receive', { ...record });

    if (getSettings().autoDownload && record.url && record.verified !== false) {
        setTimeout(() => triggerDownload(record.url, record.name), 150);
    }

    maintainReceivedLimit();
}

function maintainReceivedLimit() {
    const completed = [...receivedFiles.values()]
        .filter(r => r.status === 'complete')
        .sort((a, b) => (a.id < b.id ? -1 : 1)); // insertion order approximates time
    while (completed.length > MAX_RECEIVED_KEPT) {
        const oldest = completed.shift();
        if (oldest.url) URL.revokeObjectURL(oldest.url);
        receivedFiles.delete(oldest.id);
    }
}

// --- Housekeeping ---------------------------------------------------------------------
export function removeFile(fileId, direction) {
    const map = direction === 'send' ? sentFiles : receivedFiles;
    const record = map.get(fileId);
    if (!record) return;
    if (record.url) URL.revokeObjectURL(record.url);
    map.delete(fileId);
}

export function clearCompleted() {
    for (const [id, r] of [...receivedFiles.entries()]) {
        if (r.status === 'complete') removeFile(id, 'receive');
    }
    for (const [id, r] of [...sentFiles.entries()]) {
        if (['complete', 'cancelled'].includes(r.status)) sentFiles.delete(id);
    }
}

// --- Download helper ---------------------------------------------------------------------
export function triggerDownload(url, fileName) {
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName || 'download';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}
