// Helper function to generate a random ID
function generateId() {
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

// Helper function to format bytes to human-readable size
function formatBytes(bytes, decimals = 1) {
    if (bytes === 0) return '0 B';
    
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + sizes[i];
}

console.log('FileSender P2P script loaded successfully');
console.log('Current time:', new Date().toISOString());

document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM Content Loaded - Starting FileSender P2P initialization');

    // DOM Elements
    const connectionStatusEl = document.getElementById('connection-status');
    const hostInfoEl = document.getElementById('host-info');
    const clientInfoEl = document.getElementById('client-info');
    const shareLinkInput = document.getElementById('share-link');
    const copyButton = document.getElementById('copy-button');
    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-input');
    const filesToSendList = document.getElementById('files-to-send');
    const receivedFilesList = document.getElementById('received-files');
    
    // Make sure file list containers are visible
    const fileListContainers = document.querySelectorAll('.list-container');
    fileListContainers.forEach(container => {
        container.style.display = 'block';
    });
    
    // Debug: Check if DOM elements are found
    console.log('DOM Elements found:', {
        filesToSendList: !!filesToSendList,
        receivedFilesList: !!receivedFilesList,
        dropZone: !!dropZone,
        fileInput: !!fileInput
    });

    // App State
    let peer;
    let connection;
    let isHost = false;
    let peerId;
    let ws; // WebSocket connection
    const filesToSend = {};
    const receivedFiles = {};
    const CHUNK_SIZE = 64 * 1024; // 64KB chunks
    const MAX_CHUNKS_IN_FLIGHT = 10; // Maximum number of chunks to send before waiting for acknowledgment
    let chunksInFlight = 0; // Track how many chunks are currently being sent
    let transferQueue = []; // Queue for files waiting to be sent
    
    const AUTO_DOWNLOAD_ENABLED = true; 
    const MAX_FILES_TO_KEEP = 5;
    const fileHistory = {
        sent: [],
        received: []
    };

    // Check if URL has a peer ID (client mode)
    // Handle both query parameter format and path format
    let hostId = null;
    
    // Check for query parameter format: ?host=ID
    const urlParams = new URLSearchParams(window.location.search);
    hostId = urlParams.get('host');
    
    // If not found, check for path format: /host=ID
    if (!hostId && window.location.pathname.startsWith('/host=')) {
        hostId = window.location.pathname.substring(6); // Remove '/host='
    }

    // Log for debugging
    console.log('Host ID from URL:', hostId);

    // Initialize the application
    init();

    // Functions
    function init() {
        updateStatus('Initializing...');
        connectToSignalingServer();
    }

    function updateStatus(message, isConnected = false) {
        if (connectionStatusEl) {
            connectionStatusEl.textContent = message;
            connectionStatusEl.className = isConnected ? 'connected' : 'disconnected';
        }
        console.log('Status update:', message);
    }

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
            
            // Setup UI events
            setupUIEvents();
            
            // Determine if we're host or client
            if (hostId) {
                isHost = false;
                if (clientInfoEl) clientInfoEl.style.display = 'block';
                updateStatus('Waiting to connect to host...', false);
                
                // Join the host's room
                ws.send(JSON.stringify({
                    type: 'join',
                    hostId: hostId
                }));
            } else {
                isHost = true;
                updateStatus('Ready! Waiting for connections.', true);
                if (hostInfoEl) hostInfoEl.style.display = 'block';
                
                // Generate shareable link
                const shareUrl = `${window.location.origin}${window.location.pathname}?host=${peerId}`;
                if (shareLinkInput) shareLinkInput.value = shareUrl;
                console.log('Share URL generated:', shareUrl);
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
                    break;
                    
                case 'client-joined':
                    console.log('Client joined:', data.clientId);
                    createPeerConnection(data.clientId, true);
                    break;
                    
                case 'offer':
                    console.log('Received offer from:', data.sender);
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
                    if (peer && peer.remotePeerId === data.clientId) {
                        updateStatus('Peer disconnected', false);
                        if (peer) {
                            peer.destroy();
                            peer = null;
                        }
                        connection = null;
                        
                        if (isHost && hostInfoEl) {
                            hostInfoEl.style.display = 'block';
                        }
                    }
                    break;
                    
                case 'host-left':
                    console.log('Host left:', data.hostId);
                    updateStatus('Host disconnected', false);
                    if (peer) {
                        peer.destroy();
                        peer = null;
                    }
                    connection = null;
                    break;
                    
                case 'error':
                    console.error('Signaling server error:', data.message);
                    updateStatus(`Signaling error: ${data.message}`, false);
                    break;
            }
        };
        
        ws.onerror = (error) => {
            console.error('WebSocket error:', error);
            updateStatus('Signaling server connection error', false);
        };
        
        ws.onclose = () => {
            console.log('Disconnected from signaling server');
            updateStatus('Disconnected from signaling server', false);
            setTimeout(connectToSignalingServer, 5000);
        };
    }

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
            updateStatus('Error creating connection: ' + err.message, false);
            return null;
        }
    }

    function handleOffer(senderId, offer) {
        try {
            if (!peer) {
                peer = createPeerConnection(senderId, false);
                if (!peer) return;
            }
            peer.signal(offer);
        } catch (err) {
            console.error('Error handling offer:', err);
            updateStatus('Error handling offer: ' + err.message, false);
        }
    }

    function handleAnswer(senderId, answer) {
        try {
            if (peer && peer.remotePeerId === senderId) {
                peer.signal(answer);
            } else {
                console.error('Received answer from unknown peer:', senderId);
            }
        } catch (err) {
            console.error('Error handling answer:', err);
            updateStatus('Error handling answer: ' + err.message, false);
        }
    }

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
            updateStatus('Connected to peer!', true);
            if (hostInfoEl) hostInfoEl.style.display = 'none';
            if (clientInfoEl) clientInfoEl.style.display = 'none';
            
            sendMessage({
                type: 'greeting',
                message: 'Hello from FileSender!'
            });
            
            connection = peer;
            console.log('Connection variable set:', !!connection);
        });

        peer.on('data', (data) => {
            console.log('Received data from peer, size:', data.byteLength || data.length);
            receiveData(data);
        });

        peer.on('error', (err) => {
            console.error('Peer connection error:', err);
            updateStatus(`Connection error: ${err.message}`, false);
        });

        peer.on('close', () => {
            console.log('Peer connection closed');
            updateStatus('Connection closed', false);
            connection = null;
            peer = null;
            
            if (isHost && hostInfoEl) {
                hostInfoEl.style.display = 'block';
            }
        });
        
        console.log('Peer events setup complete');
    }

    function setupUIEvents() {
        // Copy button event
        if (copyButton && shareLinkInput) {
            copyButton.addEventListener('click', () => {
                shareLinkInput.select();
                navigator.clipboard.writeText(shareLinkInput.value).then(() => {
                    copyButton.textContent = 'Copied!';
                    setTimeout(() => {
                        copyButton.textContent = 'Copy';
                    }, 2000);
                }).catch(() => {
                    document.execCommand('copy');
                    copyButton.textContent = 'Copied!';
                    setTimeout(() => {
                        copyButton.textContent = 'Copy';
                    }, 2000);
                });
            });
        }
        
        // File drop zone
        if (dropZone && fileInput) {
            dropZone.addEventListener('click', () => {
                fileInput.click();
            });
    
            dropZone.addEventListener('dragover', (e) => {
                e.preventDefault();
                dropZone.classList.add('dragover');
            });
    
            dropZone.addEventListener('dragleave', () => {
                dropZone.classList.remove('dragover');
            });
    
            dropZone.addEventListener('drop', (e) => {
                e.preventDefault();
                dropZone.classList.remove('dragover');
                
                if (e.dataTransfer.files.length > 0) {
                    handleFiles(e.dataTransfer.files);
                }
            });
    
            fileInput.addEventListener('change', (e) => {
                if (e.target.files.length > 0) {
                    handleFiles(e.target.files);
                }
            });
        }
        
        // Initialize tab system - CRITICAL FIX
        initializeTabs();
        
        // Add empty state messages to file lists
        addEmptyStateMessages();
    }
    
    // NEW FUNCTION: Initialize tabs properly
    function initializeTabs() {
        const tabs = document.querySelectorAll('.tab');
        const containers = document.querySelectorAll('.list-container');
        
        console.log('Initializing tabs:', tabs.length, 'containers:', containers.length);
        
        // First, hide all containers and remove active classes
        containers.forEach((container, index) => {
            container.classList.remove('active');
            container.style.display = 'none';
            console.log(`Container ${index} hidden`);
        });
        
        // Remove active class from all tabs
        tabs.forEach(tab => {
            tab.classList.remove('active');
        });
        
        // Activate first tab and container
        if (tabs.length > 0 && containers.length > 0) {
            tabs[0].classList.add('active');
            containers[0].classList.add('active');
            containers[0].style.display = 'block';
            console.log('First tab and container activated');
        }
        
        // Add click event listeners to tabs
        tabs.forEach((tab, index) => {
            tab.addEventListener('click', () => {
                const tabType = tab.getAttribute('data-tab');
                console.log(`Tab clicked: ${tabType} (index: ${index})`);
                
                // Remove active class from all tabs
                tabs.forEach(t => t.classList.remove('active'));
                
                // Hide all containers
                containers.forEach(c => {
                    c.classList.remove('active');
                    c.style.display = 'none';
                });
                
                // Activate clicked tab
                tab.classList.add('active');
                
                // Show corresponding container
                const targetContainer = document.querySelector(`.list-container[data-content="${tabType}"]`);
                if (targetContainer) {
                    targetContainer.classList.add('active');
                    targetContainer.style.display = 'block';
                    console.log(`Activated container for ${tabType}`);
                } else {
                    console.error(`Container not found for tab: ${tabType}`);
                }
            });
        });
    }
    
    // ALSO ADD this function to be called after DOM is fully loaded:
    function ensureTabsInitialized() {
        // Wait a bit for DOM to settle, then ensure tabs are properly initialized
        setTimeout(() => {
            const containers = document.querySelectorAll('.list-container');
            const activeContainer = document.querySelector('.list-container.active');
            
            if (!activeContainer) {
                console.log('No active container found, forcing initialization');
                if (containers.length > 0) {
                    containers[0].classList.add('active');
                    containers[0].style.display = 'block';
                    
                    // Also ensure first tab is active
                    const firstTab = document.querySelector('.tab');
                    if (firstTab) {
                        firstTab.classList.add('active');
                    }
                }
            }
            
            // Double-check that non-active containers are hidden
            containers.forEach(container => {
                if (!container.classList.contains('active')) {
                    container.style.display = 'none';
                }
            });
        }, 100);
    }

