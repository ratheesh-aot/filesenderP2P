/**
 * Connection Manager v2 for FileSender P2P
 * Handles WebSocket signaling + WebRTC data channel.
 *
 * Improvements over v1:
 *  - Binary frames (Blob/ArrayBuffer) are routed to onBinaryData instead of
 *    being force-decoded as UTF-8 text.
 *  - Stable peerId across reconnects, so share links keep working.
 *  - Exponential-backoff WebSocket rejoin (2s -> 30s cap); clients auto-rejoin
 *    their host room after a signaling drop.
 *  - Data-channel heartbeat: if no activity for PEER_TIMEOUT_MS the peer is
 *    considered lost and onDisconnected fires with reason 'peer-lost'.
 *  - Greeting handshake carries the device display name (onPeerName).
 */

import { generateId } from './utils.js';

const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30000;
const HEARTBEAT_INTERVAL_MS = 10000;
const PEER_TIMEOUT_MS = 25000;

// --- State --------------------------------------------------------------------
let ws = null;
let peer = null;                 // SimplePeer instance
let connected = false;           // data channel is open
let peerId = generateId();       // stable for the lifetime of this page load
let isHost = false;
let remotePeerId = null;
let hostIdFromUrl = null;        // set when we opened a ?host= link

let reconnectAttempts = 0;
let reconnectTimer = null;
let joinRetryTimer = null;
let heartbeatTimer = null;
let lastActivityAt = Date.now();
let peerLostNotified = false;

// --- Callbacks ------------------------------------------------------------------
let callbacks = {
    onStatusUpdate: () => {},
    onConnected: () => {},
    onDisconnected: () => {},
    onDataReceived: () => {},
    onBinaryData: () => {},
    onShareLinkGenerated: () => {},
    onPeerName: () => {},
    onJoiningHost: () => {},
    onBecameHost: () => {},
};

/**
 * Initialize connection manager.
 * @param {object} options - callback bag (see above) plus optional deviceName
 */
export function initializeConnectionManager(options = {}) {
    callbacks = { ...callbacks, ...options };
    return {
        connect,
        joinHost,
        becomeHost,
        sendMessage,
        sendBinary,
        isConnected: () => connected,
        isHost: () => isHost,
        getPeerId: () => peerId,
        getHostId: () => hostIdFromUrl,
        getPeer: () => peer,
    };
}

/**
 * Leave the current role and join another device's room.
 * Safe to call again after a drop — it sends a fresh join on the open socket.
 * @param {string} hostId
 * @returns {{ ok: true, already?: boolean } | { ok: false, reason: 'invalid' | 'self' }}
 */
export function joinHost(hostId) {
    if (!hostId) return { ok: false, reason: 'invalid' };
    if (hostId === peerId) return { ok: false, reason: 'self' };
    if (connected && hostIdFromUrl === hostId) return { ok: true, already: true };

    isHost = false;
    hostIdFromUrl = hostId;
    rememberHost(hostId);
    // Silent so a deliberate switch does not also toast "connection lost".
    teardownPeer('switching host', { silent: true });
    peerLostNotified = false;
    clearJoinRetry();
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    callbacks.onStatusUpdate('Connecting to host...', false);
    callbacks.onJoiningHost();

    if (ws && ws.readyState === WebSocket.OPEN) sendJoin();
    else if (!ws || ws.readyState !== WebSocket.CONNECTING) openSocket();

    return { ok: true };
}

/**
 * Stop joining and publish this device's share link again.
 * @returns {{ ok: true } | { ok: false, reason: 'connected' }}
 */
export function becomeHost() {
    if (connected) return { ok: false, reason: 'connected' };

    hostIdFromUrl = null;
    isHost = true;
    clearJoinRetry();
    teardownPeer('become host', { silent: true });
    peerLostNotified = false;

    try {
        const url = new URL(window.location.href);
        url.searchParams.delete('host');
        history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    } catch { /* ignore */ }

    const shareUrl = `${window.location.origin}${window.location.pathname}?host=${peerId}`;
    callbacks.onStatusUpdate('Waiting for peer...', false);
    callbacks.onShareLinkGenerated(shareUrl);
    callbacks.onBecameHost();
    return { ok: true };
}

function rememberHost(hostId) {
    try {
        const url = new URL(window.location.href);
        if (url.searchParams.get('host') === hostId) return;
        url.searchParams.set('host', hostId);
        history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    } catch { /* ignore */ }
}

// --- Signaling --------------------------------------------------------------------
export function connect() {
    hostIdFromUrl = readHostParam();
    callbacks.onStatusUpdate(hostIdFromUrl ? 'Connecting to host...' : 'Connecting to server...', false);
    openSocket();
}

function readHostParam() {
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get('host') || null;
}

