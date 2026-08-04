import { logger, task } from '@trigger.dev/sdk';
import type { WorkflowRunPayload } from '@ever-works/agent/tasks';
import { WorkflowRunExecutorService } from '@ever-works/agent/services';
import { withWorkerContext } from '../../trigger/worker/utils/worker-context.utils';
import { TriggerWorkflowRunModule } from '../../trigger/worker/modules/trigger-workflow-run.module';
import { TriggerPluginHydratorService } from '../../trigger/worker/services/trigger-plugin-hydrator.service';
// Security: validate payload ids before any DB access (defence in depth,
// mirrors every other task that takes ids off a queue payload).
import { assertUuid } from '../../trigger/worker/utils/task-context.utils';

/**
 * Judgment layer G5 — execute a SAVED workflow graph.
 *
 * `POST /api/workflows/:id/run` creates the `workflow_runs` row in
 * `queued` and enqueues this task, then returns 202 immediately. This
 * task does the walk and writes the terminal row.
 *
 * ## Why the walk lives here and not in the API
 *
 * A graph can hold up to four delegate nodes, each waiting up to ten
 * minutes for a child agent run, walked SEQUENTIALLY — roughly 40 minutes
 * for a maximal graph. Two shapes were considered and rejected:
 *
 *   - In-process fire-and-forget after the 202. API pods restart on every
 *     deploy, so the promise dies on the NORMAL path and a stuck-row
 *     sweeper becomes the primary mechanism. `agent-heartbeat.task.ts`
 *     states the opposite rule outright: "the stuck-row sweep in the
 *     dispatcher is a backstop, not a primary path."
 *   - A task that RPCs the walk back to the API. `TriggerInternalApi-
 *     Client` has no timeout and no `AbortSignal` and retries network
 *     errors up to 4 attempts with no idempotency key — a long call dies
 *     at the ingress hop and is re-executed, duplicating the real child
 *     agent runs a delegate node spawns.
 *
 * ## Producer/consumer skew
 *
 * `packages/tasks` deploys on its OWN workflow
 * (`.github/workflows/release-trigger-prod.yml`), separately from the
 * API. If the API starts dispatching `workflow-run` before a worker
 * carrying this file lands, `tasks.trigger` still returns a handle and
 * the run parks in `PENDING_VERSION` — it executes late rather than
 * failing. Nothing breaks on an OLD worker: it simply never sees the id.
 * That is also why the payload is ids only — an old worker silently drops
 * fields it does not know, so nothing load-bearing may ride on it.
 *
 * ## Retries
 *
 * `maxAttempts: 1`. A graph walk is NOT safely retryable at the task
 * level: `ai.ask` nodes have already been paid for and delegate nodes
 * spawn real child runs, so a blind re-run duplicates side effects. The
 * executor's own `on_failure` edges are the retry mechanism that
 * understands the graph. `WorkflowRunExecutorService` is nonetheless
 * idempotent — it returns early on a row already in a terminal state —
 * so a runtime-level redelivery cannot double-walk.
 */
export const workflowRunTask = task<'workflow-run', WorkflowRunPayload>({
    id: 'workflow-run',
    // Comfortably above the ~40-minute worst case (4 delegate nodes at
    // the 10-minute ceiling), with room for the AI calls between them.
    maxDuration: 60 * 60,
    retry: { maxAttempts: 1 },
    run: async (payload: WorkflowRunPayload, { ctx }: { ctx?: { run?: { id?: string } } } = {}) => {
        assertUuid(payload.workflowRunId, 'payload.workflowRunId');
        assertUuid(payload.workflowId, 'payload.workflowId');
        assertUuid(payload.userId, 'payload.userId');

        return withWorkerContext(
            'WorkflowRun',
            async (appContext) => {
                // NOT optional. The plugin registry starts EMPTY and is
                // filled only by the bootstrap this triggers; skip it and
                // every `ai.ask` node and `llm_decide` edge throws
                // `NoProviderError` at run time, which no unit test
                // catches.
                await appContext.get(TriggerPluginHydratorService).initialize();

                const executor = appContext.get(WorkflowRunExecutorService);
                const status = await executor.execute({
                    workflowRunId: payload.workflowRunId,
                    userId: payload.userId,
                    triggerRunId: ctx?.run?.id ?? null,
                });

                logger.log('workflow-run finished', {
                    workflowRunId: payload.workflowRunId,
                    workflowId: payload.workflowId,
                    status,
                });

                // Returned, never thrown, even for `failed`. A graph that
                // failed is a RECORDED outcome, not an infrastructure
                // fault — throwing would mark the Trigger.dev run red and
                // invite a retry that re-walks a graph whose failure is
                // already persisted with its failure code.
                return {
                    workflowRunId: payload.workflowRunId,
                    workflowId: payload.workflowId,
                    status,
                };
            },
            // NOTE the third argument: `withWorkerContext` defaults to
            // `TriggerWorkerModule`, which provides none of this task's
            // services — omitting it fails at runtime, on every fire.
            TriggerWorkflowRunModule,
        );
    },
});