// ALSO UPDATE the addEmptyStateMessages function:

function addEmptyStateMessages() {
    const filesToSendList = document.getElementById('files-to-send');
    const receivedFilesList = document.getElementById('received-files');
    
    // Function to add empty state if needed
    const addEmptyStateIfNeeded = (listElement, message, iconClass) => {
        if (!listElement) return;
        
        const fileItems = Array.from(listElement.children).filter(child => 
            !child.classList.contains('empty-state'));
        
        if (fileItems.length === 0 && !listElement.querySelector('.empty-state')) {
            const emptyMessage = document.createElement('li');
            emptyMessage.className = 'empty-state';
            emptyMessage.innerHTML = `<i class="fas ${iconClass}"></i> ${message}`;
            emptyMessage.style.cssText = `
                display: flex !important;
                align-items: center;
                justify-content: center;
                height: 150px;
                color: rgba(224, 224, 255, 0.6);
                font-style: italic;
                text-align: center;
                background-color: rgba(30, 40, 70, 0.2);
                border: 2px dashed rgba(66, 134, 244, 0.3);
                border-radius: 8px;
                margin: 20px 0;
                flex-direction: column;
                gap: 10px;
            `;
            listElement.appendChild(emptyMessage);
        }
    };
    
    // Add initial empty states
    addEmptyStateIfNeeded(filesToSendList, 'No files selected for sending', 'fa-paper-plane');
    addEmptyStateIfNeeded(receivedFilesList, 'No files received yet', 'fa-inbox');
    
    // Set up mutation observers to manage empty state messages
    setupEmptyStateObservers(filesToSendList, 'No files selected for sending', 'fa-paper-plane');
    setupEmptyStateObservers(receivedFilesList, 'No files received yet', 'fa-inbox');
}

