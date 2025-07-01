// Manages WebSocket connections

// Store active connections
const connections = new Map();

/**
 * Register a new connection
 * @param {string} peerId - The peer ID to register
 * @param {object} ws - The WebSocket connection
 */
function registerConnection(peerId, ws) {
    connections.set(peerId, ws);
    console.log(`Registered peer: ${peerId}`);
    return true;
}

/**
 * Get a connection by peer ID
 * @param {string} peerId - The peer ID to look up
 * @returns {object|null} - The WebSocket connection or null if not found
 */
function getConnection(peerId) {
    return connections.get(peerId) || null;
}

/**
 * Remove a connection
 * @param {string} peerId - The peer ID to unregister
 */
function removeConnection(peerId) {
    if (peerId && connections.has(peerId)) {
        console.log(`Unregistered peer: ${peerId}`);
        connections.delete(peerId);
        return true;
    }
    return false;
}

/**
 * Check if a connection is active
 * @param {string} peerId - The peer ID to check
 * @returns {boolean} - True if the connection exists and is active
 */
function isConnectionActive(peerId) {
    const ws = connections.get(peerId);
    return ws && ws.readyState === 1;
}

/**
 * Get all active connections
 * @returns {Map} - Map of all connections
 */
function getAllConnections() {
    return connections;
}

module.exports = {
    registerConnection,
    getConnection,
    removeConnection,
    isConnectionActive,
    getAllConnections
};
