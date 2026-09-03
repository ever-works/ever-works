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
import { TerminalSessionLauncher } from './terminal-session-launcher.service';
import { TaskReviewRejectionRepository } from '../database/repositories/task-review-rejection.repository';
import type { OwnershipScope } from '../database/ownership-scope';

type ScopedRunSteerInput = RunSteerInput & { ownershipScope?: OwnershipScope };

/**
 * `terminalEndedReason` values that make a finished run resumable: the
 * process was parked (hibernated) rather than completed, so its
 * conversation — identified by `cliSessionId` — is still valid.
 */
const RESUMABLE_ENDED_REASONS = ['parked'] as const;

/** Longest steering message accepted. Matches the task-chat body cap. */
const MAX_STEER_BYTES = 16 * 1024;

/**
 * Orchestration M9 — how many pending rejections a single resume replays.
 * Bounded so a Task that accumulated a rejection storm cannot blow the
 * resumed run's first prompt; the oldest are replayed first (a comment
 * thread reads in order), and anything beyond the cap stays pending for
 * the resume after this one.
 */
const MAX_REPLAYED_REJECTIONS = 3;

/**
 * Chat-template control markers a rejection body could try to forge.
 * Mirrors the worker's `neutralizeControlTokens`: rejection feedback is
 * written by a HUMAN REVIEWER — including, for `pull-request` rejections,
 * anyone who can comment on the repo — and it is spliced into the resumed
 * run's first turn, so it is untrusted input on a prompt path.
 */
const CHAT_TEMPLATE_MARKER_PATTERN =
    /<\|(?:im_start|im_end|system|user|assistant|endoftext|eot_id|start_header_id|end_header_id)\|>/gi;

/** Strip forgeable control markers; leave everything else byte-identical. */
export function neutralizeRejectionText(value: string): string {
    return value.replace(CHAT_TEMPLATE_MARKER_PATTERN, '');
}

/**
 * Orchestration M9 — compose the seeded first input for a resumed run
 * from the rejections it is answering.
 *
 * Machine-generated in the same shape as the red-gate iterate message, so
 * an agent that has learned to read one reads the other. Exported for the
 * spec: the exact wording is the contract with the model.
 */
