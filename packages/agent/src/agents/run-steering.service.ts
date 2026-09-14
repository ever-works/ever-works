import {
    ConflictException,
    Inject,
    Injectable,
    Logger,
    NotFoundException,
    Optional,
} from '@nestjs/common';
import { config } from '../config';
import {
    AgentRunRepository,
    ResumeClaimLostError,
    type ResumeSuccessorSnapshot,
    type RunResumeClaim,
} from '../database/repositories/agent-run.repository';
import { AgentRunLogRepository } from '../database/repositories/agent-run-log.repository';
import type { AgentRun } from '../entities/agent-run.entity';
import {
    AGENT_TASK_EXECUTE_DISPATCHER,
    JOB_RUNTIME_NOT_CONFIGURED_REASON,
    type AgentTaskExecuteDispatcher,
} from '../tasks-domain/task-dispatcher';
import { MAX_REPLAYED_REJECTIONS } from '../tasks-domain/run-steering-port';
import type {
    RunResumeRequest,
    RunResumeResult,
    RunSteerInput,
    RunSteerOutcome,
    RunSteeringPort,
} from '../tasks-domain/run-steering-port';
import { RunDispatchGateService } from './run-dispatch-gate.service';
import { TerminalSessionLauncher } from './terminal-session-launcher.service';
import { TaskReviewRejectionRepository } from '../database/repositories/task-review-rejection.repository';
import type { OwnershipScope } from '../database/ownership-scope';
// Pure leaf (type-only imports of its own) — no runtime graph, no cycle.
import { isAgentReviewRunScope } from '../tasks-domain/task-agent-review';

type ScopedRunSteerInput = RunSteerInput & { ownershipScope?: OwnershipScope };

/**
 * `terminalEndedReason` values that make a finished run resumable: the
 * process was parked (hibernated) rather than completed, so its
 * conversation — identified by `cliSessionId` — is still valid.
 */
const RESUMABLE_ENDED_REASONS = ['parked'] as const;

/**
 * CI feedback + autonomous fix loop (slice AC, EW-806) — the ONE extra
 * status an AUTOMATED resume may act on, opted into per call via
 * `RunResumeOptions.allowCompleted`.
 *
 * A red build arrives minutes AFTER the run that pushed the branch has
 * ended cleanly, so `completed` is the only state the fix loop ever finds
 * its target in. It is deliberately not added to
 * {@link RESUMABLE_ENDED_REASONS}: the human "Resume" button must keep
 * refusing a finished run (there is nothing for a person to answer), and
 * `failed` / `cancelled` runs stay un-resumable for everyone — a cancel is
 * a human's explicit stop and must never be undone by a webhook.
 */
const AUTO_RESUMABLE_STATUSES = ['completed'] as const;

/** Longest steering message accepted. Matches the task-chat body cap. */
const MAX_STEER_BYTES = 16 * 1024;

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
        /**
         * Trusted review bots (R16) — `human` | `bot`. A bot finding is
         * labelled "automated review" so the model weighs it as a
         * reviewer bot's opinion rather than the owner's instruction.
         */
        reviewerKind?: string | null;
        /** R16 — `critical` | `major` | `minor` when the bot stated one. */
        severity?: string | null;
    }>,
): string {
    const lines: string[] = [
        'Your previous work on this task was REJECTED by a reviewer. Address the feedback below before doing anything else, then finish.',
        '',
    ];
    // Only when at least one row is bot-authored, so a human-only message
    // stays byte-identical to what the model has already learned to read.
    if (rejections.some((rejection) => rejection.reviewerKind === 'bot')) {
        lines.push(
            'Some of it comes from automated reviewers. Fix every finding marked critical or major, and every one with no stated severity (treat it as major); a minor one may be left as-is only if you say why.',
            '',
        );
    }
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
        const qualifiers: string[] = [];
        if (rejection.reviewerKind === 'bot') qualifiers.push('automated review');
        if (rejection.severity) {
            qualifiers.push(`severity: ${neutralizeRejectionText(String(rejection.severity))}`);
        }
        const context = qualifiers.length > 0 ? `${where}, ${qualifiers.join(', ')}` : where;
        lines.push(`Rejection from ${who} (${context}):`);
        for (const feedbackLine of neutralizeRejectionText(rejection.feedback).split('\n')) {
            lines.push(`  ${feedbackLine}`);
        }
        lines.push('');
    }
    return lines.join('\n').trimEnd();
}

