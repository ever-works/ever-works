import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { config } from '@ever-works/agent/config';
import { TenantJobRuntimeConfig } from '@ever-works/agent/entities';
import {
    FleetExecutionPreferenceService,
    FleetJobService,
    FleetKillSwitchService,
} from '@ever-works/agent/fleet';
import type { AgentTaskExecuteDispatchPayload } from '@ever-works/agent/tasks-domain';
import { decideFleetRouting, DEFAULT_FLEET_EXECUTION_MODE } from '@ever-works/contracts';
import type {
    FleetAgentTaskPayload,
    FleetAgentTaskStep,
    FleetExecutionScopeQuery,
    FleetRunRoutingDecision,
} from '@ever-works/contracts';
import type {
    NodeDispatcherFactory,
    NodeJobRuntimePlugin,
} from '@ever-works/job-runtime-node-plugin';
import { agentTaskRequiredCapabilities } from './fleet-agent-task-capabilities';
import type { FleetAgentTaskPlan } from './fleet-agent-task.dispatcher';
import { FleetKillSwitchActiveError } from './fleet-kill-switch.error';
import { FleetRunnerStatusService } from './fleet-runner-status.service';
import {
    NODE_JOB_RUNTIME_DISPATCHER_FACTORY,
    NODE_JOB_RUNTIME_PLUGIN,
} from './node-job-runtime.providers';

/**
 * Ids are substituted into a command that a fleet node runs THROUGH A
 * SHELL, so anything that is not an opaque identifier is refused rather
 * than escaped. Platform ids are uuids; this is the belt on top of that.
 */
const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Thrown when a command template cannot be rendered safely. */
export class FleetAgentTaskCommandError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'FleetAgentTaskCommandError';
    }
}

/**
 * Render the operator's `FLEET_NODE_AGENT_TASK_COMMAND` template.
 *
 * Pure + exported so the substitution rules are unit-testable without a
 * DI graph. Every placeholder value is validated against
 * {@link SAFE_ID_PATTERN} first — an id that does not match is a bug
 * (or an attack), and building a shell command out of it would be worse
 * than failing the dispatch.
 */
export function renderAgentTaskCommand(
    template: string,
    ids: { taskId: string; runId?: string | null; agentId?: string | null },
): string {
    const substitute = (name: string, value: string | null | undefined): string => {
        if (typeof value !== 'string' || !SAFE_ID_PATTERN.test(value)) {
            throw new FleetAgentTaskCommandError(
                `FLEET_NODE_AGENT_TASK_COMMAND references {${name}} but the value is missing or not an opaque id`,
            );
        }
        return value;
    };
    let rendered = template;
    if (rendered.includes('{taskId}')) {
        rendered = rendered.split('{taskId}').join(substitute('taskId', ids.taskId));
    }
    if (rendered.includes('{runId}')) {
        rendered = rendered.split('{runId}').join(substitute('runId', ids.runId));
    }
    if (rendered.includes('{agentId}')) {
        rendered = rendered.split('{agentId}').join(substitute('agentId', ids.agentId));
    }
    return rendered;
}

/**
 * What the dispatcher already knows about the job before the routing
 * decision (self-build slice S). Today: the capability tags the planner
 * resolved from the tenant's execution settings, so the router counts
 * only the nodes that could lease the job. Absent = the operator's
 * config tags alone, exactly what a legacy `command` job is stamped with.
 */
export interface FleetRunRoutingHints {
    requiredCapabilities?: readonly string[];
}

/**
 * AUDIT A46/A24 — the missing PRODUCER for the fleet job queue.
 *
 * `FleetJobService.enqueue` is the server half of the `job-runtime-node`
 * provider: it writes the lease-able row an enrolled machine polls for.
 * Until this service existed nothing in production ever called it, so a
 * user could enroll a machine, watch it heartbeat green in Fleet, and it
 * would never receive a single unit of work.
 *
 * This router sits on the agent-run dispatch path and answers two
 * questions:
 *
 *   1. **Which runtime services THIS run?** The instance-global
 *      `EVER_WORKS_JOB_RUNTIME` selector, overlaid by the tenant's
 *      `tenant_job_runtime_config` row (the same precedence
 *      `TenantAwareRuntimeResolver` applies: a row only counts when it
 *      is `enabled` and its `mode` is not `inherit`). An overlay lookup
 *      that fails falls back to the instance default — resolving a
 *      runtime must never be the thing that stops a dispatch.
 *   2. **If it is the fleet, what does the node actually run?** The
 *      `agent-task` job carries the platform ids plus the ordered
 *      commands from `FLEET_NODE_AGENT_TASK_COMMAND`. A fleet node has
 *      no model access and no platform credentials, so everything it
 *      executes has to be command-shaped.
 *
 * The enqueue goes through the plugin's own {@link NodeDispatcherFactory}
 * rather than calling `FleetJobService` directly, so capability tags,
 * idempotency and the lease-TTL mapping all follow the SAME
 * `JobEnqueueOptions` semantics every sibling runtime honours.
 */