export function composeRejectionFeedbackMessage(
    rejections: Array<{
        source: string;
        feedback: string;
        reviewerLabel?: string | null;
        prNumber?: number | null;
    }>,
): string {
    const lines: string[] = [
        'Your previous work on this task was REJECTED by a reviewer. Address the feedback below before doing anything else, then finish.',
        '',
    ];
    for (const rejection of rejections) {
        const who = rejection.reviewerLabel
            ? neutralizeRejectionText(String(rejection.reviewerLabel))
            : 'reviewer';
        const where =
            rejection.source === 'pull-request'
                ? `pull request${rejection.prNumber ? ` #${rejection.prNumber}` : ''}`
                : rejection.source === 'gate'
                  ? 'quality gate'
                  : 'task review';
        lines.push(`Rejection from ${who} (${where}):`);
        for (const feedbackLine of neutralizeRejectionText(rejection.feedback).split('\n')) {
            lines.push(`  ${feedbackLine}`);
        }
        lines.push('');
    }
    return lines.join('\n').trimEnd();
}

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
    /**
     * Orchestration M9 — how many durable reviewer rejections were
     * replayed into the resumed run's first input. 0 = a plain resume.
     */
    rejectionsReplayed: number;
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
        // A resumed persistent run wants its terminal back. Appended last +
        // @Optional() so existing positional test constructions keep working.
        @Optional() private readonly terminalLauncher?: TerminalSessionLauncher,
        // Orchestration M9 — durable reviewer rejections replayed into the
        // resumed run's first input. @Optional() + appended LAST for the
        // same positional-arity reason as every constructor arg above it;
        // absent = today's plain resume, unchanged.
        @Optional() private readonly rejections?: TaskReviewRejectionRepository,
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

    async steer(input: ScopedRunSteerInput): Promise<RunSteerOutcome> {
        const message = this.assertMessage(input.message);
        const run = await this.requireOwnedRun(input.runId, input.userId, input.ownershipScope);

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

    async interrupt(
        runId: string,
        userId: string,
        ownershipScope?: OwnershipScope,
    ): Promise<RunInterruptOutcome> {
        const run = await this.requireOwnedRun(runId, userId, ownershipScope);
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
        ownershipScope?: OwnershipScope,
    ): Promise<RunResumeOutcome> {
        const trimmed =
            message == null || message.trim().length === 0 ? null : this.assertMessage(message);
        const run = await this.requireOwnedRun(runId, userId, ownershipScope);

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

        // Same concurrency choke point as every other dispatch path — and
        // the row that consumes the admitted slot is created INSIDE it, so
        // count + insert are one critical section (advisory-locked on
        // Postgres, documented no-op elsewhere).
        let created: AgentRun | undefined;
        const reserve = async (verdict: {
            admitted: boolean;
            queuedReason?: string;
        }): Promise<void> => {
            created = await this.runs.createQueued({
                agentId: run.agentId,
                userId,
                triggerKind: 'task',
                taskId: run.taskId!,
                workId: run.workId ?? null,
                tenantId: run.tenantId ?? null,
                organizationId: run.organizationId ?? null,
                runnerKind: run.runnerKind ?? null,
                queuedReason: verdict.admitted ? null : (verdict.queuedReason ?? null),
                // Streaming terminal — the conversation lifetime survives
                // the process lifetime, and so does the SHAPE of the
                // session. A resumed persistent run still wants an
                // interactive terminal, which is what the fan-out's
                // `requirePersistent` gate reads.
                persistent: run.persistent === true,
            });
        };
        const admission: { admitted: boolean; queuedReason?: string } = this.dispatchGate
            ? await this.dispatchGate.admit(
                  {
                      userId,
                      workId: run.workId ?? null,
                      organizationId: run.organizationId ?? null,
                  },
                  reserve,
              )
            : { admitted: true, queuedReason: undefined };
        // Gate absent, or a gate stub that ignored the callback.
        if (!created) await reserve(admission);
        // Non-null from here: `reserve` either ran above or threw.
        const next = created!;

        // Orchestration M9 — rejection-feedback prepend. A run is most
        // often resumed BECAUSE a human rejected its work, and until now
        // the reason was lost: the reviewer's words lived on a PR or in a
        // review row, and the resumed run started from nothing. Any
        // durable rejections recorded for this Task since the last resume
        // become the FIRST thing the new run reads, ahead of the caller's
        // own message.
        //
        // Best-effort by contract: a resume must never fail because the
        // feedback lookup hiccuped — the run still resumes, just without
        // the prepend, which is exactly today's behavior.
        const replayed = await this.claimRejectionFeedback(run.taskId, next.id);

        // The conversation lifetime survives the process lifetime: hand the
        // pipeline plugin its own resume id, and seed the first message so
        // the resumed loop starts from the human's answer.
        //
        // Order matters: the rejection block goes FIRST so the agent reads
        // "here is what was wrong" before "here is what to do about it".
        const seeded = [
            ...(replayed.message ? [replayed.message] : []),
            ...(trimmed ? [trimmed] : []),
        ];
        await this.runs.seedResumeContext(next.id, {
            cliSessionId: run.cliSessionId ?? null,
            pendingInput: seeded.length > 0 ? seeded : null,
        });

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
                    // Scope carriers, mirroring
                    // `TaskTransitionService.dispatchAgentRun` (self-build
                    // slice Q): the fleet router resolves the TENANT's job
                    // runtime from `tenantId` and falls back to the INSTANCE
                    // default when it is absent — without these, a tenant
                    // whose fleet selection lives in the tenant job-runtime
                    // overlay would resume a parked fleet run onto the cloud.
                    // Ignored by adapters that don't route per tenant.
                    tenantId: run.tenantId ?? null,
                    organizationId: run.organizationId ?? null,
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

        // The source run is answered — it must stop showing up in the
        // needs-attention filter. Cleared ONLY here, once the successor is
        // parked by the gate or actually enqueued (self-build slice Q): the
        // fleet-aware dispatcher runs the planner on resume and can refuse
        // (`FleetAgentTaskPlanError` for a done / cancelled Task, a Task
        // without a repository or an oversize brief;
        // `JobRuntimeNotConfiguredError` with the runtime off). Clearing
        // before the enqueue left the source run terminal AND not awaiting —
        // no longer resumable — so the Inbox question the failed reply
        // reopened would route 'none' on the next attempt and the owner's
        // answer could never reach a node. The catch above rethrows before
        // this line, so a failed enqueue keeps the source run parked.
        if (run.awaitingInput) {
            await this.runs.setAwaitingInput(run.id, false).catch(() => undefined);
        }

        await this.stamp(next.id, userId, 'resume', {
            resumedFromRunId: run.id,
            carriedCliSession: Boolean(run.cliSessionId),
            hasMessage: Boolean(trimmed),
            queued: !admission.admitted,
            rejectionsReplayed: replayed.count,
        });
        // Streaming terminal: the fan-out path gates on `requirePersistent`,
        // but resume dispatches `agent-task-execute` directly, so without this
        // a resumed persistent run comes back with no session attached.
        // Best-effort — a terminal is an affordance, never a reason to fail a
        // resume that already dispatched.
        if (admission.admitted && run.persistent === true && this.terminalLauncher) {
            try {
                const outcome = await this.terminalLauncher.startForRun({
                    runId: next.id,
                    agentId: run.agentId,
                    userId,
                    requirePersistent: true,
                });
                if (outcome.started === false) {
                    this.logger.warn(
                        `Run ${next.id}: terminal not restarted on resume (${outcome.reason}).`,
                    );
                }
            } catch (err) {
                this.logger.warn(
                    `Run ${next.id}: terminal relaunch failed on resume: ${
                        err instanceof Error ? err.message : String(err)
                    }`,
                );
            }
        }

        this.logger.log(`Run ${run.id}: resumed as ${next.id} by user ${userId}.`);

        return {
            dispatched: 'new-run',
            runId: next.id,
            resumedFromRunId: run.id,
            carriedCliSession: Boolean(run.cliSessionId),
            queued: !admission.admitted,
            rejectionsReplayed: replayed.count,
        };
    }

    // ── internals ──────────────────────────────────────────────────

    /**
     * Orchestration M9 — read the Task's pending reviewer rejections,
     * compose the prepend block, and CLAIM the rows for this run.
     *
     * Claiming (not just reading) is what makes the replay exactly-once:
     * `markConsumed` is CAS-guarded on `consumedByRunId IS NULL`, so two
     * concurrent resumes cannot both seed the same feedback, and a third
     * resume after the work was actually redone does not re-litigate a
     * rejection that has already been answered.
     *
     * If a row is claimed but the dispatch later fails, the feedback is
     * "spent" on a run that never executed. That is the deliberate trade:
     * the alternative (claim after dispatch) risks the far worse failure
     * of replaying the same rejection forever. The rejection text is still
     * on the record and in the run's seeded input, so nothing is lost —
     * only the automatic replay is.
     */
    private async claimRejectionFeedback(
        taskId: string,
        newRunId: string,
    ): Promise<{ message: string | null; count: number }> {
        if (!this.rejections) return { message: null, count: 0 };
        try {
            const pending = await this.rejections.findPendingForTask(
                taskId,
                MAX_REPLAYED_REJECTIONS,
            );
            if (pending.length === 0) return { message: null, count: 0 };
            const claimed = await this.rejections.markConsumed(
                pending.map((row) => row.id),
                newRunId,
            );
            // Lost every row to a concurrent resume — that resume is
            // carrying the feedback, so this one must not duplicate it.
            if (claimed === 0) return { message: null, count: 0 };
            const message = composeRejectionFeedbackMessage(pending);
            this.logger.log(
                `Run ${newRunId}: replaying ${pending.length} reviewer rejection(s) for task ${taskId}.`,
            );
            return { message, count: pending.length };
        } catch (err) {
            this.logger.warn(
                `Run ${newRunId}: rejection-feedback lookup failed (resuming without it): ${err}`,
            );
            return { message: null, count: 0 };
        }
    }

    private async requireOwnedRun(
        runId: string,
        userId: string,
        ownershipScope?: OwnershipScope,
    ): Promise<AgentRun> {
        const run = ownershipScope
            ? await this.runs.findByIdAndUser(runId, userId, ownershipScope)
            : await this.runs.findByIdAndUser(runId, userId);
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
