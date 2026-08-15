import { Logger } from '@nestjs/common';
import type { NotificationService } from '@ever-works/agent/notifications';
import type {
    AgentTaskExecuteDispatcher,
    AgentTaskExecuteDispatchPayload,
} from '@ever-works/agent/tasks-domain';
import type { FleetExecutionScopeQuery, FleetRunRoutingDecision } from '@ever-works/contracts';
import type { FleetRunRouterService } from './fleet-run-router.service';

const logger = new Logger('FleetAwareAgentTaskExecuteDispatcher');

/**
 * Resolves the Work / Goal a Task belongs to, so a routing preference can
 * be scoped narrower than the account.
 *
 * A PORT rather than a `TasksService` import: this file sits on the
 * dispatch path and must stay a leaf. The api-side module supplies a
 * lookup; when none is supplied, resolution simply falls back to the
 * account-wide preference, which is the pre-existing behaviour.
 */
export interface FleetTaskScopeResolver {
    resolve(taskId: string): Promise<FleetExecutionScopeQuery>;
}

export interface FleetAwareDispatcherDeps {
    /** Resolves the Work / Goal scope of the Task being dispatched. */
    scopeResolver?: FleetTaskScopeResolver;
    /** Emits the "local runner fallback → cloud" inbox entry. */
    notifications?: Pick<NotificationService, 'notifyFleetRunnerFallback'>;
}

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
 * selected the fleet runtime.
 *
 * ## The three outcomes
 *
 * The router now answers with a DECISION rather than a boolean, because
 * "run this locally" has three honest answers and the boolean could only
 * express two of them:
 *
 *   - `fleet`         — a runner can take it now.
 *   - `fleet-waiting` — the owner asked for `local-wait`, no runner is
 *                       free, and the work is deliberately held for the
 *                       machine that is supposed to run it. The job is
 *                       still enqueued (the fleet queue IS the wait), and
 *                       carries `waiting-for-runner` so the wait is
 *                       visible instead of looking like a stall.
 *   - `cloud`         — either the tenant is not on the fleet at all, or
 *                       the owner allowed a fallback and no runner could
 *                       take it. Only the SECOND case notifies: relocating
 *                       a run that asked to be local is a changed outcome
 *                       its owner has to be able to see, whereas a tenant
 *                       that never wanted the fleet has nothing to be told.
 *
 * A routing decision that THROWS falls back to the delegate rather than
 * failing the dispatch: deciding where to run is infrastructure, and an
 * infrastructure hiccup must not cost the user a run. An enqueue that
 * throws after the decision is a real failure and propagates, so the
 * transition service records it on the run row where a human can see it.
 */
export function createFleetAwareAgentTaskExecuteDispatcher(
    delegate: AgentTaskExecuteDispatcher,
    router: Pick<FleetRunRouterService, 'routeAgentTask' | 'enqueueAgentTask'>,
    deps: FleetAwareDispatcherDeps = {},
): AgentTaskExecuteDispatcher {
    return {
        async enqueue(payload: AgentTaskExecuteDispatchPayload): Promise<{ runId: string }> {
            let decision: FleetRunRoutingDecision = { target: 'cloud', mode: 'cloud' };
            try {
                const scope = await resolveScope(deps.scopeResolver, payload.taskId);
                decision = await router.routeAgentTask(payload, scope);
            } catch (err) {
                logger.warn(
                    `Fleet routing check failed for task ${payload.taskId} — using the platform dispatcher: ${
                        err instanceof Error ? err.message : String(err)
                    }`,
                );
                decision = { target: 'cloud', mode: 'cloud' };
            }

            if (decision.target === 'fleet' || decision.target === 'fleet-waiting') {
                return router.enqueueAgentTask(payload, decision.queuedReason ?? null);
            }

            // Notify ONLY on a real fallback — a decision carrying a
            // `fallbackReason` means the owner asked for local and did
            // not get it. A tenant that was never on the fleet reaches
            // here too, with no reason, and must stay silent.
            if (decision.fallbackReason && deps.notifications) {
                try {
                    await deps.notifications.notifyFleetRunnerFallback({
                        userId: payload.userId,
                        taskId: payload.taskId,
                        reason: decision.fallbackReason,
                        runnerCount: decision.fallbackReason === 'no-runners' ? 0 : 1,
                    });
                } catch (err) {
                    // Best-effort by contract: the run is what matters,
                    // and a notification outage must never turn a
                    // successful fallback into a failed dispatch.
                    logger.warn(
                        `Fleet fallback notice failed for task ${payload.taskId}: ${
                            err instanceof Error ? err.message : String(err)
                        }`,
                    );
                }
            }
            return delegate.enqueue(payload);
        },
    };
}

/**
 * Best-effort scope lookup. A resolver that throws (or is absent)
 * degrades to the account-wide preference rather than failing the
 * dispatch — the same posture every other seam on this path takes.
 */
async function resolveScope(
    resolver: FleetTaskScopeResolver | undefined,
    taskId: string,
): Promise<FleetExecutionScopeQuery> {
    if (!resolver) return {};
    try {
        return await resolver.resolve(taskId);
    } catch (err) {
        logger.debug(
            `Fleet scope lookup failed for task ${taskId} — using the account-wide preference: ${
                err instanceof Error ? err.message : String(err)
            }`,
        );
        return {};
    }
}
