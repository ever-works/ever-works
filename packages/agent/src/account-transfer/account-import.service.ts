import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { WorkRepository } from '../database/repositories/work.repository';
import { WorkMemberRepository } from '../database/repositories/work-member.repository';
import { WorkCustomDomainRepository } from '../database/repositories/work-custom-domain.repository';
import { UserPluginRepository } from '../plugins/repositories/user-plugin.repository';
import { WorkPluginRepository } from '../plugins/repositories/work-plugin.repository';
import { PluginRepository } from '../plugins/repositories/plugin.repository';
import { UserRepository } from '../database/repositories/user.repository';
import { WorkAdvancedPromptsRepository } from '../database/repositories/work-advanced-prompts.repository';
import { WorkScheduleRepository } from '../database/repositories/work-schedule.repository';
import { GitFacadeService } from '../facades/git.facade';
import { DataRepository } from '../generators/data-generator/data-repository';
import { Work } from '../entities/work.entity';
import { WorkMember } from '../entities/work-member.entity';
import { WorkCustomDomain } from '../entities/work-custom-domain.entity';
import { UserPluginEntity } from '../plugins/entities/user-plugin.entity';
import { WorkPluginEntity } from '../plugins/entities/work-plugin.entity';
import type {
    AccountExportPayload,
    ImportPreview,
    ImportConflict,
    ConflictResolution,
    ImportResult,
    ExportedWork,
} from './types';
import { containsMaskedSecrets, MASKED_SECRET_PREFIX } from './types';

@Injectable()
export class AccountImportService {
    private readonly logger = new Logger(AccountImportService.name);

    constructor(
        private readonly dataSource: DataSource,
        private readonly workRepository: WorkRepository,
        private readonly workMemberRepository: WorkMemberRepository,
        private readonly workCustomDomainRepository: WorkCustomDomainRepository,
        private readonly userPluginRepository: UserPluginRepository,
        private readonly workPluginRepository: WorkPluginRepository,
        private readonly pluginRepository: PluginRepository,
        private readonly userRepository: UserRepository,
        private readonly advancedPromptsRepository: WorkAdvancedPromptsRepository,
        private readonly scheduleRepository: WorkScheduleRepository,
        private readonly gitFacade: GitFacadeService,
    ) {}

