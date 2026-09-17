import { Logger } from '@nestjs/common';
import type { NotificationService } from '@ever-works/agent/notifications';
import type {
    AgentTaskExecuteDispatcher,
    AgentTaskExecuteDispatchPayload,
} from '@ever-works/agent/tasks-domain';
import type {
    FleetAgentModelExecution,
    FleetAgentTaskGitPolicy,
    FleetAgentTaskMcpBridge,
    FleetExecutionScopeQuery,
    FleetRunRoutingDecision,
    FleetTaskWorkspaceSpec,
    TaskAcceptanceCheck,
} from '@ever-works/contracts';
import type { FleetKillSwitchService } from '@ever-works/agent/fleet';
import { FleetDelegationScopeRefusedError } from './fleet-agent-task-plan.error';
import {
    FLEET_DELEGATION_SCOPE_UNVERIFIABLE,
    markDelegationScopeCleared,
} from './fleet-delegation-scope';
import {
    FleetKillSwitchActiveError,
    isFleetKillSwitchActiveError,
} from './fleet-kill-switch.error';
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
    /**
     * Dispatch-frozen SETUP phase (EW-807): the dependency install a
     * freshly provisioned worktree needs before any command in it means
     * anything. Absent for every plan that declares none, which is every
     * plan until an owner (or, through the allow-list, their repository)
     * declares one.
     */
    setup?: TaskAcceptanceCheck[];
    git: FleetAgentTaskGitPolicy;
    /**
     * Self-build slice Z (EW-796) — the platform-MCP bridge for this run,
     * present ONLY when the operator switch, a configured server URL and
     * the Agent's `canCallExternalTools` permission all say yes. Absent
     * (the overwhelmingly common case) the job payload carries no `mcp`
     * block at all and the node runs exactly as it always has.
     */
    mcp?: FleetAgentTaskMcpBridge;
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
     * Judgment layer G9 on the fleet — THROWS when the run is a delegated
     * run whose `agent_runs.delegationScope` NARROWS what it may do
     * (`allowedTools` is an array without the `'*'` wildcard, `allowedPaths`
     * is present, or `networkAccess` is present and not `true`; an ABSENT
     * key restricts nothing), or when the run row cannot be read to rule
     * that out. No fleet node can enforce a delegation scope — it runs a
     * model CLI with shell and git access and pushes itself — so such a run
     * must never become a fleet job.
     *
     * Called for EVERY fleet-bound dispatch, in both execution modes, BEFORE
     * {@link plan} and before the job row is written. Its throw propagates
     * like a planning failure and is NEVER turned into a move to the cloud
     * runtime; the enqueue site records it on the run row
     * (`dispatch-failed: …` from the transition service, the dispatch-gate
     * drain and resume; `enqueue-failed: …` plus HTTP 500 from
     * `POST /agents/:id/assign-task`). Resolves for a readable row whose
     * scope is `null` or restricts nothing, and then the dispatch continues
     * exactly as before.
     *
     * Optional on the planner because the guard is its own port
     * ({@link FleetDelegationScopeGuard}); the planner serves as the guard
     * when no explicit `delegationScopeGuard` is wired. Either way the
     * dispatcher REQUIRES one for the fleet: with neither, every fleet-bound
     * run is refused (`fleet-delegation-scope-unverifiable`) instead of the
     * check being skipped. The api-side `FleetAgentTaskPlannerService` — the
     * one `TasksModule` wires into the production dispatcher — always
     * implements it, and its read fails closed (see
     * `refuseUnenforceableDelegationScope` there for the rule, the read
     * posture and what a node would have to prove).
     */
    refuseUnenforceableDelegationScope?(payload: AgentTaskExecuteDispatchPayload): Promise<void>;
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
    /**
     * Reviewer agent stage (self-build slice AD, EW-811) — THROWS when the
     * run is an agent REVIEW run, which must never execute on the fleet.
     *
     * A fleet node has no tool channel through which a verdict could be
     * recorded (`submitTaskReview` lives only in the platform's in-process
     * tool loop; the node's MCP bridge is off by default and exposes no
     * verdict route), so a fleet review would be a paid model run with a
     * structurally impossible outcome — and its brief would be rendered as
     * an `# OWNER ANSWER`, i.e. the pull request author's diff presented to
     * the model as the owner's own words. Called for every fleet-bound
     * dispatch the delegation-scope guard admitted, in both execution modes,
     * BEFORE {@link plan}; its throw propagates like a planning failure, so
     * the run is marked `dispatch-failed` with the reason and the review
     * ledger settles the claim `failed`. Fails closed: a run row it cannot
     * read refuses too.
     *
     * The SECOND refusal a review run meets, not the first. The G9 guard
     * ({@link refuseUnenforceableDelegationScope}) runs before it, and the
     * review-only scope always narrows, so with production wiring (the
     * planner is the guard) a review run is refused by G9 as
     * `fleet-delegation-scope-unenforceable` and this method is never asked.
     * It is reachable only behind an explicit `delegationScopeGuard` that
     * admits the run, and it is the rule that still matters if G9 is ever
     * relaxed for nodes that can enforce a scope: a verdict still cannot be
     * recorded on a node.
     *
     * Optional so a planner double without it keeps working; the api-side
     * `FleetAgentTaskPlannerService` always implements it.
     */
    refuseAgentReviewRun?(payload: AgentTaskExecuteDispatchPayload): Promise<void>;
}