function setupEmptyStateObservers(listElement, emptyMessage, iconClass) {
    if (!listElement) return;
    
    const observer = new MutationObserver(mutations => {
        mutations.forEach(mutation => {
            if (mutation.type === 'childList') {
                const fileItems = Array.from(listElement.children).filter(child => 
                    !child.classList.contains('empty-state'));
                
                if (fileItems.length > 0) {
                    // Remove empty state messages
                    const emptyStates = listElement.querySelectorAll('.empty-state');
                    emptyStates.forEach(el => el.remove());
                } else if (listElement.querySelectorAll('.empty-state').length === 0) {
                    // Add empty state message
                    const emptyEl = document.createElement('li');
                    emptyEl.className = 'empty-state';
                    emptyEl.innerHTML = `<i class="fas ${iconClass}"></i> ${emptyMessage}`;
                    emptyEl.style.cssText = `
                        display: flex !important;
                        align-items: center;
                        justify-content: center;
                        height: 150px;
                        color: rgba(224, 224, 255, 0.6);
                        font-style: italic;
                        text-align: center;
                        background-color: rgba(30, 40, 70, 0.2);
                        border: 2px dashed rgba(66, 134, 244, 0.3);
                        border-radius: 8px;
                        margin: 20px 0;
                        flex-direction: column;
                        gap: 10px;
                    `;
                    listElement.appendChild(emptyEl);
                }
            }
        });
    });
    
    observer.observe(listElement, { childList: true });
}
    
    function getFileTypeIcon(fileName) {
        const extension = fileName.split('.').pop().toLowerCase();
        
        const fileTypes = {
            'jpg': 'fa-file-image', 'jpeg': 'fa-file-image', 'png': 'fa-file-image',
            'gif': 'fa-file-image', 'svg': 'fa-file-image', 'webp': 'fa-file-image',
            'pdf': 'fa-file-pdf', 'doc': 'fa-file-word', 'docx': 'fa-file-word',
            'xls': 'fa-file-excel', 'xlsx': 'fa-file-excel',
            'ppt': 'fa-file-powerpoint', 'pptx': 'fa-file-powerpoint',
            'txt': 'fa-file-alt', 'rtf': 'fa-file-alt',
            'zip': 'fa-file-archive', 'rar': 'fa-file-archive', '7z': 'fa-file-archive',
            'tar': 'fa-file-archive', 'gz': 'fa-file-archive',
            'mp3': 'fa-file-audio', 'wav': 'fa-file-audio', 'ogg': 'fa-file-audio',
            'mp4': 'fa-file-video', 'avi': 'fa-file-video', 'mov': 'fa-file-video',
            'wmv': 'fa-file-video', 'html': 'fa-file-code', 'css': 'fa-file-code',
            'js': 'fa-file-code', 'json': 'fa-file-code', 'php': 'fa-file-code',
            'py': 'fa-file-code', 'java': 'fa-file-code', 'c': 'fa-file-code',
            'cpp': 'fa-file-code', 'cs': 'fa-file-code', 'rb': 'fa-file-code',
            'go': 'fa-file-code', 'ts': 'fa-file-code'
        };
        
        return fileTypes[extension] || 'fa-file';
    }

    function createFileElement(file, type) {
        console.log('createFileElement called with:', { file, type });
        const li = document.createElement('li');
        li.className = 'file-item';
        li.style.animationDelay = `${Math.random() * 0.5}s`;
        
        const fileIcon = document.createElement('div');
        fileIcon.className = 'file-icon';
        const iconElement = document.createElement('i');
        iconElement.className = `fas ${getFileTypeIcon(file.name)}`;
        fileIcon.appendChild(iconElement);
        li.appendChild(fileIcon);
        
        const fileInfo = document.createElement('div');
        fileInfo.className = 'file-info';
        
        const fileName = document.createElement('div');
        fileName.className = 'file-name';
        fileName.textContent = file.name;
        
        const fileSize = document.createElement('div');
        fileSize.className = 'file-size';
        fileSize.textContent = formatBytes(file.size);
        
        fileInfo.appendChild(fileName);
        fileInfo.appendChild(fileSize);
        li.appendChild(fileInfo);
        
        console.log('File element created successfully');
        return li;
    }

    function addFileToUI(listElement, fileId, fileName, fileSize, status) {
        console.log('addFileToUI called:', { listElement: listElement?.id, fileId, fileName, fileSize, status });
        
        if (!listElement) {
            console.error('List element is null');
            return;
        }
        
        const fileType = listElement === receivedFilesList ? 'receive' : 'send';
        console.log('File type determined as:', fileType);
        
        const li = createFileElement({ name: fileName, size: fileSize }, fileType);
        li.id = `file-${fileId}`;
        console.log('Created file element with ID:', li.id);
        
        // Add progress bar
        const progressBar = document.createElement('div');
        progressBar.className = 'progress-bar-container';
        const progressBarInner = document.createElement('div');
        progressBarInner.className = 'progress-bar';
        progressBarInner.style.width = '0%';
        progressBar.appendChild(progressBarInner);
        
        li.querySelector('.file-info').appendChild(progressBar);
        
        // Add status tag
        const statusTag = document.createElement('div');
        statusTag.className = `status-tag ${fileType === 'receive' ? 'tag-receiving' : 'tag-sending'}`;
        statusTag.textContent = status;
        statusTag.style.cssText = 'display: inline-flex !important; visibility: visible !important;';
        li.appendChild(statusTag);
        
        // For received files, add a download button (initially hidden)
        if (fileType === 'receive') {
            const downloadLink = document.createElement('a');
            downloadLink.className = 'download-button';
            downloadLink.href = '#';
            downloadLink.download = fileName;
            downloadLink.style.display = 'none';
            
            const downloadIcon = document.createElement('i');
            downloadIcon.className = 'fas fa-download';
            downloadLink.appendChild(downloadIcon);
            
            const downloadText = document.createElement('span');
            downloadText.className = 'download-text';
            downloadText.textContent = 'Download';
            downloadLink.appendChild(downloadText);
            
            // IMPROVED: Better download handler that prevents double downloads
            downloadLink.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                
                console.log('Manual download requested for:', fileName);
                
                // Find the file in history
                const fileInfo = fileHistory.received.find(f => f.fileId === fileId);
                if (fileInfo && fileInfo.blob) {
                    // Create fresh URL for download
                    const url = URL.createObjectURL(fileInfo.blob);
                    
                    triggerFileDownload(url, fileName);
                    
                    // Clean up the temporary URL after download
                    setTimeout(() => {
                        URL.revokeObjectURL(url);
                    }, 1000);
                    
                    console.log('Manual download completed for:', fileName);
                } else {
                    alert('File data no longer available. Please request the file again.');
                }
            });
            
            li.appendChild(downloadLink);
        }
        
        console.log('Appending file element to list:', listElement?.id);
        listElement.appendChild(li);
        console.log('File element appended successfully');
        
        // Add to history for sent files
        if (fileType === 'send') {
            fileHistory.sent.push({
                fileId: fileId,
                fileName: fileName,
                timestamp: Date.now()
            });
        }
        
        // Maintain file limit
        maintainFileLimit(fileType);
        
        // Make sure the list is visible
        if (listElement && listElement.parentElement) {
            listElement.parentElement.style.display = 'block';
            const fileListsContainer = document.querySelector('.file-lists');
            if (fileListsContainer) {
                fileListsContainer.style.display = 'flex';
            }
        }
    }
    
    // UPDATED updateFileStatus function
    function updateFileStatus(listElement, fileId, status, progress, downloadUrl = null, fileName = null) {
        const li = document.getElementById(`file-${fileId}`);
        if (!li) return;
        
        // Update progress bar
        const progressBar = li.querySelector('.progress-bar');
        if (progressBar) {
            progressBar.style.width = `${progress}%`;
        }
        
        // Update status tag
        const statusTag = li.querySelector('.status-tag');
        if (statusTag) {
            const isActive = (
                (status === 'Queued' && progress === 0) ||
                (status.includes('Sending') && progress < 100) ||
                (status === 'Complete' && progress === 100) ||
                (status === 'Received' && downloadUrl) ||
                status.includes('Error')
            );
            
            if (isActive) {
                statusTag.textContent = status;
                statusTag.style.display = 'inline-flex';
                
                statusTag.className = 'status-tag';
                if (status.includes('Sending')) {
                    statusTag.classList.add('tag-sending');
                } else if (status === 'Complete') {
                    statusTag.classList.add('tag-complete');
                } else if (status === 'Received') {
                    statusTag.classList.add('tag-received');
                } else if (status.includes('Error')) {
                    statusTag.classList.add('tag-error');
                } else if (status === 'Queued') {
                    statusTag.classList.add('tag-queued');
                }
            } else {
                statusTag.style.display = 'none';
            }
        }
        
        // Show download button for completed received files
        if (downloadUrl && fileName && status === 'Received') {
            const downloadLink = li.querySelector('.download-button');
            if (downloadLink) {
                downloadLink.style.display = 'flex';
                // Update the href for initial download (but the click handler will handle re-downloads)
                downloadLink.href = downloadUrl;
            }
        }
    }

    function handleFiles(fileList) {
        console.log('handleFiles called with:', fileList.length, 'files');
        console.log('Connection status:', !!connection);
        
        if (!connection) {
            console.error('No active connection when trying to handle files');
            alert('No active connection. Please connect to a peer first.');
            return;
        }

        console.log('Processing files...');
        Array.from(fileList).forEach(file => {
            console.log('Processing file:', file.name, file.size);
            const fileId = generateId();
            
            transferQueue.push({
                fileId: fileId,
                file: file
            });
            
            console.log('Adding file to UI:', fileId, file.name);
            addFileToUI(filesToSendList, fileId, file.name, file.size, 'Queued');
        });
        
        console.log('Transfer queue length:', transferQueue.length);
        console.log('Chunks in flight:', chunksInFlight);
        
        if (chunksInFlight === 0) {
            console.log('Starting to process transfer queue...');
            processTransferQueue();
        }
    }

    function processTransferQueue() {
        if (transferQueue.length === 0 || chunksInFlight >= MAX_CHUNKS_IN_FLIGHT) {
            return;
        }
        
        const { fileId, file } = transferQueue.shift();
        
        filesToSend[fileId] = {
            file: file,
            progress: 0,
            sent: false,
            chunks: Math.ceil(file.size / CHUNK_SIZE)
        };
        
        sendFileMetadata(fileId, file);
        sendFileChunks(fileId, file);
    }

    function sendFileMetadata(fileId, file) {
        sendMessage({
            type: 'file-metadata',
            fileId: fileId,
            name: file.name,
            size: file.size,
            chunks: Math.ceil(file.size / CHUNK_SIZE),
            mimeType: file.type
        });
    }

    function sendFileChunks(fileId, file) {
        const reader = new FileReader();
        let offset = 0;
        let chunkIndex = 0;
        
        const sendNextChunk = () => {
            if (offset >= file.size) {
                updateFileStatus(filesToSendList, fileId, 'Sent', 100);
                filesToSend[fileId].sent = true;
                
                sendMessage({
                    type: 'file-complete',
                    fileId: fileId
                });
                
                chunksInFlight--;
                processTransferQueue();
                return;
            }
            
            if (chunksInFlight >= MAX_CHUNKS_IN_FLIGHT) {
                setTimeout(sendNextChunk, 100);
                return;
            }
            
            const chunk = file.slice(offset, offset + CHUNK_SIZE);
            reader.readAsArrayBuffer(chunk);
        };
        
        reader.onload = (e) => {
            if (!connection) {
                updateFileStatus(filesToSendList, fileId, 'Error: Connection lost', 0);
                chunksInFlight--;
                processTransferQueue();
                return;
            }
            
            sendFileChunk(fileId, chunkIndex, e.target.result);
            chunksInFlight++;
            
            offset += e.target.result.byteLength;
            chunkIndex++;
            const progress = Math.min(100, Math.floor((offset / file.size) * 100));
            filesToSend[fileId].progress = progress;
            
            updateFileStatus(filesToSendList, fileId, `Sending ${progress}%`, progress);
            
            setTimeout(sendNextChunk, 0);
        };
        
        reader.onerror = () => {
            updateFileStatus(filesToSendList, fileId, 'Error reading file', 0);
            chunksInFlight--;
            processTransferQueue();
        };
        
        chunksInFlight++;
        sendNextChunk();
    }

    function sendFileChunk(fileId, chunkIndex, chunk) {
        const metadata = {
            fileId: fileId,
            chunkIndex: chunkIndex
        };
        
        const metadataStr = JSON.stringify(metadata);
        const metadataBytes = new TextEncoder().encode(metadataStr);
        
        const metadataLength = metadataBytes.length;
        const combined = new Uint8Array(4 + metadataLength + chunk.byteLength);
        
        combined[0] = 1; // Marker for chunk data
        combined[1] = metadataLength & 0xFF;
        combined[2] = (metadataLength >> 8) & 0xFF;
        combined[3] = (metadataLength >> 16) & 0xFF;
        
        combined.set(metadataBytes, 4);
        combined.set(new Uint8Array(chunk), 4 + metadataLength);
        
        connection.send(combined.buffer);
    }

    function sendMessage(message) {
        if (!connection) {
            console.error('Cannot send message: No connection');
            return;
        }
        
        const jsonString = JSON.stringify(message);
        const jsonBytes = new TextEncoder().encode(jsonString);
        
        const combined = new Uint8Array(jsonBytes.length + 1);
        combined[0] = 0; // Marker for JSON data
        combined.set(jsonBytes, 1);
        
        connection.send(combined.buffer);
    }

    function receiveData(data) {
        const dataView = new Uint8Array(data);
        const marker = dataView[0];
        
        if (marker === 0) {
            const jsonBytes = dataView.slice(1);
            const jsonString = new TextDecoder().decode(jsonBytes);
            const message = JSON.parse(jsonString);
            handleMessage(message);
        } else if (marker === 1) {
            handleFileChunk(data);
        } else {
            console.error('Unknown data marker:', marker);
        }
    }

    function handleMessage(message) {
        console.log('Received message:', message);
        
        switch (message.type) {
            case 'greeting':
                console.log('Peer says:', message.message);
                break;
                
            case 'file-metadata':
                receivedFiles[message.fileId] = {
                    metadata: message,
                    chunks: new Array(message.chunks),
                    receivedChunks: 0,
                    complete: false
                };
                
                addFileToUI(receivedFilesList, message.fileId, message.name, message.size, 'Receiving 0%');
                break;
                
            case 'file-complete':
                const fileData = receivedFiles[message.fileId];
                if (fileData && fileData.receivedChunks === fileData.metadata.chunks) {
                    assembleAndSaveFile(message.fileId);
                } else if (fileData) {
                    console.warn(`File complete message received but only ${fileData.receivedChunks}/${fileData.metadata.chunks} chunks received`);
                }
                break;
                
            case 'chunk-received':
                chunksInFlight--;
                processTransferQueue();
                break;
        }
    }

 // REPLACE these two functions in your script.js file:

