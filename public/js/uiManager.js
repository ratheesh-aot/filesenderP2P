/**
 * UI Manager v2 for FileSender P2P
 * Renders the unified activity feed, status pills, toasts, theme, and settings.
 */

import { formatBytes, getFileTypeIcon } from './utils.js';

// --- DOM refs --------------------------------------------------------------------
let els = {};
let currentFilter = 'all';

/** fileId -> live stats for speed/ETA display */
const liveStats = new Map();

const THEME_KEY = 'fs2p-theme'; // 'system' | 'light' | 'dark'

// --- Init --------------------------------------------------------------------------
export function initializeUI() {
    els.statusPill = document.getElementById('connection-status');
    els.statusText = document.getElementById('connection-status-text');
    els.shareCard = document.getElementById('share-card');
    els.hostInfo = document.getElementById('host-info');
    els.clientInfo = document.getElementById('client-info');
    els.shareLinkInput = document.getElementById('share-link');
    els.copyButton = document.getElementById('copy-button');
    els.qrContainer = document.getElementById('qrcode-container');
    els.joinPanel = document.getElementById('join-host');
    els.joinNote = document.getElementById('join-host-note');
    els.reconnectButton = document.getElementById('reconnect-host-button');
    els.hostInsteadButton = document.getElementById('host-instead-button');
    els.scanButton = document.getElementById('scan-qr-button');
    els.scannerModal = document.getElementById('scanner-modal');
    els.scannerStatus = document.getElementById('scanner-status');
    els.scannerVideo = document.getElementById('scanner-video');
    els.scannerClose = document.getElementById('scanner-close');
    els.dropZone = document.getElementById('drop-zone');
    els.fileInput = document.getElementById('file-input');
    els.activityList = document.getElementById('activity-list');
    els.emptyState = document.getElementById('empty-state');
    els.toastContainer = document.getElementById('toast-container');
    els.settingsButton = document.getElementById('settings-button');
    els.settingsDrawer = document.getElementById('settings-drawer');

    // NOTE: no forced display overrides here — v1's force-show of both panels
    // is what broke the tabs. The feed is a single list, so there is nothing to fight.

    applyTheme(getStoredTheme());
    setupFilterChips();
    return els;
}

// --- Theme ---------------------------------------------------------------------------
function getStoredTheme() {
    const v = localStorage.getItem(THEME_KEY);
    if (v === 'light' || v === 'dark') return v;
    return 'system';
}

const THEME_COLORS = { light: '#e7f3f7', dark: '#060e16' };

