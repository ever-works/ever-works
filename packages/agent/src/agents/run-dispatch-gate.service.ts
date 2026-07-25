import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { config } from '../config';
import { AgentRunRepository } from '../database/repositories/agent-run.repository';
import {
    AGENT_TASK_EXECUTE_DISPATCHER,
    JOB_RUNTIME_NOT_CONFIGURED_REASON,
    type AgentTaskExecuteDispatcher,
} from '../tasks-domain/task-dispatcher';

/**
 * Stable machine token stamped into `agent_runs.queuedReason` when the
 * gate parks a run instead of dispatching it. The drain looks rows up by
 * this exact literal — one shared constant, never three drifting copies.
 */
export const QUEUED_REASON_CONCURRENCY = 'concurrency-limit' as const;

export interface RunDispatchAdmitInput {
    userId: string;
    workId?: string | null;
    organizationId?: string | null;
}

export interface RunDispatchAdmitResult {
    admitted: boolean;
    /** Set only when `admitted === false`; today always `concurrency-limit`. */
    queuedReason?: string;
}

export interface RunDispatchDrainResult {
    dispatched: boolean;
    runId?: string;
    reason?: 'no-candidate' | 'over-limit' | 'claim-lost' | 'no-dispatcher' | 'dispatch-failed';
}

/**
 * Run orchestration (Wave 4 M2) — the single concurrency choke point for
 * agent-run dispatch.
 *
 * `admit()` counts in-flight runs (`running` + dispatched-`queued`) per
 * Work and per org/user against CONFIGURABLE safety valves
 * (`AGENT_MAX_CONCURRENT_RUNS_PER_WORK`, default 10;
 * `AGENT_MAX_CONCURRENT_RUNS_PER_ORG`, default 25; `<= 0` disables the
 * valve). These are operator knobs, never product limits. A per-Work
 * override column (`works.maxConcurrentAgentRuns`, works.yml v2) is the
 * documented next step — it will slot in ahead of the env default inside
 * `resolveWorkLimit()` without touching any caller.
 *
 * Over-limit dispatch paths create the run anyway (`status='queued'`,
 * `queuedReason='concurrency-limit'`) and skip the job-runtime enqueue.
 * `drainForWork()` promotes the OLDEST parked run for a Work — called on
 * terminal transitions (worker terminal writes, user cancel) and from the
 * stuck-run sweeper as the safety net.
 *
 * Races: the count is check-then-insert without an advisory lock (the
 * e2e suite runs on sqlite, which has none), so a parallel burst can
 * transiently exceed a valve by the burst width. Acceptable for a safety
 * valve; the CAS claim in `claimQueuedForDispatch` is what prevents the
 * harmful race — two drains double-dispatching one run.
 */
@Injectable()
export class RunDispatchGateService {
    private readonly logger = new Logger(RunDispatchGateService.name);

    constructor(
        private readonly runs: AgentRunRepository,
        // Bound by the api-side @Global() TasksModule; absent in unit
        // tests and installs without a job runtime — admit() still
        // works, drain reports `no-dispatcher`.
        @Optional()
        @Inject(AGENT_TASK_EXECUTE_DISPATCHER)
        private readonly dispatcher?: AgentTaskExecuteDispatcher,
    ) {}

    /** Env default today; per-Work override column when it lands. */
    private resolveWorkLimit(): number {
        return config.agents.getMaxConcurrentRunsPerWork();
    }

    private resolveOrgLimit(): number {
        return config.agents.getMaxConcurrentRunsPerOrg();
    }

    /**
     * Decide whether a new run may be handed to the job runtime NOW.
     * Never throws on its own account — callers treat a thrown counting
     * failure as fail-open (a broken safety valve must not stop work).
     */
    async admit(input: RunDispatchAdmitInput): Promise<RunDispatchAdmitResult> {
        const workLimit = this.resolveWorkLimit();
        if (input.workId && workLimit > 0) {
            const inFlight = await this.runs.countInFlightForWork(input.workId);
            if (inFlight >= workLimit) {
                this.logger.log(
                    `Dispatch gate: Work ${input.workId} at ${inFlight}/${workLimit} in-flight runs — queueing.`,
                );
                return { admitted: false, queuedReason: QUEUED_REASON_CONCURRENCY };
            }
        }

        const orgLimit = this.resolveOrgLimit();
        if (orgLimit > 0) {
            const inFlight = input.organizationId
                ? await this.runs.countInFlightForOrganization(input.organizationId)
                : await this.runs.countInFlightForUser(input.userId);
            if (inFlight >= orgLimit) {
                this.logger.log(
                    `Dispatch gate: ${
                        input.organizationId
                            ? `org ${input.organizationId}`
                            : `user ${input.userId}`
                    } at ${inFlight}/${orgLimit} in-flight runs — queueing.`,
                );
                return { admitted: false, queuedReason: QUEUED_REASON_CONCURRENCY };
            }
        }

        return { admitted: true };
    }

