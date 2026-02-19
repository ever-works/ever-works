import { Injectable } from '@nestjs/common';
import type {
    IGitProviderPlugin,
    GitRepository,
    GitUser,
    GitOrganization,
    GitBranch,
    GitCommit,
    GitPullRequest,
    GitPullRequestFile,
    CreateRepoOptions,
    CreatePROptions,
    MergeOptions,
    MergeResult,
    ForkRepositoryOptions,
    GitRepositoryWithPermissions,
    ListRepositoriesOptions,
    ListPullRequestsOptions,
    GitCommitter,
    GitFileChange,
    IGitFacade,
    GitProviderInfo,
} from '@ever-works/plugin';
import { PLUGIN_CAPABILITIES } from '@ever-works/plugin';
import { PluginRegistryService } from '../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../plugins/services/plugin-settings.service';
import { OAuthTokenRepository } from '../database/repositories/oauth-token.repository';
import { FacadeError } from './base.facade';

// Facade-specific types that don't require token (facade resolves token internally)
export interface FacadeCloneOptions {
    readonly owner: string;
    readonly repo: string;
    readonly committer?: GitCommitter;
    readonly branch?: string;
    readonly autoSwitchToMainBranch?: boolean;
}

export interface FacadePushOptions {
    readonly dir: string;
    readonly force?: boolean;
    readonly maxRetries?: number;
}

export class GitFacadeError extends FacadeError {
    constructor(message: string, operation: string, provider?: string, cause?: Error) {
        super(message, operation, provider, cause);
        this.name = 'GitFacadeError';
    }
}

export class NoGitProviderError extends GitFacadeError {
    constructor() {
        super('No Git provider configured or available', 'getPlugin');
        this.name = 'NoGitProviderError';
    }
}

export class GitProviderNotFoundError extends GitFacadeError {
    constructor(providerId: string) {
        super(`Git provider not found: ${providerId}`, 'getPlugin', providerId);
        this.name = 'GitProviderNotFoundError';
    }
}

export class NoGitCredentialsError extends GitFacadeError {
    constructor(providerId: string, userId: string) {
        super(
            `No OAuth token found for user ${userId} with provider ${providerId}`,
            'getCredentials',
            providerId,
        );
        this.name = 'NoGitCredentialsError';
    }
}

/** Base options shared by all Git facade calls */
interface GitFacadeBaseOptions {
    readonly providerId: string;
    readonly directoryId?: string;
}

/** Token-based auth — used when caller already has a token (e.g., public repo analysis) */
export interface GitFacadeTokenAuth extends GitFacadeBaseOptions {
    readonly token: string;
    readonly userId?: string;
}

/** User-based auth — facade looks up OAuth/PAT credentials for the user */
export interface GitFacadeUserAuth extends GitFacadeBaseOptions {
    readonly userId: string;
    readonly token?: string;
}

/** Git facade options: must provide at least token OR userId */
export type GitFacadeOptions = GitFacadeTokenAuth | GitFacadeUserAuth;

export type { GitProviderInfo };

@Injectable()
export class GitFacadeService implements IGitFacade {
    private readonly CAPABILITY = PLUGIN_CAPABILITIES.GIT_PROVIDER;

    constructor(
        private readonly registry: PluginRegistryService,
        private readonly oauthTokenRepository: OAuthTokenRepository,
        private readonly settingsService: PluginSettingsService,
    ) {}

    isConfigured(): boolean {
        const plugins = this.registry.getByCapability(this.CAPABILITY);
        return plugins.length > 0 && plugins.some((p) => p.state === 'loaded');
    }

    getAvailableProviders(): GitProviderInfo[] {
        const plugins = this.registry.getByCapability(this.CAPABILITY);
        return plugins.map((p) => ({
            id: p.plugin.id,
            name: (p.plugin as IGitProviderPlugin).providerName,
            enabled: p.state === 'loaded',
            icon: p.manifest.icon,
            description: p.manifest.description,
            homepage: p.manifest.homepage,
        }));
    }

