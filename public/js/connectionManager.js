/**
 * Connection Manager for FileSender P2P
 * Handles WebSocket and WebRTC connections
 */
import { generateId } from './utils.js';

// Connection state
let ws; // WebSocket connection
let peer; // WebRTC peer connection
let connection; // Active data connection
let peerId; // Our peer ID
let isHost = false; // Whether we're the host
let remotePeerId = null; // Remote peer ID

// Event callbacks
let callbacks = {
    onStatusUpdate: () => {},
    onConnected: () => {},
    onDisconnected: () => {},
    onDataReceived: () => {},
    onShareLinkGenerated: () => {}
};

/**
 * Initialize connection manager
 * @param {object} options - Connection options
 * @param {function} options.onStatusUpdate - Status update callback
 * @param {function} options.onConnected - Connection established callback
 * @param {function} options.onDisconnected - Connection closed callback
 * @param {function} options.onDataReceived - Data received callback
 * @returns {object} Connection manager API
 */
export function initializeConnectionManager(options) {
    // Set callbacks
    callbacks = { ...callbacks, ...options };
    
    return {
        connect,
        sendMessage,
        isConnected: () => !!connection,
        isHost: () => isHost,
        getPeerId: () => peerId,
        getConnection: () => connection
    };
}

/**
 * Connect to signaling server and set up peer connection
 */
function connect() {
    callbacks.onStatusUpdate('Initializing...', false);
    connectToSignalingServer();
}

/**
 * Connect to WebSocket signaling server
 */
function connectToSignalingServer() {
    // Use the current host and port for WebSocket connection
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;
    
    console.log('Connecting to WebSocket server:', wsUrl);
    ws = new WebSocket(wsUrl);
    
    ws.onopen = () => {
        console.log('Connected to signaling server');
        
        // Generate a random peer ID
        peerId = generateId();
        console.log('Generated peer ID:', peerId);
        
        // Register with signaling server
        ws.send(JSON.stringify({
            type: 'register',
            peerId: peerId
        }));
        
        // Determine if we're host or client
        const urlParams = new URLSearchParams(window.location.search);
        const hostId = urlParams.get('host') || 
                      (window.location.pathname.startsWith('/host=') ? 
                       window.location.pathname.substring(6) : null);
        
        if (hostId) {
            isHost = false;
            callbacks.onStatusUpdate('Connecting to host...', false);
            
            // Join the host's room
            ws.send(JSON.stringify({
                type: 'join',
                hostId: hostId
            }));
        } else {
            isHost = true;
            callbacks.onStatusUpdate('Ready! Waiting for connections.', true);
            
            // Generate shareable link
            const shareUrl = `${window.location.origin}${window.location.pathname}?host=${peerId}`;
            console.log('Share URL generated:', shareUrl);
            
            // Update UI with shareable link
            callbacks.onShareLinkGenerated(shareUrl);
        }
    };
    
    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        console.log('Received WebSocket message:', data);
        
        switch (data.type) {
            case 'registered':
                console.log('Successfully registered with signaling server');
                break;
                
            case 'join-sent':
                console.log('Join request sent to host:', data.hostId);
                callbacks.onStatusUpdate('Establishing connection...', false);
                break;
                
            case 'client-joined':
                console.log('Client joined:', data.clientId);
                remotePeerId = data.clientId;
                createPeerConnection(data.clientId, true);
                break;
                
            case 'offer':
                console.log('Received offer from:', data.sender);
                remotePeerId = data.sender;
                handleOffer(data.sender, data.offer);
                break;
                
            case 'answer':
                console.log('Received answer from:', data.sender);
                handleAnswer(data.sender, data.answer);
                break;
                
            case 'ice-candidate':
                console.log('Received ICE candidate from:', data.sender);
                handleIceCandidate(data.sender, data.candidate);
                break;
                
            case 'client-left':
                console.log('Client left:', data.clientId);
                if (peer && remotePeerId === data.clientId) {
                    callbacks.onStatusUpdate('Peer disconnected', false);
                    if (peer) {
                        peer.destroy();
                        peer = null;
                    }
                    connection = null;
                    callbacks.onDisconnected();
                }
                break;
                
            case 'host-left':
                console.log('Host left:', data.hostId);
                callbacks.onStatusUpdate('Host disconnected', false);
                if (peer) {
                    peer.destroy();
                    peer = null;
                }
                connection = null;
                callbacks.onDisconnected();
                break;
                
            case 'error':
                console.error('Signaling server error:', data.message);
                callbacks.onStatusUpdate(`Signaling error: ${data.message}`, false);
                break;
        }
    };
    
    ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        callbacks.onStatusUpdate('Signaling server connection error', false);
    };
    
    ws.onclose = () => {
        console.log('Disconnected from signaling server');
        callbacks.onStatusUpdate('Disconnected from signaling server', false);
        setTimeout(connectToSignalingServer, 5000);
    };
}

/**
 * Create a WebRTC peer connection
 * @param {string} remotePeerId - Remote peer ID
 * @param {boolean} isInitiator - Whether we're initiating the connection
 * @returns {RTCPeerConnection} Peer connection
 */
