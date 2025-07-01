/**
 * Main server entry point
 * Uses modular components for better organization
 */

// Import modules
const { PORT } = require('./src/config');
const httpServer = require('./src/httpServer');
const webSocketServer = require('./src/webSocketServer');

// Create HTTP server
const server = httpServer.createServer();

// Create WebSocket server attached to HTTP server
const wss = webSocketServer.createWebSocketServer(server);

// Start the server
server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}/`);
    console.log(`WebSocket server running on ws://localhost:${PORT}`);
});
