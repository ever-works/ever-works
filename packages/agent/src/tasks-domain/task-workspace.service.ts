import { Injectable, Logger, Optional } from '@nestjs/common';
import type { Task } from '../entities/task.entity';
import { WorkRepository } from '../database/repositories/work.repository';
import { TaskRepository } from '../database/repositories/task.repository';
import { AgentRunRepository } from '../database/repositories/agent-run.repository';
import { WorkspaceFacadeService } from '../facades/workspace.facade';
import { GitFacadeService } from '../facades/git.facade';
import { resolveTaskIsolation, taskBranchName } from './task-isolation';

export interface ProvisionedTaskWorkspace {
    /** Filesystem path of the checkout — the run's working directory. */
    cwd: string;
    branch: string;
    baseSha: string;
    reused: boolean;
    provider: string;
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
}
