/**
 * THE agent-resolution ladder for a Task, as a leaf function.
 *
 * Lifted out of `TaskTransitionService.resolveDispatchAgentIds` (which
 * now delegates to it, unchanged in behaviour) so a SECOND consumer can
 * ask the same question without importing the transition service.
 *
 * The second consumer is the reviewer agent stage (slice AD, EW-811): the
 * self-review refusal has to know which agents this Task's work belongs
 * to, and `TaskAgentReviewService` cannot inject `TaskTransitionService`
 * because the transition service injects IT (a circular provider pair
 * inside one module, which Nest cannot resolve). A second copy of the
 * ladder is the thing this file exists to prevent — the transition
 * service's own doc has said since slice AH that a second ladder would
 * drift, and "who wrote this code?" is exactly the question that must not
 * be answered two different ways.
 *
 * Deliberately NOT error-swallowing: a repository failure propagates, so
 * a driver that cannot tell whether a Task has an agent refuses to act on
 * it rather than guessing.
 */

/** The only thing this ladder needs from the assignee store. */
export interface TaskAgentAssigneeReader {
    findAgentAssignees(taskId: string): Promise<Array<{ assigneeId: string }>>;
}

/**
 * Agent assignee rows first (one run per agent), else the Task's own
 * `agentId` column, else nothing.
 *
 * No `task_assignees` rows does NOT mean no agent: the Task detail page
 * assigns an Agent by writing `task.agentId` without creating an assignee
 * row, and the run-candidates API already models that as its own source.
 */
export async function resolveTaskDispatchAgentIds(
    task: { id: string; agentId?: string | null },
    assignees?: TaskAgentAssigneeReader,
): Promise<string[]> {
    const agentAssignees = assignees ? await assignees.findAgentAssignees(task.id) : [];
    if (agentAssignees.length > 0) {
        return agentAssignees.map((assignee) => assignee.assigneeId);
    }
    return task.agentId ? [task.agentId] : [];
}
