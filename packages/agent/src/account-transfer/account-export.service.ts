import { Injectable, Logger } from '@nestjs/common';
import { DirectoryRepository } from '../database/repositories/directory.repository';
import { DirectoryMemberRepository } from '../database/repositories/directory-member.repository';
import { DirectoryCustomDomainRepository } from '../database/repositories/directory-custom-domain.repository';
import { UserPluginRepository } from '../plugins/repositories/user-plugin.repository';
import { DirectoryPluginRepository } from '../plugins/repositories/directory-plugin.repository';
import { UserRepository } from '../database/repositories/user.repository';
import { DirectoryAdvancedPromptsRepository } from '../database/repositories/directory-advanced-prompts.repository';
import { DirectoryScheduleRepository } from '../database/repositories/directory-schedule.repository';
import { GitFacadeService } from '../facades/git.facade';
import { DataRepository } from '../generators/data-generator/data-repository';
import type {
    AccountExportPayload,
    ExportedDirectory,
    ExportedAdvancedPrompts,
    ExportedSchedule,
    ExportedComparison,
    ExportedMarkdownTemplate,
    ExportedDirectoryItem,
    ExportedDirectoryCategory,
    ExportedDirectoryTag,
    ExportedDirectoryCollection,
    ExportedUserPlugin,
    ExportOptions,
} from './types';
import { maskSecretSettings } from './types';

@Injectable()
export class AccountExportService {
    private readonly logger = new Logger(AccountExportService.name);

    constructor(
        private readonly directoryRepository: DirectoryRepository,
        private readonly directoryMemberRepository: DirectoryMemberRepository,
        private readonly directoryCustomDomainRepository: DirectoryCustomDomainRepository,
        private readonly userPluginRepository: UserPluginRepository,
        private readonly directoryPluginRepository: DirectoryPluginRepository,
        private readonly userRepository: UserRepository,
        private readonly advancedPromptsRepository: DirectoryAdvancedPromptsRepository,
        private readonly scheduleRepository: DirectoryScheduleRepository,
        private readonly gitFacade: GitFacadeService,
    ) {}

    async exportAccountData(
        userId: string,
        options: ExportOptions = {},
    ): Promise<AccountExportPayload> {
        const { includeSecrets = false } = options;

        const user = await this.userRepository.findById(userId);
        if (!user) {
            throw new Error('User not found');
        }

        const directories = await this.directoryRepository.findByUser(userId);

        const exportedDirectories: ExportedDirectory[] = await Promise.all(
            directories.map((dir) => this.exportDirectory(dir.id, dir, includeSecrets)),
        );

        const userPlugins = await this.userPluginRepository.findByUser(userId);
        const exportedUserPlugins: ExportedUserPlugin[] = userPlugins.map((up) => {
            const exported: ExportedUserPlugin = {
                pluginId: up.pluginId,
                enabled: up.enabled,
                autoEnableForDirectories: up.autoEnableForDirectories,
                settings: up.settings || {},
            };
            if (includeSecrets && up.secretSettings) {
                // Never export real secrets — only masked representations
                exported.secretSettings = maskSecretSettings(up.secretSettings);
            }
            return exported;
        });

        return {
            version: 1,
            exportedAt: new Date().toISOString(),
            includesSecrets: includeSecrets,
            data: {
                profile: {
                    username: user.username,
                    email: user.email,
                    avatar: user.avatar || undefined,
                },
                directories: exportedDirectories,
                userPlugins: exportedUserPlugins,
            },
        };
    }

