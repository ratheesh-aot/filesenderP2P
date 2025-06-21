// Simple HTTP server to serve static files
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('ws');

const PORT = 3001; // Changed port to avoid conflict

// MIME types for different file extensions
const MIME_TYPES = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};

// Create HTTP server
const server = http.createServer((req, res) => {
    // Handle the request
    let url = req.url;
    
    // Fix for paths that should be query parameters
    if (url.startsWith('/host=')) {
        url = '/?' + url.substring(1);
    }
    
    // Extract the path part from the URL (ignore query parameters)
    const urlPath = url.split('?')[0];
    
    let filePath = path.join(__dirname, 'public', urlPath === '/' ? 'index.html' : urlPath);
    
    // Get the file extension
    const extname = path.extname(filePath);
    
    // Default content type
    let contentType = MIME_TYPES[extname] || 'application/octet-stream';
    
    // Read the file
    fs.readFile(filePath, (err, content) => {
        if (err) {
            if (err.code === 'ENOENT') {
                // Page not found
                fs.readFile(path.join(__dirname, 'public', '404.html'), (err, content) => {
                    if (err) {
                        // If 404 page doesn't exist, send simple message
                        res.writeHead(404);
                        res.end('404 Not Found');
                    } else {
                        res.writeHead(404, { 'Content-Type': 'text/html' });
                        res.end(content, 'utf8');
                    }
                });
            } else {
                // Server error
                res.writeHead(500);
                res.end(`Server Error: ${err.code}`);
            }
        } else {
            // Success
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content, 'utf8');
        }
    });
});

// Create WebSocket server attached to HTTP server
const wss = new Server({ server });

// Store active connections
const connections = new Map();
const rooms = new Map();

// WebSocket server handling
wss.on('connection', (ws) => {
    console.log('WebSocket client connected');
    let clientId = null;
    
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            console.log('Received message type:', data.type);
            
            switch (data.type) {
                case 'register':
                    // Register this connection with the peerId
                    if (data.peerId) {
                        clientId = data.peerId;
                        connections.set(data.peerId, ws);
                        console.log(`Registered peer: ${data.peerId}`);
                        ws.send(JSON.stringify({ type: 'registered', peerId: data.peerId }));
                    }
                    break;
                    
                case 'join':
                    // Client wants to join a room (connect to a host)
                    if (data.hostId) {
                        const hostId = data.hostId;
                        const hostWs = connections.get(hostId);
                        
                        if (hostWs && hostWs.readyState === 1) {
                            // Create or get room
                            if (!rooms.has(hostId)) {
                                rooms.set(hostId, new Set());
                            }
                            
                            const room = rooms.get(hostId);
                            room.add(clientId);
                            
                            console.log(`Client ${clientId} joining room with host ${hostId}`);
                            
                            // Notify host that a client wants to join
                            hostWs.send(JSON.stringify({
                                type: 'client-joined',
                                clientId: clientId
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
                    break;
                    
                case 'signal':
                    // Forward signaling data to the target peer
                    if (data.target && data.sender && data.signal) {
                        const targetWs = connections.get(data.target);
                        if (targetWs && targetWs.readyState === 1) {
                            console.log(`Forwarding signal from ${data.sender} to ${data.target}`);
                            targetWs.send(JSON.stringify({
                                type: 'signal',
                                sender: data.sender,
                                signal: data.signal
                            }));
                        } else {
                            console.log(`Target peer ${data.target} not found or not connected`);
                            ws.send(JSON.stringify({ 
                                type: 'error', 
                                message: 'Target peer not found or not connected' 
                            }));
                        }
                    }
                    break;
                    
                case 'offer':
                    // Host is sending an offer to a client
                    if (data.target && data.sender && data.offer) {
                        const targetWs = connections.get(data.target);
                        if (targetWs && targetWs.readyState === 1) {
                            console.log(`Forwarding offer from ${data.sender} to ${data.target}`);
                            targetWs.send(JSON.stringify({
                                type: 'offer',
                                sender: data.sender,
                                offer: data.offer
                            }));
                        } else {
                            console.log(`Target client ${data.target} not found or not connected`);
                            ws.send(JSON.stringify({ 
                                type: 'error', 
                                message: 'Target client not found or not connected' 
                            }));
                        }
                    }
                    break;
                    
                case 'answer':
                    // Client is sending an answer to a host
                    if (data.target && data.sender && data.answer) {
                        const targetWs = connections.get(data.target);
                        if (targetWs && targetWs.readyState === 1) {
                            console.log(`Forwarding answer from ${data.sender} to ${data.target}`);
                            targetWs.send(JSON.stringify({
                                type: 'answer',
                                sender: data.sender,
                                answer: data.answer
                            }));
                        } else {
                            console.log(`Target host ${data.target} not found or not connected`);
                            ws.send(JSON.stringify({ 
                                type: 'error', 
                                message: 'Target host not found or not connected' 
                            }));
                        }
                    }
                    break;
                    
                case 'ice-candidate':
                    // Forward ICE candidate to the target peer
                    if (data.target && data.sender && data.candidate) {
                        const targetWs = connections.get(data.target);
                        if (targetWs && targetWs.readyState === 1) {
                            console.log(`Forwarding ICE candidate from ${data.sender} to ${data.target}`);
                            targetWs.send(JSON.stringify({
                                type: 'ice-candidate',
                                sender: data.sender,
                                candidate: data.candidate
                            }));
                        } else {
                            console.log(`Target peer ${data.target} not found or not connected`);
                            ws.send(JSON.stringify({ 
                                type: 'error', 
                                message: 'Target peer not found or not connected' 
                            }));
                        }
                    }
                    break;
            }
        } catch (err) {
            console.error('Error processing message:', err);
        }
    });
    
    ws.on('close', () => {
        console.log('WebSocket client disconnected');
        
        // Remove this connection from the connections map
        if (clientId) {
            console.log(`Unregistered peer: ${clientId}`);
            connections.delete(clientId);
            
            // Notify all rooms this client was in
            for (const [hostId, clients] of rooms.entries()) {
                if (clients.has(clientId)) {
                    clients.delete(clientId);
                    
                    // Notify host that client left
                    const hostWs = connections.get(hostId);
                    if (hostWs && hostWs.readyState === 1) {
                        hostWs.send(JSON.stringify({
                            type: 'client-left',
                            clientId: clientId
                        }));
                    }
                }
                
                // If this was a host, notify all clients in the room
                if (hostId === clientId) {
                    for (const clientInRoom of clients) {
                        const clientWs = connections.get(clientInRoom);
                        if (clientWs && clientWs.readyState === 1) {
                            clientWs.send(JSON.stringify({
                                type: 'host-left',
                                hostId: hostId
                            }));
                        }
                    }
                    
                    // Delete the room
                    rooms.delete(hostId);
                }
            }
        }
    });
});

// Start the server
server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}/`);
    console.log(`WebSocket server running on ws://localhost:${PORT}`);
});
