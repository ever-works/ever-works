import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { GitFacadeService } from '../facades/git.facade';
import { OAuthTokenRepository } from '../database/repositories/oauth-token.repository';
import { UserRepository } from '../database/repositories/user.repository';
import { UserSyncConfigRepository } from './repositories/user-sync-config.repository';
import { AccountExportService } from './account-export.service';
import { AccountImportService } from './account-import.service';
import type {
    SyncStatus,
    ConfigureSyncDto,
    SyncPushOptions,
    AccountExportPayload,
    ImportPreview,
    ConflictResolution,
    ImportResult,
} from './types';

const SYNC_REPO_NAME = 'ever-works-config';
const PROVIDER_ID = 'github';

@Injectable()
export class GitHubSyncService {
    private readonly logger = new Logger(GitHubSyncService.name);

    constructor(
        private readonly gitFacade: GitFacadeService,
        private readonly oauthTokenRepository: OAuthTokenRepository,
        private readonly userRepository: UserRepository,
        private readonly syncConfigRepository: UserSyncConfigRepository,
        private readonly exportService: AccountExportService,
        private readonly importService: AccountImportService,
    ) {}

    async getSyncStatus(userId: string): Promise<SyncStatus> {
        const hasOAuth = await this.hasGitHubOAuth(userId);
        const config = await this.syncConfigRepository.findByUser(userId);

        if (!config) {
            return { configured: false, hasOAuth };
        }

        return {
            configured: true,
            hasOAuth,
            repoOwner: config.repoOwner,
            repoName: config.repoName,
            lastPushAt: config.lastPushAt?.toISOString(),
            lastPullAt: config.lastPullAt?.toISOString(),
            lastSyncError: config.lastSyncError || undefined,
        };
    }

    async configureSyncRepo(userId: string, dto: ConfigureSyncDto): Promise<SyncStatus> {
        await this.ensureGitHubOAuth(userId);
        const gitOptions = { providerId: PROVIDER_ID, userId };

        let repoOwner: string;
        let repoName: string;

        if (dto.createNew) {
            // Get GitHub user info to determine owner
            const gitUser = await this.gitFacade.getUser(gitOptions);
            repoOwner = gitUser.login;
            repoName = SYNC_REPO_NAME;

            // Check if repo already exists
            const exists = await this.gitFacade.repositoryExists(repoOwner, repoName, gitOptions);

            if (!exists) {
                await this.gitFacade.createRepository(
                    {
                        name: repoName,
                        description: 'Ever Works account configuration backup',
                        isPrivate: true,
                    },
                    gitOptions,
                );
            } else {
                // Verify it's private
                const repo = await this.gitFacade.getRepository(repoOwner, repoName, gitOptions);
                if (repo && !repo.isPrivate) {
                    throw new Error(
                        'Repository must be private. Please make it private or choose a different repository.',
                    );
                }
            }
        } else if (dto.repoFullName) {
            const parts = dto.repoFullName.split('/');
            if (parts.length !== 2) {
                throw new Error('Invalid repository name. Expected format: owner/repo');
            }
            repoOwner = parts[0];
            repoName = parts[1];

            // Verify it exists and is private
            const repo = await this.gitFacade.getRepository(repoOwner, repoName, gitOptions);
            if (!repo) {
                throw new Error(`Repository "${dto.repoFullName}" not found or inaccessible`);
            }
            if (!repo.isPrivate) {
                throw new Error(
                    'Repository must be private. Syncing to public repositories is not allowed for security reasons.',
                );
            }
        } else {
            throw new Error('Either createNew or repoFullName must be provided');
        }

        await this.syncConfigRepository.upsert(userId, {
            provider: PROVIDER_ID,
            repoOwner,
            repoName,
        });

        return this.getSyncStatus(userId);
    }

    async pushToGitHub(userId: string, options: SyncPushOptions = {}): Promise<void> {
        const config = await this.syncConfigRepository.findByUser(userId);
        if (!config) {
            throw new Error('Sync not configured. Please configure a repository first.');
        }

        const gitOptions = { providerId: PROVIDER_ID, userId };

        try {
            const payload = await this.exportService.exportAccountData(userId, {
                includeSecrets: options.includeSecrets || config.includeSecrets,
            });

            const user = await this.userRepository.findById(userId);
            const committer = user ? { name: user.username, email: user.email } : undefined;

            // Clone or pull the repo
            const dir = await this.gitFacade.cloneOrPull(
                { owner: config.repoOwner, repo: config.repoName, committer },
                gitOptions,
            );

            // Write structured files
            this.writeExportFiles(dir, payload);

            // Stage, commit, push
            await this.gitFacade.addAll(PROVIDER_ID, dir);
            const status = await this.gitFacade.getStatus(PROVIDER_ID, dir);
            if (status.length === 0) {
                this.logger.log('No changes to push');
                return;
            }

            await this.gitFacade.commit(
                PROVIDER_ID,
                dir,
                `sync: update account configuration (${new Date().toISOString()})`,
                committer,
            );
            await this.gitFacade.push({ dir }, gitOptions);

            await this.syncConfigRepository.updateLastPush(userId);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await this.syncConfigRepository.updateError(userId, message);
            throw error;
        }
    }

