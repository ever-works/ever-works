/**
 * APW-08 T34 (FR-51…FR-55) — a Mission's OUTPUT: whether its tick files Ideas (as every Mission
 * did before P2), Tasks on its attached App Works, or both, and the bounds of the Task output.
 *
 * `missions.taskOutput` is `simple-json`, so whatever is stored is read back through
 * {@link normalizeMissionTaskOutput} on every use: a value out of bounds, of the wrong type or
 * missing falls back to the default (plan §3.3: "fails toward the defaults"). A mode that is not
 * one of the three reads as `ideas` — the Mission before P2.
 *
 * A leaf: no Nest, no TypeORM, no other module of the package.
 */

export const MISSION_OUTPUT_MODES = ['ideas', 'tasks', 'both'] as const;
export type MissionOutputMode = (typeof MISSION_OUTPUT_MODES)[number];

/** The default mode: the Mission before APW-08 P2. */
export const DEFAULT_MISSION_OUTPUT_MODE: MissionOutputMode = 'ideas';

/** Tasks one tick may file per Work (plan §3.3). */
export const MISSION_TASKS_PER_TICK = { min: 1, max: 3, default: 1 } as const;
/** Open Tasks a Mission may have on one Work before it files no more (plan §3.3). */
export const MISSION_OPEN_TASKS_CAP = { min: 1, max: 10, default: 3 } as const;

/** The relations under which a Mission files Tasks on a Work (FR-51). */
export const MISSION_TASK_OUTPUT_RELATIONS = ['improves', 'operates'] as const;

/** The warning a write answers when Task output has no App Work to file on (plan §5, S27). */
export const MISSION_NO_APP_WORK_RELATION = 'noAppWorkRelation';

export interface MissionTaskOutput {
    tasksPerTick: number;
    openTasksCap: number;
    /** The Agent the filed Tasks are dispatched to; absent = the Work's default Agent. */
    agentId?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isMissionOutputMode(value: unknown): value is MissionOutputMode {
    return typeof value === 'string' && (MISSION_OUTPUT_MODES as readonly string[]).includes(value);
}

/** A stored mode, read without trusting it: anything else is `ideas`. */
export function normalizeMissionOutputMode(raw: unknown): MissionOutputMode {
    return isMissionOutputMode(raw) ? raw : DEFAULT_MISSION_OUTPUT_MODE;
}

/** Does this mode file Tasks on the Mission's App Works? */
export function missionFilesTasks(mode: unknown): boolean {
    const normalized = normalizeMissionOutputMode(mode);
    return normalized === 'tasks' || normalized === 'both';
}

function boundedInt(
    raw: unknown,
    bounds: { readonly min: number; readonly max: number; readonly default: number },
): number {
    if (typeof raw !== 'number' || !Number.isInteger(raw)) return bounds.default;
    if (raw < bounds.min || raw > bounds.max) return bounds.default;
    return raw;
}

/**
 * The Task output of a Mission, read without trusting the column: each field in bounds or its
 * default, an `agentId` kept only when it is a uuid. A non-object is the defaults.
 */
export function normalizeMissionTaskOutput(raw: unknown): MissionTaskOutput {
    const input =
        raw && typeof raw === 'object' && !Array.isArray(raw)
            ? (raw as Record<string, unknown>)
            : {};
    const agentId =
        typeof input.agentId === 'string' && UUID.test(input.agentId.trim())
            ? input.agentId.trim().toLowerCase()
            : undefined;
    return {
        tasksPerTick: boundedInt(input.tasksPerTick, MISSION_TASKS_PER_TICK),
        openTasksCap: boundedInt(input.openTasksCap, MISSION_OPEN_TASKS_CAP),
        ...(agentId ? { agentId } : {}),
    };
}
