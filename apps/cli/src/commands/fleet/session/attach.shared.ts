/**
 * Sessions on computers (FL-04 P2, spec FR-53) — the pure half of
 * `ever-works fleet session attach`: the detach chord and the socket URL.
 * Kept free of I/O so the spec drives it byte by byte.
 */

/** `Ctrl-]` — the chord's first key (0x1d), as in the classic terminal clients. */
export const DETACH_PREFIX = 0x1d;
/** The second key: `d` detaches. */
export const DETACH_KEY = 0x64;

/** The CLI's exit codes (spec FR-53): 0 detached / ended, 1 refused, 2 usage. */
export const SESSION_CLI_EXIT = { ok: 0, refused: 1, usage: 2 } as const;

/**
 * A stateful filter over stdin chunks: `Ctrl-]` then `d` detaches (neither key
 * reaches the session); `Ctrl-]` twice sends one `Ctrl-]`; `Ctrl-]` then any
 * other key sends both. Everything else passes through untouched.
 */
export function createDetachChord(): (chunk: Uint8Array) => {
    forward: Uint8Array;
    detach: boolean;
} {
    let armed = false;
    return (chunk) => {
        const out: number[] = [];
        for (const byte of chunk) {
            if (armed) {
                armed = false;
                if (byte === DETACH_KEY) return { forward: Uint8Array.from(out), detach: true };
                if (byte === DETACH_PREFIX) {
                    out.push(DETACH_PREFIX);
                    continue;
                }
                out.push(DETACH_PREFIX, byte);
                continue;
            }
            if (byte === DETACH_PREFIX) {
                armed = true;
                continue;
            }
            out.push(byte);
        }
        return { forward: Uint8Array.from(out), detach: false };
    };
}

/** The absolute socket URL for a `wsPath` the platform answered, from the API base the CLI calls. */
export function sessionSocketUrl(apiUrl: string, wsPath: string): string {
    const origin = apiUrl.replace(/\/+$/, '').replace(/\/api$/, '');
    return origin.replace(/^http/, 'ws') + (wsPath.startsWith('/') ? wsPath : `/${wsPath}`);
}