    async pullFromGitHub(userId: string): Promise<ImportPreview> {
        const config = await this.syncConfigRepository.findByUser(userId);
        if (!config) {
            throw new Error('Sync not configured. Please configure a repository first.');
        }

        const gitOptions = { providerId: PROVIDER_ID, userId };

        try {
            const user = await this.userRepository.findById(userId);
            const committer = user ? { name: user.username, email: user.email } : undefined;

            const dir = await this.gitFacade.cloneOrPull(
                { owner: config.repoOwner, repo: config.repoName, committer },
                gitOptions,
            );

            const payload = this.readExportFiles(dir);
            if (!payload) {
                return {
                    valid: false,
                    errors: ['No valid configuration found in repository'],
                    version: 0,
                    includesSecrets: false,
                    profile: { username: '', email: '' },
                    directoryCount: 0,
                    totalItemCount: 0,
                    userPluginCount: 0,
                    conflicts: [],
                    missingPlugins: [],
                };
            }

            return this.importService.previewImport(userId, payload);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await this.syncConfigRepository.updateError(userId, message);
            throw error;
        }
    }

    async applyPull(userId: string, resolutions: ConflictResolution[]): Promise<ImportResult> {
        const config = await this.syncConfigRepository.findByUser(userId);
        if (!config) {
            throw new Error('Sync not configured');
        }

        const gitOptions = { providerId: PROVIDER_ID, userId };
        const user = await this.userRepository.findById(userId);
        const committer = user ? { name: user.username, email: user.email } : undefined;

        const dir = await this.gitFacade.cloneOrPull(
            { owner: config.repoOwner, repo: config.repoName, committer },
            gitOptions,
        );

        const payload = this.readExportFiles(dir);
        if (!payload) {
            return {
                success: false,
                directoriesCreated: 0,
                directoriesUpdated: 0,
                directoriesSkipped: 0,
                userPluginsImported: 0,
                errors: ['No valid configuration found in repository'],
                warnings: [],
            };
        }

        const result = await this.importService.applyImport(userId, payload, resolutions);
        if (result.success) {
            await this.syncConfigRepository.updateLastPull(userId);
        }
        return result;
    }

    async removeSyncConfig(userId: string): Promise<void> {
        await this.syncConfigRepository.delete(userId);
    }

    private writeExportFiles(dir: string, payload: AccountExportPayload): void {
        // Write manifest
        const manifest = {
            version: payload.version,
            syncedAt: new Date().toISOString(),
            directoryCount: payload.data.directories.length,
            includesSecrets: payload.includesSecrets,
        };
        this.writeJsonFile(path.join(dir, 'manifest.json'), manifest);

        // Write profile
        this.writeJsonFile(path.join(dir, 'profile.json'), payload.data.profile);

        // Write user plugins
        const pluginsDir = path.join(dir, 'plugins');
        fs.mkdirSync(pluginsDir, { recursive: true });
        this.writeJsonFile(path.join(pluginsDir, 'user-plugins.json'), payload.data.userPlugins);

        // Write directories
        const directoriesDir = path.join(dir, 'directories');
        fs.mkdirSync(directoriesDir, { recursive: true });

        for (const directory of payload.data.directories) {
            const dirPath = path.join(directoriesDir, directory.slug);
            fs.mkdirSync(dirPath, { recursive: true });

            const {
                members,
                customDomains,
                directoryPlugins,
                advancedPrompts,
                schedule,
                siteConfig,
                markdownTemplate,
                items,
                categories,
                tags,
                collections,
                comparisons,
                ...config
            } = directory;
            this.writeJsonFile(path.join(dirPath, 'config.json'), config);
            this.writeJsonFile(path.join(dirPath, 'members.json'), members);
            this.writeJsonFile(path.join(dirPath, 'domains.json'), customDomains);
            this.writeJsonFile(path.join(dirPath, 'plugins.json'), directoryPlugins);
            if (advancedPrompts && Object.keys(advancedPrompts).length > 0) {
                this.writeJsonFile(path.join(dirPath, 'prompts.json'), advancedPrompts);
            }
            if (schedule) {
                this.writeJsonFile(path.join(dirPath, 'schedule.json'), schedule);
            }
            if (siteConfig && Object.keys(siteConfig).length > 0) {
                this.writeJsonFile(path.join(dirPath, 'site-config.json'), siteConfig);
            }
            if (markdownTemplate && (markdownTemplate.header || markdownTemplate.footer)) {
                this.writeJsonFile(path.join(dirPath, 'markdown-template.json'), markdownTemplate);
            }
            if (items && items.length > 0) {
                this.writeJsonFile(path.join(dirPath, 'items.json'), items);
            }
            if (categories && categories.length > 0) {
                this.writeJsonFile(path.join(dirPath, 'categories.json'), categories);
            }
            if (tags && tags.length > 0) {
                this.writeJsonFile(path.join(dirPath, 'tags.json'), tags);
            }
            if (collections && collections.length > 0) {
                this.writeJsonFile(path.join(dirPath, 'collections.json'), collections);
            }
            if (comparisons && comparisons.length > 0) {
                this.writeJsonFile(path.join(dirPath, 'comparisons.json'), comparisons);
            }
        }
    }

