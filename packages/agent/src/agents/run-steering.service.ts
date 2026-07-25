import {
    ConflictException,
    Inject,
    Injectable,
    Logger,
    NotFoundException,
    Optional,
} from '@nestjs/common';
import { AgentRunRepository } from '../database/repositories/agent-run.repository';
import { AgentRunLogRepository } from '../database/repositories/agent-run-log.repository';
import type { AgentRun } from '../entities/agent-run.entity';
import {
    AGENT_TASK_EXECUTE_DISPATCHER,
    JOB_RUNTIME_NOT_CONFIGURED_REASON,
    type AgentTaskExecuteDispatcher,
} from '../tasks-domain/task-dispatcher';
import type {
    RunSteerInput,
    RunSteerOutcome,
    RunSteeringPort,
} from '../tasks-domain/run-steering-port';
import { RunDispatchGateService } from './run-dispatch-gate.service';

/**
 * `terminalEndedReason` values that make a finished run resumable: the
 * process was parked (hibernated) rather than completed, so its
 * conversation — identified by `cliSessionId` — is still valid.
 */
const RESUMABLE_ENDED_REASONS = ['parked'] as const;

/** Longest steering message accepted. Matches the task-chat body cap. */
const MAX_STEER_BYTES = 16 * 1024;

export interface RunInterruptOutcome {
    /** True when the flag was recorded on a live run. */
    interrupted: boolean;
    runId: string;
}

export interface RunResumeOutcome {
    dispatched: 'new-run';
    /** The NEW run's id. The source run stays terminal — runs are immutable. */
    runId: string;
    /** Source run this one resumes. */
    resumedFromRunId: string;
    /** Whether the pipeline's own conversation id was carried over. */
    carriedCliSession: boolean;
    /** True when the dispatch gate parked the new run instead of enqueuing it. */
    queued: boolean;
}

/**
 * Run steering (Wave 4 M5) — the four run controls, all owner-scoped and
 * all executor-stamped.
 *
 *  - **steer**     — a message for a run. LIVE run (`queued`/`running`) ⇒ the
 *                    message is appended to the run's persisted pending-input
 *                    queue and the executing tool loop injects it between
 *                    model round-trips (`dispatched: 'injected'`). TERMINAL
 *                    run ⇒ nothing is injected and the caller is told to start
 *                    a fresh run (`dispatched: 'new-run'`). Steering also
 *                    clears `awaitingInput`: an answered question is no longer
 *                    a question.
 *  - **interrupt** — cooperative stop request. Sets `interruptRequested`; the
 *                    tool loop honours it at its per-iteration checkpoint, so
 *                    the run stops BETWEEN iterations and finishes `completed`
 *                    with a summary rather than being killed mid-flight.
 *  - **stop**      — deliberately NOT implemented here. Stop is cancel, and
 *                    cancel already exists end-to-end
 *                    (`AgentRunRepository.cancel` + `AGENT_RUN_CANCELLER` +
 *                    `POST /api/agents/:id/runs/:runId/cancel`). Duplicating
 *                    it would fork the CAS + remote-cancel + drain semantics.
 *  - **resume**    — a parked or awaiting-input run gets a NEW run carrying
 *                    its `cliSessionId` (the pipeline plugin's own conversation
 *                    id) and, optionally, a first message. Runs are immutable:
 *                    resume never revives the old row.
 *
 * Every method loads the run through `findByIdAndUser`, so a run belonging to
 * another user is indistinguishable from a missing one (no existence oracle —
 * architecture/security §9).
 */
@Injectable()
export class RunSteeringService implements RunSteeringPort {
    private readonly logger = new Logger(RunSteeringService.name);

    constructor(
        private readonly runs: AgentRunRepository,
        // Executor stamping (this plan §3.4): every control action writes an
        // audit row naming the acting user. @Optional() so unit-test
        // constructors can omit it.
        @Optional() private readonly runLogs?: AgentRunLogRepository,
        // Bound by the api-side @Global() TasksModule; absent in unit tests
        // and installs without a job runtime — resume reports honestly
        // instead of pretending it dispatched.
        @Optional()
        @Inject(AGENT_TASK_EXECUTE_DISPATCHER)
        private readonly dispatcher?: AgentTaskExecuteDispatcher,
        // Resume goes through the same concurrency choke point as every
        // other dispatch path — a resumed run is a run.
        @Optional() private readonly dispatchGate?: RunDispatchGateService,
    ) {}