function openSocket() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;
    const socket = new WebSocket(wsUrl);
    ws = socket;

    socket.onopen = () => {
        reconnectAttempts = 0;
        lastActivityAt = Date.now();
        peerLostNotified = false;

        socket.send(JSON.stringify({ type: 'register', peerId }));

        if (hostIdFromUrl) {
            isHost = false;
            if (!connected) callbacks.onStatusUpdate('Connecting to host...', false);
            sendJoin();
        } else {
            isHost = true;
            const shareUrl = `${window.location.origin}${window.location.pathname}?host=${peerId}`;
            callbacks.onStatusUpdate('Waiting for peer...', false);
            callbacks.onShareLinkGenerated(shareUrl);
        }
    };

    socket.onmessage = (event) => {
        if (ws !== socket) return;
        lastActivityAt = Date.now();
        let data;
        try { data = JSON.parse(event.data); } catch { return; }
        handleSignalingMessage(data);
    };

    socket.onerror = () => { /* onclose follows */ };

    socket.onclose = () => {
        if (ws !== socket) return;
        stopHeartbeat();
        clearJoinRetry();
        teardownPeer('signaling lost');
        callbacks.onStatusUpdate(isHost ? 'Reconnecting to server...' : 'Server connection lost, retrying...', false);
        scheduleReconnect();
    };
}

function sendJoin() {
    if (!ws || ws.readyState !== WebSocket.OPEN || !hostIdFromUrl) return;
    ws.send(JSON.stringify({ type: 'join', hostId: hostIdFromUrl, peerId }));
}

function scheduleJoinRetry() {
    if (isHost || connected || joinRetryTimer) return;
    joinRetryTimer = setTimeout(() => {
        joinRetryTimer = null;
        if (!connected) sendJoin();
    }, 2000);
}

function clearJoinRetry() {
    if (joinRetryTimer) {
        clearTimeout(joinRetryTimer);
        joinRetryTimer = null;
    }
}

function scheduleReconnect() {
    if (reconnectTimer) return;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** reconnectAttempts);
    reconnectAttempts++;
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        openSocket();
    }, delay);
}

function handleSignalingMessage(data) {
    switch (data.type) {
        case 'registered':
            break;

        case 'join-sent':
            if (!connected) callbacks.onStatusUpdate('Establishing connection...', false);
            break;

        case 'client-joined':
            // After this device switches to joining a host, ignore late guests.
            if (!isHost) break;
            remotePeerId = data.clientId;
            createPeerConnection(data.clientId, true);
            break;

        case 'offer':
            // Hosts send offers. Ignore one that arrives after we switch back to hosting.
            if (isHost && remotePeerId !== data.sender) break;
            if (remotePeerId !== data.sender) {
                // A different peer is offering — replace the current one.
                teardownPeer('replaced');
                remotePeerId = data.sender;
            }
            handleOffer(data.sender, data.offer);
            break;

        case 'answer':
            if (peer && peer.remotePeerId === data.sender) {
                peer.signal(data.answer);
            }
            break;

        case 'ice-candidate':
            if (peer && peer.remotePeerId === data.sender) {
                peer.signal({ candidate: data.candidate });
            }
            break;

        case 'client-left':
            if (remotePeerId === data.clientId) {
                teardownPeer('peer left');
                if (isHost) callbacks.onStatusUpdate('Waiting for peer...', false);
            }
            break;

        case 'host-left':
            if (isHost) break;
            teardownPeer('host left');
            callbacks.onStatusUpdate('Host disconnected, retrying...', false);
            scheduleJoinRetry();
            break;

        case 'error':
            console.error('Signaling server error:', data.message);
            if (connected) break;
            callbacks.onStatusUpdate(`Server: ${data.message}`, false);
            if (!isHost && /host not found/i.test(data.message || '')) scheduleJoinRetry();
            break;
    }
}

// --- WebRTC ------------------------------------------------------------------------
function createPeerConnection(remoteId, isInitiator) {
    if (peer && peer.remotePeerId !== remoteId) teardownPeer('replaced');
    if (peer) return peer; // already talking to this peer

    try {
        const options = {
            initiator: isInitiator,
            trickle: true,
            config: {
                iceServers: [
                    { urls: 'stun:stun.l.google.com:19302' },
                    { urls: 'stun:global.stun.twilio.com:3478' },
                ],
            },
        };

        peer = new SimplePeer(options);
        peer.remotePeerId = remoteId;
        setupPeerEvents();
        return peer;
    } catch (err) {
        console.error('Error creating peer connection:', err);
        callbacks.onStatusUpdate('Connection error: ' + err.message, false);
        return null;
    }
}

function handleOffer(senderId, offer) {
    try {
        if (!peer || peer.remotePeerId !== senderId) createPeerConnection(senderId, false);
        if (peer) peer.signal(offer);
    } catch (err) {
        console.error('Error handling offer:', err);
        callbacks.onStatusUpdate('Connection error: ' + err.message, false);
    }
}

