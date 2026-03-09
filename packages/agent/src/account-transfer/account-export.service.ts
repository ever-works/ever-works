import { Injectable } from '@nestjs/common';
import { DirectoryRepository } from '../database/repositories/directory.repository';
import { DirectoryMemberRepository } from '../database/repositories/directory-member.repository';
import { DirectoryCustomDomainRepository } from '../database/repositories/directory-custom-domain.repository';
import { UserPluginRepository } from '../plugins/repositories/user-plugin.repository';
import { DirectoryPluginRepository } from '../plugins/repositories/directory-plugin.repository';
import { UserRepository } from '../database/repositories/user.repository';
import type {
    AccountExportPayload,
    ExportedDirectory,
    ExportedUserPlugin,
    ExportOptions,
} from './types';

@Injectable()
export class AccountExportService {
    constructor(
        private readonly directoryRepository: DirectoryRepository,
        private readonly directoryMemberRepository: DirectoryMemberRepository,
        private readonly directoryCustomDomainRepository: DirectoryCustomDomainRepository,
        private readonly userPluginRepository: UserPluginRepository,
        private readonly directoryPluginRepository: DirectoryPluginRepository,
        private readonly userRepository: UserRepository,
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
                exported.secretSettings = up.secretSettings;
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
        const [members, customDomains, directoryPlugins] = await Promise.all([
            this.directoryMemberRepository.findByDirectory(directoryId),
            this.directoryCustomDomainRepository.findByDirectory(directoryId),
            this.directoryPluginRepository.findByDirectory(directoryId),
        ]);

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
                    exported.secretSettings = dp.secretSettings;
                }
                return exported;
            }),
        };
    }
}
