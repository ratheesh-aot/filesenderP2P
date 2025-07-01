// Handles WebRTC signaling between peers

const connectionManager = require('./connectionManager');

/**
 * Forward a signal to a target peer
 * @param {string} sender - The sender's peer ID
 * @param {string} target - The target's peer ID
 * @param {object} signal - The signal data
 * @returns {object} - Result object with success flag and message
 */
function forwardSignal(sender, target, signal) {
    const targetWs = connectionManager.getConnection(target);
    
    if (connectionManager.isConnectionActive(target)) {
        console.log(`Forwarding signal from ${sender} to ${target}`);
        targetWs.send(JSON.stringify({
            type: 'signal',
            sender: sender,
            signal: signal
        }));
        return { success: true };
    } else {
        console.log(`Target peer ${target} not found or not connected`);
        return { 
            success: false, 
            message: 'Target peer not found or not connected' 
        };
    }
}

/**
 * Forward an offer to a target peer
 * @param {string} sender - The sender's peer ID
 * @param {string} target - The target's peer ID
 * @param {object} offer - The WebRTC offer
 * @returns {object} - Result object with success flag and message
 */
function forwardOffer(sender, target, offer) {
    const targetWs = connectionManager.getConnection(target);
    
    if (connectionManager.isConnectionActive(target)) {
        console.log(`Forwarding offer from ${sender} to ${target}`);
        targetWs.send(JSON.stringify({
            type: 'offer',
            sender: sender,
            offer: offer
        }));
        return { success: true };
    } else {
        console.log(`Target client ${target} not found or not connected`);
        return { 
            success: false, 
            message: 'Target client not found or not connected' 
        };
    }
}

/**
 * Forward an answer to a target peer
 * @param {string} sender - The sender's peer ID
 * @param {string} target - The target's peer ID
 * @param {object} answer - The WebRTC answer
 * @returns {object} - Result object with success flag and message
 */
function forwardAnswer(sender, target, answer) {
    const targetWs = connectionManager.getConnection(target);
    
    if (connectionManager.isConnectionActive(target)) {
        console.log(`Forwarding answer from ${sender} to ${target}`);
        targetWs.send(JSON.stringify({
            type: 'answer',
            sender: sender,
            answer: answer
        }));
        return { success: true };
    } else {
        console.log(`Target host ${target} not found or not connected`);
        return { 
            success: false, 
            message: 'Target host not found or not connected' 
        };
    }
}

/**
 * Forward an ICE candidate to a target peer
 * @param {string} sender - The sender's peer ID
 * @param {string} target - The target's peer ID
 * @param {object} candidate - The ICE candidate
 * @returns {object} - Result object with success flag and message
 */
function forwardIceCandidate(sender, target, candidate) {
    const targetWs = connectionManager.getConnection(target);
    
    if (connectionManager.isConnectionActive(target)) {
        console.log(`Forwarding ICE candidate from ${sender} to ${target}`);
        targetWs.send(JSON.stringify({
            type: 'ice-candidate',
            sender: sender,
            candidate: candidate
        }));
        return { success: true };
    } else {
        console.log(`Target peer ${target} not found or not connected`);
        return { 
            success: false, 
            message: 'Target peer not found or not connected' 
        };
    }
}

module.exports = {
    forwardSignal,
    forwardOffer,
    forwardAnswer,
    forwardIceCandidate
};