function createPeerConnection(remotePeerId, isInitiator) {
    try {
        const peerOptions = {
            initiator: isInitiator,
            trickle: true,
            config: {
                iceServers: [
                    { urls: 'stun:stun.l.google.com:19302' },
                    { urls: 'stun:stun1.l.google.com:19302' },
                    { urls: 'stun:stun2.l.google.com:19302' },
                    { urls: 'stun:stun3.l.google.com:19302' },
                    { urls: 'stun:stun4.l.google.com:19302' },
                    { urls: 'stun:global.stun.twilio.com:3478' }
                ]
            }
        };

        peer = new SimplePeer(peerOptions);
        peer.remotePeerId = remotePeerId;
        console.log('Peer created with options:', peerOptions);
        
        setupPeerEvents();
        return peer;
    } catch (err) {
        console.error('Error creating peer connection:', err);
        callbacks.onStatusUpdate('Error creating connection: ' + err.message, false);
        return null;
    }
}

/**
 * Handle WebRTC offer
 * @param {string} senderId - Sender's peer ID
 * @param {object} offer - WebRTC offer
 */
function handleOffer(senderId, offer) {
    try {
        if (!peer) {
            peer = createPeerConnection(senderId, false);
            if (!peer) return;
        }
        peer.signal(offer);
    } catch (err) {
        console.error('Error handling offer:', err);
        callbacks.onStatusUpdate('Error handling offer: ' + err.message, false);
    }
}

/**
 * Handle WebRTC answer
 * @param {string} senderId - Sender's peer ID
 * @param {object} answer - WebRTC answer
 */
function handleAnswer(senderId, answer) {
    try {
        if (peer && peer.remotePeerId === senderId) {
            peer.signal(answer);
        } else {
            console.error('Received answer from unknown peer:', senderId);
        }
    } catch (err) {
        console.error('Error handling answer:', err);
        callbacks.onStatusUpdate('Error handling answer: ' + err.message, false);
    }
}

/**
 * Handle ICE candidate
 * @param {string} senderId - Sender's peer ID
 * @param {object} candidate - ICE candidate
 */
function handleIceCandidate(senderId, candidate) {
    try {
        if (peer && peer.remotePeerId === senderId) {
            peer.signal({ candidate: candidate });
        } else {
            console.error('Received ICE candidate from unknown peer:', senderId);
        }
    } catch (err) {
        console.error('Error handling ICE candidate:', err);
    }
}

/**
 * Set up WebRTC peer events
 */
function setupPeerEvents() {
    console.log('Setting up peer events for peer:', peer);
    
    peer.on('signal', (data) => {
        console.log('Generated signal data', data);
        
        if (data.type === 'offer') {
            console.log('Sending offer to remote peer');
            ws.send(JSON.stringify({
                type: 'offer',
                sender: peerId,
                target: peer.remotePeerId,
                offer: data
            }));
        } else if (data.type === 'answer') {
            console.log('Sending answer to remote peer');
            ws.send(JSON.stringify({
                type: 'answer',
                sender: peerId,
                target: peer.remotePeerId,
                answer: data
            }));
        } else if (data.candidate) {
            console.log('Sending ICE candidate to remote peer');
            ws.send(JSON.stringify({
                type: 'ice-candidate',
                sender: peerId,
                target: peer.remotePeerId,
                candidate: data.candidate
            }));
        }
    });

    peer.on('connect', () => {
        console.log('Peer connection established!');
        callbacks.onStatusUpdate('Connected to peer!', true);
        
        // Set connection first
        connection = peer;
        console.log('Connection variable set:', !!connection);
        
        // Then send greeting message
        sendMessage({
            type: 'greeting',
            message: 'Hello from FileSender!'
        });
        
        callbacks.onConnected();
    });

    peer.on('data', (data) => {
        console.log('Received data from peer:', {
            type: typeof data,
            constructor: data?.constructor?.name,
            size: data.byteLength || data.length,
            isString: typeof data === 'string',
            isArrayBuffer: data instanceof ArrayBuffer,
            isUint8Array: data instanceof Uint8Array
        });

        // Handle different types of data
        if (typeof data === 'string') {
            // String data - pass it directly to the callback
            // The callback will handle JSON parsing
            callbacks.onDataReceived(data);
        } else if (data instanceof ArrayBuffer || data instanceof Uint8Array) {
            // Binary data - convert to string
            try {
                // Convert binary data to string
                const decoder = new TextDecoder('utf-8');
                const dataString = decoder.decode(data instanceof ArrayBuffer ? data : data.buffer);
                console.log('Successfully converted binary data to string');
                
                // Pass the string to the callback
                // The callback will handle JSON parsing
                callbacks.onDataReceived(dataString);
            } catch (err) {
                console.error('Error converting binary data to string:', err);
            }
        } else {
            console.warn('Received unsupported data type (this should not happen):', data);
        }
    });

    peer.on('error', (err) => {
        console.error('Peer connection error:', err);
        callbacks.onStatusUpdate(`Connection error: ${err.message}`, false);
    });

    peer.on('close', () => {
        console.log('Peer connection closed');
        callbacks.onStatusUpdate('Connection closed', false);
        connection = null;
        callbacks.onDisconnected();
    });
    
    console.log('Peer events setup complete');
}

/**
 * Send a message to the connected peer
 * @param {object} message - Message to send
 * @returns {boolean} Whether the message was sent
 */
export function sendMessage(message) {
    if (!connection) {
        console.error('Cannot send message: No connection');
        return false;
    }
    
    try {
        const serializedMessage = JSON.stringify(message);
        connection.send(serializedMessage);
        return true;
    } catch (err) {
        console.error('Error sending message:', err);
        return false;
    }
}
