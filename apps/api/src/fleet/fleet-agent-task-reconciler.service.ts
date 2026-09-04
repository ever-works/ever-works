import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { RunDispatchGateService } from '@ever-works/agent/agents';
import { AgentRepository, AgentRunRepository } from '@ever-works/agent/database';
import type { AgentRun, FleetNode, Task } from '@ever-works/agent/entities';
import { FleetJobCompletedEvent, FleetJobLeasedEvent } from '@ever-works/agent/events';
import { FleetNodeRepository } from '@ever-works/agent/fleet';
import { INBOX_PRODUCER, type InboxProducer } from '@ever-works/agent/inbox';
import {
    TaskChatService,
    TaskRepository,
    TaskRunDenormService,
    TaskWorkspaceService,
    type TaskWorkspaceFinalizeOutcome,
    type TaskMountPushOutcome,
} from '@ever-works/agent/tasks-domain';
import { redactSecrets } from '@ever-works/agent/utils';
import {
    FLEET_AGENT_TASK_QUESTION_MAX_TEXT_CHARS,
    INBOX_MAX_BODY_CHARS,
    normalizeFleetAgentTaskQuestion,
    normalizeFleetTaskWorkspaceMounts,
    type FleetAgentTaskGitResult,
    type FleetAgentTaskPayload,
    type FleetAgentTaskQuestion,
    type FleetAgentTaskResult,
    type FleetJobView,
    type FleetTaskWorkspaceMountSpec,
    type GateStatus,
    type TaskCheckResult,
} from '@ever-works/contracts';

/** What an `agent-task` job correlates to on the platform side. */
export interface FleetAgentTaskCorrelation {
    runId: string;
    taskId: string;
    agentId: string | null;
}

/** Longest run summary / chat body the reconciler will store. */
const MAX_SUMMARY_CHARS = 4000;
const MAX_TAIL_CHARS = 1500;
/** A node-reported identifier as far as it is ever quoted back to a human. */
const MAX_QUOTED_CHARS = 120;
/**
 * A node-reported VERDICT sentence — a git error, a withheld-publish
 * reason — as far as it is quoted back to a human. Wider than an
 * identifier because the sentences the node writes are whole
 * explanations ("the lease on this work expired 40s ago; the platform may
 * already have re-offered it to another node"), and a reason cut at 120
 * characters is a reason the operator has to go and look up anyway.
 */
const MAX_VERDICT_CHARS = 300;
const SHA_PATTERN = /^[0-9a-f]{40,64}$/i;

/** The planned mounts of a job, keyed by lower-cased repository identity. */
type PlannedMounts = Map<string, FleetTaskWorkspaceMountSpec>;

/**
 * Self-build slice Q — the Inbox body is `question + blank line +
 * context`; the question line is capped at the title width, so this is
 * what is left of `INBOX_MAX_BODY_CHARS` for the context we compose.
 */
const MAX_QUESTION_CONTEXT_CHARS =
    INBOX_MAX_BODY_CHARS - FLEET_AGENT_TASK_QUESTION_MAX_TEXT_CHARS - 2;

/**
 * Agent execution v2 (slice B) — turn what a fleet node reported into
 * AgentRun / Task / pull-request state.
 *
 * Before this, `FleetJobService.completeJob` wrote `fleet_jobs.result`
 * and stopped: the `AgentRun` behind the job stayed `queued`, the Task
 * board never moved, the Goals orchestrator never saw an iteration end,
 * and the pushed branch never became a pull request. A node-executed
 * Task was, from the platform's point of view, invisible.
 *
 * The reconciler mirrors the cloud executor's OWN bookkeeping, in the
 * same order and through the same services, so a node run and a cloud
 * run leave the same trail:
 *
 *   lease     → `markStarted` (CAS) + board denorm + activity line
 *   complete  → gate results on the run → run terminal (CAS) + denorm
 *               → branch recorded / PR opened through
 *                 `TaskWorkspaceService.finalizeRemotePush` (the shared
 *                 PR + merge-policy tail every finalize uses)
 *               → Task chat message from the agent → Inbox notice on
 *                 failure → drain the Work's parked runs
 *   question  → (self-build slice Q, taken for ANY status BEFORE the
 *               success / failure split) run PARKED: `tryMarkCompleted`
 *               (CAS) + `awaitingInput` → denorm `completed` → pushed
 *               branch recorded through `recordRemotePush` (no pull
 *               request, no `in_review`; mounts through
 *               `finalizeMountPush` with PRs off) → Inbox QUESTION with
 *               the node / branch / Task provenance → Task chat → drain.
 *               Never `markFailed`: asking is not failing.
 *
 * Every step is best-effort and idempotent: `markStarted` / `markCompleted`
 * / `markFailed` are CAS-guarded, the PR open is skipped when the Task
 * already carries one, a replayed completion for a run that is already
 * terminal files no second question, and a listener failure is logged
 * rather than propagated (an event has no caller to fail).
 */
@Injectable()
export class FleetAgentTaskReconcilerService {
    private readonly logger = new Logger(FleetAgentTaskReconcilerService.name);

    constructor(
        private readonly runs: AgentRunRepository,
        private readonly tasks: TaskRepository,
        private readonly agents: AgentRepository,
        private readonly runDenorm: TaskRunDenormService,
        private readonly taskWorkspace: TaskWorkspaceService,
        @Optional() private readonly taskChat?: TaskChatService,
        @Optional() private readonly dispatchGate?: RunDispatchGateService,
        @Optional() @Inject(INBOX_PRODUCER) private readonly inbox?: InboxProducer,
        @Optional() private readonly nodes?: FleetNodeRepository,
    ) {}

