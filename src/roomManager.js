// Manages rooms and participants

// Store rooms and their participants
const rooms = new Map();

/**
 * Create a new room or get existing room
 * @param {string} hostId - The host ID for the room
 * @returns {Set} - The room's client set
 */
function getOrCreateRoom(hostId) {
    if (!rooms.has(hostId)) {
        rooms.set(hostId, new Set());
    }
    return rooms.get(hostId);
}

/**
 * Add a client to a room
 * @param {string} hostId - The host ID for the room
 * @param {string} clientId - The client ID to add
 * @returns {boolean} - True if the client was added
 */
function addClientToRoom(hostId, clientId) {
    const room = getOrCreateRoom(hostId);
    room.add(clientId);
    console.log(`Client ${clientId} joined room with host ${hostId}`);
    return true;
}

/**
 * Remove a client from a room
 * @param {string} hostId - The host ID for the room
 * @param {string} clientId - The client ID to remove
 * @returns {boolean} - True if the client was removed
 */
function removeClientFromRoom(hostId, clientId) {
    const room = rooms.get(hostId);
    if (room && room.has(clientId)) {
        room.delete(clientId);
        return true;
    }
    return false;
}

/**
 * Delete a room
 * @param {string} hostId - The host ID for the room to delete
 * @returns {boolean} - True if the room was deleted
 */
function deleteRoom(hostId) {
    if (rooms.has(hostId)) {
        rooms.delete(hostId);
        return true;
    }
    return false;
}

/**
 * Get all clients in a room
 * @param {string} hostId - The host ID for the room
 * @returns {Set|null} - Set of client IDs or null if room doesn't exist
 */
function getClientsInRoom(hostId) {
    return rooms.get(hostId) || null;
}

/**
 * Check if a client is in a room
 * @param {string} hostId - The host ID for the room
 * @param {string} clientId - The client ID to check
 * @returns {boolean} - True if the client is in the room
 */
function isClientInRoom(hostId, clientId) {
    const room = rooms.get(hostId);
    return room && room.has(clientId);
}

/**
 * Get all rooms
 * @returns {Map} - Map of all rooms
 */
function getAllRooms() {
    return rooms;
}

module.exports = {
    getOrCreateRoom,
    addClientToRoom,
    removeClientFromRoom,
    deleteRoom,
    getClientsInRoom,
    isClientInRoom,
    getAllRooms
};