@Injectable()
export class FleetRunRouterService {
    private readonly logger = new Logger(FleetRunRouterService.name);

    constructor(
        @Inject(NODE_JOB_RUNTIME_DISPATCHER_FACTORY)
        private readonly dispatchers: NodeDispatcherFactory,
        @Inject(NODE_JOB_RUNTIME_PLUGIN)
        private readonly plugin: NodeJobRuntimePlugin,
        // Optional so a fixture (or a deployment that never registered
        // the overlay entity) resolves to the instance-global selector
        // instead of failing to construct.
        @Optional()
        @InjectRepository(TenantJobRuntimeConfig)
        private readonly overlay?: Repository<TenantJobRuntimeConfig>,
        // Appended LAST and @Optional() — the positional-arity rule the
        // sibling services follow, so every existing spec that builds
        // this router positionally keeps compiling. Absent, routing
        // degrades to the pre-preference behaviour: the fleet whenever
        // the resolved runtime is `node`, no waiting, no fallback notice.
        @Optional()
        private readonly preferences?: FleetExecutionPreferenceService,
        @Optional()
        private readonly runners?: FleetRunnerStatusService,
        // Self-build slice S — the affinity question, asked BEFORE the job
        // exists (see `FleetJobService.resolveAgentTaskTarget`). Same
        // positional-arity rule; absent = every job is judged unpinned.
        @Optional()
        private readonly jobs?: FleetJobService,
        // Panic controls (EW-778) — the GLOBAL STOP FLAG. Same appended-
        // LAST + @Optional() posture. Present, `routeAgentTask` and
        // `enqueueAgentTask` REFUSE (typed error, never a cloud fallback)
        // while the flag is set or cannot be read.
        @Optional()
        private readonly killSwitch?: FleetKillSwitchService,
    ) {}