    private async exportDirectory(
        directoryId: string,
        dir: any,
        includeSecrets: boolean,
    ): Promise<ExportedDirectory> {
        const [members, customDomains, directoryPlugins, prompts, scheduleEntity] =
            await Promise.all([
                this.directoryMemberRepository.findByDirectory(directoryId),
                this.directoryCustomDomainRepository.findByDirectory(directoryId),
                this.directoryPluginRepository.findByDirectory(directoryId),
                this.advancedPromptsRepository.findByDirectoryId(directoryId),
                this.scheduleRepository.findByDirectoryId(directoryId),
            ]);

        // Fetch items, config, comparisons, and markdown template from the data repo
        const repoData = await this.fetchDirectoryRepoData(dir);

        // Build schedule if configured
        let schedule: ExportedSchedule | undefined;
        if (scheduleEntity) {
            schedule = {
                cadence: scheduleEntity.cadence,
                status: scheduleEntity.status,
                billingMode: scheduleEntity.billingMode,
                alwaysCreatePullRequest: scheduleEntity.alwaysCreatePullRequest,
                maxFailureBeforePause: scheduleEntity.maxFailureBeforePause,
                providerOverrides: scheduleEntity.providerOverrides || undefined,
            };
        }

        // Build advanced prompts if any are set
        let advancedPrompts: ExportedAdvancedPrompts | undefined;
        if (prompts) {
            const p: ExportedAdvancedPrompts = {};
            if (prompts.relevanceAssessment) p.relevanceAssessment = prompts.relevanceAssessment;
            if (prompts.itemGeneration) p.itemGeneration = prompts.itemGeneration;
            if (prompts.itemExtraction) p.itemExtraction = prompts.itemExtraction;
            if (prompts.searchQuery) p.searchQuery = prompts.searchQuery;
            if (prompts.categorization) p.categorization = prompts.categorization;
            if (prompts.deduplication) p.deduplication = prompts.deduplication;
            if (prompts.sourceValidation) p.sourceValidation = prompts.sourceValidation;
            if (Object.keys(p).length > 0) advancedPrompts = p;
        }

        return {
            name: dir.name,
            slug: dir.slug,
            description: dir.description,
            owner: dir.owner || undefined,
            gitProvider: dir.gitProvider,
            deployProvider: dir.deployProvider || undefined,
            readmeConfig: dir.readmeConfig || undefined,
            domainType: dir.domainType || undefined,
            repoVisibility: dir.repoVisibility || undefined,
            scheduledUpdatesEnabled: dir.scheduledUpdatesEnabled,
            scheduledCadence: dir.scheduledCadence || null,
            communityPrEnabled: dir.communityPrEnabled,
            communityPrAutoClose: dir.communityPrAutoClose,
            comparisonsEnabled: dir.comparisonsEnabled,
            members: members.map((m) => ({
                userId: m.userId,
                role: m.role,
            })),
            customDomains: customDomains.map((cd) => ({
                domain: cd.domain,
                environment: cd.environment,
                verified: cd.verified,
                provider: cd.provider || undefined,
            })),
            directoryPlugins: directoryPlugins.map((dp) => {
                const exported: any = {
                    pluginId: dp.pluginId,
                    enabled: dp.enabled,
                    activeCapability: dp.activeCapability || undefined,
                    settings: dp.settings || {},
                    priority: dp.priority,
                };
                if (includeSecrets && dp.secretSettings) {
                    // Never export real secrets — only masked representations
                    exported.secretSettings = maskSecretSettings(dp.secretSettings);
                }
                return exported;
            }),
            advancedPrompts,
            schedule,
            siteConfig: repoData.siteConfig,
            markdownTemplate: repoData.markdownTemplate,
            items: repoData.items,
            categories: repoData.categories,
            tags: repoData.tags,
            collections: repoData.collections,
            comparisons: repoData.comparisons,
        };
    }

    private async fetchDirectoryRepoData(dir: any): Promise<{
        items: ExportedDirectoryItem[];
        categories: ExportedDirectoryCategory[];
        tags: ExportedDirectoryTag[];
        collections: ExportedDirectoryCollection[];
        siteConfig?: Record<string, any>;
        comparisons: ExportedComparison[];
        markdownTemplate?: ExportedMarkdownTemplate;
    }> {
        const empty = {
            items: [],
            categories: [],
            tags: [],
            collections: [],
            siteConfig: undefined,
            comparisons: [],
            markdownTemplate: undefined,
        };

        try {
            const repoOwner = dir.getRepoOwner();
            const dataRepo = dir.getDataRepo();
            const userId = dir.user?.id || dir.userId;

            const dest = await this.gitFacade.cloneOrPull(
                { owner: repoOwner, repo: dataRepo },
                { userId, providerId: dir.gitProvider },
            );

            const data = await DataRepository.create(dest);

            const [items, categories, tags, collections, siteConfig, comparisons, mdTemplate] =
                await Promise.all([
                    data.getItems().catch(() => []),
                    data.getCategories().catch(() => []),
                    data.getTags().catch(() => []),
                    data.getCollections().catch(() => []),
                    data.getConfig().catch(() => null),
                    data.getComparisons().catch(() => []),
                    data.readMarkdownTemplate().catch(() => null),
                ]);

            // Build comparisons with markdown
            const exportedComparisons: ExportedComparison[] = [];
            for (const comp of comparisons) {
                const md = await data.getComparisonMarkdown(comp.slug).catch(() => undefined);
                exportedComparisons.push({ ...comp, markdown: md } as ExportedComparison);
            }

            return {
                items: items as ExportedDirectoryItem[],
                categories: categories as ExportedDirectoryCategory[],
                tags: tags as ExportedDirectoryTag[],
                collections: collections as ExportedDirectoryCollection[],
                siteConfig: siteConfig || undefined,
                comparisons: exportedComparisons,
                markdownTemplate:
                    mdTemplate && (mdTemplate.header || mdTemplate.footer) ? mdTemplate : undefined,
            };
        } catch (error) {
            this.logger.warn(
                `Failed to fetch repo data for directory "${dir.slug}": ${error instanceof Error ? error.message : String(error)}`,
            );
            return empty;
        }
    }
}
