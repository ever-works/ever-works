import {
    FLEET_NODE_MAX_CONCURRENT_JOBS,
    FLEET_NODE_MAX_CPU_PERCENT,
    FLEET_NODE_MAX_MEMORY_MB,
    FLEET_NODE_MIN_CONCURRENT_JOBS,
    FLEET_NODE_MIN_CPU_PERCENT,
    FLEET_NODE_MIN_MEMORY_MB,
    type FleetNodeLimitCeiling,
} from '@ever-works/contracts';

/**
 * Remote node limits (self-build slice AS) — the drawer's limit-ceiling
 * editor, as pure functions so the parsing is unit-tested without React.
 *
 * Each field is a text input: EMPTY means "no ceiling on this dimension",
 * a whole number inside the node's own bounds is a ceiling, anything else
 * is refused before it is sent — the API refuses it too, and saying so
 * here is kinder than a 400 toast.
 */

export type FleetNodeLimitField = keyof FleetNodeLimitCeiling;

/** Field order — the inputs and the summary render from this list. */
export const FLEET_NODE_LIMIT_FIELDS: readonly FleetNodeLimitField[] = [
    'maxConcurrentJobs',
    'maxCpuPercent',
    'maxMemoryMb',
];

/** The node's own bounds per field — the same numbers the API validates against. */
export const FLEET_NODE_LIMIT_BOUNDS: Readonly<
    Record<FleetNodeLimitField, { min: number; max: number }>
> = {
    maxConcurrentJobs: { min: FLEET_NODE_MIN_CONCURRENT_JOBS, max: FLEET_NODE_MAX_CONCURRENT_JOBS },
    maxCpuPercent: { min: FLEET_NODE_MIN_CPU_PERCENT, max: FLEET_NODE_MAX_CPU_PERCENT },
    maxMemoryMb: { min: FLEET_NODE_MIN_MEMORY_MB, max: FLEET_NODE_MAX_MEMORY_MB },
};

export type FleetNodeLimitDraft = Record<FleetNodeLimitField, string>;

/** A ceiling (or none) → the editor's initial text. */
export function limitCeilingToDraft(
    ceiling: FleetNodeLimitCeiling | null | undefined,
): FleetNodeLimitDraft {
    const text = (value: number | null | undefined) =>
        typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
    return {
        maxConcurrentJobs: text(ceiling?.maxConcurrentJobs),
        maxCpuPercent: text(ceiling?.maxCpuPercent),
        maxMemoryMb: text(ceiling?.maxMemoryMb),
    };
}

/**
 * The editor's text → the ceiling to PUT, or the first field the API would
 * refuse. An empty field is `null` (no ceiling on that dimension).
 */
export function draftToLimitCeiling(
    draft: FleetNodeLimitDraft,
): { ok: true; ceiling: FleetNodeLimitCeiling } | { ok: false; field: FleetNodeLimitField } {
    const ceiling: FleetNodeLimitCeiling = {
        maxConcurrentJobs: null,
        maxCpuPercent: null,
        maxMemoryMb: null,
    };
    for (const field of FLEET_NODE_LIMIT_FIELDS) {
        const trimmed = draft[field].trim();
        if (!trimmed) continue;
        if (!/^\d+$/.test(trimmed)) return { ok: false, field };
        const value = Number(trimmed);
        const { min, max } = FLEET_NODE_LIMIT_BOUNDS[field];
        if (!Number.isSafeInteger(value) || value < min || value > max) return { ok: false, field };
        ceiling[field] = value;
    }
    return { ok: true, ceiling };
}

/** True when no dimension carries a ceiling. */
export function isEmptyLimitCeiling(ceiling: FleetNodeLimitCeiling | null | undefined): boolean {
    return (
        !ceiling ||
        (ceiling.maxConcurrentJobs === null &&
            ceiling.maxCpuPercent === null &&
            ceiling.maxMemoryMb === null)
    );
}