    async previewImport(userId: string, payload: AccountExportPayload): Promise<ImportPreview> {
        const errors: string[] = [];

        if (!payload || typeof payload !== 'object') {
            return {
                valid: false,
                errors: ['Invalid payload: expected a JSON object'],
                version: 0,
                includesSecrets: false,
                hasMaskedSecrets: false,
                profile: { username: '', email: '' },
                workCount: 0,
                totalItemCount: 0,
                userPluginCount: 0,
                conflicts: [],
                missingPlugins: [],
            };
        }

        if (payload.version !== 1) {
            return {
                valid: false,
                errors: [
                    `Unsupported export version: ${payload.version}. Only version 1 is supported.`,
                ],
                version: payload.version || 0,
                includesSecrets: false,
                hasMaskedSecrets: false,
                profile: { username: '', email: '' },
                workCount: 0,
                totalItemCount: 0,
                userPluginCount: 0,
                conflicts: [],
                missingPlugins: [],
            };
        }

        if (!payload.data) {
            errors.push('Missing data field in payload');
        }

        if (!payload.data?.profile) {
            errors.push('Missing profile data');
        }

        if (!Array.isArray(payload.data?.works)) {
            errors.push('Missing or invalid works array');
        }

        if (!Array.isArray(payload.data?.userPlugins)) {
            errors.push('Missing or invalid userPlugins array');
        }

        if (errors.length > 0) {
            return {
                valid: false,
                errors,
                version: payload.version,
                includesSecrets: payload.includesSecrets || false,
                hasMaskedSecrets: false,
                profile: payload.data?.profile || { username: '', email: '' },
                workCount: 0,
                totalItemCount: 0,
                userPluginCount: 0,
                conflicts: [],
                missingPlugins: [],
            };
        }

        // Detect slug conflicts
        const conflicts: ImportConflict[] = [];
        const existingWorks = await this.workRepository.findByUser(userId);
        const existingSlugs = new Map(existingWorks.map((d) => [d.slug, d.name]));

        for (const dir of payload.data.works) {
            if (existingSlugs.has(dir.slug)) {
                conflicts.push({
                    slug: dir.slug,
                    existingName: existingSlugs.get(dir.slug)!,
                    incomingName: dir.name,
                });
            }
        }

        // Check for missing plugins
        const missingPlugins: string[] = [];
        const allPluginIds = new Set<string>();

        for (const up of payload.data.userPlugins) {
            allPluginIds.add(up.pluginId);
        }
        for (const dir of payload.data.works) {
            for (const dp of dir.workPlugins || []) {
                allPluginIds.add(dp.pluginId);
            }
        }

        for (const pluginId of allPluginIds) {
            const exists = await this.pluginRepository.findByPluginId(pluginId);
            if (!exists) {
                missingPlugins.push(pluginId);
            }
        }

        const totalItemCount = payload.data.works.reduce(
            (sum, d) => sum + (d.items?.length || 0),
            0,
        );

        // Detect masked secret values in the payload
        let hasMaskedSecrets = false;
        for (const up of payload.data.userPlugins) {
            if (containsMaskedSecrets(up.secretSettings)) {
                hasMaskedSecrets = true;
                break;
            }
        }
        if (!hasMaskedSecrets) {
            for (const dir of payload.data.works) {
                for (const dp of dir.workPlugins || []) {
                    if (containsMaskedSecrets(dp.secretSettings)) {
                        hasMaskedSecrets = true;
                        break;
                    }
                }
                if (hasMaskedSecrets) break;
            }
        }

        return {
            valid: true,
            errors: [],
            version: payload.version,
            includesSecrets: payload.includesSecrets || false,
            hasMaskedSecrets,
            profile: payload.data.profile,
            workCount: payload.data.works.length,
            totalItemCount,
            userPluginCount: payload.data.userPlugins.length,
            conflicts,
            missingPlugins,
        };
    }

    async applyImport(
        userId: string,
        payload: AccountExportPayload,
        resolutions: ConflictResolution[],
    ): Promise<ImportResult> {
        const result: ImportResult = {
            success: true,
            worksCreated: 0,
            worksUpdated: 0,
            worksSkipped: 0,
            userPluginsImported: 0,
            errors: [],
            warnings: [],
        };

        const user = await this.userRepository.findById(userId);
        if (!user) {
            result.success = false;
            result.errors.push('User not found');
            return result;
        }

        const resolutionMap = new Map(resolutions.map((r) => [r.slug, r]));

        const queryRunner = this.dataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();

        try {
            // Import works
            for (const dir of payload.data.works) {
                try {
                    await this.importWork(
                        userId,
                        user,
                        dir,
                        resolutionMap,
                        payload.includesSecrets,
                        result,
                    );
                } catch (error) {
                    result.errors.push(
                        `Failed to import work "${dir.slug}": ${error instanceof Error ? error.message : String(error)}`,
                    );
                }
            }

            // Import user plugins
            for (const up of payload.data.userPlugins) {
                try {
                    const pluginEntity = await this.pluginRepository.findByPluginId(up.pluginId);
                    if (!pluginEntity) {
                        result.warnings.push(
                            `Plugin "${up.pluginId}" is not installed on this instance, skipping`,
                        );
                        continue;
                    }

                    const data: Partial<UserPluginEntity> & { userId: string; pluginId: string } = {
                        userId,
                        pluginId: up.pluginId,
                        pluginEntityId: pluginEntity.id,
                        enabled: up.enabled,
                        autoEnableForWorks: up.autoEnableForWorks,
                        settings: up.settings || {},
                    };
                    if (payload.includesSecrets && up.secretSettings) {
                        // Skip masked secret values — they are placeholders, not real credentials
                        if (containsMaskedSecrets(up.secretSettings)) {
                            result.warnings.push(
                                `Plugin "${up.pluginId}" has masked secret values. Replace "${MASKED_SECRET_PREFIX}..." values with real credentials in the JSON file and re-import.`,
                            );
                        } else {
                            data.secretSettings = up.secretSettings;
                        }
                    }

                    await this.userPluginRepository.upsert(data);
                    result.userPluginsImported++;
                } catch (error) {
                    result.errors.push(
                        `Failed to import user plugin "${up.pluginId}": ${error instanceof Error ? error.message : String(error)}`,
                    );
                }
            }

            await queryRunner.commitTransaction();
        } catch (error) {
            await queryRunner.rollbackTransaction();
            result.success = false;
            result.errors.push(
                `Transaction failed: ${error instanceof Error ? error.message : String(error)}`,
            );
        } finally {
            await queryRunner.release();
        }

        return result;
    }

