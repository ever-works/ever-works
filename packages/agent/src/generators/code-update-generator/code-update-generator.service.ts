import { Injectable, Logger } from '@nestjs/common';
import { GitFacadeService } from '../../facades/git.facade';
import { WorkCodeUpdateRepository, WorkRepository } from '../../database';
import {
    Work,
    User,
    WorkCodeUpdate,
    WorkCodeUpdateSource,
    WorkCodeUpdateStatus,
} from '../../entities';
import { WebsiteTemplateResolverService } from '../website-generator/website-template-resolver.service';
import { AiCodeEditorService } from './ai-code-editor.service';
import type { CodeUpdateRequest } from './types';

export interface RequestCodeUpdateOptions {
    autoExecute?: boolean;
}

@Injectable()
export class CodeUpdateGeneratorService {
    private readonly logger = new Logger(CodeUpdateGeneratorService.name);

    constructor(
        private readonly gitFacade: GitFacadeService,
        private readonly workRepository: WorkRepository,
        private readonly codeUpdateRepository: WorkCodeUpdateRepository,
        private readonly templateResolver: WebsiteTemplateResolverService,
        private readonly aiCodeEditor: AiCodeEditorService,
    ) {}

    /**
     * Create a code-update record. Heavy lifting (clone + edit + PR) is
     * deferred to `execute()` so callers can either run inline or hand off
     * to a Trigger.dev task (see work-code-regeneration.task).
     */
    async request(
        work: Work,
        user: User,
        dto: CodeUpdateRequest,
        opts: RequestCodeUpdateOptions = {},
    ): Promise<WorkCodeUpdate> {
        const template = await this.templateResolver.resolveForWork(work);

        const record = await this.codeUpdateRepository.create({
            workId: work.id,
            requestedByUserId: user.id,
            prompt: dto.prompt,
            title: dto.title,
            aiModel: dto.aiModel,
            templateId: template.id,
            source: dto.source ?? WorkCodeUpdateSource.MANUAL,
            status: WorkCodeUpdateStatus.PENDING,
        });

        if (opts.autoExecute) {
            await this.execute(record.id, user);
        }

        return record;
    }

