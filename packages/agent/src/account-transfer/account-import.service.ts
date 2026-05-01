import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DirectoryRepository } from '../database/repositories/directory.repository';
import { DirectoryMemberRepository } from '../database/repositories/directory-member.repository';
import { DirectoryCustomDomainRepository } from '../database/repositories/directory-custom-domain.repository';
import { UserPluginRepository } from '../plugins/repositories/user-plugin.repository';
import { DirectoryPluginRepository } from '../plugins/repositories/directory-plugin.repository';
import { PluginRepository } from '../plugins/repositories/plugin.repository';
import { UserRepository } from '../database/repositories/user.repository';
import { DirectoryAdvancedPromptsRepository } from '../database/repositories/directory-advanced-prompts.repository';
import { DirectoryScheduleRepository } from '../database/repositories/directory-schedule.repository';
import { GitFacadeService } from '../facades/git.facade';
import { DataRepository } from '../generators/data-generator/data-repository';
import { Directory } from '../entities/directory.entity';
import { DirectoryMember } from '../entities/directory-member.entity';
import { DirectoryCustomDomain } from '../entities/directory-custom-domain.entity';
import { UserPluginEntity } from '../plugins/entities/user-plugin.entity';
import { DirectoryPluginEntity } from '../plugins/entities/directory-plugin.entity';
import type {
    AccountExportPayload,
    ImportPreview,
    ImportConflict,
    ConflictResolution,
    ImportResult,
    ExportedDirectory,
} from './types';
import { containsMaskedSecrets, MASKED_SECRET_PREFIX } from './types';

@Injectable()
export class AccountImportService {
    private readonly logger = new Logger(AccountImportService.name);

    constructor(
        private readonly dataSource: DataSource,
        private readonly directoryRepository: DirectoryRepository,
        private readonly directoryMemberRepository: DirectoryMemberRepository,
        private readonly directoryCustomDomainRepository: DirectoryCustomDomainRepository,
        private readonly userPluginRepository: UserPluginRepository,
        private readonly directoryPluginRepository: DirectoryPluginRepository,
        private readonly pluginRepository: PluginRepository,
        private readonly userRepository: UserRepository,
        private readonly advancedPromptsRepository: DirectoryAdvancedPromptsRepository,
        private readonly scheduleRepository: DirectoryScheduleRepository,
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
                directoryCount: 0,
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
                directoryCount: 0,
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

        if (!Array.isArray(payload.data?.directories)) {
            errors.push('Missing or invalid directories array');
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
                directoryCount: 0,
                totalItemCount: 0,
                userPluginCount: 0,
                conflicts: [],
                missingPlugins: [],
            };
        }

        // Detect slug conflicts
        const conflicts: ImportConflict[] = [];
        const existingDirectories = await this.directoryRepository.findByUser(userId);
        const existingSlugs = new Map(existingDirectories.map((d) => [d.slug, d.name]));

