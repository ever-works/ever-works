import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { RunDispatchGateService } from '@ever-works/agent/agents';
import { AgentRepository, AgentRunRepository } from '@ever-works/agent/database';
import type { Task } from '@ever-works/agent/entities';
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
    normalizeFleetTaskWorkspaceMounts,
    type FleetAgentTaskGitResult,
    type FleetAgentTaskPayload,
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
const SHA_PATTERN = /^[0-9a-f]{40,64}$/i;

/** The planned mounts of a job, keyed by lower-cased repository identity. */
type PlannedMounts = Map<string, FleetTaskWorkspaceMountSpec>;

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
 *
 * Every step is best-effort and idempotent: `markStarted` / `markCompleted`
 * / `markFailed` are CAS-guarded, the PR open is skipped when the Task
 * already carries one, and a listener failure is logged rather than
 * propagated (an event has no caller to fail).
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

        if (event.source === 'cancelled') {
            // The operator path already flipped the run to `cancelled`
            // (that is what triggered the job cancel); mirror the board.
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
                    mountNotes.push(
                        `\`${mount.repositoryId}\`: committed on \`${mount.branch}\` but not pushed${
                            entry.error
                                ? ` (${truncate(entry.error, MAX_QUOTED_CHARS)})`
                                : ' (git policy)'
                        }.`,
                    );
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

    private async describeNode(nodeId: string, userId: string): Promise<string> {
        if (!this.nodes) return nodeId;
        try {
            const node = await this.nodes.findById(nodeId);
            return node && node.userId === userId ? `${node.name} (${nodeId.slice(0, 8)})` : nodeId;
        } catch {
            return nodeId;
        }
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
