# FileSender P2P

A peer-to-peer file sharing web application that allows users to share files directly between browsers without a central server.

## Features

- 🚀 Direct peer-to-peer file transfer using WebRTC
- 🔗 Shareable link generation for easy connection
- 📁 Drag and drop file selection
- 📊 Real-time transfer progress tracking
- 🎨 Simple, animated, cartoon-like UI
- 📱 Works on both desktop and mobile browsers

## How It Works

1. The first user (Host) opens the application in their browser
2. The application generates a unique shareable link
3. The host shares this link with another user (Client)
4. When the client opens the link, a direct P2P connection is established
5. Both users can now drag and drop files to send to each other
6. Files are transferred directly between browsers without going through a server

## Technical Details

- Uses WebRTC for direct peer-to-peer data transfer
- PeerJS library simplifies WebRTC implementation
- Files are chunked and streamed for efficient transfer
- Supports large file transfers. When available, the browser's File System Access API is used to store incoming data directly to disk to avoid high memory usage.
- Works across different networks through STUN servers

## Getting Started

1. Clone this repository
2. Install dependencies: `npm install`
3. Start the server: `npm start`
4. Open `http://localhost:3000` in your browser
5. Share the generated link with another user

## Requirements

- Modern browser with WebRTC support (Chrome, Firefox, Edge, Safari)
- Node.js for running the local server

## Note

This is a client-side peer-to-peer application. The server is only used to serve the static files and is not involved in the file transfer process. All file transfers happen directly between browsers.
