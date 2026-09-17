import { createHash } from 'node:crypto';

/**
 * Safety rails (AW-24) — the digest that makes "approving executes the exact
 * thing" checkable.
 *
 * P2 stores the resolved payload of a held action and executes THAT, verbatim,
 * on approval. The digest is what turns that from a promise into an assertion:
 * the executor recomputes it immediately before executing and refuses on a
 * mismatch, so a payload edited between hold and execution cannot run.
 *
 * P1 ships the function and its test because the shape of a stored payload is
 * decided here, not in P2 — a canonicalisation that changed later would
 * invalidate every digest already written.
 *
 * ## Canonical form
 *
 * Object keys are sorted; `undefined` values are dropped (JSON has no
 * `undefined`, and a round-trip would otherwise change the digest); arrays
 * keep their order, because order is meaning in a recipient list or a command;
 * and `Date` is serialised as an ISO string rather than left to `toJSON`
 * ordering. Everything else is plain `JSON.stringify` semantics.
 */

/** Canonical JSON: sorted keys, no `undefined`, stable across key insertion order. */
export function canonicalJson(value: unknown): string {
    return JSON.stringify(canonicalise(value));
}

function canonicalise(value: unknown): unknown {
    if (value === null || value === undefined) return null;
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map((entry) => canonicalise(entry));
    if (typeof value !== 'object') return value;

    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
        const entry = source[key];
        // A key whose value is `undefined` is absent, not null: JSON.stringify
        // drops it, so keeping it here would make an object and its own
        // round-trip hash differently.
        if (entry === undefined) continue;
        out[key] = canonicalise(entry);
    }
    return out;
}

/**
 * sha256 of the canonical form, hex-encoded (64 characters — the width of the
 * `payloadDigest` column P2 adds).
 *
 * Two payloads that differ by one byte anywhere produce different digests;
 * two payloads that differ only in key order produce the same one.
 */
export function payloadDigest(payload: unknown): string {
    return createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
}
