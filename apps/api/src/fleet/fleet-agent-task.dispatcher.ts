import { Logger } from '@nestjs/common';
import type {
    AgentTaskExecuteDispatcher,
    AgentTaskExecuteDispatchPayload,
} from '@ever-works/agent/tasks-domain';
import type { FleetRunRouterService } from './fleet-run-router.service';

const logger = new Logger('FleetAwareAgentTaskExecuteDispatcher');

/**
 * AUDIT A46/A24 — the routing seam that finally gives
 * `FleetJobService.enqueue` a production caller.
 *
 * `TaskTransitionService.dispatchAgentRun` is THE dispatch path for one
 * (Task, Agent) pair: gate admit → pre-created queued run → board denorm
 * → job-runtime enqueue → remote-run-id stamp. It reaches the runtime
 * through exactly one seam, the `AGENT_TASK_EXECUTE_DISPATCHER` token.
 * Wrapping that token here means a Fleet-routed run enters the SAME
 * path a Trigger.dev-routed one does — same concurrency valve, same run
 * row, same loud-degradation bookkeeping — and differs only in which
 * runtime receives it.
 *
 * Extension, not replacement: `delegate` is the existing platform
 * dispatcher and stays the behaviour for every install that has not
 * selected the fleet runtime. Only a resolved runtime of `node` (and a
 * fleet runtime that is not killed by `FLEET_NODE_RUNTIME_ENABLED=false`)
 * diverts.
 *
 * A routing decision that THROWS falls back to the delegate rather than
 * failing the dispatch: deciding where to run is infrastructure, and an
 * infrastructure hiccup must not cost the user a run. An enqueue that
 * throws after the decision is a real failure and propagates, so the
 * transition service records it on the run row where a human can see it.
 */
export function createFleetAwareAgentTaskExecuteDispatcher(
    delegate: AgentTaskExecuteDispatcher,
    router: Pick<FleetRunRouterService, 'shouldDispatchToFleet' | 'enqueueAgentTask'>,
): AgentTaskExecuteDispatcher {
    return {
        async enqueue(payload: AgentTaskExecuteDispatchPayload): Promise<{ runId: string }> {
            let routeToFleet = false;
            try {
                routeToFleet = await router.shouldDispatchToFleet(payload.tenantId);
            } catch (err) {
                logger.warn(
                    `Fleet routing check failed for task ${payload.taskId} — using the platform dispatcher: ${
                        err instanceof Error ? err.message : String(err)
                    }`,
                );
                routeToFleet = false;
            }
            if (routeToFleet) {
                return router.enqueueAgentTask(payload);
            }
            return delegate.enqueue(payload);
        },
    };
}
