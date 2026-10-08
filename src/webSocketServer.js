// WebSocket server setup and message handling
const { Server } = require('ws');
const connectionManager = require('./connectionManager');
const roomManager = require('./roomManager');
const signalHandler = require('./signalHandler');

// Keepalive tuning: proxies (e.g. Vercel) drop idle sockets, so we ping
// regularly and terminate connections that stop answering pongs.
const PING_INTERVAL_MS = 30000;
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024; // signaling frames are tiny; cap at 16 MB

/**
 * Create and configure the WebSocket server
 * @param {http.Server} httpServer - HTTP server to attach the WebSocket server to
 * @returns {WebSocket.Server} - Configured WebSocket server instance
 */
function createWebSocketServer(httpServer) {
    // Create WebSocket server attached to HTTP server
    const wss = new Server({
        server: httpServer,
        maxPayload: MAX_MESSAGE_BYTES,
    });

    // Periodic ping sweep; terminate dead connections.
    setInterval(() => {
        for (const client of wss.clients) {
            if (!client.isAlive) {
                try { client.terminate(); } catch { /* ignore */ }
                continue;
            }
            client.isAlive = false;
            try { client.ping(); } catch { /* ignore */ }
        }
    }, PING_INTERVAL_MS).unref?.();

    // WebSocket server handling
    wss.on('connection', handleConnection);

    return wss;
}

/**
 * Handle a new WebSocket connection
 * @param {WebSocket} ws - The WebSocket connection
 */
function handleConnection(ws) {
    console.log('WebSocket client connected');
    let clientId = null;

    // Track liveness for the ping sweep.
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            console.log('Received message type:', data.type);
            
            switch (data.type) {
                case 'register':
                    handleRegister(ws, data, clientId);
                    clientId = data.peerId; // Update clientId after registration
                    break;
                    
                case 'join':
                    if (data.peerId) clientId = data.peerId;
                    handleJoin(ws, data, clientId);
                    break;
                    
                case 'signal':
                    handleSignal(ws, data);
                    break;
                    
                case 'offer':
                    handleOffer(ws, data);
                    break;
                    
                case 'answer':
                    handleAnswer(ws, data);
                    break;
                    
                case 'ice-candidate':
                    handleIceCandidate(ws, data);
                    break;
            }
        } catch (err) {
            console.error('Error processing message:', err);
        }
    });
    
    ws.on('close', () => {
        handleDisconnect(clientId);
    });
}

/**
 * Handle client registration
 * @param {WebSocket} ws - The WebSocket connection
 * @param {object} data - The message data
 * @param {string} clientId - The current client ID
 */
function handleRegister(ws, data, clientId) {
    // Register this connection with the peerId
    if (data.peerId) {
        connectionManager.registerConnection(data.peerId, ws);
        ws.send(JSON.stringify({ type: 'registered', peerId: data.peerId }));
    }
}

/**
 * Handle join room request
 * @param {WebSocket} ws - The WebSocket connection
 * @param {object} data - The message data
 * @param {string} clientId - The current client ID
 */
function handleJoin(ws, data, clientId) {
    // Client wants to join a room (connect to a host)
    const joinerId = data.peerId || clientId;
    if (data.hostId && joinerId) {
        const hostId = data.hostId;
        const hostWs = connectionManager.getConnection(hostId);

        if (!connectionManager.getConnection(joinerId)) {
            connectionManager.registerConnection(joinerId, ws);
        }
        
        if (connectionManager.isConnectionActive(hostId)) {
            // Add client to room
            roomManager.addClientToRoom(hostId, joinerId);
            
            // Notify host that a client wants to join
            hostWs.send(JSON.stringify({
                type: 'client-joined',
                clientId: joinerId
            }));
            
            // Notify client that join request was sent
            ws.send(JSON.stringify({
                type: 'join-sent',
                hostId: hostId
            }));
        } else {
            console.log(`Host ${hostId} not found or not connected`);
            ws.send(JSON.stringify({
                type: 'error',
                message: 'Host not found or not connected'
            }));
        }
    }
}

/**
 * Handle signal message
 * @param {WebSocket} ws - The WebSocket connection
 * @param {object} data - The message data
 */
function handleSignal(ws, data) {
    // Forward signaling data to the target peer
    if (data.target && data.sender && data.signal) {
        const result = signalHandler.forwardSignal(data.sender, data.target, data.signal);
        
        if (!result.success) {
            ws.send(JSON.stringify({ 
                type: 'error', 
                message: result.message 
            }));
        }
    }
}

/**
 * Handle offer message
 * @param {WebSocket} ws - The WebSocket connection
 * @param {object} data - The message data
 */
function handleOffer(ws, data) {
    // Host is sending an offer to a client
    if (data.target && data.sender && data.offer) {
        const result = signalHandler.forwardOffer(data.sender, data.target, data.offer);
        
        if (!result.success) {
            ws.send(JSON.stringify({ 
                type: 'error', 
                message: result.message 
            }));
        }
    }
}

/**
 * Handle answer message
 * @param {WebSocket} ws - The WebSocket connection
 * @param {object} data - The message data
 */
function handleAnswer(ws, data) {
    // Client is sending an answer to a host
    if (data.target && data.sender && data.answer) {
        const result = signalHandler.forwardAnswer(data.sender, data.target, data.answer);
        
        if (!result.success) {
            ws.send(JSON.stringify({ 
                type: 'error', 
                message: result.message 
            }));
        }
    }
}

/**
 * Handle ICE candidate message
 * @param {WebSocket} ws - The WebSocket connection
 * @param {object} data - The message data
 */
function handleIceCandidate(ws, data) {
    // Forward ICE candidate to the target peer
    if (data.target && data.sender && data.candidate) {
        const result = signalHandler.forwardIceCandidate(data.sender, data.target, data.candidate);
        
        if (!result.success) {
            ws.send(JSON.stringify({ 
                type: 'error', 
                message: result.message 
            }));
        }
    }
}

/**
 * Handle client disconnection
 * @param {string} clientId - The client ID that disconnected
 */
function handleDisconnect(clientId) {
    console.log('WebSocket client disconnected');
    
    // Remove this connection from the connections map
    if (clientId) {
        connectionManager.removeConnection(clientId);
        
        // Notify all rooms this client was in
        for (const [hostId, clients] of roomManager.getAllRooms().entries()) {
            if (roomManager.isClientInRoom(hostId, clientId)) {
                roomManager.removeClientFromRoom(hostId, clientId);
                
                // Notify host that client left
                const hostWs = connectionManager.getConnection(hostId);
                if (connectionManager.isConnectionActive(hostId)) {
                    hostWs.send(JSON.stringify({
                        type: 'client-left',
                        clientId: clientId
                    }));
                }
            }
            
            // If this was a host, notify all clients in the room
            if (hostId === clientId) {
                for (const clientInRoom of clients) {
                    const clientWs = connectionManager.getConnection(clientInRoom);
                    if (connectionManager.isConnectionActive(clientInRoom)) {
                        clientWs.send(JSON.stringify({
                            type: 'host-left',
                            hostId: hostId
                        }));
                    }
                }
                
                // Delete the room
                roomManager.deleteRoom(hostId);
            }
        }
    }
}

module.exports = {
    createWebSocketServer
};