    async hasValidCredentials(options: GitFacadeOptions): Promise<boolean> {
        if (options.token) return true;
        if (!options.userId || !options.providerId) return false;

        try {
            const plugin = await this.resolvePlugin(
                options.providerId,
                options.userId,
                options.directoryId,
            );

            // Check OAuth token first
            const oauthToken = await this.oauthTokenRepository.findByUserAndProvider(
                options.userId,
                plugin.id,
            );
            if (oauthToken && !this.oauthTokenRepository.isTokenExpired(oauthToken)) {
                return true;
            }

            // Check plugin settings for PAT
            const patToken = await this.getPatFromSettings(
                plugin.id,
                options.userId,
                options.directoryId,
            );
            return !!patToken;
        } catch {
            return false;
        }
    }

    async getAccessToken(options: GitFacadeOptions): Promise<string | null> {
        if (options.token) return options.token;
        if (!options.userId || !options.providerId) return null;

        try {
            const plugin = await this.resolvePlugin(
                options.providerId,
                options.userId,
                options.directoryId,
            );

            // Try OAuth token first
            const oauthToken = await this.oauthTokenRepository.findByUserAndProvider(
                options.userId,
                plugin.id,
            );
            if (oauthToken && !this.oauthTokenRepository.isTokenExpired(oauthToken)) {
                return oauthToken.accessToken;
            }

            // Try plugin settings for PAT
            return this.getPatFromSettings(plugin.id, options.userId, options.directoryId);
        } catch {
            return null;
        }
    }

    async getCommitter(options: GitFacadeOptions): Promise<GitCommitter | null> {
        if (!options.userId || !options.providerId) return null;

        try {
            const plugin = await this.resolvePlugin(
                options.providerId,
                options.userId,
                options.directoryId,
            );

            // Try to get committer info from OAuth token first
            const oauthToken = await this.oauthTokenRepository.findByUserAndProvider(
                options.userId,
                plugin.id,
            );
            if (oauthToken) {
                const username = oauthToken.metadata?.login || oauthToken.username;
                const email = oauthToken.email;
                if (username && email) {
                    return { name: username, email };
                }
            }

            // For PAT-based auth, try to get committer info from plugin settings
            const settings = await this.settingsService.getResolvedSettings(plugin.id, {
                userId: options.userId,
                directoryId: options.directoryId,
                includeSecrets: false, // We don't need secrets, just user info
            });

            const gitUsername = settings.gitUsername?.value as string | undefined;
            const gitEmail = settings.gitEmail?.value as string | undefined;

            if (gitUsername && gitEmail) {
                return { name: gitUsername, email: gitEmail };
            }

            // If we have a PAT but no stored committer info, fetch from API
            const patToken = await this.getPatFromSettings(
                plugin.id,
                options.userId,
                options.directoryId,
            );
            if (patToken) {
                try {
                    const user = await plugin.getUser(patToken);
                    if (user.login && user.email) {
                        return { name: user.login, email: user.email };
                    }
                } catch {
                    // Unable to fetch user info from API
                }
            }

            return null;
        } catch {
            return null;
        }
    }

    async getUser(options: GitFacadeOptions): Promise<GitUser> {
        const { plugin, token } = await this.resolvePluginAndToken(options);
        return plugin.getUser(token);
    }

    async getOrganizations(options: GitFacadeOptions): Promise<GitOrganization[]> {
        const { plugin, token } = await this.resolvePluginAndToken(options);
        return plugin.getOrganizations(token);
    }

    async getRepository(
        owner: string,
        repo: string,
        options: GitFacadeOptions,
    ): Promise<GitRepository | null> {
        const { plugin, token } = await this.resolvePluginAndToken(options);
        return plugin.getRepository(owner, repo, token);
    }