    private readExportFiles(dir: string): AccountExportPayload | null {
        const manifestPath = path.join(dir, 'manifest.json');
        if (!fs.existsSync(manifestPath)) {
            return null;
        }

        try {
            const manifest = this.readJsonFile(manifestPath);
            const profile = this.readJsonFile(path.join(dir, 'profile.json'));
            const userPlugins =
                this.readJsonFile(path.join(dir, 'plugins', 'user-plugins.json')) || [];

            const directories: any[] = [];
            const directoriesDir = path.join(dir, 'directories');

            if (fs.existsSync(directoriesDir)) {
                const slugs = fs
                    .readdirSync(directoriesDir, { withFileTypes: true })
                    .filter((d) => d.isDirectory())
                    .map((d) => d.name);

                for (const slug of slugs) {
                    const dirPath = path.join(directoriesDir, slug);
                    const config = this.readJsonFile(path.join(dirPath, 'config.json')) || {};
                    const members = this.readJsonFile(path.join(dirPath, 'members.json')) || [];
                    const customDomains =
                        this.readJsonFile(path.join(dirPath, 'domains.json')) || [];
                    const directoryPlugins =
                        this.readJsonFile(path.join(dirPath, 'plugins.json')) || [];

                    const advancedPrompts =
                        this.readJsonFile(path.join(dirPath, 'prompts.json')) || undefined;
                    const schedule =
                        this.readJsonFile(path.join(dirPath, 'schedule.json')) || undefined;
                    const siteConfig =
                        this.readJsonFile(path.join(dirPath, 'site-config.json')) || undefined;
                    const markdownTemplate =
                        this.readJsonFile(path.join(dirPath, 'markdown-template.json')) ||
                        undefined;
                    const items = this.readJsonFile(path.join(dirPath, 'items.json')) || [];
                    const categories =
                        this.readJsonFile(path.join(dirPath, 'categories.json')) || [];
                    const tags = this.readJsonFile(path.join(dirPath, 'tags.json')) || [];
                    const collections =
                        this.readJsonFile(path.join(dirPath, 'collections.json')) || [];
                    const comparisons =
                        this.readJsonFile(path.join(dirPath, 'comparisons.json')) || [];

                    directories.push({
                        ...config,
                        slug,
                        members,
                        customDomains,
                        directoryPlugins,
                        advancedPrompts,
                        schedule,
                        siteConfig,
                        markdownTemplate,
                        items,
                        categories,
                        tags,
                        collections,
                        comparisons,
                    });
                }
            }

            return {
                version: manifest.version || 1,
                exportedAt: manifest.syncedAt || new Date().toISOString(),
                includesSecrets: manifest.includesSecrets || false,
                data: {
                    profile,
                    directories,
                    userPlugins,
                },
            };
        } catch {
            return null;
        }
    }

    private writeJsonFile(filePath: string, data: any): void {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    }

    private readJsonFile(filePath: string): any {
        if (!fs.existsSync(filePath)) return null;
        const content = fs.readFileSync(filePath, 'utf-8');
        return JSON.parse(content);
    }

    private async hasGitHubOAuth(userId: string): Promise<boolean> {
        const token = await this.oauthTokenRepository.findByUserAndProvider(userId, PROVIDER_ID);
        return !!token;
    }

    private async ensureGitHubOAuth(userId: string): Promise<void> {
        const hasOAuth = await this.hasGitHubOAuth(userId);
        if (!hasOAuth) {
            throw new Error(
                'GitHub OAuth not connected. Please connect your GitHub account first.',
            );
        }
    }
}