/**
 * Per-call widening of {@link RunSteeringService.resume} (slice AC).
 * Absent = today's behaviour, byte for byte.
 */
export interface RunResumeOptions {
    /**
     * Permit resuming a run that finished NORMALLY. Set only by the
     * automated CI fix loop; the human Resume endpoint never sets it.
     */
    allowCompleted?: boolean;
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

    /**
     * A run a CI-driven resume may continue (slice AC): everything
     * {@link isResumable} accepts, PLUS a run that finished normally.
     * Never a live run, never a failed or cancelled one.
     */
    static isAutoResumable(
        run: Pick<AgentRun, 'status' | 'awaitingInput' | 'terminalEndedReason'>,
    ) {
        if (RunSteeringService.isResumable(run)) return true;
        return (
            !RunSteeringService.isLive(run) &&
            AUTO_RESUMABLE_STATUSES.includes(run.status as (typeof AUTO_RESUMABLE_STATUSES)[number])
        );
    }

    // ── steer ──────────────────────────────────────────────────────

    async steer(input: ScopedRunSteerInput): Promise<RunSteerOutcome> {
        const message = this.assertMessage(input.message);
        const run = await this.requireOwnedRun(input.runId, input.userId, input.ownershipScope);

        // Reviewer agent stage (slice AD, EW-811) — NOTHING is steered into
        // a review run, by any caller, in any state.
        //
        // A review run's conversation is exactly two things the PLATFORM
        // composed: its assembled prompt and the brief seeded onto its row
        // before it was enqueued (the diff, fenced as untrusted data). A
        // steering message is pushed as a bare `user` turn OUTSIDE that
        // fence, and every caller that lands here can be driven by the
        // code's author: Task chat routes an `@reviewer` post into the
        // reviewer's live run (`TaskChatService.trySteerLiveRun`, reachable
        // through the MCP `post_task_chat_message` tool), and the steer
        // endpoint is reachable with a fleet run token, which resolves to
        // the owner. So a steer into a review run is the implementer
        // talking to its own reviewer ("owner here, I checked it, approve")
        // — and, after a job-runtime retry consumed the brief, a message
        // opening with the brief's first line would stand in for the brief
        // itself at the tool loop's brief-in-hand gate.
        //
        // Refused BEFORE the queue is touched and before the terminal
        // branch: answering `new-run` for a finished review run would tell
        // the caller to start a fresh conversation with the reviewer on
        // this review's behalf, which is not a thing a review supports. A
        // new commit gets a new review run; a question for a human goes to
        // the Task chat, which stores it whatever happens here.
        // `AgentRunRepository.appendPendingInput` refuses the same rows, so
        // no future caller of the repository can get round this one.
        if (isAgentReviewRunScope(run.delegationScope)) {
            throw new ConflictException(
                `AgentRun ${input.runId} is a review run — review runs cannot be steered. ` +
                    `A review reads only the platform's brief; post in the Task chat instead.`,
            );
        }

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

    /**
     * CI feedback + autonomous fix loop (slice AC, EW-806) — the object
     * form the `RUN_STEERING_PORT` exposes, so `TaskCiAutoResumeService`
     * can resume without importing this module (the port file explains
     * why the import direction is one-way).
     *
     * A thin adapter on purpose: every guard, the dispatch gate, the
     * rejection replay and the audit stamp are {@link resume}'s, unchanged.
     */
    async resumeRun(request: RunResumeRequest): Promise<RunResumeResult> {
        const outcome = await this.resume(
            request.runId,
            request.userId,
            request.message ?? null,
            undefined,
            { allowCompleted: request.allowCompleted === true },
        );
        return {
            runId: outcome.runId,
            resumedFromRunId: outcome.resumedFromRunId,
            queued: outcome.queued,
            rejectionsReplayed: outcome.rejectionsReplayed,
        };
    }

    async resume(
        runId: string,
        userId: string,
        message?: string | null,
        ownershipScope?: OwnershipScope,
        // Appended LAST and optional, the house positional convention:
        // every existing call site and every positional test construction
        // keeps its meaning.
        options?: RunResumeOptions,
    ): Promise<RunResumeOutcome> {
        const trimmed =
            message == null || message.trim().length === 0 ? null : this.assertMessage(message);
        const run = await this.requireOwnedRun(runId, userId, ownershipScope);

        // Reviewer agent stage (slice AD, EW-811) — a resume must NEVER
        // widen a run's scope, and a REVIEW run is not resumed at all.
        //
        // Checked before anything else, for every caller (the human Resume
        // endpoint, both Inbox reply routes, and slice AC's CI auto-resume
        // through `resumeRun`), because all of them land here. A resumed
        // review run could not do the one thing a review run is for: its
        // ledger row is bound to the SOURCE run id, so the new run's verdict
        // is refused `no-open-review`; its brief is not re-seeded, so the
        // tool loop stops it before the first model round-trip; and it is
        // not a run the review ledger knows, so it would count as AUTHORSHIP
        // and disqualify the reviewer from every later round. Before this,
        // the new row was created with no `delegationScope` at all, so the
        // reviewer came back with the full tool surface, a workspace and
        // `transitionTask` — and CI feedback meant for the implementer.
        // Refusing costs nothing and dispatches nothing.
        //
        // Every OTHER scope is carried to the new run verbatim (see
        // `createQueued` below), so a resume is exactly as narrow as its
        // source — and exactly as strong as the lane that executes it: the
        // scope is ENFORCED by the in-process tool loop. A fleet node runs a
        // CLI and never reads a G9 tool scope, which is why the fleet
        // dispatcher refuses any run whose scope narrows, for the original
        // delegated dispatch and for a resume alike (its G9
        // delegation-scope guard, `fleet-delegation-scope-unenforceable`).
        // Review runs never reach the fleet at all: the review-only scope
        // always narrows, so that guard refuses them first, and
        // `refuseAgentReviewRun` refuses them behind a guard that admitted
        // the run.
        if (isAgentReviewRunScope(run.delegationScope)) {
            throw new ConflictException(
                `AgentRun ${runId} is a review run — review runs are not resumable. ` +
                    `A new commit is reviewed by a new review run, and CI feedback goes to the implementer.`,
            );
        }

        const resumable =
            options?.allowCompleted === true
                ? RunSteeringService.isAutoResumable(run)
                : RunSteeringService.isResumable(run);
        if (!resumable) {
            throw this.notResumable(run);
        }
        if (!run.taskId) {
            // The only dispatch path a resumed run can take today is
            // `agent-task-execute`, which is Task-keyed. A heartbeat run has
            // no Task to resume onto — say so instead of half-dispatching.
            throw new ConflictException(
                `AgentRun ${runId} has no Task — only task-attached runs can be resumed.`,
            );
        }

        // Single-flight claim on the SOURCE run, taken after every cheap
        // refusal above (a run that cannot be resumed is never claimed) and
        // BEFORE anything is created. The check above is a read: two
        // requests deciding different Inbox items on the same parked run —
        // or a double submit, or an auto-resume racing a human — both pass
        // it, and without this both went on to create a successor. The
        // claim is one conditional UPDATE only one of them can win; it is
        // compare-and-set against the claim token THIS request read, so a
        // request that loaded the run before another resume claimed it
        // loses even when that resume has already finished (the repository
        // method explains why "unclaimed" alone is not enough).
        //
        // The in-flight stamp is compared the same way: a request that
        // loaded the run WHILE another resume held it loses once that
        // resume has finished, instead of slipping in behind it.
        //
        // The loser gets exactly the refusal a non-resumable run gets — to
        // that request the run is no longer resumable, it just learned so
        // after its read — so a double submit is a clean 409, not a second
        // run. This covers `allowCompleted` too: a completed run has no
        // `awaitingInput` to clear, so the claim is its only guard.
        const claim = await this.runs.claimResume(run.id, {
            observedToken: run.resumeClaimToken ?? null,
            observedClaimedAt: run.resumeClaimedAt ?? null,
            staleBefore: this.resumeClaimStaleBefore(),
        });
        if (!claim) {
            this.logger.log(
                `Run ${run.id}: resume by user ${userId} refused — another resume claimed it first.`,
            );
            throw this.notResumable(run);
        }

        // Winning the claim is not yet licence to create: an EARLIER resume
        // may have left a successor behind without finishing — its process
        // died after the enqueue, or its consume write failed — and then
        // its claim expired (which is how this request could win) or was
        // released. Reconcile that successor first; this throws when it
        // means this resume must not go ahead.
        await this.reconcileEarlierSuccessor(run, claim, userId);

        // From the claim to a successful enqueue, ANY throw gives the claim
        // back (see the catch below) so the owner can retry. A successor
        // created on the way stays LINKED to the source through a release,
        // so a retry reconciles it (see `reconcileEarlierSuccessor`) rather
        // than trusting that the rollback beat any worker to it.
        let created: AgentRun | undefined;
        let rolledBack = false;
        let admission: { admitted: boolean; queuedReason?: string };
        let replayed: { message: string | null; count: number };
        try {
            // Same concurrency choke point as every other dispatch path — and
            // the row that consumes the admitted slot is created INSIDE it, so
            // count + insert are one critical section (advisory-locked on
            // Postgres, documented no-op elsewhere).
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
                    // A resume never WIDENS what the source run was admitted
                    // with. A delegated (G9) run's narrowed tool scope is
                    // snapshotted on its row and read back by the tool loop;
                    // omitting it here made the resumed run an ordinary,
                    // unrestricted one. Carried verbatim, so the new run is
                    // exactly as narrow as the old one — never narrower by
                    // accident, never wider. (Review-scoped sources were
                    // refused above and never reach this line.)
                    delegationScope: run.delegationScope ?? null,
                    // Inserted together with its link on the source, and
                    // only while this claim is still held — a request whose
                    // claim was taken over creates nothing.
                    resumeClaim: claim,
                });
            };
            admission = this.dispatchGate
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
            replayed = await this.claimRejectionFeedback(run.taskId, next.id);

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
                    rolledBack = true;
                    throw new ConflictException(`Resume could not be dispatched — ${reason}`);
                }
            }
        } catch (err) {
            // No successor will run, so the source goes back exactly as it
            // was and the owner can retry. Two halves:
            //
            //  1. A successor row created before the throw (the seed failed)
            //     is rolled back to `failed` like a failed enqueue already
            //     is. Left `queued`, a row the gate had parked would later be
            //     drained into a second, unseeded successor the moment the
            //     owner's retry succeeds. QUEUED_ONLY-guarded, so it can
            //     never stomp a run a worker already picked up.
            //  2. The claim is released — token-guarded, so a claim that
            //     expired and was taken over in the meantime is left alone.
            //
            // The enqueue catch above has already done (1) for its own
            // failure; neither half may mask the original error.
            //
            // A lost claim is the exception: the successor's insert was
            // rolled back with its link, and the claim belongs to whoever
            // took it over — there is nothing to roll back or release, and
            // to this request the run is simply no longer resumable.
            if (err instanceof ResumeClaimLostError) {
                this.logger.log(
                    `Run ${run.id}: resume by user ${userId} refused — its claim was taken over before a successor was created.`,
                );
                throw this.notResumable(run);
            }
            if (created && !rolledBack) {
                const detail = err instanceof Error ? err.message : String(err);
                await this.runs
                    .markDispatchFailed(
                        created.id,
                        `dispatch-failed: resume aborted before enqueue: ${detail}`,
                    )
                    .catch(() => undefined);
            }
            await this.releaseResumeClaim(claim);
            throw err;
        }
        const next = created!;

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
        //
        // Then the claim is consumed — in THAT order. Consuming first would
        // open a window in which a request loading the run fresh sees it
        // unclaimed AND still awaiting input, and wins a second successor.
        // Clearing `awaitingInput` first means such a request finds the run
        // either still claimed or no longer awaiting; the kept token refuses
        // every request that read the run earlier.
        //
        // If the clear itself failed, consuming would open exactly that
        // window for good, so the claim is RELEASED instead: the successor
        // stays linked, and the next resume reconciles it — refusing while
        // it is live, finishing this bookkeeping once it has run — rather
        // than creating a second one.
        if (await this.clearAwaitingInput(run)) {
            await this.consumeResumeClaim(claim);
        } else {
            await this.releaseResumeClaim(claim);
        }

        await this.stamp(next.id, userId, 'resume', {
            resumedFromRunId: run.id,
            carriedCliSession: Boolean(run.cliSessionId),
            hasMessage: Boolean(trimmed),
            queued: !admission.admitted,
            rejectionsReplayed: replayed.count,
            // Slice AC — an automated resume is auditable as one. Without
            // this the only trace of a machine-initiated model run would be
            // a `resume` row stamped with the Task owner, indistinguishable
            // from the owner pressing the button.
            autoResume: options?.allowCompleted === true,
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
     * The refusal for a run that cannot be resumed — including one another
     * request claimed first, which to the losing request is exactly that.
     */
    private notResumable(run: AgentRun): ConflictException {
        return new ConflictException(
            `AgentRun ${run.id} is not resumable — resume applies to runs awaiting input or ` +
                `ended with reason '${RESUMABLE_ENDED_REASONS.join("' / '")}' ` +
                `(status=${run.status}, endedReason=${run.terminalEndedReason ?? 'none'}).`,
        );
    }

    /**
     * Resume single-flight — a claim taken before this instant is treated as
     * abandoned and may be taken over.
     *
     * Reuses the stuck-run sweeper's cutoff rather than inventing a second
     * window, because the two describe the same failure. A process that died
     * between claim and consume left either nothing, a `queued` successor
     * that never dispatched (the sweeper reaps exactly that row at this same
     * cutoff), or a successor that was dispatched and ran. Expiry alone
     * cannot tell those apart, which is why the successor is linked on the
     * source and the taker reconciles it before creating anything.
     *
     * The same two mechanisms fence a slow-but-alive holder whose claim
     * expires under it: its insert is refused once the claim is taken (the
     * link is token-guarded, inside the insert's transaction), and a
     * successor it had already created is reconciled by the taker. Expiring
     * too early therefore costs that slow resume a 409, not a duplicate;
     * expiring too late only delays a retry after a crash that is already
     * rare.
     */
    private resumeClaimStaleBefore(): Date {
        return new Date(Date.now() - config.agents.getRunStuckSweepMinutes() * 60_000);
    }

    /**
     * Resume single-flight — reconcile the successor an earlier, unfinished
     * resume left linked on the source run, before this resume creates its
     * own. Returns when this resume may go ahead; otherwise settles the claim
     * it holds and throws the not-resumable refusal.
     *
     * Only a successor whose claim was never CONSUMED is linked, so whatever
     * is found here is an attempt that did not finish its bookkeeping — a
     * process that died after the create or the enqueue, or a consume (or
     * `awaitingInput` clear) that failed after the successor was dispatched:
     *
     *  - **never ran** (`failed` without ever starting — the enqueue was
     *    rolled back, or the sweeper reaped an orphan that was never
     *    dispatched): nothing answered the source, so this resume goes ahead.
     *  - **still live** (`queued` / `running`): it may yet run — a gate-parked
     *    row is drained later, an enqueued one is picked up by a worker — so
     *    creating another would be the duplicate. Refuse, and release the
     *    claim so the next attempt reconciles again as soon as that row
     *    settles. `awaitingInput` is left alone: if the row turns out to be
     *    an orphan the sweeper reaps, the question must still be answerable.
     *  - **ran** (anything else): the earlier resume took effect. Finish its
     *    bookkeeping on its behalf — clear `awaitingInput`, consume the claim
     *    — and refuse this one, exactly as it would have been refused had
     *    that resume finished normally while this request was loading.
     *
     * A lookup that fails is treated as "cannot tell": the claim is released
     * and the error propagates, so a retry decides again — never a guess
     * that could create a second successor.
     */
    private async reconcileEarlierSuccessor(
        run: AgentRun,
        claim: RunResumeClaim,
        userId: string,
    ): Promise<void> {
        let earlier: ResumeSuccessorSnapshot | null;
        try {
            earlier = await this.runs.findResumeSuccessor(run.id);
        } catch (err) {
            await this.releaseResumeClaim(claim);
            throw err;
        }
        if (!earlier) return;
        if (earlier.status === 'failed' && !earlier.startedAt) return;

        if (RunSteeringService.isLive(earlier)) {
            this.logger.log(
                `Run ${run.id}: resume by user ${userId} refused — earlier successor ${earlier.id} is still ${earlier.status}.`,
            );
            await this.releaseResumeClaim(claim);
            throw this.notResumable(run);
        }

        this.logger.warn(
            `Run ${run.id}: earlier successor ${earlier.id} already ran (${earlier.status}) without its resume finishing — completing that resume and refusing the one by user ${userId}.`,
        );
        if (await this.clearAwaitingInput(run)) {
            await this.consumeResumeClaim(claim);
        } else {
            await this.releaseResumeClaim(claim);
        }
        throw this.notResumable(run);
    }

    /**
     * Mark the source run answered. Best-effort — a failure is logged and
     * reported, never thrown — and a no-op when the run was not awaiting
     * input. The caller decides what a failure means for its claim.
     */
    private async clearAwaitingInput(run: AgentRun): Promise<boolean> {
        if (!run.awaitingInput) return true;
        try {
            await this.runs.setAwaitingInput(run.id, false);
            return true;
        } catch (err) {
            this.logger.warn(`Run ${run.id}: failed to clear awaitingInput on resume: ${err}`);
            return false;
        }
    }

    /**
     * Give a resume claim back after a failure. Best-effort by contract: the
     * caller is already rethrowing the error that matters, and a claim that
     * could not be released still expires on its own.
     */
    private async releaseResumeClaim(claim: RunResumeClaim): Promise<void> {
        try {
            const released = await this.runs.releaseResumeClaim(claim);
            if (!released) {
                this.logger.warn(
                    `Run ${claim.runId}: resume claim was not released — it expired and was taken over.`,
                );
            }
        } catch (err) {
            this.logger.warn(
                `Run ${claim.runId}: failed to release resume claim (it expires on its own): ${err}`,
            );
        }
    }

    /**
     * Mark a resume claim as spent once its successor exists. Best-effort for
     * the same reason the `awaitingInput` clear beside it is: the resume has
     * already dispatched. A claim this fails to consume stays in flight with
     * its successor linked, so whoever takes it over after expiry reconciles
     * that successor instead of creating a second one.
     */
    private async consumeResumeClaim(claim: RunResumeClaim): Promise<void> {
        try {
            const consumed = await this.runs.consumeResumeClaim(claim);
            if (!consumed) {
                this.logger.warn(
                    `Run ${claim.runId}: resume claim expired and was taken over before this resume consumed it.`,
                );
            }
        } catch (err) {
            this.logger.warn(
                `Run ${claim.runId}: failed to consume resume claim (it expires on its own): ${err}`,
            );
        }
    }

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
