import { createHash } from 'crypto';

/**
 * APW-03 T12 — the canonical App spec hash (FR-23).
 *
 * > The spec hash MUST be computed over the `spec` block only, in a canonical
 * > form independent of key order and whitespace.
 *
 * Plan §3.1:412 fixes the value that goes in `headSpecHash` /
 * `effectiveSpecHash`:
 *
 * > sha256 of canonical JSON of `spec` (sorted keys, no whitespace).
 *
 * So this module is the **one** place that decides what "the same App spec"
 * means. It is pure, synchronous and dependency-free: no I/O, no clock, no
 * provider. Two documents that differ only in key order, in YAML quoting, in
 * comments or in indentation hash identically — which is exactly what FR-21
 * needs ("re-evaluating the same content MUST emit nothing") and what stops a
 * reformatted file from looking like a new spec.
 *
 * ## What is deliberately NOT canonicalised
 *
 * | Input | Behaviour | Why |
 * | ----- | --------- | --- |
 * | array order | **preserved** | `components[0]` is the primary web component and `env[]` order is the member's; sorting them would hash two genuinely different specs the same |
 * | `undefined` object values | **dropped** | `JSON.stringify` drops them, and `{ a: undefined }` and `{}` are the same spec as far as the platform is concerned |
 * | `null` | **kept** | `null` is a declared value, not an absence |
 * | `x-*` extension keys | **kept** | schema.md §2:74-75 preserves them, so two files differing in an extension key are two files — and folding them in cannot move a build, because every consumer reads named keys |
 * | a non-object (`null`, a string, an array) | `null` hash | the hash is defined **over the spec block**; a caller that holds no spec has no hash (`.d.ts`-free callers get `null`, never a hash of `"null"`) |
 *
 * The digest is lowercase hex sha256 — 64 characters, the width of both hash
 * columns (`work-app-spec-state.entity.ts:167-169`, `:197-199`), so a value
 * this module returns always fits the column it is written to.
 */

/**
 * The canonical JSON of a `spec` block: object keys sorted at **every** depth,
 * no insignificant whitespace, arrays in their declared order.
 *
 * Exported because the App spec tab and the drift guards want to show or
 * compare the canonical form without hashing it.
 */
export function canonicalAppSpecJson(spec: unknown): string {
    return JSON.stringify(canonicalise(spec));
}

/**
 * The sha256 of {@link canonicalAppSpecJson}, lowercase hex — or `null` when
 * there is no spec to hash.
 *
 * `null` (never `''`) is the "no spec" answer on purpose: an empty string is a
 * legitimate thing to store, and a caller that forgot to check would write a
 * hash for a document that does not exist.
 */
export function hashAppSpec(spec: unknown): string | null {
    if (!isHashable(spec)) {
        return null;
    }
    return createHash('sha256').update(canonicalAppSpecJson(spec), 'utf8').digest('hex');
}

/** Do two hashes describe the same spec, treating "no spec" as one value? */
export function appSpecHashesEqual(
    left: string | null | undefined,
    right: string | null | undefined,
): boolean {
    return (left ?? null) === (right ?? null);
}

/**
 * Is this a value the hash is defined over? An **object** (the `spec` block),
 * including `{}` — `{}` is a spec with nothing in it, and it has a hash. A
 * `null`, a string, a number or an array is not: `.works/works.yml`'s `spec:`
 * is a mapping, and hashing a non-mapping would answer "this is a spec" for a
 * value the validator has already refused.
 */
function isHashable(spec: unknown): boolean {
    return typeof spec === 'object' && spec !== null && !Array.isArray(spec);
}

/**
 * A copy of `value` whose object keys are sorted, recursively.
 *
 * Arrays keep their order and their entries are canonicalised in place, so
 * `[{ b: 1, a: 2 }]` and `[{ a: 2, b: 1 }]` canonicalise identically while
 * `[1, 2]` and `[2, 1]` stay different. `undefined` properties are dropped (the
 * `JSON.stringify` rule); `toJSON` is never consulted, so a class instance
 * cannot smuggle a different shape into the hash than the one the validator
 * saw.
 */
function canonicalise(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map((entry) => canonicalise(entry));
    }
    if (typeof value !== 'object' || value === null) {
        return value;
    }

    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
        if (source[key] === undefined) {
            continue;
        }
        out[key] = canonicalise(source[key]);
    }
    return out;
}