    private async importWork(
        userId: string,
        user: any,
        dir: ExportedWork,
        resolutionMap: Map<string, ConflictResolution>,
        includesSecrets: boolean,
        result: ImportResult,
    ): Promise<void> {
        let slug = dir.slug;
        const existing = await this.workRepository.findByOwnerAndSlug({
            userId,
            owner: dir.owner || user.username,
            slug,
        });

        if (existing) {
            const resolution = resolutionMap.get(dir.slug);
            if (!resolution || resolution.strategy === 'skip') {
                result.worksSkipped++;
                return;
            }

            if (resolution.strategy === 'rename') {
                slug = resolution.newSlug || `${dir.slug}-imported`;
                // Check the new slug doesn't conflict either
                const newExisting = await this.workRepository.existsByUserAndSlug(
                    userId,
                    slug,
                );
                if (newExisting) {
                    result.errors.push(
                        `Cannot rename "${dir.slug}" to "${slug}" - slug already exists`,
                    );
                    result.worksSkipped++;
                    return;
                }
            }

            if (resolution.strategy === 'overwrite') {
                // Update existing work
                await this.workRepository.update(existing.id, {
                    name: dir.name,
                    description: dir.description,
                    gitProvider: dir.gitProvider,
                    deployProvider: dir.deployProvider,
                    readmeConfig: dir.readmeConfig,
                    domainType: dir.domainType,
                    repoVisibility: dir.repoVisibility,
                    scheduledUpdatesEnabled: dir.scheduledUpdatesEnabled,
                    scheduledCadence: dir.scheduledCadence as any,
                    communityPrEnabled: dir.communityPrEnabled,
                    communityPrAutoClose: dir.communityPrAutoClose,
                    comparisonsEnabled: dir.comparisonsEnabled,
                });

                await this.importWorkRelations(
                    existing.id,
                    userId,
                    dir,
                    includesSecrets,
                    result,
                );
                await this.importWorkRepoData(existing, dir, user, result);
                result.worksUpdated++;
                return;
            }
        }

        // Create new work
        const newDir = await this.workRepository.create(
            {
                name: dir.name,
                slug,
                description: dir.description,
                owner: dir.owner || user.username,
                userId,
                gitProvider: dir.gitProvider,
                deployProvider: dir.deployProvider,
                readmeConfig: dir.readmeConfig,
                domainType: dir.domainType,
                repoVisibility: dir.repoVisibility,
                scheduledUpdatesEnabled: dir.scheduledUpdatesEnabled,
                scheduledCadence: dir.scheduledCadence as any,
                communityPrEnabled: dir.communityPrEnabled,
                communityPrAutoClose: dir.communityPrAutoClose,
                comparisonsEnabled: dir.comparisonsEnabled,
            },
            user,
        );

        await this.importWorkRelations(newDir.id, userId, dir, includesSecrets, result);
        await this.importWorkRepoData(newDir, dir, user, result);
        result.worksCreated++;
    }

