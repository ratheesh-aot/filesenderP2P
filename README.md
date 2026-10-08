# FileSender P2P — Secure peer-to-peer file sharing

[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](LICENSE) [![WebRTC](https://img.shields.io/badge/WebRTC-100%25-green.svg)](https://webrtc.org)

A privacy-first, peer-to-peer file transfer web app. Files travel directly between browsers over an encrypted WebRTC data channel — never through a central server.

**Try it now:**  
> Host your browser, copy the share link or scan the QR code. A peer (phone or desktop) opens the link, connects in seconds, and transfers files at LAN speed.

---

## Highlights

| Feature | Description |
|---------|-------------|
| ⚡ Zero uploads | No server storage — WebRTC data channels only. |
| 🔒 End-to-end encrypted | WebRTC includes DTLS; files are opaque binary frames. |
| 📲 Desktop ↔ Phone | Works across different networks using public STUN servers. |
| 🔌 Offline-first PWA | Installable on Android/iOS; caches the app shell. |
| 🧪 Binary fast path | 60 KB chunks with per-chunk SHA-256 integrity. |
| 📊 Live speed & ETA | Rolling-window throughput estimation and time-to-completion. |

---

## Features

- **Peer-to-peer transfers** — Files flow directly between browsers
- **Shareable links & QR codes** — Open in another browser to connect (desktop ↔ phone)
- **Real-time progress** — Progress bars, speed in MB/s, and ETA
- **Pause / Resume / Cancel** — Control your transfers mid-flight
- **Per-chunk integrity** — SHA-256 verification on the receiver; block corrupted files
- **Unified activity feed** — One list showing sent and received transfers
- **Dark mode & settings** — System-aware theme, device name badge, auto-download toggle

---

## How to use

### Desktop → Desktop
1. Open the app in your browser  
2. Copy the share link or scan the QR code  
3. Open the same URL on another desktop computer  
4. Drop files on either side to send  

### Desktop → Mobile
1. Host from your desktop  
2. Copy the link or scan the QR on your phone  
3. Drop files from either side — transfers happen over the internet  

---

## Technical architecture

```
┌───────────────┐            ┌───────────────┐
│    Host       │◀──────────▶│    Client     │
│  (browser)    │  WebRTC    │  (browser)    │
│               │ Data Chan. │               │
└───────┬───────┘            └───────┬────────┘
        │                            │
        └───────────┐    ┌───────────┘
                    ▼    ▼
               ┌────────────┐
               │   Signaling│
               │  (Node.js) │
               └────────────┘
                    ▲
                    │ HTTP/WS
              Static files (Vercel/AWS/S3)
```

- **Signaling** — Simple WebSocket server (shared secret: `hostId`) to exchange ICE candidates and WebRTC offers/answers
- **WebRTC** — Direct data channel between peers (STUN-only, no TURN server)
- **App shell** — HTML + CSS + JS cached by service worker

---

## Deploying your own instance

### Option A: Vercel (recommended for quick demos)

1. Push this repo to GitHub
2. Create a new Vercel project and connect your repo  
3. Set the **Build Command** to `echo "Skip build"` (we serve static files)  
4. Set the **Output Directory** to `public`  
5. Under **Functions**, configure:
   - `/api/*` → Not used (but required)
6. Deploy and share your domain

> **Note**: Vercel’s serverless WebSockets have ~15s idle timeouts. The app includes auto-reconnect.

### Option B: Node.js server (self-hosted)

1. Install Node 20+  
   ```bash
   git clone https://github.com/<your-username>/filesenderP2P.git && cd filesenderP2P
   npm install
   ```
2. Run the server (port 3001 is default, update in `src/config.js` if needed)  
   ```bash
   npm start
   ```
3. Point your browser to `http://localhost:3001`
4. Expose port 3001 to the internet (firewall) and add HTTPS via Caddy/Nginx  
   ```nginx
   server {
       listen 443 ssl;
       server_name your-domain.com;
       ssl_certificate /path/to/cert.pem;
       ssl_certificate_key /path/to/key.pem;

       location / {
           proxy_pass http://localhost:3001;
           proxy_http_version 1.1;
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection "upgrade";
       }
   }
   ```

### Option C: Docker

```bash
docker build -t filesender .
docker run -d -p 3001:3001 --name fs2p filesender
```

---

## Protocol notes

### Frame format (binary file chunks)

- Header: `"FS2P"` magic + 32-bit LE `fileIndex` + 32-bit LE `chunkIndex` + 8-bit flags
- SHA-256 hash of payload (32 bytes)
- Payload (max 60 KB, under the WebRTC data-channel message limit)

Control messages are JSON over the same channel, distinguishing by frame type.

### Merkle root integrity

The sender computes a SHA-256 per-chunk and transmits the Merkle root in the metadata message. The receiver verifies each chunk hash individually; at completion, recomputes the root and compares — a mismatch triggers an error badge.

---

## Privacy & security

- **No uploads to server** — Only WebRTC signaling metadata passes through the Node.js backend.
- **Encryption** — WebRTC data channels use DTLS; files are opaque binary frames.
- **No authentication** — Anyone with the share link can connect. (Use for trusted networks or consider a shared-secret header if you add access control.)

---

## Limitations

- **Symmetric NATs** — Without a TURN server, some restrictive firewalls block connections. The UI surfaces clear errors if the connection cannot be established.
- **Multi-client rooms** — Currently only 1:1 (host ↔ client) is implemented, although the signaling server supports multiple clients per host.

---

## Contributing

PRs welcome! Please:
1. Keep PRs focused (one feature/bug per pull)
2. Run `npm start` and verify the app works on your local machine
3. For UI changes, include screenshots of dark/light modes

### Development quick-start

```bash
npm install
npm start          # Starts local server on port 3001
```

Test the E2E flow with a second browser tab or another machine.

---

## License

ISC. See [LICENSE](LICENSE) for details.

---

*Built with WebRTC, SimplePeer, and a commitment to privacy.*