    async listRepositories(
        options: GitFacadeOptions,
        page?: number,
        perPage?: number,
        listOptions?: ListRepositoriesOptions,
    ): Promise<GitRepositoryWithPermissions[]> {
        const { plugin, token } = await this.resolvePluginAndToken(options);
        if (plugin.listRepositories) {
            return plugin.listRepositories(token, page, perPage, listOptions);
        }
        return [];
    }

    async createRepository(
        createOptions: CreateRepoOptions,
        options: GitFacadeOptions,
    ): Promise<GitRepository> {
        const { plugin, token } = await this.resolvePluginAndToken(options);
        return plugin.createRepository(createOptions, token);
    }

    async deleteRepository(owner: string, repo: string, options: GitFacadeOptions): Promise<void> {
        const { plugin, token } = await this.resolvePluginAndToken(options);
        return plugin.deleteRepository(owner, repo, token);
    }

    async updateRepository(
        owner: string,
        repo: string,
        data: { isPrivate?: boolean; description?: string },
        options: GitFacadeOptions,
    ): Promise<GitRepository> {
        const { plugin, token } = await this.resolvePluginAndToken(options);
        if (plugin.updateRepository) {
            return plugin.updateRepository(owner, repo, data, token);
        }
        throw new GitFacadeError(
            'Update repository not supported by this provider',
            'updateRepository',
            plugin.id,
        );
    }

    async hasRepositoryAccess(
        owner: string,
        repo: string,
        options: GitFacadeOptions,
    ): Promise<boolean> {
        const { plugin, token } = await this.resolvePluginAndToken(options);
        if (plugin.hasRepositoryAccess) {
            return plugin.hasRepositoryAccess(owner, repo, token);
        }
        const repository = await plugin.getRepository(owner, repo, token);
        return repository !== null;
    }

    async forkRepository(
        owner: string,
        repo: string,
        forkOptions: ForkRepositoryOptions,
        options: GitFacadeOptions,
    ): Promise<GitRepository | null> {
        const { plugin, token } = await this.resolvePluginAndToken(options);
        if (plugin.forkRepository) {
            return plugin.forkRepository(owner, repo, forkOptions, token);
        }
        throw new GitFacadeError(
            'Fork repository not supported by this provider',
            'forkRepository',
            plugin.id,
        );
    }

    async createRepositoryFromTemplate(
        templateOwner: string,
        templateRepo: string,
        createOptions: CreateRepoOptions,
        options: GitFacadeOptions,
    ): Promise<GitRepository | null> {
        const { plugin, token } = await this.resolvePluginAndToken(options);
        if (plugin.createRepositoryFromTemplate) {
            return plugin.createRepositoryFromTemplate(
                templateOwner,
                templateRepo,
                createOptions,
                token,
            );
        }
        throw new GitFacadeError(
            'Create from template not supported by this provider',
            'createRepositoryFromTemplate',
            plugin.id,
        );
    }

    async hasForkRelationship(
        forkOwner: string,
        forkRepo: string,
        parentOwner: string,
        parentRepo: string,
        options: GitFacadeOptions,
    ): Promise<boolean> {
        const { plugin, token } = await this.resolvePluginAndToken(options);
        if (plugin.hasForkRelationship) {
            return plugin.hasForkRelationship(forkOwner, forkRepo, parentOwner, parentRepo, token);
        }
        return false;
    }

    async repositoryExists(
        owner: string,
        repo: string,
        options: GitFacadeOptions,
    ): Promise<boolean> {
        const { plugin, token } = await this.resolvePluginAndToken(options);
        if (plugin.repositoryExists) {
            return plugin.repositoryExists(owner, repo, token);
        }
        const repository = await plugin.getRepository(owner, repo, token);
        return repository !== null;
    }

    async listBranches(
        owner: string,
        repo: string,
        options: GitFacadeOptions,
    ): Promise<GitBranch[]> {
        const { plugin, token } = await this.resolvePluginAndToken(options);
        return plugin.listBranches(owner, repo, token);
    }

