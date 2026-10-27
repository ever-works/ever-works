import { Logger } from '@nestjs/common';
import { isAppWorkKind } from '@ever-works/contracts';

import type { Work } from '../entities/work.entity';
import { resolveTaskRepository } from '../tasks-domain/task-repository';
import {
    buildAppRunInstructionsBlock,
    buildAppRunRulesBlock,
    buildAppRunRulesUnreadableBlock,
    instructionFilePathRefusal,
    type AppRunInstructionFileRead,
    type AppRunInstructionFileRefusal,
} from './app-run-brief';
import { AppSpecUnreadableError, type AppWorkRules } from './app-work-rules.service';

/**
 * APW-08 T18 — the source both run paths ask for an App Work run's brief: the cloud path through
 * `AgentRunService` (in the API process) and the fleet path through the planner's
 * `composeInstructions`. Bound by the API's `@Global()` `AgentsModule` under
 * {@link APP_RUN_BRIEF_SOURCE}; unbound, a run is briefed exactly as before.
 *
 * Reads, in order, from platform rows and the git provider only: the Task, its Work (not an App
 * Work → `null`), the Work's repository (`resolveTaskRepository`), the base branch (the run's
 * own base ref when the caller has one, else the Work's isolation base, else the repository
 * default), its head commit, the rules at THAT commit (`AppWorkRulesService.resolve`, never the
 * branch), then each instruction file at that commit. The file content is the only third-party
 * text, and it only ever reaches the brief fenced (`buildAppRunInstructionsBlock`).
 *
 * Best-effort by contract: a run is never failed by its brief. An unreadable App spec yields the
 * "could not be read" rules block (the change gate refuses the pull request on its own); any
 * other failure yields `null` and a warning.
 */
export const APP_RUN_BRIEF_SOURCE = Symbol('APP_RUN_BRIEF_SOURCE');

export interface AppRunBrief {
    /** Platform text: the rules at the base commit, or the "could not be read" notice. */
    readonly rules: string;
    /** Untrusted repository content, fenced; `null` when no instruction file was included. */
    readonly instructions: string | null;
    readonly branch: string;
    readonly baseSha: string | null;
    readonly includedFiles: readonly string[];
    readonly truncatedFiles: readonly string[];
    readonly refusedFiles: ReadonlyArray<{ path: string; reason: AppRunInstructionFileRefusal }>;
}

export interface AppRunBriefSource {
    /** The brief for a run of `taskId`, or `null` when the Task is not on an App Work. */
    forTask(input: { taskId: string; baseRef?: string | null }): Promise<AppRunBrief | null>;
}

type GitOptions = { userId: string; providerId: string; workId: string };

/** What the service reads — structural, so a spec passes plain doubles. */
export interface AppRunBriefReads {
    tasks: { findById(id: string): Promise<{ id: string; workId?: string | null } | null> };
    works: { findById(id: string): Promise<Work | null> };
    rules: { resolve(work: Work, baseSha: string): Promise<AppWorkRules> };
    git: {
        getRepository(
            owner: string,
            repo: string,
            options: GitOptions,
        ): Promise<{ defaultBranch?: string | null } | null>;
        getLatestCommit(
            owner: string,
            repo: string,
            branch: string,
            options: GitOptions,
        ): Promise<{ sha?: string | null } | null>;
        getFileContent(
            owner: string,
            repo: string,
            path: string,
            options: GitOptions,
            ref?: string,
        ): Promise<{ content: string; encoding: string } | null>;
    };
}

export class AppRunBriefService implements AppRunBriefSource {
    private readonly logger = new Logger(AppRunBriefService.name);

    constructor(private readonly reads: AppRunBriefReads) {}

    async forTask(input: { taskId: string; baseRef?: string | null }): Promise<AppRunBrief | null> {
        try {
            const task = await this.reads.tasks.findById(input.taskId);
            if (!task?.workId) return null;
            const work = await this.reads.works.findById(task.workId);
            if (!work || !isAppWorkKind(work.kind)) return null;
            return await this.compose(work, input.baseRef ?? null);
        } catch (error) {
            this.logger.warn(
                `App run brief for Task ${input.taskId} could not be composed (the run is briefed without it): ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return null;
        }
    }

    private async compose(work: Work, baseRef: string | null): Promise<AppRunBrief | null> {
        const target = resolveTaskRepository(work);
        if (!target) return null;
        const gitOptions: GitOptions = {
            userId: work.userId,
            providerId: work.gitProvider || 'github',
            workId: work.id,
        };
        const branch =
            baseRef?.trim() ||
            work.taskIsolationBaseBranch?.trim() ||
            (
                await this.reads.git.getRepository(target.owner, target.repo, gitOptions)
            )?.defaultBranch?.trim() ||
            '';
        if (!branch) return this.unreadable(work, 'the base branch', 'no base branch');
        const head = await this.reads.git.getLatestCommit(
            target.owner,
            target.repo,
            branch,
            gitOptions,
        );
        const baseSha = head?.sha?.trim() || null;
        if (!baseSha) return this.unreadable(work, branch, 'no base commit');

        let rules: AppWorkRules;
        try {
            rules = await this.reads.rules.resolve(work, baseSha);
        } catch (error) {
            if (error instanceof AppSpecUnreadableError)
                return this.unreadable(work, branch, error.status, baseSha);
            throw error;
        }

        const files: AppRunInstructionFileRead[] = [];
        for (const path of rules.instructionFiles) {
            const refusal = instructionFilePathRefusal(path);
            if (refusal) {
                files.push({ path, content: null, refusal });
                continue;
            }
            // A provider answers a file it can read as a file; a symlink whose target is not a
            // file in the repository comes back as no content, and is refused as unreadable.
            const read = await this.reads.git
                .getFileContent(target.owner, target.repo, path, gitOptions, baseSha)
                .catch(() => null);
            files.push({ path, content: typeof read?.content === 'string' ? read.content : null });
        }
        const block = buildAppRunInstructionsBlock(files);
        return {
            rules: buildAppRunRulesBlock(rules, { branch, baseSha }),
            instructions: block.text,
            branch,
            baseSha,
            includedFiles: block.included,
            truncatedFiles: block.truncated,
            refusedFiles: block.refused,
        };
    }

    private unreadable(
        work: Work,
        branch: string,
        reason: string,
        baseSha: string | null = null,
    ): AppRunBrief {
        this.logger.warn(
            `App run brief for Work ${work.id}: the App spec on ${branch} could not be read (${reason}).`,
        );
        return {
            rules: buildAppRunRulesUnreadableBlock({ branch, reason }),
            instructions: null,
            branch,
            baseSha,
            includedFiles: [],
            truncatedFiles: [],
            refusedFiles: [],
        };
    }
}