function handleFileChunk(data) {
    try {
        const dataView = new Uint8Array(data);
        
        // Extract metadata length (3 bytes, little-endian)
        const metadataLength = dataView[1] | (dataView[2] << 8) | (dataView[3] << 16);
        
        // Extract metadata
        const metadataBytes = dataView.slice(4, 4 + metadataLength);
        const metadataStr = new TextDecoder().decode(metadataBytes);
        const metadata = JSON.parse(metadataStr);
        
        const { fileId, chunkIndex } = metadata;
        
        // CRITICAL FIX: Extract chunk data as ArrayBuffer to preserve binary data
        const chunkData = data.slice(4 + metadataLength);
        
        // Store the chunk
        if (receivedFiles[fileId]) {
            const fileData = receivedFiles[fileId];
            
            // Verify chunk index is valid
            if (chunkIndex < 0 || chunkIndex >= fileData.metadata.chunks) {
                console.error(`Invalid chunk index ${chunkIndex} for file ${fileId}`);
                return;
            }
            
            // CRITICAL FIX: Store chunk as ArrayBuffer to preserve binary data
            fileData.chunks[chunkIndex] = chunkData;
            fileData.receivedChunks++;
            
            console.log(`Received chunk ${chunkIndex}/${fileData.metadata.chunks - 1} for ${fileData.metadata.name} (${chunkData.byteLength} bytes)`);
            
            // Update progress
            const progress = Math.min(100, Math.floor((fileData.receivedChunks / fileData.metadata.chunks) * 100));
            updateFileStatus(receivedFilesList, fileId, `Receiving ${progress}%`, progress);
            
            // Acknowledge chunk received
            sendMessage({
                type: 'chunk-received',
                fileId: fileId,
                chunkIndex: chunkIndex
            });
            
            // Check if file is complete
            if (fileData.receivedChunks === fileData.metadata.chunks) {
                console.log(`All chunks received for ${fileData.metadata.name}, assembling file...`);
                fileData.complete = true;
                assembleAndSaveFile(fileId);
            }
        } else {
            console.error('Received chunk for unknown file:', fileId);
        }
    } catch (err) {
        console.error('Error handling file chunk:', err);
    }
}