    async createBranch(
        owner: string,
        repo: string,
        name: string,
        fromRef: string,
        options: GitFacadeOptions,
    ): Promise<GitBranch> {
        const { plugin, token } = await this.resolvePluginAndToken(options);
        if (plugin.createBranch) {
            return plugin.createBranch(owner, repo, name, fromRef, token);
        }
        throw new GitFacadeError(
            'Create branch not supported by this provider',
            'createBranch',
            plugin.id,
        );
    }

    async deleteBranch(
        owner: string,
        repo: string,
        name: string,
        options: GitFacadeOptions,
    ): Promise<void> {
        const { plugin, token } = await this.resolvePluginAndToken(options);
        if (plugin.deleteBranch) {
            return plugin.deleteBranch(owner, repo, name, token);
        }
        throw new GitFacadeError(
            'Delete branch not supported by this provider',
            'deleteBranch',
            plugin.id,
        );
    }

    async getLatestCommit(
        owner: string,
        repo: string,
        branch: string,
        options: GitFacadeOptions,
    ): Promise<GitCommit | null> {
        const { plugin, token } = await this.resolvePluginAndToken(options);
        if (plugin.getLatestCommit) {
            return plugin.getLatestCommit(owner, repo, branch, token);
        }
        return null;
    }

    async getFileContent(
        owner: string,
        repo: string,
        path: string,
        options: GitFacadeOptions,
        ref?: string,
    ): Promise<{ content: string; encoding: string } | null> {
        const { plugin, token } = await this.resolvePluginAndToken(options);
        if (plugin.getFileContent) {
            return plugin.getFileContent(owner, repo, path, ref, token);
        }
        return null;
    }

    async getReadme(
        owner: string,
        repo: string,
        options: GitFacadeOptions,
        ref?: string,
    ): Promise<{ content: string; path: string } | null> {
        const { plugin, token } = await this.resolvePluginAndToken(options);
        if (plugin.getReadme) {
            return plugin.getReadme(owner, repo, ref, token);
        }
        return null;
    }

    getRawFileUrl(
        providerId: string,
        owner: string,
        repo: string,
        branch: string,
        path: string,
    ): string {
        const plugin = this.getPluginSync(providerId);
        if (plugin.getRawFileUrl) {
            return plugin.getRawFileUrl(owner, repo, branch, path);
        }
        throw new GitFacadeError(
            'getRawFileUrl not supported by this provider',
            'getRawFileUrl',
            plugin.id,
        );
    }

    async getDirectoryContents(
        owner: string,
        repo: string,
        path: string,
        options: GitFacadeOptions,
    ): Promise<Array<{
        name: string;
        type: 'file' | 'dir' | 'submodule' | 'symlink';
        path: string;
    }> | null> {
        const { plugin, token } = await this.resolvePluginAndToken(options);
        if (plugin.getDirectoryContents) {
            return plugin.getDirectoryContents(owner, repo, path, token);
        }
        return null;
    }

    async createPullRequest(
        prOptions: CreatePROptions,
        options: GitFacadeOptions,
    ): Promise<GitPullRequest> {
        const { plugin, token } = await this.resolvePluginAndToken(options);
        return plugin.createPullRequest(prOptions, token);
    }

    async getPullRequest(
        owner: string,
        repo: string,
        prNumber: number,
        options: GitFacadeOptions,
    ): Promise<GitPullRequest | null> {
        const { plugin, token } = await this.resolvePluginAndToken(options);
        if (plugin.getPullRequest) {
            return plugin.getPullRequest(owner, repo, prNumber, token);
        }
        return null;
    }

    async mergePullRequest(
        owner: string,
        repo: string,
        prNumber: number,
        mergeOptions: MergeOptions | undefined,
        options: GitFacadeOptions,
    ): Promise<MergeResult> {
        const { plugin, token } = await this.resolvePluginAndToken(options);
        return plugin.mergePullRequest(owner, repo, prNumber, mergeOptions, token);
    }

