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
import type {
    FleetAgentTaskResult,
    FleetJobView,
    GateStatus,
    TaskCheckResult,
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
            // are visible on the Task rather than orphaned on the remote.
            if (task && result?.mountGit) {
                for (const entry of result.mountGit) {
                    if (!entry.repositoryId || !entry.pushed || entry.empty) continue;
                    await this.bestEffort(`record pushed mount ${entry.repositoryId}`, () =>
                        this.taskWorkspace.finalizeMountPush({
                            task,
                            userId: event.userId,
                            agentId: agentId ?? run.agentId,
                            agentCanOpenPullRequests: false,
                            repositoryId: entry.repositoryId!,
                            branch: entry.branch,
                            baseRef: findMount(result, entry.repositoryId)?.baseRef ?? null,
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
        const mountNotes: string[] = [];
        const openedPullRequests: string[] = [];
        if (task && Array.isArray(result.mountGit) && result.mountGit.length > 0) {
            if (primaryPrUrl) openedPullRequests.push(primaryPrUrl);
            for (const entry of result.mountGit) {
                if (!entry.repositoryId) continue;
                if (entry.empty) {
                    mountNotes.push(`\`${entry.repositoryId}\`: no changes.`);
                    continue;
                }
                if (!entry.pushed) {
                    mountNotes.push(
                        `\`${entry.repositoryId}\`: committed on \`${entry.branch}\` but not pushed${
                            entry.error ? ` (${entry.error})` : ' (git policy)'
                        }.`,
                    );
                    continue;
                }
                const outcome = await this.taskWorkspace.finalizeMountPush({
                    task,
                    userId: event.userId,
                    agentId: agentId ?? run.agentId,
                    agentCanOpenPullRequests: agent?.permissions?.canOpenPullRequests !== false,
                    repositoryId: entry.repositoryId,
                    branch: entry.branch,
                    baseRef: findMount(result, entry.repositoryId)?.baseRef ?? null,
                    headSha: entry.headSha ?? null,
                    primaryPrUrl,
                    summary,
                });
                mountNotes.push(describeMountOutcome(outcome, entry.branch));
                if (outcome.prUrl) openedPullRequests.push(outcome.prUrl);
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
    return {
        ...(raw as FleetAgentTaskResult),
        status,
        taskId: typeof raw.taskId === 'string' ? raw.taskId : '',
        runId: typeof raw.runId === 'string' ? raw.runId : null,
        checks,
        git: git && typeof git.branch === 'string' ? git : null,
        model,
        failureReason: typeof raw.failureReason === 'string' ? raw.failureReason : null,
    };
}

/** The provisioned mount descriptor for a repository, when the node reported one. */
function findMount(result: FleetAgentTaskResult, repositoryId: string) {
    return (result.workspace?.mounts ?? []).find(
        (mount) => mount.repositoryId.toLowerCase() === repositoryId.toLowerCase(),
    );
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
