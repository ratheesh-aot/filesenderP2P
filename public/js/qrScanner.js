/**
 * Camera QR scan. Uses the browser barcode detector when it exists,
 * and falls back to the local jsQR build.
 */

let active = null;
let jsQRPromise = null;

export function cancelQrScan() {
    const session = active;
    active = null;
    if (!session) return;
    session.stopped = true;
    release(session);
    session.finish?.(null);
}

/**
 * Open the camera and resolve with the first QR text that shouldAccept allows.
 * Resolves null when the scan is cancelled. Rejects if the camera cannot start.
 * @param {{ video: HTMLVideoElement, onStatus?: (text: string) => void, shouldAccept?: (text: string) => boolean }} opts
 * @returns {Promise<string|null>}
 */
export async function scanQrCode({ video, onStatus, shouldAccept }) {
    cancelQrScan();

    if (!window.isSecureContext) {
        throw new Error('The camera needs a secure page. Use HTTPS or localhost, or paste the link.');
    }
    if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('This browser cannot open a camera. Paste the share link instead.');
    }

    const session = { stopped: false, stream: null, video, timer: null, finish: null };
    active = session;

    let stream;
    try {
        stream = await openCamera();
    } catch (err) {
        if (active === session) active = null;
        throw new Error(cameraMessage(err));
    }

    if (session.stopped || active !== session) {
        stream.getTracks().forEach((track) => track.stop());
        return null;
    }

    session.stream = stream;
    video.srcObject = stream;
    video.setAttribute('playsinline', '');
    try {
        await video.play();
    } catch {
        release(session);
        if (active === session) active = null;
        throw new Error('The camera preview could not start.');
    }

    let read;
    try {
        read = await createReader();
    } catch {
        release(session);
        if (active === session) active = null;
        throw new Error('QR scanning is not available in this browser. Paste the share link instead.');
    }

    if (session.stopped || active !== session) {
        release(session);
        return null;
    }

    onStatus?.('Point the camera at the host QR code.');

    return new Promise((resolve) => {
        session.finish = (value) => {
            session.finish = null;
            resolve(value);
        };

        const tick = async () => {
            if (session.stopped || active !== session) return;
            try {
                const text = await read(video);
                if (session.stopped || active !== session) return;
                if (text && (!shouldAccept || shouldAccept(text))) {
                    session.stopped = true;
                    release(session);
                    if (active === session) active = null;
                    session.finish?.(text);
                    return;
                }
            } catch {
                /* A single missed frame should not stop the camera. */
            }
            if (!session.stopped && active === session) {
                session.timer = setTimeout(tick, 200);
            }
        };

        session.timer = setTimeout(tick, 200);
    });
}

function release(session) {
    if (session.timer) clearTimeout(session.timer);
    session.timer = null;
    if (session.stream) {
        session.stream.getTracks().forEach((track) => track.stop());
        session.stream = null;
    }
    if (session.video && session.video.srcObject) session.video.srcObject = null;
}

async function openCamera() {
    const attempts = [
        { audio: false, video: { facingMode: { ideal: 'environment' } } },
        { audio: false, video: true },
    ];
    let lastError;
    for (const constraints of attempts) {
        try {
            return await navigator.mediaDevices.getUserMedia(constraints);
        } catch (err) {
            lastError = err;
            if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) break;
        }
    }
    throw lastError || new Error('camera');
}

function cameraMessage(err) {
    switch (err?.name) {
        case 'NotAllowedError':
        case 'PermissionDeniedError':
            return 'Camera permission was blocked. Allow the camera, or paste the link.';
        case 'NotFoundError':
        case 'DevicesNotFoundError':
            return 'No camera was found on this device. Paste the link instead.';
        case 'NotReadableError':
        case 'TrackStartError':
            return 'The camera is in use by another app.';
        case 'SecurityError':
            return 'The camera is blocked on this page. Use HTTPS or localhost, or paste the link.';
        default:
            return 'The camera could not be opened. Paste the link instead.';
    }
}

async function createReader() {
    if ('BarcodeDetector' in window) {
        try {
            const formats = await window.BarcodeDetector.getSupportedFormats?.();
            if (!formats || formats.includes('qr_code')) {
                const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
                return async (video) => {
                    if (!video.videoWidth) return '';
                    const codes = await detector.detect(video);
                    return codes[0]?.rawValue || '';
                };
            }
        } catch {
            /* Use jsQR below. */
        }
    }

    const jsQR = await loadJsQR();
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    return (video) => {
        const width = video.videoWidth;
        const height = video.videoHeight;
        if (!width || !height) return '';
        const scale = Math.min(1, 480 / width);
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(image.data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' });
        return code?.data || '';
    };
}

function loadJsQR() {
    if (typeof window.jsQR === 'function') return Promise.resolve(window.jsQR);
    if (!jsQRPromise) {
        jsQRPromise = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = '/js/vendor/jsQR.js';
            script.async = true;
            script.onload = () => {
                if (typeof window.jsQR === 'function') resolve(window.jsQR);
                else reject(new Error('jsQR missing'));
            };
            script.onerror = () => reject(new Error('jsQR failed to load'));
            document.head.appendChild(script);
        });
    }
    return jsQRPromise;
}