    async listPullRequests(
        owner: string,
        repo: string,
        listOptions: ListPullRequestsOptions | undefined,
        options: GitFacadeOptions,
    ): Promise<GitPullRequest[]> {
        const { plugin, token } = await this.resolvePluginAndToken(options);
        if (plugin.listPullRequests) {
            return plugin.listPullRequests(owner, repo, listOptions, token);
        }
        return [];
    }

    async getPullRequestFiles(
        owner: string,
        repo: string,
        prNumber: number,
        options: GitFacadeOptions,
    ): Promise<GitPullRequestFile[]> {
        const { plugin, token } = await this.resolvePluginAndToken(options);
        if (plugin.getPullRequestFiles) {
            return plugin.getPullRequestFiles(owner, repo, prNumber, token);
        }
        return [];
    }

    async createPullRequestComment(
        owner: string,
        repo: string,
        prNumber: number,
        body: string,
        options: GitFacadeOptions,
    ): Promise<{ id: number; body: string }> {
        const { plugin, token } = await this.resolvePluginAndToken(options);
        if (plugin.createPullRequestComment) {
            return plugin.createPullRequestComment(owner, repo, prNumber, body, token);
        }
        throw new GitFacadeError(
            'Create pull request comment not supported by this provider',
            'createPullRequestComment',
            plugin.id,
        );
    }

    async closePullRequest(
        owner: string,
        repo: string,
        prNumber: number,
        options: GitFacadeOptions,
    ): Promise<GitPullRequest> {
        const { plugin, token } = await this.resolvePluginAndToken(options);
        if (plugin.closePullRequest) {
            return plugin.closePullRequest(owner, repo, prNumber, token);
        }
        throw new GitFacadeError(
            'Close pull request not supported by this provider',
            'closePullRequest',
            plugin.id,
        );
    }

    async cloneOrPull(
        cloneOptions: FacadeCloneOptions,
        options: GitFacadeOptions,
    ): Promise<string> {
        const { plugin, token } = await this.resolvePluginAndToken(options);
        return plugin.cloneOrPull({ ...cloneOptions, token });
    }

    async pull(
        dir: string,
        committer: GitCommitter | undefined,
        options: GitFacadeOptions,
    ): Promise<void> {
        const { plugin, token } = await this.resolvePluginAndToken(options);
        return plugin.pull(dir, token, committer);
    }

    async add(providerId: string, dir: string, paths: string | string[]): Promise<void> {
        const plugin = this.getPluginSync(providerId);
        return plugin.add(dir, paths);
    }

    async addAll(providerId: string, dir: string): Promise<void> {
        const plugin = this.getPluginSync(providerId);
        return plugin.addAll(dir);
    }

    async commit(
        providerId: string,
        dir: string,
        message: string,
        committer?: GitCommitter,
    ): Promise<string> {
        const plugin = this.getPluginSync(providerId);
        return plugin.commit(dir, message, committer);
    }

    async push(pushOptions: FacadePushOptions, options: GitFacadeOptions): Promise<void> {
        const { plugin, token } = await this.resolvePluginAndToken(options);
        return plugin.push({ ...pushOptions, token });
    }

    async getCurrentBranch(providerId: string, dir: string): Promise<string | null> {
        const plugin = this.getPluginSync(providerId);
        return plugin.getCurrentBranch(dir);
    }

    async getMainBranch(providerId: string, dir: string): Promise<string | null> {
        const plugin = this.getPluginSync(providerId);
        return plugin.getMainBranch(dir);
    }

    async switchBranch(
        providerId: string,
        dir: string,
        branch: string,
        create?: boolean,
    ): Promise<string> {
        const plugin = this.getPluginSync(providerId);
        return plugin.switchBranch(dir, branch, create);
    }

    async getStatus(providerId: string, dir: string): Promise<GitFileChange[]> {
        const plugin = this.getPluginSync(providerId);
        return plugin.getStatus(dir);
    }

    getCloneUrl(providerId: string, owner: string, repo: string): string {
        const plugin = this.getPluginSync(providerId);
        return plugin.getCloneUrl(owner, repo);
    }