function assembleAndSaveFile(fileId) {
    const fileData = receivedFiles[fileId];
    if (!fileData) {
        console.error('No file data found for fileId:', fileId);
        return;
    }
    
    const chunks = fileData.chunks;
    const mimeType = fileData.metadata.mimeType;
    const fileName = fileData.metadata.name;
    
    console.log('Assembling file:', fileName);
    console.log('Total chunks:', chunks.length);
    console.log('Chunks received:', fileData.receivedChunks);
    
    // CRITICAL FIX: Verify all chunks are present and convert to proper format
    const validChunks = [];
    let totalSize = 0;
    
    for (let i = 0; i < chunks.length; i++) {
        if (!chunks[i]) {
            console.error(`Missing chunk ${i} for file ${fileName}`);
            updateFileStatus(receivedFilesList, fileId, 'Error: Missing chunks', 0);
            return;
        }
        
        // Convert chunk to Uint8Array if it's an ArrayBuffer
        let chunkData;
        if (chunks[i] instanceof ArrayBuffer) {
            chunkData = new Uint8Array(chunks[i]);
        } else if (chunks[i] instanceof Uint8Array) {
            chunkData = chunks[i];
        } else {
            console.error('Invalid chunk type at index', i, ':', typeof chunks[i]);
            updateFileStatus(receivedFilesList, fileId, 'Error: Invalid chunk data', 0);
            return;
        }
        
        validChunks.push(chunkData);
        totalSize += chunkData.byteLength;
    }
    
    console.log('Original file size:', fileData.metadata.size);
    console.log('Assembled size:', totalSize);
    
    // Verify file size matches (allow small difference due to chunking)
    if (Math.abs(totalSize - fileData.metadata.size) > CHUNK_SIZE) {
        console.error(`File size mismatch! Expected: ${fileData.metadata.size}, Got: ${totalSize}`);
        updateFileStatus(receivedFilesList, fileId, 'Error: Size mismatch', 0);
        return;
    }
    
    // CRITICAL FIX: Create blob with proper MIME type and binary data
    const blob = new Blob(validChunks, { 
        type: mimeType || 'application/octet-stream' 
    });
    
    console.log('Final blob size:', blob.size);
    
    // CRITICAL FIX: Store blob data for persistent downloads
    fileHistory.received.push({
        fileId: fileId,
        fileName: fileName,
        blob: blob,
        timestamp: Date.now(),
        autoDownloaded: false // Track if auto-download has occurred
    });
    
    // Create download URL that won't be revoked immediately
    const url = URL.createObjectURL(blob);
    
    // Update UI to show file is ready for download
    updateFileStatus(receivedFilesList, fileId, 'Received', 100, url, fileName);
    
    // CONFIGURABLE AUTO-DOWNLOAD: Only auto-download if enabled and not already downloaded
    const fileInfo = fileHistory.received.find(f => f.fileId === fileId);
    if (AUTO_DOWNLOAD_ENABLED && fileInfo && !fileInfo.autoDownloaded) {
        console.log('Auto-downloading file:', fileName);
        triggerFileDownload(url, fileName);
        fileInfo.autoDownloaded = true; // Mark as auto-downloaded
    } else if (!AUTO_DOWNLOAD_ENABLED) {
        console.log('Auto-download disabled. File ready for manual download:', fileName);
    }
    
    // Clean up old files and maintain max limit
    maintainFileLimit('received');
    
    console.log('File assembled and ready for download:', fileName);
}