    /** A run that can still receive injected input. */
    static isLive(run: Pick<AgentRun, 'status'>): boolean {
        return run.status === 'queued' || run.status === 'running';
    }

    /** A finished run whose conversation can still be resumed. */
    static isResumable(run: Pick<AgentRun, 'status' | 'awaitingInput' | 'terminalEndedReason'>) {
        if (run.awaitingInput === true) return true;
        return (
            !RunSteeringService.isLive(run) &&
            RESUMABLE_ENDED_REASONS.includes(
                (run.terminalEndedReason ?? '') as (typeof RESUMABLE_ENDED_REASONS)[number],
            )
        );
    }

    // ── steer ──────────────────────────────────────────────────────

    async steer(input: RunSteerInput): Promise<RunSteerOutcome> {
        const message = this.assertMessage(input.message);
        const run = await this.requireOwnedRun(input.runId, input.userId);

        if (!RunSteeringService.isLive(run)) {
            // Terminal run — nothing to inject into. The caller (task chat,
            // API, UI) starts a fresh run instead. NOT an error: "the run
            // already finished" is a normal race with a human typing.
            await this.stamp(run.id, input.userId, 'steer', {
                dispatched: 'new-run',
                runStatus: run.status,
            });
            return { dispatched: 'new-run', runId: run.id };
        }

        const appended = await this.runs.appendPendingInput(run.id, message);
        if (!appended) {
            // Lost the race with a terminal write between our read and the
            // guarded UPDATE. Same answer as the terminal branch.
            await this.stamp(run.id, input.userId, 'steer', {
                dispatched: 'new-run',
                reason: 'terminal-race',
            });
            return { dispatched: 'new-run', runId: run.id };
        }

        const queue = await this.peekQueueLength(run.id);
        await this.stamp(run.id, input.userId, 'steer', {
            dispatched: 'injected',
            queuedCount: queue,
        });
        this.logger.log(`Run ${run.id}: steering message injected by user ${input.userId}.`);
        return { dispatched: 'injected', runId: run.id, queuedCount: queue };
    }

    // ── interrupt ──────────────────────────────────────────────────

    async interrupt(runId: string, userId: string): Promise<RunInterruptOutcome> {
        const run = await this.requireOwnedRun(runId, userId);
        if (!RunSteeringService.isLive(run)) {
            throw new ConflictException(
                `AgentRun ${runId} is ${run.status} — only a queued or running run can be interrupted.`,
            );
        }
        const recorded = await this.runs.requestInterrupt(run.id);
        if (!recorded) {
            // Terminal between the read and the CAS.
            throw new ConflictException(
                `AgentRun ${runId} finished before the interrupt could be recorded.`,
            );
        }
        await this.stamp(run.id, userId, 'interrupt', { previousStatus: run.status });
        this.logger.log(`Run ${run.id}: interrupt requested by user ${userId}.`);
        return { interrupted: true, runId: run.id };
    }

    // ── resume ─────────────────────────────────────────────────────

