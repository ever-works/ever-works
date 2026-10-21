/**
 * Prompt-injection hardening — the `awaiting-owner` label (review of #2769).
 *
 * A Task filed from an email whose sender is NOT trusted carries it. It is
 * BINDING, not decorative:
 *
 *  - no agent may transition it (`TaskTransitionService` refuses an
 *    `actorType: 'agent'` move — the `transitionTask` tool, a run's finisher);
 *  - the automatic fan-out never picks it up (`findFanoutCandidates`);
 *  - a PERSON clears it by starting the Task: moving it into `todo` or
 *    `in_progress`, or pressing Run (`TasksService.runTask`).
 */
export const AWAITING_OWNER_LABEL = 'awaiting-owner' as const;

/** Whether a Task carries the binding `awaiting-owner` label. */
export function isAwaitingOwner(task: { labels?: readonly string[] | null }): boolean {
    return Array.isArray(task.labels) && task.labels.includes(AWAITING_OWNER_LABEL);
}

/** The Task's labels without `awaiting-owner`. */
export function withoutAwaitingOwner(labels: readonly string[] | null | undefined): string[] {
    return (labels ?? []).filter((label) => label !== AWAITING_OWNER_LABEL);
}
