/**
 * Turn a scanned QR value or pasted share link into a host id on this site.
 * Full URLs must match pageOrigin so a code cannot send the browser elsewhere.
 */

const HOST_ID = /^[a-z0-9]{4,64}$/i;

/**
 * @param {string} text
 * @param {string} pageOrigin origin of the page that is joining, e.g. https://share.example
 * @returns {{ ok: true, hostId: string } | { ok: false, reason: 'empty' | 'invalid' | 'origin' }}
 */
export function parseHostTarget(text, pageOrigin) {
    const raw = String(text ?? '').trim();
    if (!raw) return { ok: false, reason: 'empty' };

    if (HOST_ID.test(raw)) return { ok: true, hostId: raw.toLowerCase() };

    let url;
    try {
        url = new URL(raw);
    } catch {
        return { ok: false, reason: 'invalid' };
    }

    if (pageOrigin && url.origin !== pageOrigin) return { ok: false, reason: 'origin' };

    const hostId = url.searchParams.get('host') || '';
    if (!HOST_ID.test(hostId)) return { ok: false, reason: 'invalid' };
    return { ok: true, hostId: hostId.toLowerCase() };
}
