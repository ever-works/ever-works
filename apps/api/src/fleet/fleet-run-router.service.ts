import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { config } from '@ever-works/agent/config';
import { TenantJobRuntimeConfig } from '@ever-works/agent/entities';
import { FleetExecutionPreferenceService } from '@ever-works/agent/fleet';
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
    ) {}

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
     * `FLEET_NODE_RUNTIME_ENABLED=false` is the kill switch and wins
     * over the selector — an operator draining the fleet gets the
     * platform default back without editing every tenant row.
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
     *   1. **Is the fleet even on the table?** {@link shouldDispatchToFleet}
     *      answers that from the runtime selector and the operator kill
     *      switch. A `no` here is final — an owner cannot opt INTO the
     *      fleet with a preference row when their tenant is not on the
     *      fleet runtime, and no preference outranks an operator
     *      draining the fleet.
     *   2. **Given the fleet is available, what does the owner want for
     *      THIS Work / Goal, and can a runner take it right now?** That
     *      is `resolveForUser` + `availability` fed into the pure
     *      {@link decideFleetRouting}.
     *
     * Never throws: any failure below step 1 degrades to plain `fleet`,
     * which is byte-for-byte what this path did before preferences
     * existed. Deciding WHERE to run is infrastructure, and an
     * infrastructure hiccup must not cost the user a run.
     */
    async routeAgentTask(
        payload: AgentTaskExecuteDispatchPayload,
        scope: FleetExecutionScopeQuery = {},
    ): Promise<FleetRunRoutingDecision> {
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
            const availability = await this.runners.availability(payload.userId);
            return decideFleetRouting(mode, availability);
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
    ): Promise<{ runId: string }> {
        const steps = this.buildAgentTaskSteps(payload);
        const workspacePath = config.fleetNode.getAgentTaskWorkspacePath();

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
                requiredCapabilities: config.fleetNode.getRequiredCapabilities(),
                ...(queuedReason ? { queuedReason } : {}),
            },
            enqueueOptions,
        );

        this.logger.log(
            `Enqueued fleet job ${jobId} (agent-task) for task ${payload.taskId} run ${
                payload.runId ?? 'unknown'
            }${queuedReason ? ` [${queuedReason}]` : ''}`,
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