    /**
     * Run the full code-update flow against an existing record. Idempotent
     * for the failure case — re-execution restarts from a fresh workspace.
     */
    async execute(codeUpdateId: string, user: User): Promise<void> {
        const record = await this.codeUpdateRepository.findById(codeUpdateId);
        if (!record) {
            this.logger.warn(`Code update ${codeUpdateId} not found`);
            return;
        }
        if (
            record.status === WorkCodeUpdateStatus.APPLIED ||
            record.status === WorkCodeUpdateStatus.PROPOSED
        ) {
            this.logger.debug(`Code update ${codeUpdateId} is ${record.status}; skipping`);
            return;
        }

        const work = await this.workRepository.findById(record.workId);
        if (!work) {
            await this.codeUpdateRepository.markFailed(codeUpdateId, 'Work not found');
            return;
        }

        await this.codeUpdateRepository.update(codeUpdateId, {
            status: WorkCodeUpdateStatus.GENERATING,
        });

        const branch = `ai/codegen-${Date.now()}`;
        const websiteOwner = work.getRepoOwner('website');
        const websiteRepo = work.getWebsiteRepo();
        const template = await this.templateResolver.resolveForWork(work);

        try {
            const workspaceDir = await this.gitFacade.cloneOrPull(
                {
                    owner: websiteOwner,
                    repo: websiteRepo,
                    branch: template.branch,
                    committer: work.resolveCommitter(user),
                },
                {
                    userId: work.userId,
                    providerId: work.gitProvider,
                    workId: work.id,
                },
            );

            await this.gitFacade.switchBranch(work.gitProvider, workspaceDir, branch, true);

            const editResult = await this.aiCodeEditor.apply({
                workspaceDir,
                prompt: record.prompt,
                model: record.aiModel ?? undefined,
            });

            await this.gitFacade.addAll(work.gitProvider, workspaceDir);
            await this.gitFacade.commit(
                work.gitProvider,
                workspaceDir,
                this.buildCommitMessage(record),
                work.resolveCommitter(user),
            );
            await this.gitFacade.push(
                { dir: workspaceDir },
                {
                    userId: work.userId,
                    providerId: work.gitProvider,
                    workId: work.id,
                },
            );

            const pr = await this.gitFacade.createPullRequest(
                {
                    owner: websiteOwner,
                    repo: websiteRepo,
                    head: branch,
                    base: template.branch,
                    title: record.title ?? `AI: ${record.prompt.slice(0, 64)}`,
                    body: this.buildPrBody(record, editResult.summary),
                },
                {
                    userId: work.userId,
                    providerId: work.gitProvider,
                    workId: work.id,
                },
            );

            await this.codeUpdateRepository.update(codeUpdateId, {
                status: WorkCodeUpdateStatus.PROPOSED,
                branch,
                prNumber: pr.number,
                prUrl: pr.url,
                diff: editResult.diff,
                summary: editResult.summary,
            });

            this.logger.log(
                `Code update ${codeUpdateId} proposed on ${websiteOwner}/${websiteRepo}#${pr.number}`,
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error(`Code update ${codeUpdateId} failed: ${message}`);
            await this.codeUpdateRepository.markFailed(codeUpdateId, message);
        }
    }

    /**
     * Apply a PROPOSED code update by merging its PR. The merge to the
     * default branch triggers the existing production-deploy pipeline; no
     * extra dispatch needed here.
     */
    async apply(codeUpdateId: string): Promise<void> {
        const record = await this.codeUpdateRepository.findById(codeUpdateId);
        if (!record) throw new Error('Code update not found');
        if (record.status !== WorkCodeUpdateStatus.PROPOSED) {
            throw new Error(`Code update is ${record.status}; can only apply PROPOSED records`);
        }
        if (!record.prNumber) {
            throw new Error('Code update has no PR to merge');
        }

        const work = await this.workRepository.findById(record.workId);
        if (!work) throw new Error('Work not found');

        await this.gitFacade.mergePullRequest(
            work.getRepoOwner('website'),
            work.getWebsiteRepo(),
            record.prNumber,
            {
                mergeMethod: 'squash',
                commitTitle: record.title ?? `AI: ${record.prompt.slice(0, 64)}`,
            },
            { userId: work.userId, providerId: work.gitProvider, workId: work.id },
        );

        await this.codeUpdateRepository.markApplied(codeUpdateId);
    }

    /**
     * Reject a code update by closing its PR (no merge). Idempotent —
     * closing an already-closed PR is silently absorbed by the provider.
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
            try {
                await this.gitFacade.closePullRequest(
                    work.getRepoOwner('website'),
                    work.getWebsiteRepo(),
                    record.prNumber,
                    { userId: work.userId, providerId: work.gitProvider, workId: work.id },
                );
            } catch (err) {
                this.logger.warn(
                    `Failed to close PR for code update ${codeUpdateId}: ${
                        err instanceof Error ? err.message : String(err)
                    }`,
                );
            }
        }

        await this.codeUpdateRepository.markRejected(codeUpdateId);
    }

    list(workId: string): Promise<WorkCodeUpdate[]> {
        return this.codeUpdateRepository.findByWork(workId);
    }

    get(codeUpdateId: string): Promise<WorkCodeUpdate | null> {
        return this.codeUpdateRepository.findById(codeUpdateId);
    }

    private buildCommitMessage(record: WorkCodeUpdate): string {
        const headline = record.title ?? `AI: ${record.prompt.slice(0, 64)}`;
        return `${headline}\n\nRequested via Ever Works codegen (${record.id})`;
    }

    private buildPrBody(record: WorkCodeUpdate, summary: string): string {
        return [
            '## AI code update',
            '',
            `**Code update id:** ${record.id}`,
            `**Source:** ${record.source}`,
            `**Model:** ${record.aiModel ?? 'unspecified'}`,
            '',
            '### Prompt',
            '',
            record.prompt,
            '',
            '### Summary',
            '',
            summary,
            '',
            '---',
            '',
            'Review the diff and `Apply` / `Reject` from the Ever Works Codegen tab to merge or close this PR.',
        ].join('\n');
    }
}