    async resume(
        runId: string,
        userId: string,
        message?: string | null,
    ): Promise<RunResumeOutcome> {
        const trimmed =
            message == null || message.trim().length === 0 ? null : this.assertMessage(message);
        const run = await this.requireOwnedRun(runId, userId);

        if (!RunSteeringService.isResumable(run)) {
            throw new ConflictException(
                `AgentRun ${runId} is not resumable — resume applies to runs awaiting input or ` +
                    `ended with reason '${RESUMABLE_ENDED_REASONS.join("' / '")}' ` +
                    `(status=${run.status}, endedReason=${run.terminalEndedReason ?? 'none'}).`,
            );
        }
        if (!run.taskId) {
            // The only dispatch path a resumed run can take today is
            // `agent-task-execute`, which is Task-keyed. A heartbeat run has
            // no Task to resume onto — say so instead of half-dispatching.
            throw new ConflictException(
                `AgentRun ${runId} has no Task — only task-attached runs can be resumed.`,
            );
        }

        // Same concurrency choke point as every other dispatch path.
        const admission = this.dispatchGate
            ? await this.dispatchGate.admit({
                  userId,
                  workId: run.workId ?? null,
                  organizationId: run.organizationId ?? null,
              })
            : { admitted: true as const, queuedReason: undefined };

        const next = await this.runs.createQueued({
            agentId: run.agentId,
            userId,
            triggerKind: 'task',
            taskId: run.taskId,
            workId: run.workId ?? null,
            organizationId: run.organizationId ?? null,
            runnerKind: run.runnerKind ?? null,
            queuedReason: admission.admitted ? null : (admission.queuedReason ?? null),
            // Streaming terminal — the conversation lifetime survives the
            // process lifetime, and so does the SHAPE of the session. A
            // resumed persistent run still wants an interactive terminal,
            // which is what the fan-out's `requirePersistent` gate reads.
            persistent: run.persistent === true,
        });

        // The conversation lifetime survives the process lifetime: hand the
        // pipeline plugin its own resume id, and seed the first message so
        // the resumed loop starts from the human's answer.
        await this.runs.seedResumeContext(next.id, {
            cliSessionId: run.cliSessionId ?? null,
            pendingInput: trimmed ? [trimmed] : null,
        });

        // The source run is answered — it must stop showing up in the
        // needs-attention filter.
        if (run.awaitingInput) {
            await this.runs.setAwaitingInput(run.id, false).catch(() => undefined);
        }

        if (admission.admitted && this.dispatcher) {
            try {
                const handle = await this.dispatcher.enqueue({
                    agentId: run.agentId,
                    userId,
                    taskId: run.taskId,
                    // Run-scoped so a double resume dedups at the runner and
                    // cannot collide with the original run's fan-out key.
                    dedupKey: `${run.taskId}:${run.agentId}:resume:${next.id}`,
                    runId: next.id,
                });
                if (handle?.runId) {
                    await this.runs
                        .setTriggerRunId(next.id, handle.runId)
                        .catch((err) =>
                            this.logger.warn(
                                `Run ${next.id}: failed to stamp triggerRunId on resume: ${err}`,
                            ),
                        );
                }
            } catch (err) {
                const detail = err instanceof Error ? err.message : String(err);
                const notConfigured =
                    err instanceof Error && err.name === 'JobRuntimeNotConfiguredError';
                const reason = notConfigured
                    ? `${JOB_RUNTIME_NOT_CONFIGURED_REASON}: ${detail}`
                    : `dispatch-failed: ${detail}`;
                this.logger.warn(`Run ${next.id}: resume enqueue failed: ${reason}`);
                await this.runs.markDispatchFailed(next.id, reason).catch(() => undefined);
                throw new ConflictException(`Resume could not be dispatched — ${reason}`);
            }
        }

        await this.stamp(next.id, userId, 'resume', {
            resumedFromRunId: run.id,
            carriedCliSession: Boolean(run.cliSessionId),
            hasMessage: Boolean(trimmed),
            queued: !admission.admitted,
        });
        this.logger.log(`Run ${run.id}: resumed as ${next.id} by user ${userId}.`);

        return {
            dispatched: 'new-run',
            runId: next.id,
            resumedFromRunId: run.id,
            carriedCliSession: Boolean(run.cliSessionId),
            queued: !admission.admitted,
        };
    }

    // ── internals ──────────────────────────────────────────────────

    private async requireOwnedRun(runId: string, userId: string): Promise<AgentRun> {
        const run = await this.runs.findByIdAndUser(runId, userId);
        if (!run) throw new NotFoundException(`AgentRun ${runId} not found.`);
        return run;
    }

    private assertMessage(message: string): string {
        const trimmed = (message ?? '').trim();
        if (trimmed.length === 0) {
            throw new ConflictException('A steering message is required.');
        }
        if (trimmed.length > MAX_STEER_BYTES) {
            throw new ConflictException(`Steering message exceeds max ${MAX_STEER_BYTES} bytes.`);
        }
        return trimmed;
    }

    private async peekQueueLength(runId: string): Promise<number> {
        try {
            const fresh = await this.runs.findById(runId);
            return Array.isArray(fresh?.pendingInput) ? fresh.pendingInput.length : 0;
        } catch {
            return 0;
        }
    }

    /**
     * Executor stamp (this plan §3.4 — "all of them stamp the acting user").
     * Best-effort: an audit-row failure must never fail the control action it
     * describes, but every failure is logged so a silent audit gap is
     * impossible.
     */
    private async stamp(
        runId: string,
        userId: string,
        action: 'steer' | 'interrupt' | 'resume',
        metadata: Record<string, unknown>,
    ): Promise<void> {
        if (!this.runLogs) return;
        try {
            await this.runLogs.append({
                runId,
                level: 'INFO',
                step: 'steering',
                message: `Run control '${action}' by user ${userId}.`,
                metadata: { ...metadata, action, actorUserId: userId },
            });
        } catch (err) {
            this.logger.warn(`Run ${runId}: failed to stamp '${action}' audit row: ${err}`);
        }
    }
}
