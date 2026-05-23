import {
    BadRequestException,
    Inject,
    Injectable,
    Logger,
    NotFoundException,
    Optional,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { TemplateRepository } from '@src/database/repositories/template.repository';
import { TemplateCustomizationRepository } from '@src/database/repositories/template-customization.repository';
import { UserRepository } from '@src/database/repositories/user.repository';
import { GitFacadeService, type GitFacadeOptions } from '@src/facades/git.facade';
import type { GitCommitter } from '@ever-works/plugin';
import { CodeEditFacadeService, type CodeEditProviderInfo } from '@src/facades/code-edit.facade';
import { AiFacadeService } from '@src/facades/ai.facade';
import {
    TEMPLATE_CUSTOMIZATION_DISPATCHER,
    type TemplateCustomizationDispatcher,
} from '@src/tasks';
import {
    findWebsiteTemplateConfig,
    type WebsiteTemplateConfig,
} from '@src/generators/website-generator/config/website-template.config';
import {
    TemplateCustomization,
    TemplateCustomizationStatus,
} from '@src/entities/template-customization.entity';
import { Template } from '@src/entities/template.entity';
import { assertCreatedRepositoryTarget } from '@src/utils/git-repository.utils';
import { getCustomizationPromptForBaseTemplate } from './customization-prompts';
import { inferFrameworkFromRepository } from './utils/framework-inference';

const GIT_PROVIDER_ID = 'github';
const REPO_NAME_MAX = 90;
const SUFFIX_LEN = 6;

/**
 * Paths inside a freshly cloned base template that should be stripped before
 * pushing the per-template fork to the user's GitHub org. These directories
 * exist in-tree for the source template's own developers (reference samples,
 * docs site, e2e tests) but they never reach a deployed Work — Vercel pins
 * `rootDirectory: apps/web` and the Dockerfile only COPYs `apps/web/`. Carrying
 * them into every user-cloned fork would bloat repo size, slow `pnpm install`,
 * waste CI minutes building things that never ship, and confuse users who open
 * "their" repo expecting one app.
 *
 * Only paths inside the template clone are stripped. Workspace package
 * directories under `packages/` are intentionally preserved — `apps/web/`
 * depends on them.
 */
const PROVISION_STRIP_PATHS: readonly string[] = [
    'apps/sample-basic',
    'apps/sample-events',
    'apps/sample-git',
    'apps/sample-jobs',
    'apps/sample-real-estate',
    'apps/docs',
    'apps/web-e2e',
];

export interface CreateAndStartCustomizationInput {
    baseTemplateId: string;
    name: string;
    prompt: string;
    providerId: string;
    aiProviderId?: string;
    targetOwner?: string;
    description?: string;
}

export interface CreateAndStartCustomizationResult {
    customization: TemplateCustomization;
    template: Template;
}

export interface IterateCustomizationInput {
    prompt: string;
    providerId: string;
    aiProviderId?: string;
}

export interface SyncTemplateFromBaseResult {
    template: Template;
    method: 'duplicate';
    changed: boolean;
    message: string;
}

/**
 * Provision a brand-new repo for each customization (clone base → push to new
 * repo → run agent → push). NOT a GitHub fork — fork API is 1-per-account,
 * users need many custom templates from the same base.
 */
@Injectable()
export class TemplateCustomizationService {
    private readonly logger = new Logger(TemplateCustomizationService.name);

    constructor(
        private readonly templateRepository: TemplateRepository,
        private readonly customizationRepository: TemplateCustomizationRepository,
        private readonly userRepository: UserRepository,
        private readonly gitFacade: GitFacadeService,
        private readonly codeEditFacade: CodeEditFacadeService,
        private readonly aiFacade: AiFacadeService,
        @Optional()
        @Inject(TEMPLATE_CUSTOMIZATION_DISPATCHER)
        private readonly dispatcher?: TemplateCustomizationDispatcher,
    ) {}

    async createAndStart(
        userId: string,
        input: CreateAndStartCustomizationInput,
    ): Promise<CreateAndStartCustomizationResult> {
        const name = input.name?.trim();
        const prompt = input.prompt?.trim();
        const providerId = input.providerId?.trim();

        if (!name) {
            throw new BadRequestException({
                status: 'error',
                message: 'Template name is required.',
            });
        }
        if (!prompt) {
            throw new BadRequestException({ status: 'error', message: 'Prompt is required.' });
        }
        if (!providerId) {
            throw new BadRequestException({
                status: 'error',
                message: 'Select an installed code-edit provider before continuing.',
            });
        }

        const baseConfig = this.resolveCustomizableBase(input.baseTemplateId);
        const codeEditProvider = await this.assertProviderAvailable(providerId, userId);
        const aiProviderId = await this.resolveAiProviderRequirement(
            codeEditProvider,
            input.aiProviderId?.trim(),
            userId,
        );
        const user = await this.userRepository.findById(userId);
        if (!user) {
            throw new NotFoundException({ status: 'error', message: 'User not found.' });
        }

        const targetOwner = await this.resolveTargetOwner(userId, input.targetOwner);
        const repoName = this.buildRepoName(name, baseConfig);
        const committer = await this.resolveCommitter(userId, user);

        const provisioned = await this.provisionFromBase({
            baseConfig,
            targetOwner,
            repoName,
            committer,
            userId,
        });

        const template = await this.templateRepository.upsert({
            id: `custom-${randomUUID()}`,
            kind: 'website',
            sourceType: 'custom',
            ownerUserId: userId,
            name,
            description: input.description?.trim() || baseConfig.description,
            framework: inferFrameworkFromRepository(baseConfig.repo),
            repositoryUrl: provisioned.repositoryUrl,
            repositoryOwner: provisioned.owner,
            repositoryName: provisioned.name,
            branch: provisioned.branch,
            syncBranches: [provisioned.branch],
            isActive: true,
            metadata: {
                baseTemplateId: baseConfig.id,
                baseRepositoryOwner: baseConfig.owner,
                baseRepositoryName: baseConfig.repo,
                provisionedAt: new Date().toISOString(),
            },
        });

        const customization = await this.customizationRepository.create({
            templateId: template.id,
            userId,
            baseTemplateId: baseConfig.id,
            prompt,
            providerId,
            aiProviderId,
        });

        await this.start(customization.id);

        return { customization, template };
    }

    async runOnExistingTemplate(
        userId: string,
        templateId: string,
        input: IterateCustomizationInput,
    ): Promise<CreateAndStartCustomizationResult> {
        const prompt = input.prompt?.trim();
        const providerId = input.providerId?.trim();

        if (!prompt) {
            throw new BadRequestException({ status: 'error', message: 'Prompt is required.' });
        }
        if (!providerId) {
            throw new BadRequestException({
                status: 'error',
                message: 'Select an installed code-edit provider before continuing.',
            });
        }

        const template = await this.templateRepository.findById(templateId);
        if (!template || template.ownerUserId !== userId || template.sourceType !== 'custom') {
            throw new NotFoundException({
                status: 'error',
                message: 'Custom template not found.',
            });
        }

        const baseTemplateId =
            typeof template.metadata?.baseTemplateId === 'string'
                ? template.metadata.baseTemplateId
                : null;
        if (!baseTemplateId) {
            throw new BadRequestException({
                status: 'error',
                message: 'Template is not linked to a customizable base.',
            });
        }
        this.resolveCustomizableBase(baseTemplateId);

        const codeEditProvider = await this.assertProviderAvailable(providerId, userId);
        const aiProviderId = await this.resolveAiProviderRequirement(
            codeEditProvider,
            input.aiProviderId?.trim(),
            userId,
        );

        const customization = await this.customizationRepository.create({
            templateId: template.id,
            userId,
            baseTemplateId,
            prompt,
            providerId,
            aiProviderId,
        });

        await this.start(customization.id);

        return { customization, template };
    }

    async syncFromBase(userId: string, templateId: string): Promise<SyncTemplateFromBaseResult> {
        const template = await this.templateRepository.findById(templateId);
        if (!template || template.ownerUserId !== userId || template.sourceType !== 'custom') {
            throw new NotFoundException({
                status: 'error',
                message: 'Custom template not found.',
            });
        }

        const baseTemplateId =
            typeof template.metadata?.baseTemplateId === 'string'
                ? template.metadata.baseTemplateId
                : null;
        if (!baseTemplateId) {
            throw new BadRequestException({
                status: 'error',
                message: 'Template is not linked to a customizable base.',
            });
        }

        const baseConfig = this.resolveCustomizableBase(baseTemplateId);
        const user = await this.userRepository.findById(userId);
        if (!user) {
            throw new NotFoundException({ status: 'error', message: 'User not found.' });
        }

        const committer = await this.resolveCommitter(userId, user);
        const gitOptions: GitFacadeOptions = { userId, providerId: GIT_PROVIDER_ID };

        await this.syncDuplicateFromBase(template, baseConfig, committer, gitOptions);

        const syncedAt = new Date().toISOString();
        const metadata = {
            ...(template.metadata ?? {}),
            lastBaseSyncedAt: syncedAt,
            lastBaseSyncMethod: 'duplicate',
            lastBaseSyncBase: `${baseConfig.owner}/${baseConfig.repo}@${baseConfig.branch}`,
        };
        const updated = await this.templateRepository.updateById(template.id, { metadata });

        return {
            template: updated ?? { ...template, metadata },
            method: 'duplicate',
            changed: true,
            message:
                'Synced the custom template by replacing it with the latest base template code.',
        };
    }
    private async start(customizationId: string): Promise<void> {
        const dispatchedId = this.dispatcher
            ? await this.dispatcher.dispatchTemplateCustomization({ customizationId })
            : null;

        if (dispatchedId) {
            await this.customizationRepository.updateById(customizationId, {
                triggerRunId: dispatchedId,
            });
            return;
        }

        if (this.dispatcher) {
            this.logger.warn(
                `Trigger dispatch failed, falling back to in-process customization for ${customizationId}`,
            );
        }
        void this.runAsync(customizationId);
    }

    getByIdForUser(id: string, userId: string): Promise<TemplateCustomization | null> {
        return this.customizationRepository.findByIdForUser(id, userId);
    }

    listForTemplate(templateId: string, userId: string): Promise<TemplateCustomization[]> {
        return this.customizationRepository.listForTemplate(templateId, userId);
    }

    listProviders(userId: string): Promise<CodeEditProviderInfo[]> {
        return this.codeEditFacade.listProviders(userId);
    }

    listAiProviders(userId: string) {
        return this.aiFacade.getAvailableProvidersForUser(userId);
    }

    /** Exposed for direct invocation by background tasks / tests. */
    async execute(customizationId: string): Promise<void> {
        const record = await this.customizationRepository.findById(customizationId);
        if (!record || this.isTerminal(record.status)) return;

        const template = await this.templateRepository.findById(record.templateId);
        if (!template) return this.markFailed(record.id, 'Custom template not found');

        const user = await this.userRepository.findById(record.userId);
        if (!user) return this.markFailed(record.id, 'User not found for customization');

        const basePrompt = getCustomizationPromptForBaseTemplate(record.baseTemplateId);
        if (!basePrompt) {
            return this.markFailed(
                record.id,
                `No customization prompt registered for base "${record.baseTemplateId}"`,
            );
        }

        const gitOptions: GitFacadeOptions = { userId: record.userId, providerId: GIT_PROVIDER_ID };
        const branch = template.branch || 'main';

        try {
            await this.customizationRepository.updateById(record.id, {
                status: TemplateCustomizationStatus.CUSTOMIZING,
                startedAt: new Date(),
                branch,
            });

            const committer = await this.resolveCommitter(record.userId, user);
            const workspaceDir = await this.gitFacade.cloneOrPull(
                {
                    owner: template.repositoryOwner,
                    repo: template.repositoryName,
                    branch,
                    committer,
                },
                gitOptions,
            );

            const composedPrompt = `${basePrompt}\n\n# User customization request\n\n${record.prompt.trim()}\n`;

            const edit = await this.codeEditFacade.execute(
                { workspaceDir, prompt: composedPrompt },
                {
                    userId: record.userId,
                    providerId: record.providerId ?? undefined,
                    aiProviderId: record.aiProviderId ?? undefined,
                },
                { onLogLine: (s, line) => this.logger.debug(`[tpl-customize:${s}] ${line}`) },
            );

            if (!edit.success) {
                throw new Error(edit.error ?? edit.summary ?? 'Agent edit failed');
            }
            if (edit.filesChanged.length === 0) {
                throw new Error('Agent produced no file changes; nothing to commit.');
            }

            await this.customizationRepository.updateById(record.id, {
                status: TemplateCustomizationStatus.PUSHING,
            });

            await this.gitFacade.addAll(GIT_PROVIDER_ID, workspaceDir);
            await this.gitFacade.commit(
                GIT_PROVIDER_ID,
                workspaceDir,
                this.commitMessage(record, edit.summary),
                committer,
            );
            await this.gitFacade.push({ dir: workspaceDir }, gitOptions);

            await this.templateRepository.updateById(template.id, {
                metadata: {
                    ...(template.metadata ?? {}),
                    lastCustomizedAt: new Date().toISOString(),
                    lastCustomizationPrompt: record.prompt,
                    lastCustomizationId: record.id,
                },
            });

            await this.customizationRepository.updateById(record.id, {
                status: TemplateCustomizationStatus.SUCCEEDED,
                completedAt: new Date(),
            });

            this.logger.log(
                `Customization ${record.id} succeeded on ${template.repositoryOwner}/${template.repositoryName}@${branch} (${edit.filesChanged.length} files)`,
            );
        } catch (error) {
            await this.markFailed(record.id, this.errorMessage(error));
        }
    }

    // ── Internals ─────────────────────────────────────────────────────────

    private async provisionFromBase(args: {
        baseConfig: WebsiteTemplateConfig;
        targetOwner: string;
        repoName: string;
        committer: GitCommitter;
        userId: string;
    }): Promise<{ owner: string; name: string; branch: string; repositoryUrl: string }> {
        const { baseConfig, targetOwner, repoName, committer, userId } = args;
        const gitOptions: GitFacadeOptions = { userId, providerId: GIT_PROVIDER_ID };

        const baseDir = await this.gitFacade.cloneOrPull(
            {
                owner: baseConfig.owner,
                repo: baseConfig.repo,
                branch: baseConfig.branch,
                committer,
            },
            gitOptions,
        );

        // Strip reference samples / docs / e2e from the per-template fork
        // before pushing. See PROVISION_STRIP_PATHS for the why. The strip
        // is committed (when anything was removed) so the user's repo
        // history reflects the deliberate slim-down rather than a silent
        // delta vs. the upstream template.
        const stripped = await this.stripProvisionedDir(baseDir, baseConfig);
        if (stripped.length > 0) {
            await this.gitFacade.addAll(GIT_PROVIDER_ID, baseDir);
            await this.gitFacade.commit(
                GIT_PROVIDER_ID,
                baseDir,
                `chore(template): remove reference samples for per-Work fork\n\n` +
                    `These directories live in the upstream template for its own\n` +
                    `developers (reference samples, docs site, e2e tests) and are\n` +
                    `not part of a deployed Work site. Stripped to keep the fork\n` +
                    `lean and avoid confusing the deploying user.\n\n` +
                    stripped.map((p) => `- ${p}`).join('\n'),
                committer,
            );
        }

        const personal = await this.gitFacade.getUser(gitOptions);
        const isOrg = personal.login.toLowerCase() !== targetOwner.toLowerCase();

        const created = assertCreatedRepositoryTarget(
            await this.gitFacade.createRepository(
                {
                    name: repoName,
                    description: `Custom ${baseConfig.name} template`,
                    organization: isOrg ? targetOwner : undefined,
                    isPrivate: true,
                },
                gitOptions,
            ),
            targetOwner,
            repoName,
            'Custom template repository',
        );

        const cloneUrl = this.gitFacade.getCloneUrl(GIT_PROVIDER_ID, created.owner, created.name);
        await this.gitFacade.replaceRemote(GIT_PROVIDER_ID, baseDir, 'origin', cloneUrl);
        await this.gitFacade.push({ dir: baseDir, force: true }, gitOptions);

        const repositoryUrl =
            created.url ?? this.gitFacade.getWebUrl(GIT_PROVIDER_ID, created.owner, created.name);

        return {
            owner: created.owner,
            name: created.name,
            branch: created.defaultBranch || baseConfig.branch,
            repositoryUrl,
        };
    }

    /**
     * Remove `PROVISION_STRIP_PATHS` directories from a freshly cloned base
     * template. Returns the list of paths actually removed (relative to the
     * workspace) so the caller can record them in a commit message — when
     * the base template doesn't ship some of these (e.g. classic has no
     * `apps/sample-*`), they're silently skipped.
     *
     * Strip is only applied to the `minimal` template today; the classic
     * template has none of these paths and the helper short-circuits.
     */
    private async stripProvisionedDir(
        workspaceDir: string,
        baseConfig: WebsiteTemplateConfig,
    ): Promise<string[]> {
        if (baseConfig.id !== 'minimal') {
            return [];
        }
        // `let` because `removed` is built up via push() through the loop —
        // the binding is conceptually mutable. Repo convention prefers `let`
        // for mutated locals over `const`.
        let removed: string[] = [];
        for (const relPath of PROVISION_STRIP_PATHS) {
            const absPath = path.join(workspaceDir, relPath);
            const existed = await fs
                .access(absPath)
                .then(() => true)
                .catch(() => false);
            if (!existed) {
                // Not every base template ships every strip path; just
                // skip silently.
                continue;
            }
            try {
                await fs.rm(absPath, { recursive: true, force: true });
                removed.push(relPath);
            } catch (error) {
                // Don't block the provision on a strip failure. The repo
                // will still work; it'll just be heavier than ideal.
                this.logger.warn(
                    `Failed to strip ${relPath} from ${workspaceDir}: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
            }
        }
        if (removed.length > 0) {
            this.logger.log(
                `Stripped ${removed.length} reference path(s) from ${baseConfig.id} fork: ${removed.join(', ')}`,
            );
        }
        return removed;
    }

    private async syncDuplicateFromBase(
        template: Template,
        baseConfig: WebsiteTemplateConfig,
        committer: GitCommitter,
        gitOptions: GitFacadeOptions,
    ): Promise<void> {
        await this.gitFacade.removeLocalDir(GIT_PROVIDER_ID, baseConfig.owner, baseConfig.repo);
        const baseDir = await this.gitFacade.cloneOrPull(
            {
                owner: baseConfig.owner,
                repo: baseConfig.repo,
                branch: baseConfig.branch,
                committer,
            },
            gitOptions,
        );

        await this.stripProvisionedDir(baseDir, baseConfig);
        await this.gitFacade.addAll(GIT_PROVIDER_ID, baseDir);
        await this.gitFacade.commit(
            GIT_PROVIDER_ID,
            baseDir,
            'chore(template): sync from latest base template',
            committer,
        );

        const targetRepoUrl = this.gitFacade.getCloneUrl(
            GIT_PROVIDER_ID,
            template.repositoryOwner,
            template.repositoryName,
        );
        await this.gitFacade.switchBranch(GIT_PROVIDER_ID, baseDir, baseConfig.branch);
        await this.gitFacade.replaceRemote(GIT_PROVIDER_ID, baseDir, 'origin', targetRepoUrl);
        await this.gitFacade.push({ dir: baseDir, force: true }, gitOptions);
        await this.gitFacade.removeLocalDir(GIT_PROVIDER_ID, baseConfig.owner, baseConfig.repo);

        this.logger.log(
            `Synced custom template ${template.repositoryOwner}/${template.repositoryName} from ${baseConfig.owner}/${baseConfig.repo}@${baseConfig.branch} using duplicate method`,
        );
    }
    private async resolveTargetOwner(userId: string, override?: string): Promise<string> {
        const trimmed = override?.trim();
        if (trimmed) return trimmed;
        const user = await this.gitFacade.getUser({ userId, providerId: GIT_PROVIDER_ID });
        return user.login;
    }

    private async resolveCommitter(
        userId: string,
        user: { username?: string; email?: string },
    ): Promise<GitCommitter> {
        const fromGit = await this.gitFacade.getCommitter({ userId, providerId: GIT_PROVIDER_ID });
        if (fromGit) return fromGit;
        return {
            name: user.username || user.email || 'ever-works-user',
            email: user.email || `${user.username || 'user'}@users.noreply.github.com`,
        };
    }

    private async assertProviderAvailable(
        providerId: string,
        userId: string,
    ): Promise<CodeEditProviderInfo> {
        const match = await this.codeEditFacade.getProviderForUser(providerId, userId);
        if (!match) {
            throw new BadRequestException({
                status: 'error',
                message: `Code-edit provider "${providerId}" is not installed or not enabled for this account.`,
            });
        }
        return match;
    }

    private async resolveAiProviderRequirement(
        codeEditProvider: CodeEditProviderInfo,
        candidateAiProviderId: string | undefined,
        userId: string,
    ): Promise<string | null> {
        if (!codeEditProvider.selectableProviderCategories.includes('ai-provider')) {
            return null;
        }
        if (!candidateAiProviderId) {
            throw new BadRequestException({
                status: 'error',
                message: `${codeEditProvider.name} requires you to pick an AI provider.`,
            });
        }
        const available = await this.aiFacade.getAvailableProvidersForUser(userId);
        if (!available.some((p) => p.id === candidateAiProviderId)) {
            throw new BadRequestException({
                status: 'error',
                message: `AI provider "${candidateAiProviderId}" is not installed or not enabled for this account.`,
            });
        }
        return candidateAiProviderId;
    }

    private resolveCustomizableBase(id: string): WebsiteTemplateConfig {
        const config = findWebsiteTemplateConfig(id);
        if (!config) {
            throw new NotFoundException({
                status: 'error',
                message: `Unknown base template: ${id}`,
            });
        }
        if (!config.customizable) {
            throw new BadRequestException({
                status: 'error',
                message: `Template "${config.name}" is not available for agent customization.`,
            });
        }
        if (!getCustomizationPromptForBaseTemplate(config.id)) {
            throw new BadRequestException({
                status: 'error',
                message: `No customization prompt registered for "${config.name}".`,
            });
        }
        return config;
    }

    private buildRepoName(displayName: string, base: WebsiteTemplateConfig): string {
        const slug =
            displayName
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-+|-+$/g, '')
                .slice(0, 50) || 'tpl';
        const suffix = randomUUID().replace(/-/g, '').slice(0, SUFFIX_LEN);
        const prefix = `tpl-${base.id}-`;
        const maxBody = REPO_NAME_MAX - prefix.length - 1 - suffix.length;
        const body = slug.slice(0, Math.max(1, maxBody));
        return `${prefix}${body}-${suffix}`;
    }

    private async runAsync(id: string): Promise<void> {
        try {
            await this.execute(id);
        } catch (error) {
            this.logger.error(`Customization ${id} crashed: ${this.errorMessage(error)}`);
            await this.markFailed(id, this.errorMessage(error)).catch(() => {});
        }
    }

    private async markFailed(id: string, message: string): Promise<void> {
        await this.customizationRepository.updateById(id, {
            status: TemplateCustomizationStatus.FAILED,
            errorMessage: message,
            completedAt: new Date(),
        });
        this.logger.warn(`Customization ${id} failed: ${message}`);
    }

    private commitMessage(record: TemplateCustomization, summary?: string): string {
        const lines = [
            'chore(template): apply agent UI customization',
            '',
            `User prompt: ${record.prompt.trim()}`,
        ];
        if (summary) lines.push('', `Agent summary: ${summary}`);
        lines.push('', `Template customization: ${record.id}`);
        return lines.join('\n');
    }

    private isTerminal(status: TemplateCustomizationStatus): boolean {
        return (
            status === TemplateCustomizationStatus.SUCCEEDED ||
            status === TemplateCustomizationStatus.FAILED
        );
    }

    private errorMessage(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }
}
