/** A placeholder origin: only used to resolve a path, never requested. */
const PROBE_ORIGIN = 'https://palette.invalid';

/**
 * True when `value` is an in-app path the palette may navigate to: it starts
 * with `/`, holds no control character, and resolves on the application's own
 * origin.
 *
 * Security: Recent entries come from browser storage, which anything running
 * on the origin can write. A browser drops tab and newline characters while
 * parsing a URL, so `/<tab>/evil.example` becomes the protocol-relative
 * `//evil.example`; `/\evil.example` resolves off-site the same way. Checking
 * the prefix alone is not enough — the value is resolved exactly as the
 * browser would and must stay on the origin.
 */
export function isInAppDestination(value: unknown): value is string {
    if (typeof value !== 'string' || !value.startsWith('/')) return false;
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code < 0x20 || code === 0x7f) return false;
    }
    if (value.length > 1 && (value[1] === '/' || value[1] === '\\')) return false;
    try {
        return new URL(value, PROBE_ORIGIN).origin === PROBE_ORIGIN;
    } catch {
        return false;
    }
}
