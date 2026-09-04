import { Logger } from '@nestjs/common';
import { tasks } from '@trigger.dev/sdk';
import type { WorkflowRunDispatcher, WorkflowRunPayload } from '@ever-works/agent/tasks';

/**
 * A Nest logger, NOT `logger` from `@trigger.dev/sdk`.
 *
 * The SDK's `logger` writes through its run-scoped `LoggerAPI` singleton,
 * which resolves to a `NoopTaskLogger` outside a task run. This adapter is
 * bound to `WORKFLOW_RUN_DISPATCHER` by the API-side `WorkflowsModule` and so
 * only ever executes in the API process, where that logger discards every
 * call. The dispatch-failure branch below was therefore silent: the whole
 * point of catching before returning `null` is to leave an account of WHY,
 * and it was writing to nothing.
 *
 * The sibling adapters in this directory (`idea-build-execute.dispatcher.ts`,
 * `agent-task-dispatchers.ts`) import only `tasks` from the SDK and never hit
 * this; the trigger-side tasks, which DO run inside a task, keep using the
 * SDK logger correctly.
 */
const logger = new Logger('WorkflowRunDispatcher');

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
            logger.error(
                `workflow-run dispatch failed (workflowRunId=${payload.workflowRunId}, ` +
                    `workflowId=${payload.workflowId}): ` +
                    (err instanceof Error ? err.message : String(err)),
                err instanceof Error ? err.stack : undefined,
            );
            return null;
        }
    },
};
