import { Injectable, Logger } from '@nestjs/common';
import { GitFacadeService } from '../../facades/git.facade';
import { CodeEditFacadeService } from '../../facades/code-edit.facade';
import type { GitFacadeOptions } from '../../facades/git.facade';
import { WorkCodeUpdateRepository, WorkRepository } from '../../database';
import {
    Work,
    User,
    WorkCodeUpdate,
    WorkCodeUpdateSource,
    WorkCodeUpdateStatus,
} from '../../entities';
import { WebsiteTemplateResolverService } from '../website-generator/website-template-resolver.service';
import type { CodeUpdateRequest } from './types';
import {
    buildCodegenBranch,
    buildCommitMessage,
    buildCommitTitle,
    buildPullRequestBody,
} from './pr-templates';

@Injectable()
export class CodeUpdateGeneratorService {
    private readonly logger = new Logger(CodeUpdateGeneratorService.name);

    constructor(
        private readonly gitFacade: GitFacadeService,
        private readonly codeEditFacade: CodeEditFacadeService,
        private readonly workRepository: WorkRepository,
        private readonly codeUpdateRepository: WorkCodeUpdateRepository,
        private readonly templateResolver: WebsiteTemplateResolverService,
    ) {}

    // ─────────────────────────────────────────────────────────────────────
    // Public API
    // ─────────────────────────────────────────────────────────────────────

    /**
     * Create a code-update record. Heavy lifting (clone + edit + PR) is
     * deferred to `execute()` so callers can either run inline or hand off
     * to a Trigger.dev task.
     */
    async request(work: Work, user: User, dto: CodeUpdateRequest): Promise<WorkCodeUpdate> {
        const template = await this.templateResolver.resolveForWork(work);
        return this.codeUpdateRepository.create({
            workId: work.id,
            requestedByUserId: user.id,
            prompt: dto.prompt,
            title: dto.title,
            aiModel: dto.aiModel,
            templateId: template.id,
            source: dto.source ?? WorkCodeUpdateSource.MANUAL,
            status: WorkCodeUpdateStatus.PENDING,
        });
    }