        for (const dir of payload.data.directories) {
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
        for (const dir of payload.data.directories) {
            for (const dp of dir.directoryPlugins || []) {
                allPluginIds.add(dp.pluginId);
            }
        }

        for (const pluginId of allPluginIds) {
            const exists = await this.pluginRepository.findByPluginId(pluginId);
            if (!exists) {
                missingPlugins.push(pluginId);
            }
        }

        const totalItemCount = payload.data.directories.reduce(
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
            for (const dir of payload.data.directories) {
                for (const dp of dir.directoryPlugins || []) {
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
            directoryCount: payload.data.directories.length,
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
            directoriesCreated: 0,
            directoriesUpdated: 0,
            directoriesSkipped: 0,
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
            // Import directories
            for (const dir of payload.data.directories) {
                try {
                    await this.importDirectory(
                        userId,
                        user,
                        dir,
                        resolutionMap,
                        payload.includesSecrets,
                        result,
                    );
                } catch (error) {
                    result.errors.push(
                        `Failed to import directory "${dir.slug}": ${error instanceof Error ? error.message : String(error)}`,
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
                        autoEnableForDirectories: up.autoEnableForDirectories,
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

    private async importDirectory(
        userId: string,
        user: any,
        dir: ExportedDirectory,
        resolutionMap: Map<string, ConflictResolution>,
        includesSecrets: boolean,
        result: ImportResult,
    ): Promise<void> {
        let slug = dir.slug;
        const existing = await this.directoryRepository.findByOwnerAndSlug({
            userId,
            owner: dir.owner || user.username,
            slug,
        });

        if (existing) {
            const resolution = resolutionMap.get(dir.slug);
            if (!resolution || resolution.strategy === 'skip') {
                result.directoriesSkipped++;
                return;
            }

            if (resolution.strategy === 'rename') {
                slug = resolution.newSlug || `${dir.slug}-imported`;
                // Check the new slug doesn't conflict either
                const newExisting = await this.directoryRepository.existsByUserAndSlug(
                    userId,
                    slug,
                );
                if (newExisting) {
                    result.errors.push(
                        `Cannot rename "${dir.slug}" to "${slug}" - slug already exists`,
                    );
                    result.directoriesSkipped++;
                    return;
                }
            }

            if (resolution.strategy === 'overwrite') {
                // Update existing directory
                await this.directoryRepository.update(existing.id, {
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

                await this.importDirectoryRelations(
                    existing.id,
                    userId,
                    dir,
                    includesSecrets,
                    result,
                );
                await this.importDirectoryRepoData(existing, dir, user, result);
                result.directoriesUpdated++;
                return;
            }
        }

        // Create new directory
        const newDir = await this.directoryRepository.create(
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

        await this.importDirectoryRelations(newDir.id, userId, dir, includesSecrets, result);
        await this.importDirectoryRepoData(newDir, dir, user, result);
        result.directoriesCreated++;
    }

    private async importDirectoryRelations(
        directoryId: string,
        userId: string,
        dir: ExportedDirectory,
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
                const exists = await this.directoryMemberRepository.isMember(
                    directoryId,
                    member.userId,
                );
                if (!exists) {
                    await this.directoryMemberRepository.addMember(
                        directoryId,
                        member.userId,
                        member.role as any,
                    );
                }
            } catch (error) {
                result.warnings.push(
                    `Failed to import member for directory: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }

        // Import custom domains
        for (const cd of dir.customDomains || []) {
            try {
                const existingDomain = await this.directoryCustomDomainRepository.findOne(
                    directoryId,
                    cd.domain,
                );
                if (!existingDomain) {
                    await this.directoryCustomDomainRepository.addDomain(
                        directoryId,
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
                await this.advancedPromptsRepository.createOrUpdate(directoryId, {
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
                    `Failed to import advanced prompts for directory "${dir.slug}": ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }

        // Import schedule
        if (dir.schedule) {
            try {
                await this.scheduleRepository.upsert(directoryId, {
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
                    `Failed to import schedule for directory "${dir.slug}": ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }

        // Import directory plugins
        for (const dp of dir.directoryPlugins || []) {
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
                            `Directory plugin "${dp.pluginId}" has masked secret values. Replace "${MASKED_SECRET_PREFIX}..." values with real credentials in the JSON file and re-import.`,
                        );
                    } else {
                        secretSettings = dp.secretSettings;
                    }
                }

                await this.directoryPluginRepository.upsert({
                    directoryId,
                    pluginId: dp.pluginId,
                    pluginEntityId: pluginEntity.id,
                    enabled: dp.enabled,
                    activeCapabilities: dp.activeCapabilities ?? [],
                    settings: dp.settings || {},
                    secretSettings,
                    priority: dp.priority,
                });
            } catch (error) {
                result.warnings.push(
                    `Failed to import directory plugin "${dp.pluginId}": ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }
    }

    private async importDirectoryRepoData(
        directory: any,
        dir: ExportedDirectory,
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
            const repoOwner = directory.getRepoOwner?.() || dir.owner || user.username;
            const dataRepo = `${directory.slug || dir.slug}-data`;
            const committer = user.asCommitter?.() || { name: user.username, email: user.email };

            const dest = await this.gitFacade.cloneOrPull(
                { owner: repoOwner, repo: dataRepo, committer },
                { userId: user.id || directory.userId, providerId: dir.gitProvider },
            );

            const data = await DataRepository.create(dest);
            await data.ensureDirectoriesExist();

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
                    { userId: user.id || directory.userId, providerId: dir.gitProvider },
                );
            }
        } catch (error) {
            this.logger.warn(
                `Failed to import repo data for directory "${dir.slug}": ${error instanceof Error ? error.message : String(error)}`,
            );
            result.warnings.push(
                `Repo data for directory "${dir.slug}" could not be imported: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }
}
