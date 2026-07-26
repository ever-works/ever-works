import { createHash, timingSafeEqual } from 'crypto';

/**
 * The Fleet credential primitives, in one place.
 *
 * Enrollment, heartbeat and now the job-lease protocol all authenticate
 * with the SAME node secret and must therefore share ONE definition of
 * "verified" — a second, subtly-different compare in the job path would
 * be exactly the kind of drift that turns a hardened protocol into a
 * soft one.
 *
 * Posture (unchanged from `fleet.service.ts`, extracted verbatim):
 *   - credentials are stored ONLY as sha256 hex, never in plaintext;
 *   - verification is constant-time (`timingSafeEqual` behind an
 *     explicit length guard, since it throws on mismatched lengths);
 *   - nothing here ever throws — every invalid path returns
 *     false/null so the caller can map it to one undifferentiated 401.
 */

export const CREDENTIAL_MIN_LENGTH = 16;
export const CREDENTIAL_MAX_LENGTH = 256;

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function sha256Hex(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Constant-time equality with the terminal-attach posture: explicit
 * length guard BEFORE `timingSafeEqual` (which throws on mismatched
 * lengths), null-safe, and never throws.
 */
export function constantTimeEquals(stored: string | null | undefined, computed: string): boolean {
    if (typeof stored !== 'string' || stored.length === 0) return false;
    const storedBuf = Buffer.from(stored, 'utf8');
    const computedBuf = Buffer.from(computed, 'utf8');
    const lengthsMatch = storedBuf.length === computedBuf.length;
    const comparisonBuf = lengthsMatch ? computedBuf : Buffer.alloc(storedBuf.length);
    const bytesMatch = timingSafeEqual(storedBuf, comparisonBuf);
    return lengthsMatch && bytesMatch;
}

export interface VerifiedNodeCredential {
    /** The shape-validated node id. */
    nodeId: string;
    /** Constant-time compare of the presented secret against a stored hash. */
    matches(storedHash: string | null | undefined): boolean;
}

/**
 * Shape-validate a `(nodeId, secret)` pair off the wire and return a
 * verifier bound to the presented secret's hash.
 *
 * Returns `null` — not a throw — when either value is structurally
 * wrong, so an obviously-malformed credential is refused before any
 * database round-trip and with the same response as a wrong one.
 */
export function verifyNodeSecret(nodeId: unknown, secret: unknown): VerifiedNodeCredential | null {
    if (typeof nodeId !== 'string' || !UUID_RE.test(nodeId)) {
        return null;
    }
    if (
        typeof secret !== 'string' ||
        secret.length < CREDENTIAL_MIN_LENGTH ||
        secret.length > CREDENTIAL_MAX_LENGTH
    ) {
        return null;
    }
    const presentedHash = sha256Hex(secret);
    return {
        nodeId,
        matches: (storedHash) => constantTimeEquals(storedHash, presentedHash),
    };
}
