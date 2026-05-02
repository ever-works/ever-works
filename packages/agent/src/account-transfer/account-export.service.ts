import { Injectable, Logger } from '@nestjs/common';
import { WorkRepository } from '../database/repositories/work.repository';
import { WorkMemberRepository } from '../database/repositories/work-member.repository';
import { WorkCustomDomainRepository } from '../database/repositories/work-custom-domain.repository';
import { UserPluginRepository } from '../plugins/repositories/user-plugin.repository';
import { WorkPluginRepository } from '../plugins/repositories/work-plugin.repository';
import { UserRepository } from '../database/repositories/user.repository';
import { WorkAdvancedPromptsRepository } from '../database/repositories/work-advanced-prompts.repository';
import { WorkScheduleRepository } from '../database/repositories/work-schedule.repository';
import { GitFacadeService } from '../facades/git.facade';
import { DataRepository } from '../generators/data-generator/data-repository';
import type {
    AccountExportPayload,
    ExportedWork,
    ExportedAdvancedPrompts,
    ExportedSchedule,
    ExportedComparison,
    ExportedMarkdownTemplate,
    ExportedWorkItem,
    ExportedWorkCategory,
    ExportedWorkTag,
    ExportedWorkCollection,
    ExportedUserPlugin,
    ExportOptions,
} from './types';
import { maskSecretSettings } from './types';
import { getActiveCapabilities } from '../plugins/utils/active-capabilities.util';

@Injectable()
export class AccountExportService {
    private readonly logger = new Logger(AccountExportService.name);

    constructor(
        private readonly workRepository: WorkRepository,
        private readonly workMemberRepository: WorkMemberRepository,
        private readonly workCustomDomainRepository: WorkCustomDomainRepository,
        private readonly userPluginRepository: UserPluginRepository,
        private readonly workPluginRepository: WorkPluginRepository,
        private readonly userRepository: UserRepository,
        private readonly advancedPromptsRepository: WorkAdvancedPromptsRepository,
        private readonly scheduleRepository: WorkScheduleRepository,
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

        const works = await this.workRepository.findByUser(userId);

        const exportedWorks: ExportedWork[] = await Promise.all(
            works.map((dir) => this.exportWork(dir.id, dir, includeSecrets)),
        );

        const userPlugins = await this.userPluginRepository.findByUser(userId);
        const exportedUserPlugins: ExportedUserPlugin[] = userPlugins.map((up) => {
            const exported: ExportedUserPlugin = {
                pluginId: up.pluginId,
                enabled: up.enabled,
                autoEnableForWorks: up.autoEnableForWorks,
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
                works: exportedWorks,
                userPlugins: exportedUserPlugins,
            },
        };
    }

    private async exportWork(
        workId: string,
        dir: any,
        includeSecrets: boolean,
    ): Promise<ExportedWork> {
        const [members, customDomains, workPlugins, prompts, scheduleEntity] = await Promise.all([
            this.workMemberRepository.findByWork(workId),
            this.workCustomDomainRepository.findByWork(workId),
            this.workPluginRepository.findByWork(workId),
            this.advancedPromptsRepository.findByWorkId(workId),
            this.scheduleRepository.findByWorkId(workId),
        ]);

        // Fetch items, config, comparisons, and markdown template from the data repo
        const repoData = await this.fetchWorkRepoData(dir);

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
            workPlugins: workPlugins.map((dp) => {
                const exported: any = {
                    pluginId: dp.pluginId,
                    enabled: dp.enabled,
                    activeCapabilities: getActiveCapabilities(dp),
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

    private async fetchWorkRepoData(dir: any): Promise<{
        items: ExportedWorkItem[];
        categories: ExportedWorkCategory[];
        tags: ExportedWorkTag[];
        collections: ExportedWorkCollection[];
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
                items: items as ExportedWorkItem[],
                categories: categories as ExportedWorkCategory[],
                tags: tags as ExportedWorkTag[],
                collections: collections as ExportedWorkCollection[],
                siteConfig: siteConfig || undefined,
                comparisons: exportedComparisons,
                markdownTemplate:
                    mdTemplate && (mdTemplate.header || mdTemplate.footer) ? mdTemplate : undefined,
            };
        } catch (error) {
            this.logger.warn(
                `Failed to fetch repo data for work "${dir.slug}": ${error instanceof Error ? error.message : String(error)}`,
            );
            return empty;
        }
    }
}
