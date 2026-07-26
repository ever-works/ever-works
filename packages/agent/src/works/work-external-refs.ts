import {
    INGEST_WORK_HINT_EXTERNAL_ID_MAX_CHARS,
    WORK_EXTERNAL_REFS_MAX_PER_KIND,
    WORK_EXTERNAL_REF_KINDS,
    type WorkExternalRefKind,
    type WorkExternalRefs,
} from '@ever-works/contracts';

/**
 * Write-path rules for `works.externalRefs` — the claim map the ingest
 * spine reads to route an ingested event to a Work
 * (`WorkHintResolverService.matchByExternalRef`).
 *
 * Two deliberately different postures share this vocabulary:
 *
 *   - the account-IMPORT path (`normalizeImportedExternalRefs`) is
 *     drop-if-unrecognized: a hand-edited archive must never fail a
 *     restore, so unknown kinds/entries are silently discarded;
 *   - this module is the USER write path (`PATCH /api/works/:id`), where
 *     silently discarding a claim would look like "the editor lost my
 *     Slack channel". Unknown kinds, over-cap lists and oversized ids are
 *     rejected with an explicit message instead.
 *
 * Matching is case-insensitive + trimmed on both sides, exactly like the
 * resolver, so `#C123` and ` c123 ` are the same claim.
 */

/** Same normalization the resolver applies before comparing. */
export function normalizeExternalRefValue(value: string): string {
    return value.trim().toLowerCase();
}

/** Thrown for a malformed claim map; callers map it to a 400. */
export class WorkExternalRefsValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'WorkExternalRefsValidationError';
    }
}

/** One duplicate claim: `externalId` under `kind` is already taken by `workId`. */
export interface WorkExternalRefConflict {
    kind: WorkExternalRefKind;
    externalId: string;
    workId: string;
    workName: string;
}

/** Type guard for the closed kind set (also usable from DTO validation). */
export function isWorkExternalRefKind(value: unknown): value is WorkExternalRefKind {
    return (
        typeof value === 'string' && (WORK_EXTERNAL_REF_KINDS as readonly string[]).includes(value)
    );
}

/**
 * Validate + normalize a user-supplied claim map.
 *
 * Returns `null` when nothing survives (every kind empty) so the caller
 * can clear the column — `null` is the canonical "claims nothing" value
 * the resolver already tolerates.
 *
 * Throws {@link WorkExternalRefsValidationError} on: a non-object payload,
 * an unknown kind, a non-array kind value, a non-string / empty / oversized
 * entry, or more than {@link WORK_EXTERNAL_REFS_MAX_PER_KIND} entries under
 * one kind. Duplicates WITHIN one kind are deduped (case-insensitively)
 * rather than rejected — re-submitting the same editor rows is not an error.
 */
export function validateWorkExternalRefs(value: unknown): WorkExternalRefs | null {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'object' || Array.isArray(value)) {
        throw new WorkExternalRefsValidationError(
            'externalRefs must be an object keyed by ref kind.',
        );
    }

    const source = value as Record<string, unknown>;

    for (const key of Object.keys(source)) {
        if (!isWorkExternalRefKind(key)) {
            throw new WorkExternalRefsValidationError(
                `Unknown external ref kind "${key}". Allowed: ${WORK_EXTERNAL_REF_KINDS.join(', ')}.`,
            );
        }
    }

    const out: WorkExternalRefs = {};
    let kept = 0;

    for (const kind of WORK_EXTERNAL_REF_KINDS) {
        const raw = source[kind];
        if (raw === undefined || raw === null) continue;
        if (!Array.isArray(raw)) {
            throw new WorkExternalRefsValidationError(
                `externalRefs.${kind} must be an array of identifiers.`,
            );
        }

        const seen = new Set<string>();
        const ids: string[] = [];
        for (const entry of raw) {
            if (typeof entry !== 'string') {
                throw new WorkExternalRefsValidationError(
                    `externalRefs.${kind} entries must be strings.`,
                );
            }
            const trimmed = entry.trim();
            if (trimmed.length === 0) {
                throw new WorkExternalRefsValidationError(
                    `externalRefs.${kind} entries must not be empty.`,
                );
            }
            if (trimmed.length > INGEST_WORK_HINT_EXTERNAL_ID_MAX_CHARS) {
                throw new WorkExternalRefsValidationError(
                    `externalRefs.${kind} entries must be at most ${INGEST_WORK_HINT_EXTERNAL_ID_MAX_CHARS} characters.`,
                );
            }
            const normalized = normalizeExternalRefValue(trimmed);
            if (seen.has(normalized)) continue;
            seen.add(normalized);
            ids.push(trimmed);
        }

        if (ids.length > WORK_EXTERNAL_REFS_MAX_PER_KIND) {
            throw new WorkExternalRefsValidationError(
                `externalRefs.${kind} accepts at most ${WORK_EXTERNAL_REFS_MAX_PER_KIND} identifiers (received ${ids.length}).`,
            );
        }

        if (ids.length > 0) {
            out[kind] = ids;
            kept += ids.length;
        }
    }

    return kept > 0 ? out : null;
}

/** The minimum shape the duplicate scan needs from a sibling Work. */
export interface ExternalRefClaimant {
    id: string;
    name?: string | null;
    externalRefs?: WorkExternalRefs | null;
}

/**
 * Find claims in `refs` that another Work already owns.
 *
 * Owner-scoped by construction: the caller passes only Works owned by the
 * same user (`WorkRepository.findByUser`), so two different users may
 * still claim the same Slack channel — their events never cross. Within
 * one owner a shared claim IS ambiguous (the resolver returns the first
 * match), so the write path rejects it.
 */
export function findExternalRefConflicts(
    refs: WorkExternalRefs | null,
    siblings: readonly ExternalRefClaimant[],
    excludeWorkId: string,
): WorkExternalRefConflict[] {
    if (!refs) return [];

    const conflicts: WorkExternalRefConflict[] = [];
    for (const kind of WORK_EXTERNAL_REF_KINDS) {
        const claimed = refs[kind];
        if (!claimed || claimed.length === 0) continue;
        const wanted = new Map(claimed.map((id) => [normalizeExternalRefValue(id), id]));

        for (const sibling of siblings) {
            if (!sibling || sibling.id === excludeWorkId) continue;
            const existing = sibling.externalRefs?.[kind];
            if (!Array.isArray(existing) || existing.length === 0) continue;
            // Bounded scan — mirrors the resolver, so a hand-edited row
            // can never turn this check into an unbounded loop.
            for (const ref of existing.slice(0, WORK_EXTERNAL_REFS_MAX_PER_KIND)) {
                if (typeof ref !== 'string') continue;
                const hit = wanted.get(normalizeExternalRefValue(ref));
                if (hit !== undefined) {
                    conflicts.push({
                        kind,
                        externalId: hit,
                        workId: sibling.id,
                        workName: sibling.name ?? sibling.id,
                    });
                }
            }
        }
    }
    return conflicts;
}

/** Human-readable summary used as the 409 message. */
export function describeExternalRefConflicts(
    conflicts: readonly WorkExternalRefConflict[],
): string {
    const details = conflicts
        .map((c) => `"${c.externalId}" (${c.kind}) is already claimed by "${c.workName}"`)
        .join('; ');
    return `External reference already claimed by another Work you own: ${details}. Remove the claim there first — one identifier can only route to one Work.`;
}