/**
 * Judgment layer G9 — the port the dispatcher asks whether a fleet-bound
 * run's delegation scope lets it become a fleet job. Same contract as
 * {@link FleetAgentTaskPlanner.refuseUnenforceableDelegationScope}: resolve
 * to admit, throw to refuse (including when the run row cannot be read).
 */
export interface FleetDelegationScopeGuard {
    refuseUnenforceableDelegationScope(payload: AgentTaskExecuteDispatchPayload): Promise<void>;
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
     * run. Absent = every fleet run is the legacy command job (a
     * {@link delegationScopeGuard} is still required, see there).
     */
    planner?: FleetAgentTaskPlanner;
    /**
     * Judgment layer G9 — the delegation-scope guard asked about EVERY
     * fleet-bound run before a plan or a job exists. Absent = the planner,
     * when it implements `refuseUnenforceableDelegationScope` (production:
     * `TasksModule` wires `FleetAgentTaskPlannerService`, which does).
     *
     * FAILS CLOSED: with no explicit guard and no planner that implements
     * the method, every fleet-bound run is REFUSED
     * (`fleet-delegation-scope-unverifiable`) — never enqueued unchecked and
     * never moved to the cloud. Cloud-routed runs never consult it.
     */
    delegationScopeGuard?: FleetDelegationScopeGuard;
    /**
     * Panic controls (EW-778) — the GLOBAL STOP FLAG. Consulted BEFORE
     * routing, and its refusal is the one error the routing catch below
     * must never turn into a cloud fallback. Absent = not gated here
     * (the dispatch gate upstream still parks every run).
     */
    killSwitch?: Pick<FleetKillSwitchService, 'isStopped'>;
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
 *
 * ONE exception to that fallback (EW-778): the GLOBAL STOP FLAG. A stop
 * is not an infrastructure hiccup, it is an operator's decision, and
 * "send it to the cloud instead" is precisely the outcome it forbids. So
 * the flag is checked BEFORE routing, its refusal is a typed error, and
 * that error is rethrown out of the routing catch — never swallowed. It
 * then lands on the run row as `dispatch-failed: …` through the callers'
 * existing loud-degradation path. (The dispatch gate upstream parks every
 * run first; this seam is defence in depth for a gate that is absent or
 * mis-wired.)
 *
 * ## A fleet decision the fleet cannot honour (G9 delegation scope)
 *
 * Once the router answers `fleet` / `fleet-waiting`, the delegation-scope
 * guard (`deps.delegationScopeGuard`, else the planner's
 * `refuseUnenforceableDelegationScope`) runs FIRST — before `plan()` and
 * before `enqueueAgentTask` writes the job row — so neither the `model-cli`
 * nor the legacy `command` mode ever builds a job for a delegated run whose
 * scope narrows the tool surface (or whose run row cannot be read). Its
 * refusal propagates like any post-decision failure and the enqueue site
 * records it on the run row (`dispatch-failed: fleet-delegation-scope-…: …`
 * from the transition service, the drain and resume; `enqueue-failed: …`
 * from `POST /agents/:id/assign-task`). It is deliberately NOT a cloud
 * fallback: the tenant chose the fleet (their machines, credentials and
 * billing), so relocating the run would be a decision nobody made. A
 * `cloud` decision never consults it — the in-process tool loop enforces
 * the scope there.
 *
 * The control fails closed at both ends. A dispatcher with no guard (no
 * explicit guard, and no planner that implements the method) refuses the
 * fleet-bound run
 * rather than skipping the check. A payload that passed the guard is marked
 * cleared, and `FleetRunRouterService.enqueueAgentTask` — the one writer of
 * `agent-task` fleet rows — refuses any payload that was not, so a caller
 * that goes straight to the router cannot write a job around the guard.
 */
export function createFleetAwareAgentTaskExecuteDispatcher(
    delegate: AgentTaskExecuteDispatcher,
    router: Pick<FleetRunRouterService, 'routeAgentTask' | 'enqueueAgentTask'>,
    deps: FleetAwareDispatcherDeps = {},
): AgentTaskExecuteDispatcher {
    // (deps.planner is read per dispatch below — see FleetAgentTaskPlanner.)
    return {
        async enqueue(payload: AgentTaskExecuteDispatchPayload): Promise<{ runId: string }> {
            // EW-778 — refuse BEFORE routing, outside the fallback try.
            // Fail closed: a switch that cannot be read counts as set
            // (the service already folds read errors into `true`; the
            // catch here covers a stub or a future implementation that
            // throws instead).
            if (deps.killSwitch) {
                let stopped: boolean;
                try {
                    stopped = await deps.killSwitch.isStopped();
                } catch (err) {
                    logger.error(
                        `Global stop flag could not be read for task ${payload.taskId} — refusing dispatch (fail-closed): ${
                            err instanceof Error ? err.message : String(err)
                        }`,
                    );
                    stopped = true;
                }
                if (stopped) {
                    throw new FleetKillSwitchActiveError(payload.taskId);
                }
            }

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
                if (isFleetKillSwitchActiveError(err)) {
                    // The router read the flag itself. A stop is never a
                    // reason to run in the cloud instead.
                    throw err;
                }
                logger.warn(
                    `Fleet routing check failed for task ${payload.taskId} — using the platform dispatcher: ${
                        err instanceof Error ? err.message : String(err)
                    }`,
                );
                decision = { target: 'cloud', mode: 'cloud' };
            }

            if (decision.target === 'fleet' || decision.target === 'fleet-waiting') {
                // G9 — a delegated run whose scope no node can enforce is
                // refused HERE, before either execution mode builds a job
                // for it. Outside any try: it must propagate (the enqueue
                // site fails the run), never become a cloud fallback. A
                // missing guard refuses too (fail closed); a passed guard
                // clears THIS payload for the router's job writer, just
                // before the write below.
                await refuseUnenforceableDelegationScope(deps, payload);

                // Agent execution v2 — the plan is built AFTER the routing
                // decision (a cloud run never pays for it) and its failure
                // is NOT swallowed: a fleet run that cannot be planned has
                // no honest fallback, so the transition service records
                // the reason on the run row.
                //
                // Reviewer agent stage (slice AD): the SECOND refusal a
                // review run meets, before either execution mode builds a
                // job for it. The G9 guard above already refuses every
                // review run (its scope always narrows), so this is reached
                // only behind an explicit guard that admitted the run — see
                // `FleetAgentTaskPlanner.refuseAgentReviewRun`.
                if (deps.planner?.refuseAgentReviewRun) {
                    await deps.planner.refuseAgentReviewRun(payload);
                }
                const plan = deps.planner ? await deps.planner.plan(payload) : null;
                markDelegationScopeCleared(payload);
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
 * G9 — ask the delegation-scope guard about a fleet-bound run, failing
 * CLOSED when there is no guard to ask.
 *
 * NOT best-effort, unlike the lookups below: a guard that throws refuses the
 * run, and a guard that is missing (no `delegationScopeGuard`, and no
 * planner implementing `refuseUnenforceableDelegationScope`) refuses it
 * too, because skipping the check would let a narrowed delegated child
 * become a job on a node that cannot enforce its scope. Production always
 * wires the real planner, so the missing-guard branch only fires for a
 * mis-wired graph — where a visible refusal of every fleet-bound run is the
 * honest outcome.
 */
async function refuseUnenforceableDelegationScope(
    deps: FleetAwareDispatcherDeps,
    payload: AgentTaskExecuteDispatchPayload,
): Promise<void> {
    const guard = deps.delegationScopeGuard ?? deps.planner;
    if (!guard || typeof guard.refuseUnenforceableDelegationScope !== 'function') {
        throw new FleetDelegationScopeRefusedError(
            FLEET_DELEGATION_SCOPE_UNVERIFIABLE,
            `the delegation scope of ${
                payload.runId ? `run ${payload.runId}` : `the run for task ${payload.taskId}`
            } could not be verified before routing it to the fleet (no delegation-scope guard is ` +
                `wired into the fleet dispatcher: ${
                    deps.planner
                        ? 'the planner does not implement refuseUnenforceableDelegationScope'
                        : 'no guard and no planner'
                }). Refused: a fleet node cannot enforce a narrowed delegation scope, so a run whose ` +
                `scope cannot be checked is never assumed to be unrestricted.`,
        );
    }
    await guard.refuseUnenforceableDelegationScope(payload);
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
