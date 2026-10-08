/**
 * Main entry point for FileSender P2P v2
 * Wires the UI, signaling, and transfer pipeline together.
 */

import { initializeUI, setStatus, setJoinPanel, setScreen, addFileRow, updateFileRow, updateStats, showToast, initSettingsDrawer, initScanner, openScannerModal, closeScannerModal, setScannerStatus, getScannerVideo, generateQRCode, removeFileRow } from './uiManager.js';
import { initializeConnectionManager } from './connectionManager.js';
import { initializeFileManager, getSettings, setAutoDownload, setDeviceName } from './fileManager.js';
import { initializeTransferManager } from './transferManager.js';
import { formatBytes } from './utils.js';
import { parseHostTarget } from './joinTarget.mjs';
import { scanQrCode, cancelQrScan } from './qrScanner.js';

let mode = 'choose';
let announcedLink = false;

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
    mode = new URLSearchParams(window.location.search).has('host') ? 'receive' : 'choose';

    const showCurrentScreen = (connected) => {
        setScreen(connected ? 'session' : mode);
    };

    const connectionManager = initializeConnectionManager({
        onStatusUpdate: (message, connected) => {
            // A late signaling notice reports connected=false. Ignore it while
            // the data channel is still open, or the receiver is sent back to
            // the join panel and only the sender keeps the drop zone.
            const live = !!connected || connectionManager.isConnected();
            if (live && !connected) {
                showCurrentScreen(true);
                return;
            }
            const state = live
                ? 'connected'
                : /connect|wait|establish|retry|rejoin|lost/i.test(message)
                    ? 'connecting'
                    : 'error';
            if (!live && mode === 'receive' && !connectionManager.getHostId()) {
                message = 'Scan or paste a link to connect';
            }
            setStatus(message, state);
            setJoinPanel({
                reconnect: !live && !!connectionManager.getHostId(),
            });
            showCurrentScreen(live);
        },
        onConnected: () => {
            setScreen('session');
            transferManager?.processTransferQueue();
        },
        onDisconnected: (reason) => {
            showToast(`Connection lost (${reason})`, 'info');
            const rejoining = !connectionManager.isHost() && !!connectionManager.getHostId();
            if (rejoining) mode = 'receive';
            else if (mode === 'choose') mode = 'send';
            setJoinPanel({
                reconnect: rejoining,
                notice: rejoining
                    ? 'You were disconnected. Reconnect to the host, or scan a code to join a different one.'
                    : 'Your peer disconnected. Share the link again, or wait for them to reconnect.',
            });
            showCurrentScreen(false);
        },
        onJoiningHost: () => {
            mode = 'receive';
            setJoinPanel({
                reconnect: true,
                notice: 'Connecting to host…',
            });
            showCurrentScreen(false);
        },
        onBecameHost: () => {
            mode = 'send';
            setJoinPanel({
                reconnect: false,
                notice: 'Open the camera and scan their QR code, or paste their share link.',
            });
            showCurrentScreen(false);
        },
        onPeerName: (name) => {
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
            generateQRCode(shareUrl);
            if (mode === 'send' && !announcedLink) {
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
    setupJoin(connectionManager);
    installLeaveGuard(connectionManager);

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

    ui.copyButton.addEventListener('click', () => copyShareLink(ui));

    document.getElementById('share-button')?.addEventListener('click', () => shareOrCopyLink(ui));

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

function setupJoin(connectionManager) {
    const existingHost = new URLSearchParams(window.location.search).get('host');
    if (existingHost) {
        setJoinPanel({
            reconnect: true,
            notice: 'Connecting to the host. If that drops, reconnect here or scan a different code.',
        });
    }

    document.getElementById('choose-send')?.addEventListener('click', () => {
        mode = 'send';
        setScreen(connectionManager.isConnected() ? 'session' : 'send');
        const link = document.getElementById('share-link')?.value;
        if (link && !announcedLink) {
            announcedLink = true;
            showToast('Share link is ready', 'success');
        }
    });

    document.getElementById('choose-receive')?.addEventListener('click', () => {
        mode = 'receive';
        const connected = connectionManager.isConnected();
        setScreen(connected ? 'session' : 'receive');
        if (!connected && !connectionManager.getHostId()) {
            setStatus('Scan or paste a link to connect', 'connecting');
        }
    });

    document.getElementById('reset-button')?.addEventListener('click', () => {
        window.location.assign(window.location.pathname);
    });

    initScanner({
        onOpen: () => openJoinScanner(connectionManager),
        onClose: () => {
            cancelQrScan();
            closeScannerModal();
        },
    });

    document.getElementById('reconnect-host-button')?.addEventListener('click', () => {
        const hostId = connectionManager.getHostId() || new URLSearchParams(window.location.search).get('host');
        if (!hostId) return;
        startJoin(connectionManager, hostId);
    });

    document.getElementById('host-instead-button')?.addEventListener('click', () => {
        if (connectionManager.isConnected()) return;
        const result = connectionManager.becomeHost();
        if (!result.ok) return;
        showToast('This device is sharing its own link', 'success');
    });

    document.getElementById('join-form')?.addEventListener('submit', (event) => {
        event.preventDefault();
        const input = document.getElementById('join-link-input');
        const value = input?.value || '';
        if (startJoin(connectionManager, value) && input) input.value = '';
    });
}

let scannerBusy = false;

async function openJoinScanner(connectionManager) {
    if (scannerBusy) return;
    scannerBusy = true;
    openScannerModal();
    setScannerStatus('Opening the camera…');
    try {
        const text = await scanQrCode({
            video: getScannerVideo(),
            onStatus: setScannerStatus,
            shouldAccept: (value) => {
                const parsed = describeJoinTarget(connectionManager, value);
                if (!parsed.ok) {
                    setScannerStatus(parsed.message);
                    return false;
                }
                return true;
            },
        });
        if (!text) return;
        closeScannerModal();
        startJoin(connectionManager, text);
    } catch (err) {
        setScannerStatus(err.message || 'The camera could not be opened.');
    } finally {
        scannerBusy = false;
    }
}

function startJoin(connectionManager, raw) {
    const parsed = describeJoinTarget(connectionManager, raw);
    if (!parsed.ok) {
        showToast(parsed.message, 'error');
        return false;
    }
    if (connectionManager.isConnected()) {
        const leave = window.confirm('You are connected to a peer. Leave this session and connect to that host?');
        if (!leave) return false;
    }
    const result = connectionManager.joinHost(parsed.hostId);
    if (!result.ok) {
        showToast(joinFailureMessage(result.reason), 'error');
        return false;
    }
    if (result.already) {
        showToast('Already connected to that host', 'info');
        return true;
    }
    showToast('Connecting to host…', 'info');
    return true;
}

function describeJoinTarget(connectionManager, raw) {
    const parsed = parseHostTarget(raw, window.location.origin);
    if (!parsed.ok) return { ok: false, message: joinFailureMessage(parsed.reason) };
    if (parsed.hostId === connectionManager.getPeerId()) {
        return { ok: false, message: joinFailureMessage('self') };
    }
    return parsed;
}

function joinFailureMessage(reason) {
    switch (reason) {
        case 'empty': return 'Enter a share link or host code.';
        case 'origin': return 'That code is for a different site.';
        case 'self': return 'That code belongs to this device.';
        default: return 'That is not a Sendee link.';
    }
}

/**
 * The browser shows its own confirmation for close and refresh.
 * A custom sentence is ignored, so this only arms the prompt while a peer is connected.
 */
function installLeaveGuard(connectionManager) {
    window.addEventListener('beforeunload', (event) => {
        if (!connectionManager.isConnected()) return;
        event.preventDefault();
        event.returnValue = 'A peer is still connected. Leave this page?';
    });
}

function copyShareLink(ui) {
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
}

async function shareOrCopyLink(ui) {
    const url = ui.shareLinkInput?.value;
    if (!url) return;
    if (navigator.share) {
        try {
            await navigator.share({ title: 'Sendee.xyz', text: 'Send file directly', url });
            return;
        } catch (err) {
            if (err && err.name === 'AbortError') return;
        }
    }
    copyShareLink(ui);
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