    /** The platform identities an `agent-task` job carries, or null for any other job. */
    static correlate(job: FleetJobView): FleetAgentTaskCorrelation | null {
        if (job.kind !== 'agent-task') return null;
        const payload = job.payload;
        if (!payload || typeof payload !== 'object') return null;
        const runId = typeof payload.runId === 'string' ? payload.runId.trim() : '';
        const taskId = typeof payload.taskId === 'string' ? payload.taskId.trim() : '';
        if (!runId || !taskId) return null;
        const agentId =
            typeof payload.agentId === 'string' && payload.agentId.trim()
                ? payload.agentId.trim()
                : null;
        return { runId, taskId, agentId };
    }

    @OnEvent(FleetJobLeasedEvent.EVENT_NAME, { async: true })
    async onLeased(event: FleetJobLeasedEvent): Promise<void> {
        const ctx = FleetAgentTaskReconcilerService.correlate(event.job);
        if (!ctx) return;
        try {
            // The fleet job id is the run's remote id (stamped at dispatch),
            // exactly as a Trigger.dev run id would be.
            const claimed = await this.runs.markStarted(ctx.runId, event.job.id);
            if (!claimed) {
                this.logger.debug(
                    `Run ${ctx.runId}: markStarted skipped on fleet lease (row already terminal or running)`,
                );
                return;
            }
            await this.bestEffort('board denorm', () =>
                this.runDenorm.recordStarted(ctx.taskId, ctx.runId),
            );
            const nodeLabel = await this.describeNode(event.nodeId, event.userId);
            await this.bestEffort('run activity', () =>
                this.runs.updateTelemetry(ctx.runId, {
                    currentActivity: `Executing on fleet node ${nodeLabel}`,
                }),
            );
        } catch (error) {
            this.logger.warn(
                `Fleet lease reconcile failed for run ${ctx.runId}: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    @OnEvent(FleetJobCompletedEvent.EVENT_NAME, { async: true })
    async onCompleted(event: FleetJobCompletedEvent): Promise<void> {
        const ctx = FleetAgentTaskReconcilerService.correlate(event.job);
        if (!ctx) return;
        try {
            await this.reconcileCompletion(event, ctx);
        } catch (error) {
            this.logger.warn(
                `Fleet completion reconcile failed for run ${ctx.runId}: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    private async reconcileCompletion(
        event: FleetJobCompletedEvent,
        ctx: FleetAgentTaskCorrelation,
    ): Promise<void> {
        const run = await this.runs.findById(ctx.runId);
        if (!run || run.userId !== event.userId) {
            this.logger.debug(
                `Run ${ctx.runId}: not found for owner ${event.userId} — fleet completion ignored`,
            );
            return;
        }

        // A cancelled run gets the board mirror and NOTHING else.
        //
        // Three different arrivals mean "this run was cancelled", and only
        // the first is a synthetic event:
        //
        //   1. `source === 'cancelled'` — the operator cancelled a job no
        //      node had claimed yet, so the service failed it outright.
        //   2. `run.status === 'cancelled'` — the operator path flipped the
        //      AgentRun first (that is what triggers the job cancel).
        //   3. `event.job.cancelRequestedAt` — the job carries the flag but
        //      the node got its report in first.
        //
        // Case 3 is the one that bit. Cancellation reaches a node as a
        // REFUSED HEARTBEAT, and `FleetJobService.completeJob` deliberately
        // does not check the flag ("the row settles with the node's own
        // verdict"). So a node that had already finished and pushed before
        // its next heartbeat reports success, `completeJob` accepts it, and
        // the event arrives as an ordinary `node-report`.
        //
        // Falling through from there ran the whole success path:
        // `finalizeRemotePush` OPENED A PULL REQUEST — and can auto-merge it
        // — for a Task the user had explicitly cancelled, then posted a
        // "run finished" chat message contradicting the cancellation.
        //
        // The terminal write itself was always safe: `markCompleted` CASes
        // against NON_TERMINAL and no-ops on an already-cancelled row. What
        // was never guarded is the side effects — the pull request, the chat
        // message, the inbox notice — none of which are CAS-guarded and none
        // of which can be undone once they have happened.
        if (
            event.source === 'cancelled' ||
            run.status === 'cancelled' ||
            event.job.cancelRequestedAt
        ) {
            await this.bestEffort('board denorm', () =>
                this.runDenorm.recordTerminal(ctx.taskId, ctx.runId, 'failed'),
            );
            return;
        }

        const result = parseAgentTaskResult(event.result);
        const task = await this.tasks.findById(ctx.taskId);
        const agentId = ctx.agentId ?? run.agentId;

        if (result?.checks && result.checks.length > 0) {
            await this.bestEffort('gate results', () =>
                this.runs.updateGateResults(ctx.runId, {
                    checkResults: result.checks as TaskCheckResult[],
                    gateStatus: toGateStatus(result.gateStatus),
                }),
            );
        }
        if (typeof result?.git?.changedFiles === 'number') {
            await this.bestEffort('changed-files telemetry', () =>
                this.runs.updateTelemetry(ctx.runId, {
                    changedFilesCount: result.git!.changedFiles ?? null,
                }),
            );
        }

        // Self-build slice Q — the model asked the owner a question. Taken
        // for ANY status / gate verdict / git error, BEFORE the success-
        // failure split: partial work almost always reports a red required
        // check or a non-zero model exit, and that verdict was recorded
        // above and stays true — but the run is PARKED for the answer,
        // never failed for asking.
        if (result?.question) {
            await this.reconcileQuestion(event, ctx, run, task, agentId, result, result.question);
            return;
        }

        const succeeded = event.succeeded && result?.status === 'succeeded';
        if (!succeeded) {
            const reason = truncate(
                result?.failureReason ||
                    event.error ||
                    (event.source === 'lease-exhausted'
                        ? 'The fleet node stopped reporting; lease budget exhausted'
                        : 'Fleet job failed without a reason'),
                MAX_SUMMARY_CHARS,
            );
            await this.runs.markFailed(ctx.runId, reason);
            await this.bestEffort('board denorm', () =>
                this.runDenorm.recordTerminal(ctx.taskId, ctx.runId, 'failed'),
            );
            // Multi-repo (slice C): branches a failed run still pushed in
            // mounted repositories are recorded (no pull request) so they
            // are visible on the Task rather than orphaned on the remote —
            // for the repositories the PLAN put on the job, never for what
            // the node chose to report.
            if (task && result?.mountGit && result.mountGit.length > 0) {
                const planned = this.plannedMounts(event.job, ctx.runId);
                for (const entry of result.mountGit) {
                    const refusal = refuseMountEntry(entry, planned);
                    if (refusal) {
                        this.logger.warn(`Run ${ctx.runId}: mount result ignored — ${refusal}`);
                        continue;
                    }
                    if (!entry.pushed || entry.empty) continue;
                    const mount = planned.get(entry.repositoryId!.trim().toLowerCase())!;
                    await this.bestEffort(`record pushed mount ${mount.repositoryId}`, () =>
                        this.taskWorkspace.finalizeMountPush({
                            task,
                            userId: event.userId,
                            agentId: agentId ?? run.agentId,
                            agentCanOpenPullRequests: false,
                            repositoryId: mount.repositoryId,
                            branch: mount.branch,
                            baseRef: mount.baseRef,
                            headSha: entry.headSha ?? null,
                        }),
                    );
                }
            }
            await this.postChat(task, event.userId, agentId, composeFailureMessage(reason, result));
            await this.bestEffort('inbox notice', async () => {
                if (!this.inbox) return;
                await this.inbox.notice(event.userId, {
                    title: `Fleet run failed: ${task?.title ? truncate(task.title, 120) : ctx.taskId}`,
                    body: reason,
                    agentId,
                    agentRunId: ctx.runId,
                    taskId: ctx.taskId,
                    workId: task?.workId ?? null,
                    organizationId: task?.organizationId ?? null,
                });
            });
            await this.drain(task?.workId ?? run.workId ?? null);
            return;
        }

        const summary = truncate(result.model?.summary || 'Fleet run finished.', MAX_SUMMARY_CHARS);
        let finalizeNote = '';
        const agent = agentId ? await this.agents.findById(agentId).catch(() => null) : null;
        let primaryPrUrl: string | null = null;
        if (task && result.git && result.git.pushed && !result.git.empty) {
            const checksPassed =
                result.gateStatus === 'green' && result.checks ? result.checks.length : 0;
            try {
                const outcome = await this.taskWorkspace.finalizeRemotePush({
                    task,
                    userId: event.userId,
                    agentId: agentId ?? run.agentId,
                    agentCanOpenPullRequests: agent?.permissions?.canOpenPullRequests !== false,
                    branch: result.git.branch,
                    headSha: result.git.headSha ?? null,
                    baseSha: result.git.baseSha ?? null,
                    ...(typeof result.git.changedFiles === 'number'
                        ? { changedFiles: result.git.changedFiles }
                        : {}),
                    runId: ctx.runId,
                    ...(checksPassed > 0 ? { gate: { checksPassed } } : {}),
                    gateStatus: toGateStatus(result.gateStatus),
                });
                finalizeNote = describeFinalize(outcome, result.git.branch);
                primaryPrUrl = outcome.prUrl ?? null;
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                finalizeNote = `The branch \`${result.git.branch}\` was pushed, but opening the pull request failed: ${message}`;
                this.logger.warn(
                    `Task ${task.id}: remote finalize failed after fleet push: ${message}`,
                );
            }
        } else if (result.git?.empty || (result.git && !result.git.pushed)) {
            finalizeNote = result.git.empty
                ? 'The run produced no file changes.'
                : `Changes were committed on \`${result.git.branch}\` but not pushed (git policy).`;
        }

        // Multi-repo Task workspaces (slice C): one pull request per mounted
        // repository the run pushed, recorded on the Task next to the primary,
        // then ONE Inbox notice listing everything the human now has to review.
        //
        // The wire is untrusted: a node (or a model that tampers with the
        // node it shares an account with) must not be able to make the
        // platform open pull requests, with the OWNER's credentials, in any
        // repository it names. Repository, branch and base come from the
        // planner's spec on the job; the node only says what it pushed.
        const mountNotes: string[] = [];
        const openedPullRequests: string[] = [];
        if (task && result.mountGit && result.mountGit.length > 0) {
            if (primaryPrUrl) openedPullRequests.push(primaryPrUrl);
            const planned = this.plannedMounts(event.job, ctx.runId);
            for (const entry of result.mountGit) {
                const refusal = refuseMountEntry(entry, planned);
                if (refusal) {
                    this.logger.warn(`Run ${ctx.runId}: mount result ignored — ${refusal}`);
                    mountNotes.push(`ignored: ${refusal}.`);
                    continue;
                }
                const mount = planned.get(entry.repositoryId!.trim().toLowerCase())!;
                if (entry.empty) {
                    mountNotes.push(`\`${mount.repositoryId}\`: no changes.`);
                    continue;
                }
                if (!entry.pushed) {
                    mountNotes.push(describeUnpushedMount(mount, entry));
                    continue;
                }
                // The primary path is guarded the same way: an unexpected
                // throw here (a DB outage while recording the link) must not
                // abort before `markCompleted`, or the run stays `running`
                // for a job that is already `done`.
                try {
                    const outcome = await this.taskWorkspace.finalizeMountPush({
                        task,
                        userId: event.userId,
                        agentId: agentId ?? run.agentId,
                        agentCanOpenPullRequests: agent?.permissions?.canOpenPullRequests !== false,
                        repositoryId: mount.repositoryId,
                        branch: mount.branch,
                        baseRef: mount.baseRef,
                        headSha: entry.headSha ?? null,
                        primaryPrUrl,
                        summary,
                    });
                    mountNotes.push(describeMountOutcome(outcome, mount.branch));
                    if (outcome.prUrl) openedPullRequests.push(outcome.prUrl);
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    mountNotes.push(
                        `\`${mount.repositoryId}\`: branch \`${mount.branch}\` pushed, but recording it failed: ${message}.`,
                    );
                    this.logger.warn(
                        `Task ${task.id}: mount ${mount.repositoryId} finalize failed after fleet push: ${message}`,
                    );
                }
            }
            if (mountNotes.length > 0) {
                finalizeNote = [
                    finalizeNote,
                    'Mounted repositories:',
                    ...mountNotes.map((note) => `- ${note}`),
                ]
                    .filter((line) => line.length > 0)
                    .join('\n');
            }
            await this.bestEffort('inbox notice', async () => {
                if (!this.inbox) return;
                await this.inbox.notice(event.userId, {
                    title: `Fleet run finished: ${task.title ? truncate(task.title, 120) : ctx.taskId}`,
                    body: [
                        summary,
                        '',
                        openedPullRequests.length > 0
                            ? `Pull requests to review (${openedPullRequests.length}):\n${openedPullRequests
                                  .map((url) => `- ${url}`)
                                  .join('\n')}`
                            : 'No pull request was opened.',
                        ...(mountNotes.length > 0 ? ['', ...mountNotes] : []),
                    ].join('\n'),
                    agentId,
                    agentRunId: ctx.runId,
                    taskId: ctx.taskId,
                    workId: task.workId ?? null,
                    organizationId: task.organizationId ?? null,
                });
            });
        }

        await this.runs.markCompleted(ctx.runId, summary);
        await this.bestEffort('board denorm', () =>
            this.runDenorm.recordTerminal(ctx.taskId, ctx.runId, 'completed'),
        );
        await this.postChat(
            task,
            event.userId,
            agentId,
            composeSuccessMessage(summary, finalizeNote, result),
        );
        await this.drain(task?.workId ?? run.workId ?? null);
    }

    /**
     * Self-build slice Q — the model wrote `.ever-works/QUESTION.md`; the
     * node reported it and removed it. Park the run on the owner and file
     * the question, in an order that cannot lose the answer:
     *
     *   1. replay guard — a row that is already terminal was reconciled
     *      before (a replayed completion event); nothing to do;
     *   2. `tryMarkCompleted` (CAS) — only the winner parks and files, so
     *      two reports for one job cannot re-park a run `resume()` has
     *      meanwhile un-parked, nor stack a duplicate question;
     *   3. `setAwaitingInput(true)` — terminal BEFORE the Inbox row exists:
     *      a question filed on a still-`running` row lets a fast reply
     *      route to `RunSteeringService.steer`, which appends the answer
     *      to `pendingInput` that no node ever reads. Set HERE (not only
     *      inside `InboxService.questionRaised`) so the run is resumable
     *      from the Task page even when INBOX_PRODUCER is unbound;
     *   4. board denorm `completed` — `TaskRunTerminalStatus` has no
     *      `awaiting`; the web derives the waiting state from the run row;
     *   5. branch bookkeeping through `recordRemotePush` — NEVER
     *      `finalizeRemotePush`, whose tail opens a pull request and moves
     *      the Task to `in_review` even on the pushed-no-pr path; pushed
     *      mounts through `finalizeMountPush` with PRs off (the failure
     *      branch's precedent: `state:'pushed'` only, and only for the
     *      planned writable mounts of the job);
     *   6. the Inbox question with the node / branch / Task provenance —
     *      every id from the event or the run row, never from the result;
     *   7. Task chat + drain of the Work's parked runs.
     *
     * 4–7 are best-effort; a failure in 2–3 is logged at error level with
     * the run id (review SR-3). `markFailed` is never called on this path.
     * The question text and context were redacted by `parseAgentTaskResult`
     * (review SR-2), so the summary, the Inbox row and the chat post all
     * carry the same cleaned text.
     */
    private async reconcileQuestion(
        event: FleetJobCompletedEvent,
        ctx: FleetAgentTaskCorrelation,
        run: AgentRun,
        task: Task | null,
        agentId: string | null,
        result: FleetAgentTaskResult,
        question: FleetAgentTaskQuestion,
    ): Promise<void> {
        if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
            this.logger.debug(
                `Run ${ctx.runId}: owner question ignored — run already ${run.status} (replayed completion)`,
            );
            return;
        }
        // The two parking writes are NOT best-effort, and not silent either
        // (review SR-3): a failure here leaves the run as the database has
        // it — `running` when the terminal write failed, `completed` but
        // not awaiting when the flag failed — with the pushed branch, the
        // board chip and the Inbox question all unrecorded. Say so at
        // error level, with the run id, instead of a listener-level warn.
        let parked: boolean;
        try {
            parked = await this.runs.tryMarkCompleted(
                ctx.runId,
                truncate(
                    `Paused with a question for the owner: ${question.text}`,
                    MAX_SUMMARY_CHARS,
                ),
            );
        } catch (error) {
            this.logger.error(
                `Run ${ctx.runId}: parking on the owner question failed at the terminal write — the run stays running until the sweeper reaps it: ${describeError(error)}`,
            );
            return;
        }
        if (!parked) {
            this.logger.debug(
                `Run ${ctx.runId}: owner question ignored — lost the terminal CAS (already settled elsewhere)`,
            );
            return;
        }
        try {
            await this.runs.setAwaitingInput(ctx.runId, true);
        } catch (error) {
            this.logger.error(
                `Run ${ctx.runId}: parking on the owner question failed at the awaiting-input flag — the run is completed but NOT resumable from the Inbox; re-run the Task: ${describeError(error)}`,
            );
            return;
        }
        await this.bestEffort('board denorm', () =>
            this.runDenorm.recordTerminal(ctx.taskId, ctx.runId, 'completed'),
        );

        if (task && result.git && result.git.pushed && !result.git.empty) {
            const git = result.git;
            await this.bestEffort('record pushed branch', () =>
                this.taskWorkspace.recordRemotePush({
                    task,
                    runId: ctx.runId,
                    branch: git.branch,
                    headSha: git.headSha ?? null,
                    baseSha: git.baseSha ?? null,
                    ...(typeof git.changedFiles === 'number'
                        ? { changedFiles: git.changedFiles }
                        : {}),
                }),
            );
        }
        // Pushed mounts are recorded with pull requests OFF, through the same
        // planned-mount gate as the success and failure paths: the wire is
        // untrusted, so repository, branch and base come from the planner's
        // spec on the job and the node only says what it pushed.
        //
        // A mount that did NOT push is not dropped in silence (review LC-2 /
        // BD-6). The question branch is taken for ANY status, BEFORE the
        // success / failure split, so it is the ONLY place a multi-repo run
        // that asked a question can report the repository that failed to
        // land: the failure path — whose whole message is `failureReason` —
        // never runs for it. Nothing is RECORDED for such a mount (the Task
        // has no state for an un-pushed branch, on any path), but the verdict
        // travels with the question the way the success path already reports
        // it, so the owner answers knowing one repository is still on the
        // node.
        const mountNotes: string[] = [];
        if (result.mountGit && result.mountGit.length > 0) {
            const planned = this.plannedMounts(event.job, ctx.runId);
            for (const entry of result.mountGit) {
                const refusal = refuseMountEntry(entry, planned);
                if (refusal) {
                    this.logger.warn(`Run ${ctx.runId}: mount result ignored — ${refusal}`);
                    continue;
                }
                const mount = planned.get(entry.repositoryId!.trim().toLowerCase())!;
                if (entry.empty) continue;
                if (!entry.pushed) {
                    // Redacted here too: a failed push quotes the remote URL
                    // with the credential in it, and the server log is not a
                    // place to keep the owner's token either (review SR-2).
                    this.logger.warn(
                        `Run ${ctx.runId}: mount ${mount.repositoryId} was not pushed on a parked run: ${truncate(
                            redactSecrets(entry.error ?? entry.publishWithheld ?? 'git policy')
                                .cleaned,
                            MAX_VERDICT_CHARS,
                        )}`,
                    );
                    mountNotes.push(describeUnpushedMount(mount, entry));
                    continue;
                }
                // The Task row can be gone (deleted while the job ran); the
                // question is still filed, and the notes above still travel
                // with it — only the branch bookkeeping needs the row.
                if (!task) continue;
                await this.bestEffort(`record pushed mount ${mount.repositoryId}`, () =>
                    this.taskWorkspace.finalizeMountPush({
                        task,
                        userId: event.userId,
                        agentId: agentId ?? run.agentId,
                        agentCanOpenPullRequests: false,
                        repositoryId: mount.repositoryId,
                        branch: mount.branch,
                        baseRef: mount.baseRef,
                        headSha: entry.headSha ?? null,
                    }),
                );
            }
        }

        const node = await this.lookupNode(event.nodeId, event.userId);
        await this.bestEffort('inbox question', async () => {
            if (!this.inbox) return;
            await this.inbox.questionRaised({
                userId: event.userId,
                agentRunId: ctx.runId,
                agentId,
                question: question.text,
                context: composeQuestionContext(question, result, mountNotes),
                sourceMeta: {
                    nodeId: event.nodeId ?? event.job.nodeId ?? null,
                    nodeName: node?.name ?? null,
                    branch: result.git?.branch ?? result.workspace?.branch ?? null,
                    taskTitle: task?.title ?? null,
                    prUrl: task?.prUrl ?? null,
                    mountDir: question.mountDir,
                },
            });
        });
        await this.postChat(
            task,
            event.userId,
            agentId,
            composeQuestionMessage(question, result, mountNotes),
        );
        await this.drain(task?.workId ?? run.workId ?? null);
    }

    private async postChat(
        task: Task | null,
        userId: string,
        agentId: string | null,
        body: string,
    ): Promise<void> {
        if (!task || !this.taskChat || !agentId) return;
        await this.bestEffort('task chat', () =>
            this.taskChat!.post(userId, {
                taskId: task.id,
                authorType: 'agent',
                authorId: agentId,
                body: redactSecrets(body).cleaned,
            }),
        );
    }

    /** Promote parked runs the same way the cloud executor does on exit. */
    private async drain(workId: string | null): Promise<void> {
        if (!workId || !this.dispatchGate) return;
        await this.bestEffort('dispatch-gate drain', () => this.dispatchGate!.drainForWork(workId));
    }

    /**
     * The mounts the PLANNER put on the job — the only repositories a node
     * report may make the platform act on. Read from the job payload (the
     * same `FleetTaskWorkspaceSpec` the node provisioned from), through the
     * same normalizer, so a payload that does not normalize yields NO
     * admissible mounts rather than a permissive default.
     */
    private plannedMounts(job: FleetJobView, runId: string): PlannedMounts {
        const planned: PlannedMounts = new Map();
        const payload = job.payload as Partial<FleetAgentTaskPayload> | null | undefined;
        const workspace = payload?.workspace;
        if (
            !workspace ||
            typeof workspace !== 'object' ||
            typeof workspace.repositoryId !== 'string'
        ) {
            return planned;
        }
        try {
            for (const mount of normalizeFleetTaskWorkspaceMounts(
                workspace.mounts,
                workspace.repositoryId,
            )) {
                planned.set(mount.repositoryId.toLowerCase(), mount);
            }
        } catch (error) {
            this.logger.warn(
                `Run ${runId}: planned mounts of job ${job.id} did not normalize (${
                    error instanceof Error ? error.message : String(error)
                }); every node mount result is ignored`,
            );
            planned.clear();
        }
        return planned;
    }

    /** The reporting node, only when it is the run owner's; null otherwise or on any lookup failure. */
    private async lookupNode(nodeId: string | null, userId: string): Promise<FleetNode | null> {
        if (!nodeId || !this.nodes) return null;
        try {
            const node = await this.nodes.findById(nodeId);
            return node && node.userId === userId ? node : null;
        } catch {
            return null;
        }
    }

    private async describeNode(nodeId: string, userId: string): Promise<string> {
        const node = await this.lookupNode(nodeId, userId);
        return node ? `${node.name} (${nodeId.slice(0, 8)})` : nodeId;
    }

    private async bestEffort(what: string, fn: () => Promise<unknown>): Promise<void> {
        try {
            await fn();
        } catch (error) {
            this.logger.warn(
                `Fleet reconcile: ${what} failed: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }
}

/** Defensive parse of the node's result; the wire is untrusted data, not a contract to crash on. */
export function parseAgentTaskResult(
    raw: Record<string, unknown> | null | undefined,
): FleetAgentTaskResult | null {
    if (!raw || typeof raw !== 'object') return null;
    const status = raw.status === 'succeeded' || raw.status === 'failed' ? raw.status : null;
    if (!status) return null;
    const checks = Array.isArray(raw.checks)
        ? (raw.checks as TaskCheckResult[]).filter(isCheckResult)
        : null;
    const git =
        raw.git && typeof raw.git === 'object' ? (raw.git as FleetAgentTaskResult['git']) : null;
    const model =
        raw.model && typeof raw.model === 'object'
            ? (raw.model as FleetAgentTaskResult['model'])
            : null;
    // Multi-repo (slice C): `mountGit` is an array of per-repository
    // verdicts or nothing; a malformed shape must not throw half-way
    // through a reconcile (after `markFailed`, before the chat / notice).
    const mountGit = Array.isArray(raw.mountGit) ? raw.mountGit.filter(isMountGitResult) : null;
    return {
        ...(raw as FleetAgentTaskResult),
        status,
        taskId: typeof raw.taskId === 'string' ? raw.taskId : '',
        runId: typeof raw.runId === 'string' ? raw.runId : null,
        checks,
        git: git && typeof git.branch === 'string' ? git : null,
        model,
        mountGit,
        failureReason: typeof raw.failureReason === 'string' ? raw.failureReason : null,
        // Self-build slice Q: secrets redacted at the boundary (review
        // SR-2 — a question is exactly where a model pastes the value it
        // is unsure about), THEN coerced through the contracts' normalizer
        // so the caps apply to the redacted text and the raw spread can
        // never leak an untyped (or smuggled-field) question into the
        // parked-run path.
        question: normalizeFleetAgentTaskQuestion(redactQuestionFields(raw.question)),
    };
}

/**
 * Redact secrets from the model-written question BEFORE it is normalised
 * (review SR-2). The question line becomes the run summary, the Inbox
 * title — which `composeFleetAnswerMessage` replays into the next run's
 * prompt — and the Inbox body; until now only the Task-chat post went
 * through `redactSecrets`. Neither `InboxService.fileQuestion` nor the
 * repository redacts, so this boundary is the one place that does.
 */
function redactQuestionFields(raw: unknown): unknown {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
    const input = raw as Record<string, unknown>;
    return {
        ...input,
        ...(typeof input.text === 'string' ? { text: redactSecrets(input.text).cleaned } : {}),
        ...(typeof input.context === 'string'
            ? { context: redactSecrets(input.context).cleaned }
            : {}),
    };
}

function isMountGitResult(value: unknown): value is FleetAgentTaskGitResult {
    return Boolean(
        value &&
        typeof value === 'object' &&
        typeof (value as FleetAgentTaskGitResult).repositoryId === 'string' &&
        typeof (value as FleetAgentTaskGitResult).branch === 'string' &&
        typeof (value as FleetAgentTaskGitResult).pushed === 'boolean' &&
        typeof (value as FleetAgentTaskGitResult).empty === 'boolean',
    );
}

/**
 * Why a node-reported mount verdict is NOT acted on, or null when it is
 * admissible: the repository must be a planned WRITABLE mount of this run,
 * the branch must be the Task branch the plan named, and a reported head
 * must look like a commit id. Everything quoted back is bounded.
 */
function refuseMountEntry(entry: FleetAgentTaskGitResult, planned: PlannedMounts): string | null {
    const repositoryId = typeof entry.repositoryId === 'string' ? entry.repositoryId.trim() : '';
    if (!repositoryId) return 'a mount verdict without a repository';
    const quoted = `\`${truncate(repositoryId, MAX_QUOTED_CHARS)}\``;
    const mount = planned.get(repositoryId.toLowerCase());
    if (!mount) return `${quoted} was not a planned mount of this run`;
    if (!mount.writable) return `${quoted} is a read-only mount`;
    if (entry.branch !== mount.branch) {
        return `${quoted}: branch \`${truncate(entry.branch, MAX_QUOTED_CHARS)}\` is not the Task branch \`${mount.branch}\``;
    }
    if (entry.headSha !== null && entry.headSha !== undefined && !SHA_PATTERN.test(entry.headSha)) {
        return `${quoted}: the reported head is not a commit id`;
    }
    return null;
}

/**
 * Why a mounted repository that HAS work did not reach its remote, in one
 * line. Shared by the success and the question paths (review LC-2 / BD-6)
 * so a mount that failed to push reads the same wherever the run ended up
 * being reported.
 *
 * Repository and branch are the PLANNER's — the node only supplies the
 * reason, which is redacted (a failed push routinely quotes the remote URL
 * with the credential embedded, and this line reaches the Inbox body —
 * review SR-2) and bounded before a human ever sees it.
 */
function describeUnpushedMount(
    mount: FleetTaskWorkspaceMountSpec,
    entry: FleetAgentTaskGitResult,
): string {
    const reason = entry.error ?? entry.publishWithheld ?? null;
    const quoted = reason
        ? truncate(redactSecrets(reason).cleaned, MAX_VERDICT_CHARS)
        : 'git policy';
    return `\`${mount.repositoryId}\`: committed on \`${mount.branch}\` but not pushed (${quoted}).`;
}

function describeMountOutcome(outcome: TaskMountPushOutcome, branch: string): string {
    switch (outcome.outcome) {
        case 'pr-opened':
            return `\`${outcome.repositoryId}\`: pull request #${outcome.prNumber} opened from \`${branch}\` (${outcome.prUrl}).`;
        case 'pushed-no-pr':
            return `\`${outcome.repositoryId}\`: branch \`${branch}\` pushed; the pull request is left to a human.`;
        default:
            return `\`${outcome.repositoryId}\`: branch \`${branch}\` pushed, but opening the pull request failed: ${outcome.error ?? 'unknown error'}.`;
    }
}

function isCheckResult(value: unknown): value is TaskCheckResult {
    return Boolean(
        value &&
        typeof value === 'object' &&
        typeof (value as TaskCheckResult).id === 'string' &&
        typeof (value as TaskCheckResult).status === 'string',
    );
}

function toGateStatus(value: unknown): GateStatus {
    return value === 'green' || value === 'red' || value === 'skipped' || value === 'none'
        ? value
        : 'none';
}

function truncate(value: string, max: number): string {
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function describeFinalize(outcome: TaskWorkspaceFinalizeOutcome, branch: string): string {
    switch (outcome.outcome) {
        case 'pr-opened': {
            const merged = outcome.merge?.merged
                ? ' It was merged by the agent per the Work merge policy.'
                : '';
            return `Pull request #${outcome.prNumber} opened from \`${branch}\`: ${outcome.prUrl}.${merged}`;
        }
        case 'pushed-no-pr':
            return `Branch \`${branch}\` was pushed; this agent may not open pull requests, so one is left to a human.`;
        case 'conflict':
            return `Branch \`${branch}\` was pushed but conflicts with the base: ${outcome.conflictPaths?.join(', ') ?? ''}`;
        default:
            return `Branch \`${branch}\` was pushed.`;
    }
}

function composeSuccessMessage(
    summary: string,
    finalizeNote: string,
    result: FleetAgentTaskResult,
): string {
    const lines = ['**Fleet run finished** (executed on one of your own machines).', '', summary];
    if (finalizeNote) lines.push('', finalizeNote);
    if (result.model?.costUsd !== undefined && result.model?.costUsd !== null) {
        lines.push(
            '',
            `Model spend reported by the CLI: $${result.model.costUsd.toFixed(2)}${result.model.turns ? ` over ${result.model.turns} turn(s)` : ''}.`,
        );
    }
    if (result.gateStatus === 'green' && result.checks?.length) {
        lines.push(`Acceptance checks: all ${result.checks.length} green.`);
    }
    return lines.join('\n');
}

/**
 * Self-build slice Q — what the owner should know next to the question:
 * where the partial work is, and whether the run also reported a model
 * or check failure (both are true AND the run is parked, not failed).
 * Prose only; every id the reply routes on lives on the Inbox row.
 *
 * `mountNotes` are the caller's, already gated against the planner's spec
 * (review LC-2 / BD-6): a node report may not name a repository the plan
 * never mounted, not even in prose the owner reads.
 */
function describeQuestionNotes(
    question: FleetAgentTaskQuestion,
    result: FleetAgentTaskResult,
    mountNotes: string[] = [],
): string[] {
    const notes: string[] = [];
    const git = result.git;
    if (git) {
        if (git.error) {
            // A failed push routinely quotes the remote URL with the token
            // embedded; this note reaches the Inbox body (review SR-2).
            notes.push(`Work so far: push failed: ${redactSecrets(git.error).cleaned}`);
        } else if (git.pushed && !git.empty) {
            notes.push(`Work so far: pushed on branch \`${git.branch}\`.`);
        } else if (git.empty) {
            notes.push('Work so far: no file changes.');
        } else if (git.publishWithheld) {
            // Slice B's lease fence, NOT the Work's git policy: the node
            // committed and deliberately declined to push a branch it may
            // no longer own. Said apart from the policy line below so the
            // operator is not sent after a phantom Git fault, and so the
            // deliberate refusal is not read as a settled choice to keep
            // the work local.
            notes.push(
                `Work so far: committed on \`${git.branch}\` but the push was withheld: ${truncate(
                    redactSecrets(git.publishWithheld).cleaned,
                    MAX_VERDICT_CHARS,
                )}`,
            );
        } else {
            notes.push(
                `Work so far: committed on \`${git.branch}\` but not pushed (git policy) — the answer run may land on another node and start from the base ref.`,
            );
        }
    }
    // Multi-repo (slice C1) — the mounts that did not land, in the same
    // shape the success path uses for them. Without this the owner reads a
    // tidy question and never learns a second repository is still sitting
    // uncommitted-to-the-remote on the node.
    if (mountNotes.length > 0) {
        notes.push('Mounted repositories:', ...mountNotes.map((note) => `- ${note}`));
    }
    if (result.model && result.model.status !== 'succeeded') {
        notes.push(`The run also reported a model failure (status ${result.model.status}).`);
    }
    if (result.gateStatus === 'red') {
        const failing = (result.checks ?? [])
            .filter((check) => check.status !== 'green')
            .map((check) => check.id);
        notes.push(
            `Required acceptance checks did not pass${failing.length > 0 ? `: ${failing.join(', ')}` : '.'}`,
        );
    }
    // The node's own one-sentence verdict, LAST because it usually repeats
    // in summary form what the notes above say in detail — but it is the
    // only line that carries a failure with no git or check of its own
    // (review LC-2). Bounded and redacted exactly like the failure path's
    // `reason`, which is the message this run will never get.
    if (result.status === 'failed' && result.failureReason) {
        notes.push(
            `The run also reported a failure: ${truncate(
                redactSecrets(result.failureReason).cleaned,
                MAX_SUMMARY_CHARS,
            )}`,
        );
    }
    if (question.mountDir) {
        notes.push(`Asked from the mounted repository \`.mounts/${question.mountDir}\`.`);
    }
    return notes;
}

/** The Inbox body's context half: the model's own context, then the run notes; capped to the body width. */
function composeQuestionContext(
    question: FleetAgentTaskQuestion,
    result: FleetAgentTaskResult,
    mountNotes: string[] = [],
): string | null {
    const notes = describeQuestionNotes(question, result, mountNotes);
    const parts = [question.context, notes.length > 0 ? notes.join('\n') : null].filter(
        (part): part is string => Boolean(part && part.trim()),
    );
    if (parts.length === 0) return null;
    return truncate(parts.join('\n\n'), MAX_QUESTION_CONTEXT_CHARS);
}

function composeQuestionMessage(
    question: FleetAgentTaskQuestion,
    result: FleetAgentTaskResult,
    mountNotes: string[] = [],
): string {
    const lines = [
        '**Fleet run paused — waiting for your answer** (executed on one of your own machines).',
        '',
        question.text,
    ];
    if (question.context) {
        lines.push('', truncate(question.context, MAX_TAIL_CHARS));
    }
    const notes = describeQuestionNotes(question, result, mountNotes);
    if (notes.length > 0) lines.push('', ...notes);
    lines.push('', 'Answer it in the Inbox to resume this Task on the same branch.');
    return lines.join('\n');
}

function composeFailureMessage(reason: string, result: FleetAgentTaskResult | null): string {
    const lines = ['**Fleet run failed** (executed on one of your own machines).', '', reason];
    const failing = result?.checks?.filter((check) => check.status !== 'green') ?? [];
    if (failing.length > 0) {
        lines.push('', 'Failing checks:');
        for (const check of failing) {
            lines.push(
                `- ${check.id}: ${check.status}${check.exitCode !== null && check.exitCode !== undefined ? ` (exit ${check.exitCode})` : ''}`,
            );
        }
    }
    const tail = result?.model?.outputTail ?? result?.model?.summary ?? null;
    if (tail) {
        lines.push('', 'CLI output tail:', '```', truncate(tail, MAX_TAIL_CHARS), '```');
    }
    return lines.join('\n');
}