function teardownPeer(reason, options = {}) {
    stopHeartbeat();
    const wasConnected = connected;
    connected = false;
    if (peer) {
        const dying = peer;
        peer = null;
        try { dying.destroy(); } catch { /* ignore */ }
    }
    remotePeerId = null;

    if (wasConnected && !peerLostNotified && !options.silent) {
        peerLostNotified = true;
        callbacks.onDisconnected(reason || 'disconnected');
    }
}

function setupPeerEvents() {
    peer.on('signal', (data) => {
        lastActivityAt = Date.now();
        if (!peer || !ws || ws.readyState !== WebSocket.OPEN) return;
        const base = { sender: peerId, target: peer.remotePeerId };
        if (data.type === 'offer') {
            ws.send(JSON.stringify({ ...base, type: 'offer', offer: data }));
        } else if (data.type === 'answer') {
            ws.send(JSON.stringify({ ...base, type: 'answer', answer: data }));
        } else if (data.candidate) {
            ws.send(JSON.stringify({ ...base, type: 'ice-candidate', candidate: data.candidate }));
        }
    });

    peer.on('connect', () => {
        connected = true;
        clearJoinRetry();
        lastActivityAt = Date.now();
        peerLostNotified = false;
        callbacks.onStatusUpdate('Connected to peer!', true);
        startHeartbeat();

        // Greeting carries our display name.
        sendMessage({ type: 'greeting', name: getDeviceName() });
        callbacks.onConnected();
    });

    peer.on('data', (data) => {
        lastActivityAt = Date.now();
        // simple-peer pushes both strings and binary through a byte stream, so
        // JSON control messages often arrive as Uint8Array. File frames are the
        // only payloads that start with the FS2P magic.
        if (typeof data === 'string') {
            handleControlText(data);
            return;
        }
        const bytes = toBytes(data);
        if (!bytes) return;
        if (isFileFrame(bytes)) callbacks.onBinaryData(bytes);
        else handleControlText(new TextDecoder().decode(bytes));
    });

    peer.on('error', (err) => {
        console.error('Peer connection error:', err);
        // An error after the channel is open must not hide the session.
        // A real drop still arrives through 'close'.
        if (!connected) {
            callbacks.onStatusUpdate(isHost ? 'Waiting for peer...' : 'Connection failed — try again', false);
        }
    });

    peer.on('close', () => teardownPeer('closed'));
}

// --- Heartbeat ------------------------------------------------------------------------
function toBytes(data) {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    return null;
}

function isFileFrame(bytes) {
    return bytes.length >= 4 && bytes[0] === 0x46 && bytes[1] === 0x53 && bytes[2] === 0x32 && bytes[3] === 0x50;
}

function handleControlText(text) {
    let message;
    try { message = JSON.parse(text); } catch { return; }
    if (message.type === 'greeting' && message.name) {
        callbacks.onPeerName(message.name);
    } else if (message.type !== 'ping' && message.type !== 'pong') {
        callbacks.onDataReceived(JSON.stringify(message));
    }
}

function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
        if (!connected) return;
        const idleMs = Date.now() - lastActivityAt;
        if (idleMs > PEER_TIMEOUT_MS) {
            callbacks.onStatusUpdate('Peer lost — waiting for them to return...', false);
            teardownPeer('peer-lost');
            return;
        }
        sendMessage({ type: 'ping', t: Date.now() });
    }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat() {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
}

// --- Sending ------------------------------------------------------------------------
export function sendMessage(message) {
    if (!connected || !peer) return false;
    try {
        peer.send(JSON.stringify(message));
        lastActivityAt = Date.now();
        return true;
    } catch (err) {
        console.error('Error sending message:', err);
        return false;
    }
}

/** Send a raw binary frame (ArrayBuffer/Uint8Array/Blob). */
export function sendBinary(data) {
    if (!connected || !peer) return false;
    try {
        peer.send(data);
        lastActivityAt = Date.now();
        return true;
    } catch (err) {
        console.error('Error sending binary frame:', err);
        return false;
    }
}

// --- Device name ------------------------------------------------------------------------
function getDeviceName() {
    try {
        const stored = localStorage.getItem('fs2p-device-name');
        if (stored) return stored;
    } catch { /* private mode */ }
    // Simple heuristic default.
    const ua = navigator.userAgent || '';
    let device = 'Browser';
    if (/iPhone|iPad|iPod/i.test(ua)) device = 'iOS Device';
    else if (/Android/i.test(ua)) device = 'Android Device';
    else if (/Macintosh/i.test(ua)) device = 'Mac';
    else if (/Windows/i.test(ua)) device = 'PC (Windows)';
    else if (/Linux/i.test(ua)) device = 'PC (Linux)';
    return device;
}
