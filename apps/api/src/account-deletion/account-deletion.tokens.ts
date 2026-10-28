import { createHash, randomBytes } from 'crypto';

/**
 * Pure helpers of the self-serve deletion link. Kept free of Nest and TypeORM
 * so the security-relevant rules (entropy, hashing, expiry, link shape) are
 * unit-tested on their own.
 */

/** 32 random bytes → 43 base64url characters. */
export const ACCOUNT_DELETION_TOKEN_BYTES = 32;

/** base64url of 32 bytes, no padding. Anything else is refused before a lookup. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export const ACCOUNT_DELETION_DEFAULT_TTL_MINUTES = 30;
export const ACCOUNT_DELETION_MIN_TTL_MINUTES = 5;
export const ACCOUNT_DELETION_MAX_TTL_MINUTES = 60;

/** Links issued per address per rolling hour; extra requests are dropped silently. */
export const ACCOUNT_DELETION_MAX_REQUESTS_PER_EMAIL_PER_HOUR = 3;

/** The one message every invalid / used / expired / revoked link gets. */
export const ACCOUNT_DELETION_LINK_INVALID_MESSAGE =
    'This link is invalid or has expired. Request a new one.';

export function generateDeletionToken(): string {
    return randomBytes(ACCOUNT_DELETION_TOKEN_BYTES).toString('base64url');
}

export function isWellFormedDeletionToken(token: unknown): token is string {
    return typeof token === 'string' && TOKEN_SHAPE.test(token);
}

/** sha256(token) in hex — the only form of the token the database ever sees. */
export function hashDeletionToken(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function normaliseDeletionEmail(email: string): string {
    return email.trim().toLowerCase();
}

/** sha256(lower(trim(email))) in hex — what audit rows and logs carry instead of the address. */
export function hashDeletionEmail(email: string): string {
    return createHash('sha256').update(normaliseDeletionEmail(email), 'utf8').digest('hex');
}

/** A short, log-safe handle for an address: the first 12 hex chars of its hash. */
export function emailLogRef(email: string): string {
    return `email#${hashDeletionEmail(email).slice(0, 12)}`;
}

/**
 * `ACCOUNT_DELETION_TOKEN_TTL_MINUTES`, clamped to 5..60; 30 when unset or
 * malformed.
 */
export function resolveDeletionTokenTtlMinutes(
    raw: string | undefined = process.env.ACCOUNT_DELETION_TOKEN_TTL_MINUTES,
): number {
    if (raw === undefined || raw.trim() === '' || !/^\d+$/.test(raw.trim())) {
        return ACCOUNT_DELETION_DEFAULT_TTL_MINUTES;
    }
    const parsed = Number.parseInt(raw.trim(), 10);
    return Math.min(
        ACCOUNT_DELETION_MAX_TTL_MINUTES,
        Math.max(ACCOUNT_DELETION_MIN_TTL_MINUTES, parsed),
    );
}

/**
 * Put the token into the link's FRAGMENT so it never reaches a server log or
 * a `Referer` header:
 * - `https://app/delete-account/confirm` → `…/confirm#token=<t>`
 * - a callback that already routes in its fragment (`https://app/#/auth/x`) →
 *   `https://app/#/auth/x?token=<t>` (still inside the fragment).
 */
export function buildDeletionLink(confirmUrl: string, token: string): string {
    const encoded = encodeURIComponent(token);
    if (confirmUrl.includes('#')) {
        return `${confirmUrl}${confirmUrl.includes('?', confirmUrl.indexOf('#')) ? '&' : '?'}token=${encoded}`;
    }
    return `${confirmUrl}#token=${encoded}`;
}

/** `jane@example.com` → `j***@example.com`. Shown on the confirm page, never logged. */
export function maskEmail(email: string | null | undefined): string | null {
    if (!email) return null;
    const at = email.lastIndexOf('@');
    if (at <= 0) return '***';
    return `${email[0]}***${email.slice(at)}`;
}
