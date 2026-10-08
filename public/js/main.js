/**
 * Main entry point for FileSender P2P v2
 * Wires the UI, signaling, and transfer pipeline together.
 */

import { initializeUI, setStatus, showShareCard, setClientConnectedText, addFileRow, updateFileRow, updateStats, showToast, initSettingsDrawer, generateQRCode, removeFileRow } from './uiManager.js';
import { initializeConnectionManager } from './connectionManager.js';
import { initializeFileManager, getSettings, setAutoDownload, setDeviceName } from './fileManager.js';
import { initializeTransferManager } from './transferManager.js';
import { formatBytes } from './utils.js';

document.addEventListener('DOMContentLoaded', () => {
    console.log('[FileSender P2P v2] Starting initialization…');

    const ui = initializeUI();
    const { deviceName } = getSettings();
    if (deviceName) setDeviceName(deviceName);

    const fileManager = initializeFileManager({
        onFileAdded: (fileId, record, direction) => {
            addFileRow(fileId, direction, record);
        },
        onFileStatusUpdate: (fileId, direction, state) => {
            updateFileRow(fileId, direction, state);
        },
    });

    let transferManager = null;
    let announcedLink = false;
    const isClient = () => new URLSearchParams(window.location.search).has('host');

    const connectionManager = initializeConnectionManager({
        onStatusUpdate: (message, connected) => {
            const state = connected
                ? 'connected'
                : /connect|wait|establish|retry|rejoin|lost/i.test(message)
                    ? 'connecting'
                    : 'error';
            setStatus(message, state);
            if (!isClient()) showShareCard();
        },
        onConnected: () => {
            transferManager?.processTransferQueue();
        },
        onDisconnected: (reason) => {
            showToast(`Connection lost (${reason})`, 'info');
        },
        onPeerName: (name) => {
            if (isClient()) setClientConnectedText(name);
            showToast(`Connected to ${name}`, 'success');
        },
        onDataReceived: (raw) => {
            let message;
            try { message = JSON.parse(raw); } catch { return; }
            transferManager?.handleMessage(message);
        },
        onBinaryData: (data) => {
            transferManager?.handleBinaryFrame(data);
        },
        onShareLinkGenerated: (shareUrl) => {
            if (ui.shareLinkInput) ui.shareLinkInput.value = shareUrl;
            showShareCard();
            generateQRCode(shareUrl);
            if (!announcedLink) {
                announcedLink = true;
                showToast('Share link is ready', 'success');
            }
        },
    });

    transferManager = initializeTransferManager({
        fileManager,
        connectionManager,
        onStats: (fileId, _direction, stats) => {
            updateStats(fileId, stats);
        },
        onIncoming: (_fileId, meta) => {
            showToast(`Incoming file: ${meta.name} (${formatBytes(meta.size)})`, 'info');
        },
    });

    window.fs2p_refs = { connectionManager, transferManager, fileManager };

    setupUIEvents(ui, connectionManager, transferManager, fileManager);
    initSettingsDrawer({
        onDeviceName: setDeviceName,
        onAutoDownload: setAutoDownload,
    });

    if ('serviceWorker' in navigator) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('/sw.js').catch((err) => {
                console.log('[PWA] Service worker not registered:', err.message);
            });
        });
    }
});

function setupUIEvents(ui, connectionManager, transferManager, fileManager) {
    if (!ui || !ui.copyButton || !ui.shareLinkInput || !ui.dropZone) return;

    ui.copyButton.addEventListener('click', () => {
        const value = ui.shareLinkInput.value;
        if (!value) return;
        navigator.clipboard.writeText(value).then(() => {
            showToast('Link copied to clipboard', 'success');
            const original = ui.copyButton.innerHTML;
            ui.copyButton.innerHTML = '<i class="fas fa-check"></i>';
            setTimeout(() => { ui.copyButton.innerHTML = original; }, 2000);
        }).catch(() => {
            showToast('Failed to copy link', 'error');
        });
    });

    const openPicker = () => {
        if (ui.fileInput) ui.fileInput.click();
    };

    ui.dropZone.addEventListener('click', openPicker);
    ui.dropZone.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openPicker();
        }
    });

    const processFileList = (fileList) => {
        if (!fileList || fileList.length === 0) return;
        if (!connectionManager.isConnected()) {
            showToast('File queued — it will send when a peer connects', 'info');
        }
        transferManager.handleFiles(fileList);
    };

    ui.dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        ui.dropZone.classList.add('dragover');
    });
    ui.dropZone.addEventListener('dragleave', () => {
        ui.dropZone.classList.remove('dragover');
    });
    ui.dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        ui.dropZone.classList.remove('dragover');
        processFileList(e.dataTransfer.files);
    });

    if (ui.fileInput) {
        ui.fileInput.addEventListener('change', (e) => {
            processFileList(e.target.files);
            e.target.value = '';
        });
    }

    document.addEventListener('file-action', (e) => {
        const { fileId, action } = e.detail || {};
        if (!fileId || !action) return;
        switch (action) {
            case 'pause':
                transferManager.pauseFile(fileId);
                showToast('Transfer paused', 'info');
                break;
            case 'resume':
                transferManager.resumeFile(fileId);
                showToast('Transfer resumed', 'success');
                break;
            case 'cancel':
                transferManager.cancelFile(fileId);
                showToast('Transfer cancelled', 'info');
                break;
            case 'retry':
            case 'resend':
                transferManager.retryFile(fileId);
                showToast(action === 'resend' ? 'Sending again…' : 'Retrying…', 'info');
                break;
            case 'download':
                downloadReceived(fileManager, fileId);
                break;
            case 'remove': {
                const direction = fileManager.getSendRecord(fileId) ? 'send' : 'receive';
                fileManager.removeFile(fileId, direction);
                removeFileRow(fileId);
                break;
            }
            case 'decline':
                if (connectionManager.isConnected()) {
                    connectionManager.sendMessage({ type: 'file-cancelled', fileId });
                }
                transferManager.handleMessage({ type: 'file-cancelled', fileId });
                fileManager.removeFile(fileId, 'receive');
                removeFileRow(fileId);
                showToast('Transfer declined', 'info');
                break;
            default:
                break;
        }
    });

    connectionManager.connect();
}

function downloadReceived(fileManager, fileId) {
    const record = fileManager.getReceivedRecord(fileId);
    if (!record || !record.url) {
        showToast('File not available', 'error');
        return;
    }
    const a = document.createElement('a');
    a.href = record.url;
    a.download = record.name || 'download';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}
