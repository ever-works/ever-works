import type { WorkflowRunPayload } from './workflow-run.types';

/**
 * Producer-side seam for enqueuing a workflow graph run (judgment layer
 * G5). Implemented api-side by the Trigger.dev adapter in
 * `packages/tasks/src/dispatchers/workflow-run.dispatcher.ts`.
 *
 * ## Why a graph run is dispatched rather than awaited
 *
 * A graph may hold delegate nodes that each wait minutes for a child
 * agent run, walked sequentially — up to roughly 40 minutes for a
 * maximal graph. Two obvious alternatives were rejected:
 *
 *   - Running it in-process after a 202. API pods restart on every
 *     deploy, so the promise dies on the NORMAL path and a stuck-row
 *     sweeper becomes the primary mechanism. The repo states the
 *     opposite rule outright in `agent-heartbeat.task.ts`: "the stuck-row
 *     sweep in the dispatcher is a backstop, not a primary path."
 *   - A task that RPCs the walk back to the API. `TriggerInternalApi-
 *     Client` has no timeout and no AbortSignal and retries network
 *     errors up to 4 attempts with no idempotency key, so a long call
 *     dies at the ingress hop (~60s nginx / ~100s Cloudflare) and is
 *     re-executed — and delegate nodes spawn real child agent runs, so
 *     that would be duplicated side effects.
 *
 * ## Returning `null`
 *
 * `null` means the run could not be enqueued — Trigger.dev is not
 * configured (the ordinary case in dev and e2e) or the transport failed.
 * The `workflow_runs` row still exists in `queued`, and the caller marks
 * it dispatch-failed rather than pretending it is pending forever. This
 * mirrors every other dispatcher on `TriggerService`, which return `null`
 * instead of throwing precisely so an unconfigured install does not 500.
 */
export interface WorkflowRunDispatcher {
    dispatchWorkflowRun(payload: WorkflowRunPayload): Promise<string | null>;
}

export const WORKFLOW_RUN_DISPATCHER = Symbol('WORKFLOW_RUN_DISPATCHER');
