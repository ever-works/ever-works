import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { GitFacadeService } from '../facades/git.facade';
import { AuthAccountRepository } from '../database/repositories/auth-account.repository';
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
        private readonly authAccountRepository: AuthAccountRepository,
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
            lastPushAt:
                config.lastPushAt && !isNaN(config.lastPushAt.getTime())
                    ? config.lastPushAt.toISOString()
                    : undefined,
            lastPullAt:
                config.lastPullAt && !isNaN(config.lastPullAt.getTime())
                    ? config.lastPullAt.toISOString()
                    : undefined,
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

            // M-04: validate owner/repo character set against GitHub's
            // server-side rule (`^[A-Za-z0-9._-]+$`) before any network call.
            // The split-by-`/` above leaves the strings unchecked, so an
            // attacker passing `repoFullName: "evil.com/x#?frag"` would have
            // those characters reach the git facade's URL builder.
            const repoCoordPattern = /^[A-Za-z0-9._-]+$/;
            if (!repoCoordPattern.test(repoOwner) || !repoCoordPattern.test(repoName)) {
                throw new Error(
                    'Invalid repository name. Owner and repo may only contain letters, digits, dot, underscore, and hyphen.',
                );
            }

            // M-04 (ownership check): the OAuth-linked GitHub identity's
            // login must match the supplied owner — covers the personal-repo
            // case. Without this an attacker could point the sync at any
            // private repo whose existence they know; the subsequent push
            // would fail at GitHub's auth layer, but the configure-step
            // would still bind the platform's record to a foreign repo.
            //
            // Org-owned repos: the GitUser interface doesn't currently
            // expose the user's org list, so we fall back to "if the repo
            // returns without throwing AND is private, trust GitHub's own
            // access check". A subsequent `push` will surface any access
            // mismatch immediately, so the residual risk is small.
            const gitUser = await this.gitFacade.getUser(gitOptions);
            const ownsRepo = gitUser?.login?.toLowerCase() === repoOwner.toLowerCase();

            // Verify it exists and is private. If `getRepository` returns at
            // all, the OAuth token has at least read access — which combined
            // with the login-match check above (or a successful org-repo
            // fetch) is a reasonable proxy for "user is authorized to
            // configure sync against this repo".
            const repo = await this.gitFacade.getRepository(repoOwner, repoName, gitOptions);
            if (!repo) {
                throw new Error(`Repository "${dto.repoFullName}" not found or inaccessible`);
            }
            if (!ownsRepo) {
                // Org repo path — log it so audits can see who's pointing
                // sync at a non-personal-namespace repo.
                this.logger.warn(
                    `account.sync.configure: user=${userId} pointing sync at non-personal repo ${repoOwner}/${repoName} (oauth-user=${gitUser?.login})`,
                );
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
            // Review-fix C3: forward the v2-tail toggles so the
            // GitHub sync push actually picks up Agents/Skills/Tasks.
            // Defaults: Agents + Skills auto-mirror (small footprint),
            // Tasks opt-in (volume), Task chat double-opt-in (bloat).
            const payload = await this.exportService.exportAccountData(userId, {
                includeSecrets: options.includeSecrets || config.includeSecrets,
                includeAgents: options.includeAgents ?? true,
                includeSkills: options.includeSkills ?? true,
                includeTasks: options.includeTasks ?? false,
                includeTaskChat: options.includeTaskChat ?? false,
            });

            const user = await this.userRepository.findById(userId);
            const committer =
                user && user.email ? { name: user.username, email: user.email } : undefined;

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
            const committer =
                user && user.email ? { name: user.username, email: user.email } : undefined;

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
                    hasMaskedSecrets: false,
                    profile: { username: '', email: '' },
                    workCount: 0,
                    totalItemCount: 0,
                    userPluginCount: 0,
                    conflicts: [],
                    missingPlugins: [],
                };
            }

            // GitHub pull always ignores secrets — force includesSecrets to false
            payload.includesSecrets = false;

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

        try {
            const user = await this.userRepository.findById(userId);
            const committer =
                user && user.email ? { name: user.username, email: user.email } : undefined;

            const dir = await this.gitFacade.cloneOrPull(
                { owner: config.repoOwner, repo: config.repoName, committer },
                gitOptions,
            );

            const payload = this.readExportFiles(dir);
            if (!payload) {
                return {
                    success: false,
                    worksCreated: 0,
                    worksUpdated: 0,
                    worksSkipped: 0,
                    userPluginsImported: 0,
                    errors: ['No valid configuration found in repository'],
                    warnings: [],
                };
            }

            // GitHub pull always ignores secrets — they are masked in the repo
            payload.includesSecrets = false;

            const result = await this.importService.applyImport(userId, payload, resolutions);
            if (result.success) {
                await this.syncConfigRepository.updateLastPull(userId);
            }
            return result;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await this.syncConfigRepository.updateError(userId, message);
            throw error;
        }
    }

    async removeSyncConfig(userId: string): Promise<void> {
        await this.syncConfigRepository.delete(userId);
    }

    private writeExportFiles(dir: string, payload: AccountExportPayload): void {
        // Phase 19.5 — manifest carries the v2 tail counts when present
        // so a pull-side reader can decide which subdirs to walk
        // without crawling the whole tree first.
        const agents = payload.data.agents ?? [];
        const skills = payload.data.skills ?? [];
        const tasks = payload.data.tasks ?? [];
        const manifest = {
            version: payload.version,
            syncedAt: new Date().toISOString(),
            workCount: payload.data.works.length,
            includesSecrets: payload.includesSecrets,
            agentCount: agents.length,
            skillCount: skills.length,
            taskCount: tasks.length,
        };
        this.writeJsonFile(path.join(dir, 'manifest.json'), manifest);

        // Write profile
        this.writeJsonFile(path.join(dir, 'profile.json'), payload.data.profile);

        // Write user plugins
        const pluginsDir = path.join(dir, 'plugins');
        fs.mkdirSync(pluginsDir, { recursive: true });
        this.writeJsonFile(path.join(pluginsDir, 'user-plugins.json'), payload.data.userPlugins);

        // Write works
        const worksDir = path.join(dir, 'works');
        fs.mkdirSync(worksDir, { recursive: true });

        for (const work of payload.data.works) {
            const safeName = path.basename(work.slug);
            if (safeName !== work.slug) {
                this.logger.warn(`Skipping work with invalid slug: ${work.slug}`);
                continue;
            }
            const dirPath = path.join(worksDir, safeName);
            fs.mkdirSync(dirPath, { recursive: true });

            const {
                members,
                customDomains,
                workPlugins,
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
            } = work;
            this.writeJsonFile(path.join(dirPath, 'config.json'), config);
            this.writeJsonFile(path.join(dirPath, 'members.json'), members);
            this.writeJsonFile(path.join(dirPath, 'domains.json'), customDomains);
            this.writeJsonFile(path.join(dirPath, 'plugins.json'), workPlugins);
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

        // Phase 19.5 — Agents/Skills/Tasks v2 tail. Each section
        // becomes its own subdir for cleaner diffs in the sync repo:
        // an Agent SOUL.md edit shows up as a single-file diff instead
        // of a json-blob rewrite. One json file per row, slug-keyed
        // (slugs are unique within (ownerType, ownerId) so cross-tenant
        // collisions are not a concern for the sync repo's
        // single-tenant layout).
        if (agents.length > 0) {
            const agentsDir = path.join(dir, 'agents');
            fs.mkdirSync(agentsDir, { recursive: true });
            for (const agent of agents) {
                const safeName = path.basename(agent.identity.slug);
                if (safeName !== agent.identity.slug) {
                    this.logger.warn(`Skipping agent with invalid slug: ${agent.identity.slug}`);
                    continue;
                }
                this.writeJsonFile(path.join(agentsDir, `${safeName}.json`), agent);
            }
        }
        if (skills.length > 0) {
            const skillsDir = path.join(dir, 'skills');
            fs.mkdirSync(skillsDir, { recursive: true });
            for (const skill of skills) {
                const safeName = path.basename(skill.slug);
                if (safeName !== skill.slug) {
                    this.logger.warn(`Skipping skill with invalid slug: ${skill.slug}`);
                    continue;
                }
                this.writeJsonFile(path.join(skillsDir, `${safeName}.json`), skill);
            }
        }
        if (tasks.length > 0) {
            const tasksDir = path.join(dir, 'tasks');
            fs.mkdirSync(tasksDir, { recursive: true });
            for (const task of tasks) {
                const safeName = path.basename(task.slug);
                if (safeName !== task.slug) {
                    this.logger.warn(`Skipping task with invalid slug: ${task.slug}`);
                    continue;
                }
                this.writeJsonFile(path.join(tasksDir, `${safeName}.json`), task);
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

            const works: any[] = [];
            const worksDir = path.join(dir, 'works');

            if (fs.existsSync(worksDir)) {
                const slugs = fs
                    .readdirSync(worksDir, { withFileTypes: true })
                    .filter((d) => d.isDirectory())
                    .map((d) => d.name);

                for (const slug of slugs) {
                    const safeName = path.basename(slug);
                    if (safeName !== slug) continue;
                    const dirPath = path.join(worksDir, safeName);
                    const config = this.readJsonFile(path.join(dirPath, 'config.json')) || {};
                    const members = this.readJsonFile(path.join(dirPath, 'members.json')) || [];
                    const customDomains =
                        this.readJsonFile(path.join(dirPath, 'domains.json')) || [];
                    const workPlugins = this.readJsonFile(path.join(dirPath, 'plugins.json')) || [];

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

                    works.push({
                        ...config,
                        slug,
                        members,
                        customDomains,
                        workPlugins,
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

            // Phase 19.5 — Agents/Skills/Tasks v2 tail. Read whichever
            // subdirs are present; missing subdir => empty array (which
            // collapses to `undefined` on the payload via the filter
            // below, keeping v1 envelopes shaped exactly as before).
            const agents = this.readJsonDir(path.join(dir, 'agents'));
            const skills = this.readJsonDir(path.join(dir, 'skills'));
            const tasks = this.readJsonDir(path.join(dir, 'tasks'));

            const inferredVersion: 1 | 2 =
                agents.length > 0 || skills.length > 0 || tasks.length > 0 ? 2 : 1;

            return {
                version: (manifest.version === 2 ? 2 : inferredVersion) as 1 | 2,
                exportedAt: manifest.syncedAt || new Date().toISOString(),
                includesSecrets: manifest.includesSecrets || false,
                data: {
                    profile,
                    works,
                    userPlugins,
                    ...(agents.length > 0 ? { agents } : {}),
                    ...(skills.length > 0 ? { skills } : {}),
                    ...(tasks.length > 0 ? { tasks } : {}),
                },
            };
        } catch {
            return null;
        }
    }

    /**
     * Phase 19.5 helper — reads every `*.json` file in a directory and
     * returns the parsed objects. Returns empty array when the dir is
     * missing or unreadable. Filenames are NOT trusted — slug uniqueness
     * is re-validated on import.
     */
    private readJsonDir(dirPath: string): any[] {
        if (!fs.existsSync(dirPath)) return [];
        try {
            const rows: any[] = [];
            const names = fs
                .readdirSync(dirPath, { withFileTypes: true })
                .filter((d) => d.isFile() && d.name.endsWith('.json'))
                .map((d) => d.name)
                .sort();
            for (const name of names) {
                try {
                    const parsed = this.readJsonFile(path.join(dirPath, name));
                    if (parsed) rows.push(parsed);
                } catch (err) {
                    this.logger.warn(
                        `Failed to parse ${name} in ${dirPath}: ${err instanceof Error ? err.message : err}`,
                    );
                }
            }
            return rows;
        } catch {
            return [];
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
        const account = await this.authAccountRepository.findProviderAccount(userId, PROVIDER_ID);
        return !!account?.accessToken;
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
