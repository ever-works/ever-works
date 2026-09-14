import { createHash, randomBytes } from 'node:crypto';
import { SHARED_VIEW_LIMITS } from '@ever-works/contracts/api';

/**
 * Shared view — the share token.
 *
 * The same posture as the Organization invitation token: 256 bits from the
 * operating system's CSPRNG, rendered URL-safe, and looked up only by its
 * `sha256`. Pure functions with no I/O, so they cannot log anything.
 */

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** A fresh 256-bit share token: 43 base64url characters, no padding. */
export function generateShareToken(): string {
    return randomBytes(SHARED_VIEW_LIMITS.tokenBytes).toString('base64url');
}

/** `sha256(token)` as lowercase hex — the only form of the token the public path touches. */
export function hashShareToken(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * True when a value has the exact shape of a share token. Checked before any
 * lookup so junk input never reaches the database, and so a lookup cannot be
 * steered with an unbounded string.
 */
export function isShareTokenShaped(value: unknown): value is string {
    return typeof value === 'string' && TOKEN_SHAPE.test(value);
}