function triggerFileDownload(url, fileName) {
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    console.log('Download triggered for:', fileName);
}

function maintainFileLimit(type) {
    const isReceived = type === 'received';
    const history = isReceived ? fileHistory.received : fileHistory.sent;
    const listElement = isReceived ? receivedFilesList : filesToSendList;
    
    // Sort by timestamp (newest first)
    history.sort((a, b) => b.timestamp - a.timestamp);
    
    // If we have more than MAX_FILES_TO_KEEP, remove the oldest ones
    if (history.length > MAX_FILES_TO_KEEP) {
        const filesToRemove = history.splice(MAX_FILES_TO_KEEP);
        
        filesToRemove.forEach(fileInfo => {
            // Remove from UI
            const fileElement = document.getElementById(`file-${fileInfo.fileId}`);
            if (fileElement) {
                fileElement.remove();
                console.log(`Removed old file from UI: ${fileInfo.fileName}`);
            }
            
            // Clean up blob URLs for received files
            if (isReceived && fileInfo.blob) {
                // Find and revoke any URLs associated with this blob
                const downloadButton = fileElement?.querySelector('.download-button');
                if (downloadButton && downloadButton.href.startsWith('blob:')) {
                    URL.revokeObjectURL(downloadButton.href);
                }
                
                // Clean up the blob itself to free memory
                fileInfo.blob = null;
            }
            
            // Clean up from receivedFiles or filesToSend
            if (isReceived) {
                delete receivedFiles[fileInfo.fileId];
            } else {
                delete filesToSend[fileInfo.fileId];
            }
        });
        
        console.log(`Cleaned up ${filesToRemove.length} old ${type} files`);
    }
    
    // Update empty state if needed
    checkAndUpdateEmptyState(listElement);
}


