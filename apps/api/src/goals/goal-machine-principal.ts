/**
 * Works-security (run-token scope, 2026-10-18) — what a non-person may change
 * on a Goal, and which Definition-of-Done writes are a person's sign-off.
 */

/**
 * The ONLY Goal fields a machine principal (a fleet-run token, an integration
 * key) may set through `PATCH /api/me/goals/:id`: descriptive text.
 *
 * Refusing just `outcome` / `constraints` (lane 3a) was a denylist, and the
 * rest of the body still decides whether the Goal is met: a run could set
 * `comparator: 'gte'` + `targetValue: 0` (or move `deadline`, swap
 * `metricSource`, `window`, `criteria`, `unit`, `baselineValue`) and the next
 * evaluation marks the Goal COMPLETED / ACHIEVED — or MISSED — without anyone
 * setting `outcome`. An allowlist keeps every field added later refused too.
 */
export const MACHINE_PRINCIPAL_GOAL_WRITABLE_FIELDS: readonly string[] = Object.freeze([
    'title',
    'description',
]);

/**
 * Whether a machine principal may change `title` / `description` of a Goal
 * whose execution loop is RUNNING. Off by default: the orchestrator builds
 * every iteration's brief from that text, so a run that rewrites it writes
 * the instructions of the next run (a self-propagating injection). A person
 * edits it in the app, or pauses the loop first.
 *
 * `MACHINE_PRINCIPAL_GOAL_TEXT_EDIT_RUNNING`: only the literal `true` / `1`
 * allows it; anything else, or nothing, refuses.
 */
export function isMachineGoalTextEditWhileRunningAllowed(
    env: NodeJS.ProcessEnv = process.env,
): boolean {
    const raw = (env.MACHINE_PRINCIPAL_GOAL_TEXT_EDIT_RUNNING ?? '').trim().toLowerCase();
    return raw === 'true' || raw === '1';
}

/** The criterion shape the sign-off comparison reads. */
export interface DodCriterionLike {
    id: string;
    status?: string | null;
    proposed?: boolean | null;
}

/** A criterion status that CLOSES it (counts toward completion). */
function isClosed(status: string | null | undefined): boolean {
    return status === 'done' || status === 'waived';
}

/**
 * The ids of the criteria a full Definition-of-Done replacement would SIGN
 * OFF, i.e. what only a person in an interactive session may do:
 *
 *   - close a criterion (`done` / `waived`) that is not already closed with
 *     that same status — including a brand-new criterion arriving closed;
 *   - approve a criterion that is currently `proposed` (drop the flag);
 *   - remove an approved, still-open criterion (or clear the whole list with
 *     `null`): with it gone the remaining checklist can roll up complete,
 *     which is a waiver without the note.
 *
 * Re-saving the list unchanged — the DoD tab replaces the whole list on every
 * add and remove, echoing statuses already recorded — signs off nothing, and
 * neither does adding or editing an open criterion.
 */
export function dodSignOffChanges(
    current: readonly DodCriterionLike[] | null | undefined,
    next: readonly DodCriterionLike[] | null | undefined,
): string[] {
    const before = new Map((current ?? []).map((criterion) => [criterion.id, criterion]));
    const nextIds = new Set((next ?? []).map((criterion) => criterion.id));
    const changed = new Set<string>();

    for (const criterion of next ?? []) {
        const previous = before.get(criterion.id);
        if (isClosed(criterion.status) && previous?.status !== criterion.status) {
            changed.add(criterion.id);
        }
        if (previous?.proposed === true && criterion.proposed !== true) {
            changed.add(criterion.id);
        }
    }
    for (const [id, previous] of before) {
        if (nextIds.has(id)) continue;
        if (previous.proposed !== true && !isClosed(previous.status)) {
            changed.add(id);
        }
    }
    return [...changed];
}

/** Whether a single-criterion patch closes it (`done` / `waived`). */
export function patchClosesCriterion(status: string | null | undefined): boolean {
    return isClosed(status);
}
