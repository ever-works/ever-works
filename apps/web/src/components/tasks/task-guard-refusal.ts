import type { Task } from '@/lib/api/tasks';

/** Branch states after which a refused change has nothing left to be merged into. */
const SETTLED_BRANCH_STATES: ReadonlySet<string> = new Set(['merged', 'cleaned', 'discarded']);

/**
 * APW-08 — the primary branch's change-guard refusal still in force, or null.
 *
 * The agent records it on `branchGuardRefusal` when an App Work's change guard
 * blocks a change that reached the Task's primary branch — a change its rules
 * refuse, or a run that reported pushing a branch that is not the Task's — and
 * leaves `branchState` / `prState` as they were, because the branch really is
 * pushed. Blank text is nothing refused; a merged pull request or a settled
 * branch is history. The branch panel's banner and the board's pull-request
 * pill both read it here, so the two can never disagree.
 */
export function activeGuardRefusal(
    task: Pick<Task, 'branchGuardRefusal' | 'prState' | 'branchState'>,
): string | null {
    const reason = task.branchGuardRefusal;
    if (typeof reason !== 'string' || reason.trim().length === 0) return null;
    if (task.prState === 'merged') return null;
    if (task.branchState && SETTLED_BRANCH_STATES.has(task.branchState)) return null;
    return reason;
}
