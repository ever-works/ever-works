import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { config } from '../config';
import { AgentRunRepository } from '../database/repositories/agent-run.repository';
import {
    AGENT_CHAT_REPLY_DISPATCHER,
    AGENT_TASK_EXECUTE_DISPATCHER,
    JOB_RUNTIME_NOT_CONFIGURED_REASON,
    type AgentChatReplyDispatcher,
    type AgentTaskExecuteDispatcher,
} from '../tasks-domain/task-dispatcher';
import { RUN_CREDITS_PRECHECK, type RunCreditsPrecheck } from './run-credits-precheck';

/**
 * Stable machine token stamped into `agent_runs.queuedReason` when the
 * gate parks a run instead of dispatching it. The drain looks rows up by
 * this exact literal — one shared constant, never three drifting copies.
 */
export const QUEUED_REASON_CONCURRENCY = 'concurrency-limit' as const;

/**
 * Pricing Wave 9 M2 — stamped when the soft credits precheck parks a run
 * (credit-limited plan + exhausted balance, `CREDITS_ENFORCEMENT=on`).
 * Deliberately NOT drained by {@link RunDispatchGateService.drainForWork}
 * (that promotes concurrency-parked rows only): a credits-parked run
 * waits for a top-up, not for capacity. Promotion-on-top-up is a
 * documented Wave 9 follow-up; until then the run stays visibly queued
 * with this reason in the Sessions view.
 */
export const QUEUED_REASON_INSUFFICIENT_CREDITS = 'insufficient-credits' as const;

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
 * Persist-the-run half of an admission. Runs INSIDE the advisory lock
 * (Postgres) so the valve's count and the row that consumes a slot are
 * one critical section instead of a check-then-insert race.
 *
 * Contract: exactly one call per `admit()` that supplies it, and it must
 * be the thing that creates the `agent_runs` row (parked or not).
 */
export type RunDispatchReserve = (admission: RunDispatchAdmitResult) => Promise<void>;

/**
 * The scope a burst is serialized on. Narrowest-wins: a Work when the
 * run has one (that is the valve that actually saturates, and it keeps
 * two Works in one org from serializing against each other), else the
 * org, else the user.
 *
 * Consequence, stated plainly: with a Work-scoped lock the per-ORG valve
 * is still check-then-insert across different Works of the same org. It
 * is a safety valve with a burst-width tolerance, not a quota — and
 * locking every dispatch in an org behind one key would be a far worse
 * trade.
 */