    /**
     * Run the full code-update flow against an existing record. Each step
     * lives in its own private method so failures are localised and so
     * the flow can be re-read top-to-bottom.
     */
    async execute(codeUpdateId: string, user: User): Promise<void> {
        const record = await this.codeUpdateRepository.findById(codeUpdateId);
        if (!record || this.isAlreadyHandled(record)) return;

        const work = await this.workRepository.findById(record.workId);
        if (!work) {
            await this.codeUpdateRepository.markFailed(codeUpdateId, 'Work not found');
            return;
        }

        await this.codeUpdateRepository.update(codeUpdateId, {
            status: WorkCodeUpdateStatus.GENERATING,
        });

        try {
            const branch = buildCodegenBranch();
            const template = await this.templateResolver.resolveForWork(work);
            const workspaceDir = await this.cloneOnBranch(work, user, template.branch, branch);

            const edit = await this.runAgent(work, record, workspaceDir);
            await this.commitAndPush(work, user, workspaceDir, record);
            const pr = await this.openProposalPr(
                work,
                branch,
                template.branch,
                record,
                edit.summary,
            );

            await this.codeUpdateRepository.update(codeUpdateId, {
                status: WorkCodeUpdateStatus.PROPOSED,
                branch,
                prNumber: pr.number,
                prUrl: pr.url,
                diff: edit.filesChanged.map((f) => ({
                    path: f.path,
                    status: f.status,
                    additions: f.additions,
                    deletions: f.deletions,
                })),
                summary: edit.summary,
            });

            this.logger.log(
                `Code update ${codeUpdateId} proposed on ${work.getRepoOwner('website')}/${work.getWebsiteRepo()}#${pr.number}`,
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error(`Code update ${codeUpdateId} failed: ${message}`);
            await this.codeUpdateRepository.markFailed(codeUpdateId, message);
        }
    }

    /**
     * Apply a PROPOSED code update by merging its PR. The merge to the
     * default branch triggers the existing production-deploy pipeline.
     */
    async apply(codeUpdateId: string): Promise<void> {
        const { record, work } = await this.loadProposed(codeUpdateId);
        if (!record.prNumber) throw new Error('Code update has no PR to merge');

        await this.gitFacade.mergePullRequest(
            work.getRepoOwner('website'),
            work.getWebsiteRepo(),
            record.prNumber,
            { mergeMethod: 'squash', commitTitle: buildCommitTitle(record) },
            this.workToGitOptions(work),
        );
        await this.codeUpdateRepository.markApplied(codeUpdateId);
    }

    /**
     * Reject a code update by closing its PR (no merge). Provider-side
     * already-closed errors are absorbed.
     */
    async reject(codeUpdateId: string): Promise<void> {
        const record = await this.codeUpdateRepository.findById(codeUpdateId);
        if (!record) throw new Error('Code update not found');
        if (
            record.status !== WorkCodeUpdateStatus.PROPOSED &&
            record.status !== WorkCodeUpdateStatus.PENDING
        ) {
            throw new Error(`Code update is ${record.status}; cannot reject`);
        }

        const work = await this.workRepository.findById(record.workId);
        if (!work) throw new Error('Work not found');

        if (record.prNumber) {
            await this.gitFacade
                .closePullRequest(
                    work.getRepoOwner('website'),
                    work.getWebsiteRepo(),
                    record.prNumber,
                    this.workToGitOptions(work),
                )
                .catch((err) =>
                    this.logger.warn(
                        `Failed to close PR for code update ${codeUpdateId}: ${err instanceof Error ? err.message : String(err)}`,
                    ),
                );
        }
        await this.codeUpdateRepository.markRejected(codeUpdateId);
    }

    list(workId: string): Promise<WorkCodeUpdate[]> {
        return this.codeUpdateRepository.findByWork(workId);
    }

    get(codeUpdateId: string): Promise<WorkCodeUpdate | null> {
        return this.codeUpdateRepository.findById(codeUpdateId);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Orchestration steps (used by execute())
    // ─────────────────────────────────────────────────────────────────────

    private async cloneOnBranch(
        work: Work,
        user: User,
        baseBranch: string,
        newBranch: string,
    ): Promise<string> {
        const workspaceDir = await this.gitFacade.cloneOrPull(
            {
                owner: work.getRepoOwner('website'),
                repo: work.getWebsiteRepo(),
                branch: baseBranch,
                committer: work.resolveCommitter(user),
            },
            this.workToGitOptions(work),
        );
        await this.gitFacade.switchBranch(work.gitProvider, workspaceDir, newBranch, true);
        return workspaceDir;
    }

    private async runAgent(work: Work, record: WorkCodeUpdate, workspaceDir: string) {
        const result = await this.codeEditFacade.execute(
            {
                workspaceDir,
                prompt: record.prompt,
                model: record.aiModel ?? undefined,
            },
            { userId: work.userId, workId: work.id },
            {
                onLogLine: (stream, line) => this.logger.debug(`[code-edit:${stream}] ${line}`),
            },
        );
        if (!result.success) throw new Error(result.error ?? result.summary);
        if (result.filesChanged.length === 0) throw new Error('AI agent produced no file changes');
        return result;
    }

    private async commitAndPush(
        work: Work,
        user: User,
        workspaceDir: string,
        record: WorkCodeUpdate,
    ): Promise<void> {
        await this.gitFacade.addAll(work.gitProvider, workspaceDir);
        await this.gitFacade.commit(
            work.gitProvider,
            workspaceDir,
            buildCommitMessage(record),
            work.resolveCommitter(user),
        );
        await this.gitFacade.push({ dir: workspaceDir }, this.workToGitOptions(work));
    }

    private async openProposalPr(
        work: Work,
        head: string,
        base: string,
        record: WorkCodeUpdate,
        summary: string,
    ) {
        return this.gitFacade.createPullRequest(
            {
                owner: work.getRepoOwner('website'),
                repo: work.getWebsiteRepo(),
                head,
                base,
                title: buildCommitTitle(record),
                body: buildPullRequestBody(record, summary),
            },
            this.workToGitOptions(work),
        );
    }

    // ─────────────────────────────────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────────────────────────────────

    private isAlreadyHandled(record: WorkCodeUpdate): boolean {
        return (
            record.status === WorkCodeUpdateStatus.APPLIED ||
            record.status === WorkCodeUpdateStatus.PROPOSED
        );
    }

    private workToGitOptions(work: Work): GitFacadeOptions {
        return { userId: work.userId, providerId: work.gitProvider, workId: work.id };
    }

    private async loadProposed(
        codeUpdateId: string,
    ): Promise<{ record: WorkCodeUpdate; work: Work }> {
        const record = await this.codeUpdateRepository.findById(codeUpdateId);
        if (!record) throw new Error('Code update not found');
        if (record.status !== WorkCodeUpdateStatus.PROPOSED) {
            throw new Error(`Code update is ${record.status}; can only act on PROPOSED records`);
        }
        const work = await this.workRepository.findById(record.workId);
        if (!work) throw new Error('Work not found');
        return { record, work };
    }
}
