/**
 * Board dispatch — client-safe contract values.
 *
 * These sentinels and the picker row shape carry NO server dependency,
 * so they live apart from `tasks.ts` (which is `server-only`). The
 * `'use client'` dispatch menu imports them from here directly;
 * `tasks.ts` re-exports them so server-side callers keep a single
 * import site.
 *
 * Importing a VALUE (not just a type) from `tasks.ts` in a client
 * component pulls its `server-only` guard into the client bundle and
 * fails `next build` — tsc stays clean, so only the production build
 * catches it. This split avoids that while keeping one canonical
 * definition.
 */

/**
 * Stable machine codes the board keys its behaviour off — mirrored from
 * `@ever-works/agent/tasks-domain`. Never branch on the message: the
 * production build redacts thrown Server-Action messages.
 */
export const RUN_ALREADY_IN_FLIGHT = 'RUN_ALREADY_IN_FLIGHT';
export const RUN_AGENT_AMBIGUOUS = 'RUN_AGENT_AMBIGUOUS';
export const RUN_NO_AGENT = 'RUN_NO_AGENT';
export const RUN_AGENT_NOT_FOUND = 'RUN_AGENT_NOT_FOUND';

/** One row of the board's agent picker. */
export interface RunCandidateAgent {
    id: string;
    name: string;
    slug?: string;
    status?: string;
    source: 'assignee' | 'task' | 'work-default';
}

// ── Scoped "Add existing Task" picker ─────────────────────────────

/**
 * The three owners a Tasks tab can be scoped by. Mirrors the
 * `scopeParam` mapping in `TasksScopedSection` — one union so the
 * picker, the server action, and the section cannot drift apart.
 */
export type TaskScopeKey = 'workId' | 'missionId' | 'ideaId';

/**
 * The scope a Tasks list is being rendered UNDER, when it is rendered
 * under one at all. Absent on the global /tasks page, which is why the
 * per-row "remove from this scope" action is opt-in: there is no scope
 * there to remove a Task from.
 */
export interface TaskScopeRef {
    key: TaskScopeKey;
    id: string;
}

/**
 * One row of the "Add existing Task" picker — the narrow projection of
 * `Task` the dialog renders. Not the full DTO: the list crosses a
 * Server-Action boundary on every keystroke and nothing else on the Task
 * is needed to label a row.
 *
 * `reassigns` is the honest part: the Task is already filed under a
 * DIFFERENT owner of this kind, so picking it MOVES it rather than
 * simply adding it. The row says so before the click, not after.
 */
export interface TaskAssignCandidate {
    id: string;
    slug: string;
    title: string;
    status: string;
    priority: string;
    reassigns: boolean;
}
