import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DirectoryRepository } from '../database/repositories/directory.repository';
import { DirectoryMemberRepository } from '../database/repositories/directory-member.repository';
import { DirectoryCustomDomainRepository } from '../database/repositories/directory-custom-domain.repository';
import { UserPluginRepository } from '../plugins/repositories/user-plugin.repository';
import { DirectoryPluginRepository } from '../plugins/repositories/directory-plugin.repository';
import { PluginRepository } from '../plugins/repositories/plugin.repository';
import { UserRepository } from '../database/repositories/user.repository';
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

@Injectable()
export class AccountImportService {
    constructor(
        private readonly dataSource: DataSource,
        private readonly directoryRepository: DirectoryRepository,
        private readonly directoryMemberRepository: DirectoryMemberRepository,
        private readonly directoryCustomDomainRepository: DirectoryCustomDomainRepository,
        private readonly userPluginRepository: UserPluginRepository,
        private readonly directoryPluginRepository: DirectoryPluginRepository,
        private readonly pluginRepository: PluginRepository,
        private readonly userRepository: UserRepository,
    ) {}

    async previewImport(userId: string, payload: AccountExportPayload): Promise<ImportPreview> {
        const errors: string[] = [];

        if (!payload || typeof payload !== 'object') {
            return {
                valid: false,
                errors: ['Invalid payload: expected a JSON object'],
                version: 0,
                includesSecrets: false,
                profile: { username: '', email: '' },
                directoryCount: 0,
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
                profile: { username: '', email: '' },
                directoryCount: 0,
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
                profile: payload.data?.profile || { username: '', email: '' },
                directoryCount: 0,
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

        return {
            valid: true,
            errors: [],
            version: payload.version,
            includesSecrets: payload.includesSecrets || false,
            profile: payload.data.profile,
            directoryCount: payload.data.directories.length,
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
                    await this.importDirectory(userId, user, dir, resolutionMap, result);
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
                        data.secretSettings = up.secretSettings;
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

                await this.importDirectoryRelations(existing.id, dir, result);
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

        await this.importDirectoryRelations(newDir.id, dir, result);
        result.directoriesCreated++;
    }

    private async importDirectoryRelations(
        directoryId: string,
        dir: ExportedDirectory,
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

                await this.directoryPluginRepository.upsert({
                    directoryId,
                    pluginId: dp.pluginId,
                    pluginEntityId: pluginEntity.id,
                    enabled: dp.enabled,
                    activeCapability: dp.activeCapability || null,
                    settings: dp.settings || {},
                    secretSettings: dp.secretSettings || {},
                    priority: dp.priority,
                });
            } catch (error) {
                result.warnings.push(
                    `Failed to import directory plugin "${dp.pluginId}": ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }
    }
}
