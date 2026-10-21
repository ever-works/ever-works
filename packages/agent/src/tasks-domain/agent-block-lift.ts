/**
 * Works-security (2026-10-18) — who may lift a block.
 *
 * A blocked Task is waiting for a PERSON: somebody blocked it on purpose, or
 * the platform did (a merge conflict, an App Work change the Work's rules
 * refused, a run that reported pushing a branch that is not the Task's). While
 * it stands, the merge gate neither merges the Task's pull request nor asks
 * anyone to approve one (`TaskMergeGateService`, `task-blocked`).
 *
 * Every agent-driven move used to be able to undo that with one call: the
 * `transitionTask` tool (which takes ANY of the owner's Task ids), a run's
 * finisher, the workspace finalize step, and a fleet run's token on
 * `POST /api/tasks/:id/transition` — all `actorType: 'agent'`. One injected run
 * could unblock the Task a person had just stopped and walk it back towards a
 * merge. `TaskTransitionService.transition` therefore refuses an
 * `actorType: 'agent'` move OUT of `blocked`.
 *
 * Not affected: a person's move, an integration's mirror walk, and the
 * platform's own auto-unblock restore (`automaticRestore`, when the last open
 * blocker Task finishes — the dependency, not the agent, lifted it).
 *
 * `TASK_AGENT_BLOCK_LIFT_ALLOWED=true` restores the old behaviour.
 */
export const TASK_AGENT_BLOCK_LIFT_ALLOWED_ENV = 'TASK_AGENT_BLOCK_LIFT_ALLOWED' as const;

/** Off (refused) unless the operator set `TASK_AGENT_BLOCK_LIFT_ALLOWED=true`. Default-safe. */
export function agentMayLiftBlock(): boolean {
    return (process.env[TASK_AGENT_BLOCK_LIFT_ALLOWED_ENV] ?? '').trim().toLowerCase() === 'true';
}

/** The refusal text, shared by the service and its tests. */
export function agentBlockLiftRefusal(taskId: string): string {
    return (
        `Task ${taskId} is blocked and waits for a person: an agent cannot lift the block. ` +
        'A person unblocks it from the Task.'
    );
}
