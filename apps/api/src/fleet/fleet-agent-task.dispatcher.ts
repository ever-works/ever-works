import { Logger } from '@nestjs/common';
import type { NotificationService } from '@ever-works/agent/notifications';
import type {
    AgentTaskExecuteDispatcher,
    AgentTaskExecuteDispatchPayload,
} from '@ever-works/agent/tasks-domain';
import type {
    FleetAgentModelExecution,
    FleetAgentTaskGitPolicy,
    FleetExecutionScopeQuery,
    FleetRunRoutingDecision,
    FleetTaskWorkspaceSpec,
    TaskAcceptanceCheck,
} from '@ever-works/contracts';
import type { FleetRunRouterService } from './fleet-run-router.service';

/**
 * Agent execution v2 — everything a node needs to run the Task's agent
 * with a local model CLI. Built by the planner once the router has
 * decided the run goes to the fleet; merged into the job payload by
 * the router.
 */
export interface FleetAgentTaskPlan {
    execution: FleetAgentModelExecution;
    workspace: FleetTaskWorkspaceSpec;
    acceptanceChecks: TaskAcceptanceCheck[];
    git: FleetAgentTaskGitPolicy;
}

/**
 * Builds a {@link FleetAgentTaskPlan} for one dispatch, or returns null
 * when the tenant's fleet runs in the legacy `command` mode.
 *
 * A PORT rather than a service import, for the same reason
 * {@link FleetTaskScopeResolver} is: the planner needs the Task, Agent
 * and workspace services, which live in the api-side `TasksModule`, and
 * this file must stay a leaf on the dispatch path.
 *
 * A planner that THROWS is deliberate and propagates: the run is then
 * marked failed with the reason (no repository, missing agent, …) where
 * a human reads it, instead of a job the node cannot execute.
 */
export interface FleetAgentTaskPlanner {
    plan(payload: AgentTaskExecuteDispatchPayload): Promise<FleetAgentTaskPlan | null>;
    /**
     * Self-build slice S — what the job WILL require, known before the
     * plan is built: the capability tags, resolved from the tenant's
     * execution settings alone (no Task / workspace reads, so a cloud
     * run still never pays for planning). Fed to the router so
     * availability is counted over the nodes that could lease the job.
     * Optional and best-effort: absent or throwing, the router falls
     * back to the operator's config tags (what a legacy `command` job is
     * stamped with) and the queue SLA bounds a wrong "placed".
     */
    requirements?(payload: AgentTaskExecuteDispatchPayload): Promise<FleetAgentTaskRequirements>;
}

/** What {@link FleetAgentTaskPlanner.requirements} resolves. */
export interface FleetAgentTaskRequirements {
    requiredCapabilities: string[];
}

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
    /**
     * Agent execution v2 — supplies the model-CLI plan for a fleet-bound
     * run. Absent = every fleet run is the legacy command job.
     */
    planner?: FleetAgentTaskPlanner;
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
    // (deps.planner is read per dispatch below — see FleetAgentTaskPlanner.)
    return {
        async enqueue(payload: AgentTaskExecuteDispatchPayload): Promise<{ runId: string }> {
            let decision: FleetRunRoutingDecision = { target: 'cloud', mode: 'cloud' };
            try {
                const scope = await resolveScope(deps.scopeResolver, payload.taskId);
                const requirements = await resolveRequirements(deps.planner, payload);
                decision = await router.routeAgentTask(
                    payload,
                    scope,
                    requirements ? { requiredCapabilities: requirements.requiredCapabilities } : {},
                );
            } catch (err) {
                logger.warn(
                    `Fleet routing check failed for task ${payload.taskId} — using the platform dispatcher: ${
                        err instanceof Error ? err.message : String(err)
                    }`,
                );
                decision = { target: 'cloud', mode: 'cloud' };
            }

            if (decision.target === 'fleet' || decision.target === 'fleet-waiting') {
                // Agent execution v2 — the plan is built AFTER the routing
                // decision (a cloud run never pays for it) and its failure
                // is NOT swallowed: a fleet run that cannot be planned has
                // no honest fallback, so the transition service records
                // the reason on the run row.
                const plan = deps.planner ? await deps.planner.plan(payload) : null;
                return router.enqueueAgentTask(payload, decision.queuedReason ?? null, plan);
            }

            // Notify ONLY on a real fallback — a decision carrying a
            // `fallbackReason` means the owner asked for local and did
            // not get it. A tenant that was never on the fleet reaches
            // here too, with no reason, and must stay silent.
            if (decision.fallbackReason && deps.notifications) {
                try {
                    const notice: Parameters<NotificationService['notifyFleetRunnerFallback']>[0] =
                        {
                            userId: payload.userId,
                            taskId: payload.taskId,
                            reason: decision.fallbackReason,
                            // The real count from the availability snapshot,
                            // not a stand-in derived from the reason: an
                            // owner with four busy runners must not read
                            // "1" in a stored notification. Since slice S
                            // this is the ELIGIBLE count; the whole fleet
                            // and the pinned node ride alongside it.
                            runnerCount: decision.runnerCount ?? 0,
                        };
                    if (typeof decision.fleetRunnerCount === 'number') {
                        notice.fleetRunnerCount = decision.fleetRunnerCount;
                    }
                    if (decision.pinnedNodeId) {
                        notice.pinnedNodeId = decision.pinnedNodeId;
                    }
                    await deps.notifications.notifyFleetRunnerFallback(notice);
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
 * Best-effort requirements lookup (self-build slice S). A planner that
 * throws here, or has no `requirements`, degrades to "the router counts
 * against the operator's config tags" — never to a failed dispatch. The
 * plan itself (built later, only for a fleet-bound run) keeps its loud
 * failure semantics; this is the cheap settings-only preview of it.
 */
async function resolveRequirements(
    planner: FleetAgentTaskPlanner | undefined,
    payload: AgentTaskExecuteDispatchPayload,
): Promise<FleetAgentTaskRequirements | null> {
    if (!planner || typeof planner.requirements !== 'function') return null;
    try {
        return await planner.requirements(payload);
    } catch (err) {
        logger.debug(
            `Fleet requirements lookup failed for task ${payload.taskId} — counting availability against the config tags: ${
                err instanceof Error ? err.message : String(err)
            }`,
        );
        return null;
    }
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