    /**
     * Promote the oldest concurrency-parked run for a Work, if capacity
     * allows. One promotion per call on purpose: every terminal
     * transition frees at most one slot, and the next terminal (or the
     * sweeper net) drains the next row. Best-effort by contract — every
     * failure is logged and reported in the result, never thrown, so a
     * drain hiccup can never fail the terminal transition that hosts it.
     */
    async drainForWork(workId: string): Promise<RunDispatchDrainResult> {
        try {
            const candidate = await this.runs.findOldestQueuedForConcurrency(
                workId,
                QUEUED_REASON_CONCURRENCY,
            );
            if (!candidate) return { dispatched: false, reason: 'no-candidate' };
            if (!candidate.taskId) {
                // Only the task dispatch path parks runs today; a parked
                // run without a Task cannot be re-dispatched through the
                // agent-task-execute path. Surface loudly.
                this.logger.warn(
                    `Dispatch gate: parked run ${candidate.id} has no taskId — cannot drain.`,
                );
                return { dispatched: false, reason: 'no-candidate' };
            }

            const admission = await this.admit({
                userId: candidate.userId,
                workId,
                organizationId: candidate.organizationId ?? null,
            });
            if (!admission.admitted) return { dispatched: false, reason: 'over-limit' };

            if (!this.dispatcher) {
                // Nothing to dispatch through — leave the row parked (it
                // was never claimed) and tell the caller why.
                return { dispatched: false, reason: 'no-dispatcher' };
            }

            const claimed = await this.runs.claimQueuedForDispatch(
                candidate.id,
                QUEUED_REASON_CONCURRENCY,
            );
            if (!claimed) return { dispatched: false, reason: 'claim-lost' };

            try {
                const handle = await this.dispatcher.enqueue({
                    agentId: candidate.agentId,
                    userId: candidate.userId,
                    taskId: candidate.taskId,
                    // Unique per parked row — the original generation-based
                    // key is unknowable here, and this run was never handed
                    // to the runtime, so a run-scoped key both dedups a
                    // double drain at the runner AND cannot collide with the
                    // fan-out key of the run that was admitted immediately.
                    dedupKey: `${candidate.taskId}:${candidate.agentId}:drain:${candidate.id}`,
                    runId: candidate.id,
                });
                if (handle?.runId) {
                    try {
                        await this.runs.setTriggerRunId(candidate.id, handle.runId);
                    } catch (stampErr) {
                        this.logger.warn(
                            `Dispatch gate: failed to stamp triggerRunId on drained run ${candidate.id}: ${stampErr}`,
                        );
                    }
                }
                this.logger.log(
                    `Dispatch gate: drained run ${candidate.id} for Work ${workId} (task ${candidate.taskId}).`,
                );
                return { dispatched: true, runId: candidate.id };
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                const notConfigured =
                    err instanceof Error && err.name === 'JobRuntimeNotConfiguredError';
                const reason = notConfigured
                    ? `${JOB_RUNTIME_NOT_CONFIGURED_REASON}: ${message}`
                    : `dispatch-failed: ${message}`;
                this.logger.warn(
                    `Dispatch gate: drain enqueue failed for ${candidate.id}: ${reason}`,
                );
                // Same posture as the fan-out path: a run whose enqueue
                // threw is rolled to failed (CAS queued-only, so a runtime
                // that accepted the job anyway keeps its live run).
                try {
                    await this.runs.markDispatchFailed(candidate.id, reason);
                } catch (failErr) {
                    this.logger.warn(
                        `Dispatch gate: failed to mark drained run ${candidate.id} failed: ${failErr}`,
                    );
                }
                return { dispatched: false, reason: 'dispatch-failed' };
            }
        } catch (err) {
            this.logger.warn(`Dispatch gate: drainForWork(${workId}) failed: ${err}`);
            return { dispatched: false, reason: 'dispatch-failed' };
        }
    }
}