export function applyTheme(theme) {
    let effective = theme;
    if (theme === 'system') {
        effective = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    document.documentElement.dataset.theme = effective;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', THEME_COLORS[effective]);
}

function setupFilterChips() {
    document.querySelectorAll('.chip[data-filter]').forEach(chip => {
        chip.addEventListener('click', () => setFilter(chip.dataset.filter));
    });
}

export function setFilter(filter) {
    currentFilter = filter;
    document.querySelectorAll('.chip[data-filter]').forEach(c =>
        c.classList.toggle('active', c.dataset.filter === filter));
    for (const row of els.activityList.querySelectorAll('.file-row')) {
        const dir = row.dataset.direction;
        row.hidden = !(filter === 'all' || dir === filter);
    }
    updateEmptyState();
}

// --- Connection status ------------------------------------------------------------------
/** @param {'connecting'|'waiting'|'connected'|'error'} state */
export function setStatus(text, state) {
    els.statusText.textContent = text;
    els.statusPill.className = `status-pill ${state}`;
}

export function showShareCard() {
    if (els.shareCard) els.shareCard.classList.remove('hidden');
}

/** This device is offering the share link again. */
export function showHostShare() {
    showShareCard();
    els.hostInfo?.classList.remove('hidden');
    els.clientInfo?.classList.add('hidden');
}

export function setClientConnectedText(peerName) {
    showShareCard();
    if (els.hostInfo) els.hostInfo.classList.add('hidden');
    if (!els.clientInfo) return;
    els.clientInfo.classList.remove('hidden');
    els.clientInfo.innerHTML = `<p><i class="fas fa-check-circle"></i> Connected${peerName ? ` to <strong>${escapeHtml(peerName)}</strong>` : ''}</p>`;
}

/** Shown while this device is joining someone else's room. */
export function showClientPending(text) {
    showShareCard();
    if (els.hostInfo) els.hostInfo.classList.add('hidden');
    if (!els.clientInfo) return;
    els.clientInfo.classList.remove('hidden');
    els.clientInfo.innerHTML = `<p><i class="fas fa-link"></i> ${escapeHtml(text)}</p>`;
}

/**
 * Join-a-host card. Omit notice or reconnect to leave that part as it is.
 * @param {{ visible?: boolean, notice?: string, reconnect?: boolean }} state
 */
export function setJoinPanel({ notice, reconnect } = {}) {
    if (typeof notice === 'string' && els.joinNote) els.joinNote.textContent = notice;
    if (typeof reconnect === 'boolean') {
        els.reconnectButton?.classList.toggle('hidden', !reconnect);
        els.hostInsteadButton?.classList.toggle('hidden', !reconnect);
    }
}

/** choose | send | receive | session. CSS shows one stage at a time. */
export function setScreen(screen) {
    document.documentElement.dataset.screen = screen;
}

/** Remove one activity row after the user dismisses it. */
export function removeFileRow(fileId) {
    const row = els.activityList?.querySelector(`[data-file-id="${cssEscape(fileId)}"]`);
    if (row) row.remove();
    liveStats.delete(fileId);
    updateEmptyState();
}

// --- Activity list ---------------------------------------------------------------------
export function addFileRow(fileId, direction, { name, size }) {
    if (els.activityList.querySelector(`[data-file-id="${cssEscape(fileId)}"]`)) return null;

    const row = document.createElement('li');
    row.className = 'file-row';
    row.dataset.fileId = fileId;
    row.dataset.direction = direction;
    if (!(currentFilter === 'all' || currentFilter === direction)) row.hidden = true;

    const iconClass = getFileTypeIcon(name);
    const dirLabel = direction === 'send' ? 'Sent' : 'Received';
    row.innerHTML = `
        <div class="file-icon" aria-hidden="true"><i class="fas ${iconClass}"></i></div>
        <div class="file-main">
            <div class="file-topline">
                <div class="file-name" title="${escapeHtml(name)}">${escapeHtml(name)}</div>
                <div class="status-chip queued">Queued</div>
            </div>
            <div class="file-meta">
                <span class="dir-badge ${direction}"><i class="fas fa-${direction === 'send' ? 'paper-plane' : 'download'}"></i>${dirLabel}</span>
                <span class="file-size">${formatBytes(size || 0)}</span>
                <span class="speed-text"></span>
            </div>
            <div class="progress-container hidden">
                <div class="progress-bar" style="width: 0%"></div>
            </div>
        </div>
        <div class="row-actions"></div>`;

    els.activityList.appendChild(row);
    updateEmptyState();
    return row;
}

/**
 * Update a file row from its record + live stats.
 * @param {string} fileId
 * @param {'send'|'receive'} direction
 * @param {{status: string, progress?: number, error?: string|null, verified?: boolean, name?: string}} state
 */
export function updateFileRow(fileId, direction, state) {
    const row = els.activityList.querySelector(`[data-file-id="${cssEscape(fileId)}"]`);
    if (!row) return;

    const chip = row.querySelector('.status-chip');
    const speedEl = row.querySelector('.speed-text');
    const progressWrap = row.querySelector('.progress-container');
    const bar = row.querySelector('.progress-bar');
    const actions = row.querySelector('.row-actions');

    // Status chip
    const { label, cls } = describeStatus(direction, state);
    chip.textContent = label;
    chip.className = `status-chip ${cls}`;

    // Progress bar
    if (['sending', 'hashing', 'receiving'].includes(state.status) && typeof state.progress === 'number') {
        progressWrap.classList.remove('hidden');
        bar.style.width = `${state.progress}%`;
    } else {
        progressWrap.classList.add('hidden');
    }

    // Speed / ETA
    const stats = liveStats.get(fileId);
    if (stats && stats.speedBps > 0 && ['sending', 'receiving'].includes(state.status)) {
        speedEl.textContent = formatSpeed(stats.speedBps) + (stats.etaSec != null ? ` · ETA ${formatEta(stats.etaSec)}` : '');
    } else if (state.error) {
        speedEl.textContent = friendlyError(state.error);
    } else {
        speedEl.textContent = '';
    }

    renderActions(row, direction, state);
}

function describeStatus(direction, s) {
    switch (s.status) {
        case 'queued': return { label: 'Queued', cls: 'queued' };
        case 'hashing': return { label: `Preparing ${s.progress ?? 0}%`, cls: 'working' };
        case 'sending': return { label: `Sending ${s.progress ?? 0}%`, cls: 'active' };
        case 'receiving': return { label: `Receiving ${s.progress ?? 0}%`, cls: 'active' };
        case 'paused': return { label: 'Paused', cls: 'paused' };
        case 'complete':
            if (direction === 'receive') {
                return s.verified === false ? { label: 'Check failed', cls: 'error' } : { label: 'Done', cls: 'done' };
            }
            return { label: 'Done', cls: 'done' };
        case 'cancelled': return { label: 'Cancelled', cls: 'muted' };
        case 'error': return { label: 'Failed', cls: 'error' };
        default: return { label: s.status, cls: 'queued' };
    }
}

function friendlyError(error) {
    switch (error) {
        case 'no connection': return 'Connection lost — reconnecting';
        case 'send failed': return 'Send failed — retry when ready';
        case 'read failed': return "Couldn't read the file";
        case 'checksum mismatch': return 'Data corrupted in transit';
        case 'integrity check failed': return 'Checksum mismatch — download blocked';
        case 'assembly failed': return 'Failed to assemble file';
        default: return error ? String(error) : '';
    }
}

function renderActions(row, direction, state) {
    const actions = row.querySelector('.row-actions');
    actions.innerHTML = '';
    if (!actions.dataset.fileId) actions.dataset.fileId = row.dataset.fileId;
    const fileId = row.dataset.fileId;

    const btn = (icon, title, cls) => {
        const b = document.createElement('button');
        b.className = `row-btn ${cls}`;
        b.title = title;
        b.setAttribute('aria-label', title);
        b.innerHTML = `<i class="fas fa-${icon}"></i>`;
        return b;
    };

    if (direction === 'send') {
        if (state.status === 'sending' || state.status === 'hashing') {
            const p = btn('pause', 'Pause transfer', ''); p.onclick = () => emitAction(fileId, 'pause'); actions.appendChild(p);
            const c = btn('xmark', 'Cancel transfer', 'danger'); c.onclick = () => emitAction(fileId, 'cancel'); actions.appendChild(c);
        } else if (state.status === 'paused') {
            const r = btn('play', 'Resume transfer', ''); r.onclick = () => emitAction(fileId, 'resume'); actions.appendChild(r);
            const c = btn('xmark', 'Cancel transfer', 'danger'); c.onclick = () => emitAction(fileId, 'cancel'); actions.appendChild(c);
        } else if (state.status === 'queued') {
            const p = btn('pause', 'Hold in queue', ''); p.onclick = () => emitAction(fileId, 'pause'); actions.appendChild(p);
            const c = btn('xmark', 'Remove from queue', 'danger'); c.onclick = () => emitAction(fileId, 'cancel'); actions.appendChild(c);
        } else if (['error'].includes(state.status)) {
            const r = btn('rotate-right', 'Retry transfer', ''); r.onclick = () => emitAction(fileId, 'retry'); actions.appendChild(r);
            const c = btn('xmark', 'Remove', 'danger'); c.onclick = () => emitAction(fileId, 'cancel'); actions.appendChild(c);
        } else if (state.status === 'complete') {
            const r = btn('rotate-right', 'Send again', ''); r.onclick = () => emitAction(fileId, 'resend'); actions.appendChild(r);
            const x = btn('xmark', 'Remove from list', 'muted-btn'); x.onclick = () => emitAction(fileId, 'remove'); actions.appendChild(x);
        } else if (state.status === 'cancelled') {
            const r = btn('rotate-right', 'Retry transfer', ''); r.onclick = () => emitAction(fileId, 'retry'); actions.appendChild(r);
            const x = btn('xmark', 'Remove from list', 'muted-btn'); x.onclick = () => emitAction(fileId, 'remove'); actions.appendChild(x);
        }
    } else {
        // receive direction
        if (['receiving'].includes(state.status)) {
            const c = btn('xmark', 'Decline transfer', 'danger'); c.onclick = () => emitAction(fileId, 'decline'); actions.appendChild(c);
        } else if (state.status === 'complete' && state.verified !== false) {
            const d = btn('download', 'Download file', ''); d.onclick = () => emitAction(fileId, 'download'); actions.appendChild(d);
            const x = btn('xmark', 'Remove from list', 'muted-btn'); x.onclick = () => emitAction(fileId, 'remove'); actions.appendChild(x);
        } else if (state.status === 'error') {
            const x = btn('xmark', 'Remove', 'danger'); x.onclick = () => emitAction(fileId, 'remove'); actions.appendChild(x);
        }
    }
}

function emitAction(fileId, action) {
    document.dispatchEvent(new CustomEvent('file-action', { detail: { fileId, action } }));
}

// --- Stats display ------------------------------------------------------------------------
/** (fileId, direction, {speedBps, etaSec}) */
export function updateStats(fileId, stats) {
    liveStats.set(fileId, stats);
    const row = els.activityList.querySelector(`[data-file-id="${cssEscape(fileId)}"]`);
    if (!row) return;
    // Refresh speed text without rebuilding actions.
    const stateChip = row.querySelector('.status-chip');
    const speedEl = row.querySelector('.speed-text');
    if (stats.speedBps > 0 && /Sending|Receiving/.test(stateChip.textContent)) {
        speedEl.textContent = formatSpeed(stats.speedBps) + (stats.etaSec != null ? ` · ETA ${formatEta(stats.etaSec)}` : '');
    }
}

// --- Toasts -------------------------------------------------------------------------------
/**
 * @param {string} message
 * @param {'info'|'success'|'error'} [kind]
 */
export function showToast(message, kind = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${kind}`;
    const icons = { info: 'fa-circle-info', success: 'fa-check-circle', error: 'fa-triangle-exclamation' };
    toast.innerHTML = `<i class="fas ${icons[kind] || icons.info}"></i><span>${escapeHtml(message)}</span>`;
    els.toastContainer.appendChild(toast);
    setTimeout(() => toast.classList.add('visible'), 20);
    setTimeout(() => {
        toast.classList.remove('visible');
        setTimeout(() => toast.remove(), 300);
    }, 4200);
}

// --- QR code ---------------------------------------------------------------------------------
export function generateQRCode(url) {
    if (!els.qrContainer || typeof window.QRCode === 'undefined') return;
    els.qrContainer.innerHTML = '';
    new window.QRCode(els.qrContainer, {
        text: url,
        width: 148,
        height: 148,
        colorDark: '#1e293b',
        colorLight: '#ffffff',
        correctLevel: window.QRCode.CorrectLevel.M,
    });
}

// --- Settings drawer ---------------------------------------------------------------------------
export function initSettingsDrawer({ onDeviceName, onAutoDownload, onTheme }) {
    const input = document.getElementById('device-name-input');
    const autoToggle = document.getElementById('auto-download-toggle');
    const themeSelect = document.getElementById('theme-select');

    els.settingsButton.addEventListener('click', () => openSettings());

    // Close handlers
    els.settingsDrawer.querySelectorAll('[data-close-settings]').forEach(el =>
        el.addEventListener('click', closeSettings));
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (isScannerOpen()) {
            scannerCloseHandler();
            return;
        }
        closeSettings();
    });

    input.value = localStorage.getItem('fs2p-device-name') || '';
    autoToggle.checked = getAutoDownloadDefault();
    themeSelect.value = getStoredTheme();

    input.addEventListener('change', () => onDeviceName?.(input.value));
    autoToggle.addEventListener('change', () => onAutoDownload?.(autoToggle.checked));
    themeSelect.addEventListener('change', () => {
        localStorage.setItem(THEME_KEY, themeSelect.value);
        applyTheme(themeSelect.value);
        onTheme?.(themeSelect.value);
    });

    function getAutoDownloadDefault() {
        try { return (localStorage.getItem('fs2p-auto-download') ?? '1') === '1'; } catch { return true; }
    }
}

export function openSettings() { els.settingsDrawer.classList.remove('hidden'); }
export function closeSettings() { els.settingsDrawer.classList.add('hidden'); }

// --- QR scanner chrome -----------------------------------------------------------------
let scannerCloseHandler = () => closeScannerModal();

export function initScanner({ onOpen, onClose }) {
    scannerCloseHandler = onClose;
    els.scanButton?.addEventListener('click', onOpen);
    els.scannerModal?.querySelectorAll('[data-close-scanner]').forEach((el) => {
        el.addEventListener('click', onClose);
    });
}

export function openScannerModal() {
    els.scannerModal?.classList.remove('hidden');
    els.scannerClose?.focus();
}

export function closeScannerModal() {
    els.scannerModal?.classList.add('hidden');
}

export function isScannerOpen() {
    return !!els.scannerModal && !els.scannerModal.classList.contains('hidden');
}

export function setScannerStatus(text) {
    if (els.scannerStatus) els.scannerStatus.textContent = text;
}

export function getScannerVideo() {
    return els.scannerVideo;
}

// --- Helpers -------------------------------------------------------------------------------------
function updateEmptyState() {
    const rows = [...els.activityList.querySelectorAll('.file-row')];
    const visible = rows.filter(r => !r.hidden).length;
    els.emptyState.classList.toggle('is-hidden', visible > 0);
    const note = els.emptyState.querySelector('p');
    if (note) {
        note.textContent = rows.length === 0
            ? 'No transfers yet. Add files above to get started.'
            : 'Nothing in this view.';
    }
}

function formatSpeed(bps) {
    return `${formatBytes(bps, 1)}/s`;
}

function formatEta(sec) {
    if (!isFinite(sec) || sec <= 0) return '—';
    if (sec < 60) return `${Math.ceil(sec)}s`;
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    if (m < 60) return `${m}m ${s.toString().padStart(2, '0')}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${(m % 60).toString().padStart(2, '0')}`;
}

function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

function cssEscape(id) {
    return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}
