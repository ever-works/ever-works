import { logger, tasks } from '@trigger.dev/sdk';
import type { WorkflowRunDispatcher, WorkflowRunPayload } from '@ever-works/agent/tasks';

/**
 * Judgment layer G5 — production dispatcher adapter that hands a
 * pre-created `workflow_runs` row to the Trigger.dev `workflow-run` task.
 *
 * Bound to the `WORKFLOW_RUN_DISPATCHER` token by the API-side
 * `WorkflowsModule`. Keeps `@trigger.dev/sdk` out of the
 * `@ever-works/agent` dependency graph — the same shape as
 * `ideaBuildExecuteTriggerAdapter`.
 *
 * ## Why this is a standalone adapter rather than a `TriggerService` method
 *
 * `TriggerService` exposes no way to pass an `idempotencyKey` —
 * `stampTenantOptions` documents it as never touched, and no dispatch
 * method takes an options argument. A graph run needs one, so it takes
 * the same path the agent-task and idea-build dispatchers already do.
 *
 * `idempotencyKey = workflowRunId`: the run ROW is the unit of work, so a
 * double-fired enqueue collapses to one execution. That matters more here
 * than for most tasks, because a second walk would re-pay for every
 * `ai.ask` node and — once delegation is bound — spawn a second set of
 * real child agent runs.
 *
 * ## Returning `null`
 *
 * Errors are caught and reported as `null` rather than thrown, matching
 * the `WorkflowRunDispatcher` contract: the caller has already persisted
 * the run row and marks it dispatch-failed, which is a better outcome
 * than a 500 on a request whose row exists. An unconfigured install (dev,
 * e2e) hits the same path.
 */
export const workflowRunTriggerAdapter: WorkflowRunDispatcher = {
    async dispatchWorkflowRun(payload: WorkflowRunPayload): Promise<string | null> {
        try {
            const handle = await tasks.trigger<
                typeof import('../tasks/trigger/workflow-run.task').workflowRunTask
            >(
                'workflow-run',
                {
                    workflowRunId: payload.workflowRunId,
                    workflowId: payload.workflowId,
                    userId: payload.userId,
                } satisfies WorkflowRunPayload,
                { idempotencyKey: payload.workflowRunId },
            );
            return handle.id;
        } catch (err) {
            // LOG before collapsing to `null`. The contract is to return
            // null rather than throw — the caller has already persisted
            // the run row and a throw would 500 a request whose work is
            // recorded. But a bare `catch { return null }` DESTROYS the
            // only account of why: an auth failure, a malformed payload
            // and an unreachable Trigger.dev API would all reach the
            // operator as the same shrug. The row records that dispatch
            // failed; this records what actually happened.
            logger.error('workflow-run dispatch failed', {
                workflowRunId: payload.workflowRunId,
                workflowId: payload.workflowId,
                error: err instanceof Error ? err.message : String(err),
            });
            return null;
        }
    },
};
