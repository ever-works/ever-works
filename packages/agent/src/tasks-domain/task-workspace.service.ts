import { forwardRef, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { TaskStatus, type Task } from '../entities/task.entity';
import { WorkRepository } from '../database/repositories/work.repository';
import { TaskRepository } from '../database/repositories/task.repository';
import { AgentRunRepository } from '../database/repositories/agent-run.repository';
import { WorkspaceFacadeService } from '../facades/workspace.facade';
import { GitFacadeService } from '../facades/git.facade';
import { TaskTransitionService } from './task-transition.service';
import { TaskChatService } from './task-chat.service';
import { resolveTaskIsolation, taskBranchName } from './task-isolation';

export interface ProvisionedTaskWorkspace {
    /** Filesystem path of the checkout — the run's working directory. */
    cwd: string;
    branch: string;
    baseSha: string;
    reused: boolean;
    provider: string;
}

export interface TaskWorkspaceFinalizeOutcome {
    outcome: 'no-changes' | 'pr-opened' | 'pushed-no-pr' | 'conflict';
    prNumber?: number;
    prUrl?: string;
    conflictPaths?: string[];
}

/**
 * Worktree-per-Task isolation (Wave 2 M3) — the ONE service that turns
 * "isolation resolved on" into a provisioned workspace + persisted
 * branch identity. Called by the `agent-task-execute` worker after the
 * run claim, before dispatch.
 *
 * Failure posture: when a Work has isolation ON and provisioning
 * fails, the error PROPAGATES — the run fails loudly instead of
 * silently degrading to a non-isolated run the user explicitly opted
 * out of. When isolation resolves off, this is a no-op returning null.
 */
@Injectable()
export class TaskWorkspaceService {
    private readonly logger = new Logger(TaskWorkspaceService.name);

    constructor(
        private readonly works: WorkRepository,
        private readonly tasks: TaskRepository,
        private readonly runs: AgentRunRepository,
        // Both facades are @Optional() so unit-test constructor calls and
        // module graphs that don't import FacadesModule keep working;
        // when absent and isolation is on, we fail loudly below.
        @Optional() private readonly workspaceFacade?: WorkspaceFacadeService,
        @Optional() private readonly gitFacade?: GitFacadeService,
        // M4 — finalize path collaborators. Same module; forwardRef
        // because TaskTransitionService/TaskChatService are declared
        // after this provider in some graphs.
        @Optional()
        @Inject(forwardRef(() => TaskTransitionService))
        private readonly transitions?: TaskTransitionService,
        @Optional()
        @Inject(forwardRef(() => TaskChatService))
        private readonly taskChat?: TaskChatService,
    ) {}

    /**
     * Resolve + provision the Task's isolated workspace for one run.
     * Returns null when isolation resolves off (the overwhelmingly
     * common path while the setting defaults to off).
     */
    async provisionForRun(input: {
        task: Task;
        userId: string;
        runId: string;
        /** From `agent.permissions.canCommitToRepo` (default true). */
        agentCanCommit: boolean;
    }): Promise<ProvisionedTaskWorkspace | null> {
        const { task, userId, runId } = input;
        if (!task.workId) return null;

        const work = await this.works.findById(task.workId);
        if (!work) return null;

        const mode = resolveTaskIsolation(task, work, { agentCanCommit: input.agentCanCommit });
        if (mode !== 'on') return null;

        if (!this.workspaceFacade || !this.gitFacade) {
            throw new Error(
                `Task ${task.id} requires workspace isolation but no workspace/git facade is available in this runtime.`,
            );
        }

        // v1 repo resolution: the Work's output (data) repo on the Work's
        // git provider. `taskIsolationTargetRepo='linked'` reserves the
        // linked-source-repo variant for the connectors wave.
        const owner = work.getRepoOwner();
        const repo = work.getDataRepo();
        const gitOptions = { userId, providerId: work.gitProvider, workId: work.id };

        const token = await this.gitFacade.getAccessToken(gitOptions);
        if (!token) {
            throw new Error(
                `Task ${task.id} requires workspace isolation but no git credentials are available for provider '${work.gitProvider}'.`,
            );
        }

        const repository = await this.gitFacade.getRepository(owner, repo, gitOptions);
        const baseRef =
            (work.taskIsolationBaseBranch && work.taskIsolationBaseBranch.trim()) ||
            repository.defaultBranch;

        // The branch is AUTHORITATIVE once written — reuse it verbatim on
        // re-runs; never recompute from a (possibly edited) slug.
        const branch = task.branchRef || taskBranchName({ id: task.id, slug: task.slug });

        const handle = await this.workspaceFacade.provision(
            {
                repoUrl: repository.cloneUrl,
                baseRef,
                branch,
                bindingKey: task.id,
                auth: { token },
            },
            { userId, workId: work.id },
        );

        // Persist the durable identity on the Task…
        await this.tasks.updateById(task.id, {
            branchRef: handle.branch,
            baseSha: handle.baseSha,
            // A reused branch keeps its lifecycle state (it may already be
            // pushed / pr-open); first provision starts at 'created'.
            ...(task.branchState ? {} : { branchState: 'created' }),
        });

        // …and the per-run audit on the AgentRun (best-effort).
        try {
            await this.runs.setWorkspaceMeta(runId, {
                provider: 'workspace',
                path: handle.path,
                baseSha: handle.baseSha,
                branchRef: handle.branch,
                reused: handle.reused,
            });
        } catch (error) {
            this.logger.warn(
                `workspaceMeta persist failed for run ${runId}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }

        this.logger.log(
            `Task ${task.id} provisioned workspace on branch ${handle.branch} (base ${handle.baseSha.slice(0, 8)}, reused=${handle.reused})`,
        );

        return {
            cwd: handle.path,
            branch: handle.branch,
            baseSha: handle.baseSha,
            reused: handle.reused,
            provider: 'workspace',
        };
    }

    /**
     * M4 — green-path finalize after a successful isolated run:
     * commit + push whatever the run left in the workspace, simulate
     * the merge against a FRESH base, then either open the PR
     * (community-PR posture: agents open PRs, the merge-policy matrix
     * decides who merges) or refuse it and NAME the conflicting paths.
     *
     * State machine written here:
     *   empty run          → (no change)          outcome 'no-changes'
     *   pushed + clean     → 'pr-open' + in_review outcome 'pr-opened'
     *   pushed, no PR perm → 'pushed'             outcome 'pushed-no-pr'
     *   pushed + conflict  → 'conflict' + blocked outcome 'conflict'
     */
    async finalizeRun(input: {
        task: Task;
        userId: string;
        agentId: string;
        /** From `agent.permissions.canOpenPullRequests` (default true). */
        agentCanOpenPullRequests: boolean;
        workspace: ProvisionedTaskWorkspace;
    }): Promise<TaskWorkspaceFinalizeOutcome> {
        const { task, userId, workspace } = input;
        if (!this.workspaceFacade || !this.gitFacade) {
            throw new Error(
                `Task ${task.id} workspace finalize requires the workspace/git facades.`,
            );
        }
        if (!task.workId) {
            throw new Error(`Task ${task.id} lost its Work before finalize.`);
        }
        const work = await this.works.findById(task.workId);
        if (!work) {
            throw new Error(`Task ${task.id} lost its Work before finalize.`);
        }

        const owner = work.getRepoOwner();
        const repo = work.getDataRepo();
        const gitOptions = { userId, providerId: work.gitProvider, workId: work.id };
        const repository = await this.gitFacade.getRepository(owner, repo, gitOptions);
        const baseRef =
            (work.taskIsolationBaseBranch && work.taskIsolationBaseBranch.trim()) ||
            repository.defaultBranch;

        const handle = {
            path: workspace.cwd,
            baseSha: workspace.baseSha,
            reused: workspace.reused,
            branch: workspace.branch,
            bindingKey: task.id,
        };
        const facadeOptions = { userId, workId: work.id };

        const finalize = await this.workspaceFacade.finalize(
            handle,
            { commitMessage: `feat(task): ${task.slug} agent run output`, push: true },
            facadeOptions,
        );
        if (finalize.empty) {
            this.logger.log(`Task ${task.id} run produced no changes — nothing to push.`);
            return { outcome: 'no-changes' };
        }
        await this.tasks.updateById(task.id, { branchState: 'pushed' });

        const simulation = await this.workspaceFacade.simulateMerge(handle, baseRef, facadeOptions);

        if (!simulation.clean) {
            // Refuse the PR and NAME the paths — the single
            // highest-value UX detail of the whole feature.
            await this.tasks.updateById(task.id, {
                branchState: 'conflict',
                conflictPaths: simulation.conflictPaths,
            });
            await this.postSystemMessage(
                input,
                [
                    `Merge conflict against \`${baseRef}\` — the push was completed but no PR was opened.`,
                    '',
                    'Conflicting paths:',
                    ...simulation.conflictPaths.map((p) => `- \`${p}\``),
                    '',
                    'Send a message here (or use Resolve conflicts) to re-run with a rebase onto the fresh base.',
                ].join('\n'),
            );
            await this.transitionTask(task, TaskStatus.BLOCKED);
            return { outcome: 'conflict', conflictPaths: simulation.conflictPaths };
        }

        if (!input.agentCanOpenPullRequests) {
            this.logger.log(
                `Task ${task.id} branch ${workspace.branch} pushed; agent lacks canOpenPullRequests — leaving PR to a human.`,
            );
            return { outcome: 'pushed-no-pr' };
        }

        const pr = await this.gitFacade.createPullRequest(
            {
                owner,
                repo,
                title: `Task ${task.slug}: ${task.title ?? 'agent run output'}`,
                head: workspace.branch,
                base: baseRef,
                body: `Automated changes for Task \`${task.slug}\` (agent run). Review before merging — merge policy is governed by the Work's merge-policy settings.`,
            },
            gitOptions,
        );
        await this.tasks.updateById(task.id, {
            branchState: 'pr-open',
            prNumber: pr.number,
            prUrl: pr.url,
        });
        await this.transitionTask(task, TaskStatus.IN_REVIEW);
        this.logger.log(`Task ${task.id} opened PR #${pr.number} (${pr.url}).`);
        return { outcome: 'pr-opened', prNumber: pr.number, prUrl: pr.url };
    }

    private async transitionTask(task: Task, to: TaskStatus): Promise<void> {
        if (!this.transitions) return;
        try {
            const fresh = await this.tasks.findById(task.id);
            if (fresh && fresh.status !== to) {
                await this.transitions.transition(fresh, to);
            }
        } catch (error) {
            this.logger.warn(
                `Task ${task.id} status transition to ${to} failed: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    /**
     * M5 — "Resolve conflicts" action (UI button and chat path
     * converge here): flips the blocked Task back to in_progress, which
     * re-fires the agent dispatch. The re-run re-provisions from the
     * PUSHED branch and fetches a fresh base, so the agent works the
     * conflict against current reality. Owner-scoped; 409-style error
     * when the Task is not in a conflict state.
     */
    async resolveConflicts(userId: string, taskId: string): Promise<Task> {
        const task = await this.tasks.findByIdAndUser(taskId, userId);
        if (!task) {
            throw new Error('TASK_NOT_FOUND');
        }
        if (task.branchState !== 'conflict') {
            throw new Error('TASK_NOT_IN_CONFLICT');
        }
        if (!this.transitions) {
            throw new Error('Task transitions unavailable in this runtime.');
        }
        // Back to created: the branch exists and is pushed; the conflict
        // verdict is stale the moment a new run starts.
        await this.tasks.updateById(task.id, { branchState: 'pushed', conflictPaths: null });
        const fresh = await this.tasks.findById(task.id);
        return this.transitions.transition(fresh ?? task, TaskStatus.IN_PROGRESS, {
            force: true,
        });
    }

    /**
     * M6 — "Discard branch" escape hatch: delete the remote task branch
     * and reset the Task's workspace identity so the next run starts
     * clean. Irreversible for the branch (the UI confirms first).
     */
    async discardBranch(userId: string, taskId: string): Promise<void> {
        const task = await this.tasks.findByIdAndUser(taskId, userId);
        if (!task) {
            throw new Error('TASK_NOT_FOUND');
        }
        if (!task.branchRef) {
            return; // nothing to discard — idempotent
        }
        if (task.workId && this.gitFacade) {
            const work = await this.works.findById(task.workId);
            if (work) {
                try {
                    await this.gitFacade.deleteBranch(
                        work.getRepoOwner(),
                        work.getDataRepo(),
                        task.branchRef,
                        { userId, providerId: work.gitProvider, workId: work.id },
                    );
                } catch (error) {
                    // Branch may already be gone (merged + auto-deleted) —
                    // discard stays idempotent.
                    this.logger.warn(
                        `Task ${task.id} remote branch delete failed (continuing): ${
                            error instanceof Error ? error.message : String(error)
                        }`,
                    );
                }
            }
        }
        await this.tasks.updateById(task.id, {
            branchRef: null,
            branchState: 'discarded',
            baseSha: null,
            prNumber: null,
            prUrl: null,
            conflictPaths: null,
        });
    }

    /**
     * M6 — GC sweep for remote task branches. Called by the
     * workspace-gc cron: deletes branches of TERMINAL Tasks per the
     * Work's `taskBranchCleanup` policy ('on-merge' → eligible as soon
     * as the Task is done/cancelled; 'manual' → never auto-deleted),
     * plus a hard staleness cutoff for abandoned non-terminal branches.
     */
    async sweepStaleBranches(opts: { staleDays: number }): Promise<{ cleaned: number }> {
        const candidates = await this.tasks.findBranchCleanupCandidates(opts.staleDays);
        let cleaned = 0;
        for (const task of candidates) {
            try {
                await this.discardBranchForSweep(task);
                cleaned += 1;
            } catch (error) {
                this.logger.warn(
                    `branch GC failed for task ${task.id}: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
            }
        }
        if (cleaned > 0) this.logger.log(`branch GC cleaned ${cleaned} task branches`);
        return { cleaned };
    }

    private async discardBranchForSweep(task: Task): Promise<void> {
        if (task.workId && this.gitFacade && task.branchRef) {
            const work = await this.works.findById(task.workId);
            if (work && work.taskBranchCleanup !== 'manual') {
                try {
                    await this.gitFacade.deleteBranch(
                        work.getRepoOwner(),
                        work.getDataRepo(),
                        task.branchRef,
                        { userId: task.userId, providerId: work.gitProvider, workId: work.id },
                    );
                } catch {
                    // already gone — fine
                }
                await this.tasks.updateById(task.id, { branchState: 'cleaned' });
            }
        }
    }

    private async postSystemMessage(
        input: { task: Task; userId: string; agentId: string },
        body: string,
    ): Promise<void> {
        if (!this.taskChat) return;
        try {
            await this.taskChat.post(input.userId, {
                taskId: input.task.id,
                authorType: 'agent',
                authorId: input.agentId,
                body,
            });
        } catch (error) {
            this.logger.warn(
                `Task ${input.task.id} conflict chat message failed: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }
}
