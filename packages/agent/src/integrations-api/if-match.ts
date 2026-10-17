import { VersionMismatchError } from './integration-api.errors';

/**
 * `ETag` / `If-Match` for versioned aggregates (EW-P1-4, contract v1 B.1).
 * The ETag is the aggregate `version`, quoted: `"17"`. A weak validator
 * (`W/"17"`) is accepted too; `*` matches any existing version.
 */

/** The `ETag` header value for a version. */
export function etagFor(version: number): string {
    return `"${version}"`;
}

/**
 * The version an `If-Match` header names: `null` when the header is absent or
 * `*` (no precondition), `undefined` when it is present but not a version this
 * API issued (the caller answers `400 validation_failed`).
 */
export function parseIfMatch(
    header: string | string[] | undefined | null,
): number | null | undefined {
    const raw = Array.isArray(header) ? header[0] : header;
    if (raw === undefined || raw === null) return null;
    const value = raw.trim();
    if (value === '' || value === '*') return null;
    const match = /^(?:W\/)?"?(\d{1,10})"?$/.exec(value);
    if (!match) return undefined;
    const version = Number(match[1]);
    return Number.isSafeInteger(version) ? version : undefined;
}

/** Throws {@link VersionMismatchError} when `expected` is set and differs from `current`. */
export function assertIfMatch(expected: number | null, current: number): void {
    if (expected === null) return;
    if (expected !== current) throw new VersionMismatchError(expected, current);
}