    /**
     * True when no new work may be routed: the flag is set OR could not
     * be read. The service folds read failures into `true` itself; the
     * catch covers a stub or a future implementation that throws.
     */
    private async halted(): Promise<boolean> {
        if (!this.killSwitch) return false;
        try {
            return await this.killSwitch.isStopped();
        } catch (err) {
            this.logger.error(
                `Global stop flag could not be read — refusing to route (fail-closed): ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
            return true;
        }
    }

    /**
     * The runtime id that should service work for `tenantId`. Mirrors
     * `TenantAwareRuntimeResolver`'s precedence so the two can never
     * disagree about which tenant is on which runtime.
     */
    async resolveRuntimeId(tenantId?: string | null): Promise<string> {
        const instanceDefault = config.jobRuntime.getActiveProviderId();
        if (!tenantId || !this.overlay) {
            return instanceDefault;
        }
        try {
            const row = await this.overlay.findOne({ where: { tenantId } });
            if (!row || !row.enabled || row.mode === 'inherit') {
                return instanceDefault;
            }
            return row.providerId || instanceDefault;
        } catch (err) {
            this.logger.warn(
                `Tenant ${tenantId} job-runtime overlay lookup failed — using the instance default '${instanceDefault}': ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
            return instanceDefault;
        }
    }

    /**
     * True when this run should be enqueued onto the owner's fleet.
     *
     * `FLEET_NODE_RUNTIME_ENABLED=false` is a ROUTING SELECTOR that wins
     * over the tenant overlay — an operator taking the fleet runtime out
     * of service gets the platform default back without editing every
     * tenant row. It is NOT a panic control: work FALLS BACK TO THE
     * CLOUD. The control that stops work is the DB-backed global stop
     * flag (`FleetKillSwitchService`, EW-778), checked above this in
     * {@link routeAgentTask}.
     */
    async shouldDispatchToFleet(tenantId?: string | null): Promise<boolean> {
        if ((await this.resolveRuntimeId(tenantId)) !== 'node') {
            return false;
        }
        if (config.fleetNode.isRuntimeEnabled() === false || !this.plugin.isEnabled()) {
            this.logger.warn(
                'Fleet job runtime is selected but disabled (FLEET_NODE_RUNTIME_ENABLED) — falling back to the platform default dispatcher.',
            );
            return false;
        }
        return true;
    }

    /**
     * The full routing verdict for one dispatch: fleet now, fleet-but-
     * waiting, or cloud.
     *
     * Two questions, in this order, and the order matters:
     *
     *   0. **Is the platform STOPPED?** (EW-778) The global stop flag is
     *      read first, outside every fallback. Set (or unreadable) ⇒
     *      {@link FleetKillSwitchActiveError}, which the fleet-aware
     *      dispatcher rethrows rather than falling back to the cloud.
     *   1. **Is the fleet even on the table?** {@link shouldDispatchToFleet}
     *      answers that from the runtime selector. A `no` here is final —
     *      an owner cannot opt INTO the fleet with a preference row when
     *      their tenant is not on the fleet runtime, and no preference
     *      outranks an operator taking the runtime out of service.
     *   2. **Given the fleet is available, what does the owner want for
     *      THIS Work / Goal, and can a runner take it right now?** That
     *      is `resolveForUser` + `availability` fed into the pure
     *      {@link decideFleetRouting}.
     *
     * "A runner" means a runner that could take THIS job (self-build
     * slice S / EW-775). `FleetJobService.enqueue` pins an `agent-task`
     * to the node its Agent is bound to and stamps the tags the lease
     * scan filters on, so availability is asked the same two questions
     * here, first: the affinity (through the same
     * `resolveAgentTaskTarget` the enqueue path uses, so the two cannot
     * disagree) and the required tags (`hints`, resolved by the planner
     * from settings only — the plan itself is still built AFTER the
     * decision so a cloud run never pays for it). Before this, a job
     * pinned to a closed laptop was "placed" because five idle siblings
     * made `free > 0`, and then sat queued forever with no reason and no
     * notice.
     *
     * Never throws below step 0 (the global stop flag, which REFUSES with
     * a typed error rather than degrading): any failure after step 1
     * degrades to plain `fleet`,
     * which is byte-for-byte what this path did before preferences
     * existed. Deciding WHERE to run is infrastructure, and an
     * infrastructure hiccup must not cost the user a run. An affinity
     * lookup that fails is judged as UNPINNED and logged — the enqueue
     * path re-asks and would fail loudly if the store is really down,
     * and the queue SLA bounds a wrong "placed" either way.
     */
    async routeAgentTask(
        payload: AgentTaskExecuteDispatchPayload,
        scope: FleetExecutionScopeQuery = {},
        hints: FleetRunRoutingHints = {},
    ): Promise<FleetRunRoutingDecision> {
        if (await this.halted()) {
            throw new FleetKillSwitchActiveError(payload.taskId);
        }
        if (!(await this.shouldDispatchToFleet(payload.tenantId))) {
            // Not a fallback: this tenant was never routed to the fleet,
            // so there is nothing to notify anyone about.
            return { target: 'cloud', mode: 'cloud' };
        }
        if (!this.preferences || !this.runners) {
            return { target: 'fleet', mode: DEFAULT_FLEET_EXECUTION_MODE };
        }
        try {
            const mode = await this.preferences.resolveForUser(payload.userId, scope);
            const targetNodeId = await this.resolveAffinity(payload);
            const requiredCapabilities = hints.requiredCapabilities
                ? [...hints.requiredCapabilities]
                : agentTaskRequiredCapabilities(null);
            const availability = await this.runners.availability(payload.userId, {
                targetNodeId,
                requiredCapabilities,
            });
            const decision = decideFleetRouting(mode, availability);
            this.logger.debug(
                `Fleet routing for task ${payload.taskId}: ${decision.target} (mode ${mode}, eligible ${
                    availability.free
                }/${availability.online}/${availability.total} of ${availability.fleetTotal ?? availability.total}${
                    targetNodeId ? `, pinned to ${targetNodeId}` : ''
                }${requiredCapabilities.length > 0 ? `, requires ${requiredCapabilities.join(',')}` : ''})`,
            );
            return decision;
        } catch (err) {
            this.logger.warn(
                `Fleet execution-preference routing failed for task ${payload.taskId} — dispatching to the fleet: ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
            return { target: 'fleet', mode: DEFAULT_FLEET_EXECUTION_MODE };
        }
    }

    /**
     * The node this run's Agent is pinned to, or null. Best-effort by
     * contract (see {@link routeAgentTask}): a lookup that throws is
     * "unpinned" for the count, and the reason is logged.
     */
    private async resolveAffinity(
        payload: AgentTaskExecuteDispatchPayload,
    ): Promise<string | null> {
        if (!this.jobs) return null;
        try {
            return await this.jobs.resolveAgentTaskTarget(payload.userId, payload.agentId);
        } catch (err) {
            this.logger.warn(
                `Fleet affinity lookup failed for task ${payload.taskId} — judging availability fleet-wide: ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
            return null;
        }
    }

    /**
     * Write the lease-able `agent-task` row for one dispatched run.
     *
     * The returned id is the FLEET JOB id; the caller stamps it onto the
     * `AgentRun` the same way a Trigger.dev run id is stamped, so a
     * later status lookup / cancel can reach the remote unit of work
     * through `NodeJobRuntimePlugin.getRunStatus`.
     */
    async enqueueAgentTask(
        payload: AgentTaskExecuteDispatchPayload,
        /**
         * Stamped onto the queued row when the job was accepted with no
         * runner able to take it (`local-wait` with a busy or absent
         * fleet). Cleared by the lease CAS, so it can never outlive the
         * condition it describes.
         */
        queuedReason?: string | null,
        /**
         * Agent execution v2 — the model-CLI plan. When present the job
         * carries the assembled instructions, the token-free repository
         * spec the node provisions itself, the acceptance checks and the
         * git policy, and NOT the legacy command steps: the two modes
         * are alternatives, and a node must never be asked to run both
         * the agent and the operator's template for one Task.
         */
        plan?: FleetAgentTaskPlan | null,
    ): Promise<{ runId: string }> {
        // EW-778 — a direct caller (anything that skipped routeAgentTask)
        // is refused on the same flag. Fail closed.
        if (await this.halted()) {
            throw new FleetKillSwitchActiveError(payload.taskId);
        }
        const steps = plan ? [] : this.buildAgentTaskSteps(payload);
        const workspacePath = plan ? undefined : config.fleetNode.getAgentTaskWorkspacePath();

        const jobPayload: FleetAgentTaskPayload = {
            taskId: payload.taskId,
            agentId: payload.agentId,
            userId: payload.userId,
        };
        if (payload.runId) {
            jobPayload.runId = payload.runId;
        }
        if (workspacePath) {
            jobPayload.workspacePath = workspacePath;
        }
        if (steps.length > 0) {
            jobPayload.steps = steps;
        }
        if (plan) {
            jobPayload.execution = plan.execution;
            jobPayload.workspace = plan.workspace;
            jobPayload.acceptanceChecks = plan.acceptanceChecks;
            jobPayload.git = plan.git;
            // Self-build slice Z (EW-796) — only when the planner actually
            // enabled the bridge. The node reads THIS field to decide
            // whether to mint a credential, and `FleetRunCredentialService`
            // re-reads it at mint time, so a job whose plan never asked for
            // tools can never be talked into having them.
            if (plan.mcp) {
                jobPayload.mcp = plan.mcp;
            }
        }
        // A model-CLI job may only be leased by a node that advertises the
        // CLI it needs: the tag is backed by a resolved executable on the
        // node, so requiring it here is what keeps a Claude job off a
        // machine that only has Codex (and vice versa). ONE definition,
        // shared with the routing decision above, so the row can never
        // demand a tag the router did not count against.
        const requiredCapabilities = agentTaskRequiredCapabilities(
            plan ? plan.execution.provider : null,
        );

        const leaseTtlSec = config.fleetNode.getLeaseTtlSeconds();
        const enqueueOptions: {
            idempotencyKey: string;
            maxDurationSeconds?: number;
            tenantId?: string;
        } = { idempotencyKey: payload.dedupKey };
        if (leaseTtlSec !== undefined) {
            enqueueOptions.maxDurationSeconds = leaseTtlSec;
        }
        if (payload.tenantId) {
            enqueueOptions.tenantId = payload.tenantId;
        }

        const jobId = await this.dispatchers.enqueue(
            {
                kind: 'agent-task',
                userId: payload.userId,
                organizationId: payload.organizationId ?? null,
                payload: jobPayload as unknown as Record<string, unknown>,
                requiredCapabilities,
                ...(queuedReason ? { queuedReason } : {}),
            },
            enqueueOptions,
        );

        this.logger.log(
            `Enqueued fleet job ${jobId} (agent-task${plan ? `, model-cli/${plan.execution.provider}` : ''}) for task ${
                payload.taskId
            } run ${payload.runId ?? 'unknown'}${queuedReason ? ` [${queuedReason}]` : ''}`,
        );
        return { runId: jobId };
    }

    /**
     * Ordered commands the node runs for this task. Empty when the
     * operator has not configured `FLEET_NODE_AGENT_TASK_COMMAND` — the
     * job is still enqueued, and the node fails it naming that variable.
     * Loud degradation: a queue that silently succeeds at nothing is the
     * failure mode this whole change exists to remove.
     */
    private buildAgentTaskSteps(payload: AgentTaskExecuteDispatchPayload): FleetAgentTaskStep[] {
        const template = config.fleetNode.getAgentTaskCommand();
        if (!template) {
            return [];
        }
        const command = renderAgentTaskCommand(template, {
            taskId: payload.taskId,
            runId: payload.runId,
            agentId: payload.agentId,
        });
        const step: FleetAgentTaskStep = { id: 'agent-task', command, required: true };
        // Names only — the VALUES are read from the node's own environment and
        // never leave the machine. Without this the node's secret-shaped-name
        // scrub drops every CLI credential and the agent runs unauthenticated.
        const envPassthrough = config.fleetNode.getAgentTaskEnvPassthrough();
        if (envPassthrough.length > 0) {
            step.envPassthrough = envPassthrough;
        }
        return [step];
    }
}