export function runAdmissionLockScope(input: RunDispatchAdmitInput): string {
    if (input.workId) return `work:${input.workId}`;
    if (input.organizationId) return `org:${input.organizationId}`;
    return `user:${input.userId}`;
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
 * Races: pass a `reserve` callback to `admit()` and the count + the
 * caller's row insert become ONE critical section, serialized per
 * admission scope by `pg_advisory_xact_lock` when the driver is Postgres
 * (`AgentRunRepository.withAdmissionLock`). On sqlite — the entire e2e
 * stack — advisory locks do not exist, so that degrades to a documented
 * no-op and a parallel burst can still transiently exceed a valve by the
 * burst width. Acceptable for a safety valve; the CAS claim in
 * `claimQueuedForDispatch` remains the correctness floor either way — it
 * is what prevents the harmful race, two drains double-dispatching one
 * run.
 *
 * EVERY path that enqueues an AgentRun goes through `admit()`: the task
 * fan-out and board/batch run (`TaskTransitionService.dispatchAgentRun`),
 * resume (`RunSteeringService`), agent-mention chat replies
 * (`TaskChatService`), the heartbeat cron + run-now
 * (`AgentScheduleDispatcherService`) and `POST /agents/:id/assign-task`.
 * The DOCUMENTED bypasses, which must stay bypassed, are:
 *   - this service's own `drainForWork` (it IS the gate, and re-admits);
 *   - the worker-side `createQueued` fallbacks in `@ever-works/tasks`
 *     trigger tasks — the job runtime has already accepted that job, so
 *     the row is bookkeeping for work in flight, not a new admission;
 *   - `TerminalSessionLauncher` — attaches a shell to an ALREADY-admitted
 *     live run; it enqueues no AgentRun.
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
        // Pricing Wave 9 M2 — soft credits precheck. Bound (to
        // RunCostSettlementService) by the api-side @Global()
        // SubscriptionsModule; absent in unit tests and credit-less
        // installs. Appended LAST + @Optional() per the positional-spec
        // arity rule.
        @Optional()
        @Inject(RUN_CREDITS_PRECHECK)
        private readonly creditsPrecheck?: RunCreditsPrecheck,
        // Chat-triggered runs are now gated too, so the drain must be
        // able to put one back on the path it came from. Same @Optional()
        // + appended-LAST posture as every other seam here (the
        // positional-spec arity rule): unit tests and chat-less installs
        // simply report `no-dispatcher` for a parked chat run.
        @Optional()
        @Inject(AGENT_CHAT_REPLY_DISPATCHER)
        private readonly chatDispatcher?: AgentChatReplyDispatcher,
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
     *
     * `reserve` (optional) turns the call into a critical section: the
     * count AND the caller's `agent_runs` insert run under one
     * `pg_advisory_xact_lock` on Postgres, closing the check-then-insert
     * window that let a parallel burst walk past the valve. On every
     * other driver the lock is a documented no-op (see
     * {@link AgentRunRepository.withAdmissionLock}). When `reserve` is
     * supplied it is called EXACTLY ONCE — including on the fail-open
     * path, so a broken valve still produces a run — and errors it
     * raises propagate to the caller unchanged.
     *
     * Callers that only need the verdict (the drain, admission probes)
     * omit `reserve` and get the pre-existing behaviour byte for byte.
     */
    async admit(
        input: RunDispatchAdmitInput,
        reserve?: RunDispatchReserve,
    ): Promise<RunDispatchAdmitResult> {
        if (!reserve) return this.evaluate(input);
        // `withAdmissionLock` is optional on the repository so hand-built
        // stubs in unit tests (and any partial mock) keep working — they
        // simply run unlocked, which is what sqlite does anyway.
        const run = async (): Promise<RunDispatchAdmitResult> => {
            let admission: RunDispatchAdmitResult;
            try {
                admission = await this.evaluate(input);
            } catch (err) {
                // Fail-open: a broken counting query must never stop
                // legitimate dispatch. The caller still gets its row.
                this.logger.warn(`Dispatch gate: admission evaluation failed (fail-open): ${err}`);
                admission = { admitted: true };
            }
            await reserve(admission);
            return admission;
        };
        return typeof this.runs.withAdmissionLock === 'function'
            ? this.runs.withAdmissionLock(runAdmissionLockScope(input), run)
            : run();
    }

    private async evaluate(input: RunDispatchAdmitInput): Promise<RunDispatchAdmitResult> {
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

        // Pricing Wave 9 M2 — soft credits enforcement (ship-dark). Runs
        // ONLY when the CREDITS_ENFORCEMENT kill-switch is on AND the
        // precheck token is bound. Fail-open on any error: a broken
        // billing check must never stop work (same posture as a broken
        // concurrency valve).
        if (this.creditsPrecheck && config.billing.credits.isEnforcementEnabled()) {
            try {
                if (await this.creditsPrecheck.shouldQueueForCredits(input.userId)) {
                    this.logger.log(
                        `Dispatch gate: user ${input.userId} is credit-limited with an ` +
                            `exhausted balance — queueing.`,
                    );
                    return {
                        admitted: false,
                        queuedReason: QUEUED_REASON_INSUFFICIENT_CREDITS,
                    };
                }
            } catch (err) {
                this.logger.warn(
                    `Dispatch gate: credits precheck failed for user ${input.userId} ` +
                        `(fail-open): ${err}`,
                );
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
                // Every parking path is Task-keyed (task fan-out, board
                // run, resume, chat reply); a parked run without a Task
                // cannot be re-dispatched through either runtime path.
                // Surface loudly.
                this.logger.warn(
                    `Dispatch gate: parked run ${candidate.id} has no taskId — cannot drain.`,
                );
                return { dispatched: false, reason: 'no-candidate' };
            }
            // A chat-triggered run must go back out as `agent-chat-reply`
            // with its triggering message, NOT as `agent-task-execute` —
            // re-dispatching it on the task path would drop the message
            // the agent is supposed to be replying to.
            const viaChat = candidate.triggerKind === 'chat' && Boolean(candidate.chatMessageId);

            const admission = await this.admit({
                userId: candidate.userId,
                workId,
                organizationId: candidate.organizationId ?? null,
            });
            if (!admission.admitted) return { dispatched: false, reason: 'over-limit' };

            if (viaChat ? !this.chatDispatcher : !this.dispatcher) {
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
                // Unique per parked row — the original generation-based
                // key is unknowable here, and this run was never handed
                // to the runtime, so a run-scoped key both dedups a
                // double drain at the runner AND cannot collide with the
                // fan-out key of the run that was admitted immediately.
                const dedupKey = `${candidate.taskId}:${candidate.agentId}:drain:${candidate.id}`;
                const handle = viaChat
                    ? await this.chatDispatcher!.enqueue({
                          agentId: candidate.agentId,
                          userId: candidate.userId,
                          taskId: candidate.taskId,
                          triggeringMessageId: candidate.chatMessageId!,
                          dedupKey,
                          runId: candidate.id,
                      })
                    : await this.dispatcher!.enqueue({
                          agentId: candidate.agentId,
                          userId: candidate.userId,
                          taskId: candidate.taskId,
                          dedupKey,
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
