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
 * The credential columns `matchNodeCredential` reads. Structural rather
 * than `FleetNode`, so the API-edge guard can call it without importing
 * the entity graph.
 */
export interface FleetNodeCredentialColumns {
    enrollmentTokenHash?: string | null;
    /** sha256 of the credential replaced by the last self-rotation. */
    previousCredentialHash?: string | null;
    /** When that previous credential stops being accepted. */
    previousCredentialExpiresAt?: Date | string | null;
}

/**
 * Which of a node's two possible credentials was presented:
 * `'current'`, the in-window `'previous'` one, or neither.
 */
export type FleetNodeCredentialMatch = 'current' | 'previous' | null;

/**
 * The ONE dual-accept decision (EW-799).
 *
 * A node that rotates itself keeps working through the changeover
 * because BOTH the new credential and the one it replaced authenticate
 * for a bounded window. Four places verify a node credential — heartbeat,
 * the pause/unenroll path, the job lease/report channel and the
 * `/api/fleet/jobs/*` edge guard — and the window has to mean the same
 * thing in all four: update three and a rotated node beats happily while
 * its lease polls 401, i.e. a machine that looks healthy and does no
 * work. That is precisely the drift this module was extracted to prevent,
 * so the rule lives here once.
 *
 * Fail-closed rules, each load-bearing:
 *   - a MISSING or unparseable `previousCredentialExpiresAt` counts as
 *     EXPIRED, never as "no expiry" — same posture as `credentialIssuedAtMs`;
 *   - the window is strictly in the future: `expiresAt <= now` is over;
 *   - both compares are constant-time, and the current hash is tried
 *     first so the common path never touches the previous column;
 *   - callers that must NOT accept a stale credential (rotation itself)
 *     check for `'current'` specifically. Accepting `'previous'` there
 *     would let a captured old secret renew itself forever.
 */
export function matchNodeCredential(
    verified: VerifiedNodeCredential,
    node: FleetNodeCredentialColumns,
    now: number = Date.now(),
): FleetNodeCredentialMatch {
    if (verified.matches(node.enrollmentTokenHash)) {
        return 'current';
    }
    if (typeof node.previousCredentialHash !== 'string' || !node.previousCredentialHash) {
        return null;
    }
    const expiresAt = toEpochMs(node.previousCredentialExpiresAt);
    // NaN (missing / unparseable) fails this comparison, which is the
    // fail-closed answer we want — do not "helpfully" treat it as open.
    if (!(expiresAt > now)) {
        return null;
    }
    return verified.matches(node.previousCredentialHash) ? 'previous' : null;
}

/**
 * `Date | string` → epoch ms, or NaN when it is not a usable date.
 *
 * Accepts the string form because sqlite (the CI/e2e driver) hands
 * timestamps back as strings while Postgres hands back a `Date`; a
 * matcher that only understood one of them would fail open on the other.
 */
function toEpochMs(value: Date | string | null | undefined): number {
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'string') return new Date(value).getTime();
    return NaN;
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