function checkAndUpdateEmptyState(listElement) {
    if (!listElement) return;
    
    const fileItems = Array.from(listElement.children).filter(child => 
        !child.classList.contains('empty-state'));
    
    const emptyStates = listElement.querySelectorAll('.empty-state');
    
    if (fileItems.length === 0 && emptyStates.length === 0) {
        // Add empty state
        const message = listElement === receivedFilesList ? 
            'No files received yet' : 'No files selected for sending';
        const iconClass = listElement === receivedFilesList ? 
            'fa-inbox' : 'fa-paper-plane';
            
        const emptyEl = document.createElement('li');
        emptyEl.className = 'empty-state';
        emptyEl.innerHTML = `<i class="fas ${iconClass}"></i> ${message}`;
        emptyEl.style.cssText = `
            display: flex !important;
            align-items: center;
            justify-content: center;
            height: 150px;
            color: rgba(224, 224, 255, 0.6);
            font-style: italic;
            text-align: center;
            background-color: rgba(30, 40, 70, 0.2);
            border: 2px dashed rgba(66, 134, 244, 0.3);
            border-radius: 8px;
            margin: 20px 0;
            flex-direction: column;
            gap: 10px;
        `;
        listElement.appendChild(emptyEl);
    } else if (fileItems.length > 0) {
        // Remove empty states
        emptyStates.forEach(el => el.remove());
    }
}

 // Initialize the application
 init();
    
 // ADD THIS LINE at the very end of DOMContentLoaded:
 ensureTabsInitialized();

});

window.addEventListener('beforeunload', () => {
    console.log('Cleaning up blob URLs and memory...');
    
    // Clean up all blob URLs to prevent memory leaks
    fileHistory.received.forEach(fileInfo => {
        if (fileInfo.blob) {
            const fileElement = document.getElementById(`file-${fileInfo.fileId}`);
            const downloadButton = fileElement?.querySelector('.download-button');
            if (downloadButton && downloadButton.href.startsWith('blob:')) {
                URL.revokeObjectURL(downloadButton.href);
            }
            
            // Clear blob reference
            fileInfo.blob = null;
        }
    });
    
    // Clear file history arrays
    fileHistory.received.length = 0;
    fileHistory.sent.length = 0;
    
    console.log('Cleanup completed');
});

// Export functions for testing if needed
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        generateId,
        formatBytes
    };
}