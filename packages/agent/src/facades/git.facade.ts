import { Injectable, Optional } from '@nestjs/common';
import type {
    IGitProviderPlugin,
    IOAuthPlugin,
    GitRepository,
    GitUser,
    GitOrganization,
    GitBranch,
    GitCommit,
    GitPullRequest,
    CreateRepoOptions,
    CreatePROptions,
    MergeOptions,
    MergeResult,
    ForkRepositoryOptions,
    GitRepositoryWithPermissions,
    GitCommitter,
    GitFileChange,
    OAuthConfig,
    OAuthToken,
    OAuthUser,
    IGitFacade,
} from '@ever-works/plugin';
import { PLUGIN_CAPABILITIES, isOAuthPlugin } from '@ever-works/plugin';

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
import { PluginRegistryService } from '../plugins/services/plugin-registry.service';
import { DirectoryPluginRepository } from '../plugins/repositories/directory-plugin.repository';
import { UserPluginRepository } from '../plugins/repositories/user-plugin.repository';
import { OAuthTokenRepository } from '../database/repositories/oauth-token.repository';

export class GitFacadeError extends Error {
    constructor(
        message: string,
        public readonly operation: string,
        public readonly provider?: string,
        public readonly cause?: Error,
    ) {
        super(message);
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

export interface GitFacadeOptions {
    providerId: string;
    userId?: string;
    directoryId?: string;
    token?: string;
}

export interface GitProviderInfo {
    id: string;
    name: string;
    enabled: boolean;
}

@Injectable()
export class GitFacadeService implements IGitFacade {
    private readonly CAPABILITY = PLUGIN_CAPABILITIES.GIT_PROVIDER;

    constructor(
        private readonly registry: PluginRegistryService,
        private readonly oauthTokenRepository: OAuthTokenRepository,
        @Optional() private readonly directoryPluginRepository?: DirectoryPluginRepository,
        @Optional() private readonly userPluginRepository?: UserPluginRepository,
    ) {}

    isConfigured(): boolean {
        const plugins = this.registry.getByCapability(this.CAPABILITY);
        return plugins.length > 0 && plugins.some((p) => p.state === 'enabled');
    }

    getAvailableProviders(): GitProviderInfo[] {
        const plugins = this.registry.getByCapability(this.CAPABILITY);
        return plugins.map((p) => ({
            id: p.plugin.id,
            name: (p.plugin as IGitProviderPlugin).providerName,
            enabled: p.state === 'enabled',
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
            const token = await this.oauthTokenRepository.findByUserAndProvider(
                options.userId,
                plugin.id,
            );
            return token !== null && !this.oauthTokenRepository.isTokenExpired(token);
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
            const oauthToken = await this.oauthTokenRepository.findByUserAndProvider(
                options.userId,
                plugin.id,
            );
            if (!oauthToken || this.oauthTokenRepository.isTokenExpired(oauthToken)) {
                return null;
            }
            return oauthToken.accessToken;
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
            const oauthToken = await this.oauthTokenRepository.findByUserAndProvider(
                options.userId,
                plugin.id,
            );
            if (!oauthToken) return null;

            const username = oauthToken.metadata?.login || oauthToken.username;
            const email = oauthToken.email;

            if (!username || !email) return null;

            return { name: username, email };
        } catch {
            return null;
        }
    }

    // User & Organization

    async getUser(options: GitFacadeOptions): Promise<GitUser> {
        const { plugin, token } = await this.resolvePluginAndToken(options);
        return plugin.getUser(token);
    }

    async getOrganizations(options: GitFacadeOptions): Promise<GitOrganization[]> {
        const { plugin, token } = await this.resolvePluginAndToken(options);
        return plugin.getOrganizations(token);
    }

    // Repository operations

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
    ): Promise<GitRepositoryWithPermissions[]> {
        const { plugin, token } = await this.resolvePluginAndToken(options);
        if (plugin.listRepositories) {
            return plugin.listRepositories(token, page, perPage);
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

    // Fork & Template

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

    // Branch operations

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

    // Content access methods (for analyzing repositories)

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

    // Pull Request operations

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

    // Local git operations

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

    // OAuth methods

    getOAuthUrl(providerId: string, state: string, config: Partial<OAuthConfig>): string {
        const plugin = this.getPluginSync(providerId);
        if (!isOAuthPlugin(plugin)) {
            throw new GitFacadeError('Plugin does not support OAuth', 'getOAuthUrl', providerId);
        }
        return (plugin as unknown as IOAuthPlugin).getAuthorizationUrl(state, config);
    }

    async exchangeCodeForToken(
        providerId: string,
        code: string,
        config: Partial<OAuthConfig>,
    ): Promise<OAuthToken> {
        const plugin = this.getPluginSync(providerId);
        if (!isOAuthPlugin(plugin)) {
            throw new GitFacadeError(
                'Plugin does not support OAuth',
                'exchangeCodeForToken',
                providerId,
            );
        }
        return (plugin as unknown as IOAuthPlugin).exchangeCodeForToken(code, config);
    }

    async getOAuthUser(providerId: string, token: string): Promise<OAuthUser> {
        const plugin = this.getPluginSync(providerId);
        if (!isOAuthPlugin(plugin)) {
            throw new GitFacadeError('Plugin does not support OAuth', 'getOAuthUser', providerId);
        }
        return (plugin as unknown as IOAuthPlugin).getAuthenticatedUser(token);
    }

    // URL building methods (provider-specific, synchronous)

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
            if (registered?.state === 'enabled') {
                return registered.plugin as IGitProviderPlugin;
            }
        }

        const enabled = plugins.find((p) => p.state === 'enabled');
        if (!enabled) {
            throw new NoGitProviderError();
        }
        return enabled.plugin as IGitProviderPlugin;
    }

    async removeLocalDir(providerId: string, owner: string, repo: string): Promise<void> {
        const plugin = this.getPluginSync(providerId);
        return plugin.removeLocalDir(owner, repo);
    }

    // Provider resolution

    private async resolvePluginAndToken(
        options: GitFacadeOptions,
    ): Promise<{ plugin: IGitProviderPlugin; token: string }> {
        const plugin = await this.resolvePlugin(
            options.providerId,
            options.userId,
            options.directoryId,
        );

        let token = options.token;
        if (!token && options.userId) {
            const oauthToken = await this.oauthTokenRepository.findByUserAndProvider(
                options.userId,
                plugin.id,
            );
            if (!oauthToken) {
                throw new NoGitCredentialsError(plugin.id, options.userId);
            }
            if (this.oauthTokenRepository.isTokenExpired(oauthToken)) {
                throw new NoGitCredentialsError(plugin.id, options.userId);
            }
            token = oauthToken.accessToken;
        }

        if (!token) {
            throw new GitFacadeError(
                'No token provided and no userId for OAuth lookup',
                'resolveToken',
                plugin.id,
            );
        }

        return { plugin, token };
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
            registered.state === 'enabled'
        ) {
            const isEnabled = await this.isPluginEnabled(providerId, directoryId, userId);
            if (isEnabled) {
                return registered.plugin as IGitProviderPlugin;
            }
        }
        throw new GitProviderNotFoundError(providerId);
    }

    private async isPluginEnabled(
        pluginId: string,
        directoryId?: string,
        userId?: string,
    ): Promise<boolean> {
        if (directoryId && this.directoryPluginRepository) {
            try {
                const dp = await this.directoryPluginRepository.findByDirectoryAndPlugin(
                    directoryId,
                    pluginId,
                );
                if (dp !== null) return dp.enabled;
            } catch {
                // Continue
            }
        }

        if (userId && this.userPluginRepository) {
            try {
                const up = await this.userPluginRepository.findByUserAndPlugin(userId, pluginId);
                if (up !== null) return up.enabled;
            } catch {
                // Continue
            }
        }

        const registered = this.registry.get(pluginId);
        return registered?.manifest?.autoEnable ?? true;
    }
}