    getWebUrl(providerId: string, owner: string, repo: string): string {
        const plugin = this.getPluginSync(providerId);
        return plugin.getWebUrl(owner, repo);
    }

    getLocalDir(providerId: string, owner: string, repo: string): string {
        const plugin = this.getPluginSync(providerId);
        return plugin.getLocalDir(owner, repo);
    }

    private getPluginSync(providerId: string): IGitProviderPlugin {
        const plugins = this.registry.getByCapability(this.CAPABILITY);

        if (providerId) {
            const registered = plugins.find((p) => p.plugin.id === providerId);
            if (registered?.state === 'loaded') {
                return registered.plugin as IGitProviderPlugin;
            }
        }

        const enabled = plugins.find((p) => p.state === 'loaded');
        if (!enabled) {
            throw new NoGitProviderError();
        }
        return enabled.plugin as IGitProviderPlugin;
    }

    async replaceRemote(
        providerId: string,
        dir: string,
        remote: string,
        url: string,
    ): Promise<void> {
        const plugin = this.getPluginSync(providerId);
        return plugin.replaceRemote(dir, remote, url);
    }

    async removeLocalDir(providerId: string, owner: string, repo: string): Promise<void> {
        const plugin = this.getPluginSync(providerId);
        return plugin.removeLocalDir(owner, repo);
    }

    async renameBranch(
        providerId: string,
        dir: string,
        oldName: string,
        newName: string,
    ): Promise<void> {
        const plugin = this.getPluginSync(providerId);
        return plugin.renameBranch(dir, oldName, newName);
    }

    private async resolvePluginAndToken(
        options: GitFacadeOptions,
    ): Promise<{ plugin: IGitProviderPlugin; token: string }> {
        const plugin = await this.resolvePlugin(
            options.providerId,
            options.userId,
            options.directoryId,
        );

        // If token provided directly, use it
        if (options.token) {
            return { plugin, token: options.token };
        }

        if (!options.userId) {
            throw new GitFacadeError(
                'No token provided and no userId for credential lookup',
                'resolveToken',
                plugin.id,
            );
        }

        // 1. Try OAuth token first (for OAuth-based plugins like GitHub)
        const oauthToken = await this.oauthTokenRepository.findByUserAndProvider(
            options.userId,
            plugin.id,
        );
        if (oauthToken && !this.oauthTokenRepository.isTokenExpired(oauthToken)) {
            return { plugin, token: oauthToken.accessToken };
        }

        // 2. Try plugin user settings (for PAT-based plugins like GitLab)
        const patToken = await this.getPatFromSettings(
            plugin.id,
            options.userId,
            options.directoryId,
        );
        if (patToken) {
            return { plugin, token: patToken };
        }

        throw new NoGitCredentialsError(plugin.id, options.userId);
    }

    /**
     * Get Personal Access Token from plugin settings
     */
    private async getPatFromSettings(
        pluginId: string,
        userId: string,
        directoryId?: string,
    ): Promise<string | null> {
        try {
            const settings = await this.settingsService.getResolvedSettings(pluginId, {
                userId,
                directoryId,
                includeSecrets: true,
            });
            return (settings.accessToken?.value as string) || null;
        } catch {
            return null;
        }
    }

    private async resolvePlugin(
        providerId: string,
        userId?: string,
        directoryId?: string,
    ): Promise<IGitProviderPlugin> {
        if (!providerId) {
            throw new GitFacadeError('providerId is required', 'resolvePlugin');
        }

        const registered = this.registry.get(providerId);
        if (
            registered &&
            registered.manifest.capabilities.includes(this.CAPABILITY) &&
            registered.state === 'loaded'
        ) {
            const isEnabled = await this.registry.isPluginEnabledForScope(
                providerId,
                directoryId,
                userId,
            );
            if (isEnabled) {
                return registered.plugin as IGitProviderPlugin;
            }
        }
        throw new GitProviderNotFoundError(providerId);
    }
}
