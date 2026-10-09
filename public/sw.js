/**
 * Service Worker for FileSender P2P
 *
 * App shell caching:
 *  - index.html and the manifest are cached first.
 *  - Static assets (CSS, JS, icons) are cached on first visit and updated on future visits.
 *  - WebRTC signaling traffic bypasses cache (POST/WS).
 *
 * The app is intentionally "network-first" for dynamic endpoints but
 * fully functional offline after the first visit.
 */

const CACHE_NAME = 'filesender-v10';
const STATIC_ASSETS = [
    '/',
    '/manifest.webmanifest',
    '/style.css',
    '/script.js',
    '/js/main.js',
    '/js/connectionManager.js',
    '/js/fileManager.js',
    '/js/transferManager.js',
    '/js/uiManager.js',
    '/js/utils.js',
    '/js/joinTarget.mjs',
    '/js/qrScanner.js',
    '/js/vendor/jsQR.js',
    '/icons/icon-72.svg',
    '/icons/icon-96.svg',
    '/icons/icon-128.svg',
    '/icons/icon-144.svg',
    '/icons/icon-152.svg',
    '/icons/icon-192.svg',
    '/icons/icon-512.svg',
];

// Install phase: populate cache
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(STATIC_ASSETS))
            .then(() => self.skipWaiting())
    );
});

// Activate phase: cleanup old caches
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) => Promise.all(
            keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
        ).then(() => self.clients.claim()))
    );
});

// Fetch phase: cache-first for static assets, network-first for others
self.addEventListener('fetch', (event) => {
    // Skip non-GET requests and WebSocket upgrades
    if (event.request.method !== 'GET' || event.request.headers.get('upgrade') === 'websocket') {
        return;
    }

    // Assets with revisioned URLs can be served from cache
    if (event.request.url.includes('/css/') || event.request.url.includes('/js/') ||
        event.request.url.includes('/icons/') || event.request.url.endsWith('.webmanifest')) {
        event.respondWith(cacheFirst(event));
        return;
    }

    // Everything else (HTML, data) tries network first, falls back to cache
    event.respondWith(networkFirst(event));
});

// --- Helper strategies ----------------------------------------------------------------

async function cacheFirst(event) {
    const cached = await caches.match(event.request);
    if (cached) return cached;

    try {
        const response = await fetch(event.request);
        if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
    } catch {
        // If offline and not found in cache, try a fallback
        if (event.request.url.includes('/icons/')) {
            return new Response('<svg xmlns="http://www.w3.org/2000/svg"><circle cx="50%" cy="50%" r="40%" fill="#3730a3"/></svg>', { headers: { 'content-type': 'image/svg+xml' } });
        }
        throw new Error('Network error');
    }
}

async function networkFirst(event) {
    try {
        const response = await fetch(event.request);
        if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
    } catch {
        const cached = await caches.match(event.request);
        if (cached) return cached;
        // Offline fallback for index
        if (event.request.url === self.location.href || event.request.url === '/') {
            return caches.match('/');
        }
        throw new Error('No internet connection and no cached version');
    }
}