    private async importWorkRelations(
        workId: string,
        userId: string,
        dir: ExportedWork,
        includesSecrets: boolean,
        result: ImportResult,
    ): Promise<void> {
        // Import members
        for (const member of dir.members || []) {
            try {
                const memberUser = await this.userRepository.findById(member.userId);
                if (!memberUser) {
                    result.warnings.push(
                        `Member user "${member.userId}" not found on this instance, skipping`,
                    );
                    continue;
                }
                const exists = await this.workMemberRepository.isMember(
                    workId,
                    member.userId,
                );
                if (!exists) {
                    await this.workMemberRepository.addMember(
                        workId,
                        member.userId,
                        member.role as any,
                    );
                }
            } catch (error) {
                result.warnings.push(
                    `Failed to import member for work: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }

        // Import custom domains
        for (const cd of dir.customDomains || []) {
            try {
                const existingDomain = await this.workCustomDomainRepository.findOne(
                    workId,
                    cd.domain,
                );
                if (!existingDomain) {
                    await this.workCustomDomainRepository.addDomain(
                        workId,
                        cd.domain,
                        cd.provider,
                    );
                }
            } catch (error) {
                result.warnings.push(
                    `Failed to import custom domain "${cd.domain}": ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }

        // Import advanced prompts
        if (dir.advancedPrompts && Object.keys(dir.advancedPrompts).length > 0) {
            try {
                await this.advancedPromptsRepository.createOrUpdate(workId, {
                    relevanceAssessment: dir.advancedPrompts.relevanceAssessment,
                    itemGeneration: dir.advancedPrompts.itemGeneration,
                    itemExtraction: dir.advancedPrompts.itemExtraction,
                    searchQuery: dir.advancedPrompts.searchQuery,
                    categorization: dir.advancedPrompts.categorization,
                    deduplication: dir.advancedPrompts.deduplication,
                    sourceValidation: dir.advancedPrompts.sourceValidation,
                });
            } catch (error) {
                result.warnings.push(
                    `Failed to import advanced prompts for work "${dir.slug}": ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }

        // Import schedule
        if (dir.schedule) {
            try {
                await this.scheduleRepository.upsert(workId, {
                    userId,
                    cadence: dir.schedule.cadence as any,
                    status: dir.schedule.status as any,
                    billingMode: dir.schedule.billingMode as any,
                    alwaysCreatePullRequest: dir.schedule.alwaysCreatePullRequest,
                    maxFailureBeforePause: dir.schedule.maxFailureBeforePause,
                    providerOverrides: dir.schedule.providerOverrides || null,
                });
            } catch (error) {
                result.warnings.push(
                    `Failed to import schedule for work "${dir.slug}": ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }

        // Import work plugins
        for (const dp of dir.workPlugins || []) {
            try {
                const pluginEntity = await this.pluginRepository.findByPluginId(dp.pluginId);
                if (!pluginEntity) {
                    result.warnings.push(
                        `Plugin "${dp.pluginId}" is not installed on this instance, skipping`,
                    );
                    continue;
                }

                // Determine secret settings: skip masked values, use real values only
                let secretSettings: Record<string, unknown> = {};
                if (includesSecrets && dp.secretSettings) {
                    if (containsMaskedSecrets(dp.secretSettings)) {
                        result.warnings.push(
                            `Work plugin "${dp.pluginId}" has masked secret values. Replace "${MASKED_SECRET_PREFIX}..." values with real credentials in the JSON file and re-import.`,
                        );
                    } else {
                        secretSettings = dp.secretSettings;
                    }
                }

                await this.workPluginRepository.upsert({
                    workId,
                    pluginId: dp.pluginId,
                    pluginEntityId: pluginEntity.id,
                    enabled: dp.enabled,
                    activeCapabilities:
                        dp.activeCapabilities ?? (dp.activeCapability ? [dp.activeCapability] : []),
                    settings: dp.settings || {},
                    secretSettings,
                    priority: dp.priority,
                });
            } catch (error) {
                result.warnings.push(
                    `Failed to import work plugin "${dp.pluginId}": ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }
    }

    private async importWorkRepoData(
        work: any,
        dir: ExportedWork,
        user: any,
        result: ImportResult,
    ): Promise<void> {
        const hasItems = dir.items && dir.items.length > 0;
        const hasComparisons = dir.comparisons && dir.comparisons.length > 0;
        const hasSiteConfig = dir.siteConfig && Object.keys(dir.siteConfig).length > 0;
        const hasMarkdownTemplate =
            dir.markdownTemplate && (dir.markdownTemplate.header || dir.markdownTemplate.footer);

        if (!hasItems && !hasComparisons && !hasSiteConfig && !hasMarkdownTemplate) {
            return;
        }

        try {
            const repoOwner = work.getRepoOwner?.() || dir.owner || user.username;
            const dataRepo = `${work.slug || dir.slug}-data`;
            const committer = user.asCommitter?.() || { name: user.username, email: user.email };

            const dest = await this.gitFacade.cloneOrPull(
                { owner: repoOwner, repo: dataRepo, committer },
                { userId: user.id || work.userId, providerId: dir.gitProvider },
            );

            const data = await DataRepository.create(dest);
            await data.ensureWorksExist();

            // Write site config
            if (hasSiteConfig) {
                await data.writeConfig(dir.siteConfig as any);
            }

            // Write markdown template
            if (hasMarkdownTemplate) {
                await data.writeMarkdownTemplate(
                    dir.markdownTemplate!.header || '',
                    dir.markdownTemplate!.footer || '',
                );
            }

            // Write categories, tags, collections
            if (dir.categories && dir.categories.length > 0) {
                await data.writeCategories(dir.categories as any);
            }
            if (dir.tags && dir.tags.length > 0) {
                await data.writeTags(dir.tags as any);
            }
            if (dir.collections && dir.collections.length > 0) {
                await data.writeCollections(dir.collections as any);
            }

            // Write items
            if (hasItems) {
                for (const item of dir.items!) {
                    const { markdown, ...itemData } = item;
                    await data.writeItem(itemData as any);
                    if (markdown) {
                        await data.writeItemMarkdown(item as any, markdown);
                    }
                }
            }

            // Write comparisons
            if (hasComparisons) {
                for (const comp of dir.comparisons!) {
                    const { markdown, ...compData } = comp;
                    await data.writeComparison(compData as any);
                    if (markdown) {
                        await data.writeComparisonMarkdown(comp.slug, markdown);
                    }
                }
            }

            // Stage, commit, push
            await this.gitFacade.addAll(dir.gitProvider, dest);
            const status = await this.gitFacade.getStatus(dir.gitProvider, dest);
            if (status.length > 0) {
                const parts: string[] = [];
                if (hasItems) parts.push(`${dir.items!.length} items`);
                if (hasComparisons) parts.push(`${dir.comparisons!.length} comparisons`);
                if (hasSiteConfig) parts.push('site config');
                if (hasMarkdownTemplate) parts.push('markdown template');

                await this.gitFacade.commit(
                    dir.gitProvider,
                    dest,
                    `import: restore ${parts.join(', ')} from account export`,
                    committer,
                );
                await this.gitFacade.push(
                    { dir: dest },
                    { userId: user.id || work.userId, providerId: dir.gitProvider },
                );
            }
        } catch (error) {
            this.logger.warn(
                `Failed to import repo data for work "${dir.slug}": ${error instanceof Error ? error.message : String(error)}`,
            );
            result.warnings.push(
                `Repo data for work "${dir.slug}" could not be imported: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }
}
