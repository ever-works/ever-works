import type {
	IPlugin,
	IGitProviderPlugin,
	IOAuthPlugin,
	PluginContext,
	PluginCategory,
	PluginManifest,
	PluginHealthCheck,
	JsonSchema,
	ValidationResult,
	PluginSettings,
	GitAuth,
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
	GitCloneOptions,
	GitPushOptions,
	GitCommitter,
	GitFileChange,
	OAuthConfig,
	OAuthToken,
	OAuthUser
} from '@ever-works/plugin';
import { GitOperations } from '@ever-works/plugin/git';
import { GitHubApiService } from './github-api.service.js';
import { GitHubActionsService } from './github-actions.service.js';
import type { GitHubSettings, GitHubPublicKey } from './types.js';

const DEFAULT_SCOPES = [
	'user:email',
	'read:user',
	'repo',
	'delete_repo',
	'workflow',
	'write:repo_hook',
	'read:org',
	'project'
] as const;

export class GitHubPlugin implements IPlugin, IGitProviderPlugin, IOAuthPlugin {
	readonly id = 'github';
	readonly name = 'GitHub';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'git-provider';
	readonly capabilities: readonly string[] = ['git-provider', 'oauth'];
	readonly providerName = 'github';

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			clientId: {
				type: 'string',
				title: 'Client ID',
				description: 'GitHub OAuth App Client ID',
				'x-envVar': 'PLUGIN_GITHUB_CLIENT_ID',
				'x-writeOnly': true,
				'x-adminOnly': true,
				'x-scope': 'global'
			},
			clientSecret: {
				type: 'string',
				title: 'Client Secret',
				description: 'GitHub OAuth App Client Secret',
				'x-secret': true,
				'x-masked': true,
				'x-writeOnly': true,
				'x-envVar': 'PLUGIN_GITHUB_CLIENT_SECRET',
				'x-adminOnly': true,
				'x-scope': 'global'
			},
			apiBaseUrl: {
				type: 'string',
				title: 'API Base URL',
				description: 'GitHub API base URL (for GitHub Enterprise)',
				default: 'https://api.github.com',
				'x-envVar': 'PLUGIN_GITHUB_API_URL',
				'x-scope': 'global'
			}
		}
	};

	readonly configurationMode: 'admin-only' | 'user-required' | 'hybrid' = 'admin-only';

	private context?: PluginContext;
	private gitOps?: GitOperations;
	private apiService = new GitHubApiService();
	private actionsService = new GitHubActionsService();

	// IGitProviderPlugin - Authentication

	getAuth(token: string): GitAuth {
		return { username: 'x-access-token', password: token };
	}

	getCloneUrl(owner: string, repo: string): string {
		return `https://github.com/${owner}/${repo}.git`;
	}

	getWebUrl(owner: string, repo: string): string {
		return `https://github.com/${owner}/${repo}`;
	}

	// IGitProviderPlugin - User & Organization

	async getUser(token: string): Promise<GitUser> {
		const settings = await this.getSettings();
		return this.apiService.getUser(token, settings.apiBaseUrl);
	}

	async getOrganizations(token: string): Promise<GitOrganization[]> {
		const settings = await this.getSettings();
		return this.apiService.getOrganizations(token, settings.apiBaseUrl);
	}

	// IGitProviderPlugin - Repository operations

	async getRepository(owner: string, repo: string, token: string): Promise<GitRepository | null> {
		const settings = await this.getSettings();
		return this.apiService.getRepository(owner, repo, token, settings.apiBaseUrl);
	}

	async listRepositories(token: string, page?: number, perPage?: number): Promise<GitRepositoryWithPermissions[]> {
		const settings = await this.getSettings();
		return this.apiService.listRepositories(token, page, perPage, settings.apiBaseUrl);
	}

	async createRepository(options: CreateRepoOptions, token: string): Promise<GitRepository> {
		const settings = await this.getSettings();
		return this.apiService.createRepository(options, token, settings.apiBaseUrl);
	}

	async deleteRepository(owner: string, repo: string, token: string): Promise<void> {
		const settings = await this.getSettings();
		return this.apiService.deleteRepository(owner, repo, token, settings.apiBaseUrl);
	}

	async updateRepository(
		owner: string,
		repo: string,
		data: { isPrivate?: boolean; description?: string },
		token: string
	): Promise<GitRepository> {
		const settings = await this.getSettings();
		return this.apiService.updateRepository(owner, repo, data, token, settings.apiBaseUrl);
	}

	async hasRepositoryAccess(owner: string, repo: string, token: string): Promise<boolean> {
		const settings = await this.getSettings();
		return this.apiService.hasRepositoryAccess(owner, repo, token, settings.apiBaseUrl);
	}

	// IGitProviderPlugin - Fork & Template

	async forkRepository(
		owner: string,
		repo: string,
		options: ForkRepositoryOptions,
		token: string
	): Promise<GitRepository | null> {
		const settings = await this.getSettings();
		return this.apiService.forkRepository(owner, repo, options, token, settings.apiBaseUrl);
	}

	async createRepositoryFromTemplate(
		templateOwner: string,
		templateRepo: string,
		options: CreateRepoOptions,
		token: string
	): Promise<GitRepository | null> {
		const settings = await this.getSettings();
		return this.apiService.createRepositoryFromTemplate(
			templateOwner,
			templateRepo,
			options,
			token,
			settings.apiBaseUrl
		);
	}

	async hasForkRelationship(
		forkOwner: string,
		forkRepo: string,
		parentOwner: string,
		parentRepo: string,
		token: string
	): Promise<boolean> {
		const settings = await this.getSettings();
		return this.apiService.hasForkRelationship(
			forkOwner,
			forkRepo,
			parentOwner,
			parentRepo,
			token,
			settings.apiBaseUrl
		);
	}

	async repositoryExists(owner: string, repo: string, token: string): Promise<boolean> {
		const settings = await this.getSettings();
		return this.apiService.repositoryExists(owner, repo, token, settings.apiBaseUrl);
	}

	// IGitProviderPlugin - Branch operations

	async listBranches(owner: string, repo: string, token: string): Promise<GitBranch[]> {
		const settings = await this.getSettings();
		return this.apiService.listBranches(owner, repo, token, settings.apiBaseUrl);
	}

	async createBranch(owner: string, repo: string, name: string, fromRef: string, token: string): Promise<GitBranch> {
		const settings = await this.getSettings();
		return this.apiService.createBranch(owner, repo, name, fromRef, token, settings.apiBaseUrl);
	}

	async deleteBranch(owner: string, repo: string, name: string, token: string): Promise<void> {
		const settings = await this.getSettings();
		return this.apiService.deleteBranch(owner, repo, name, token, settings.apiBaseUrl);
	}

	async getLatestCommit(owner: string, repo: string, branch: string, token: string): Promise<GitCommit | null> {
		const settings = await this.getSettings();
		return this.apiService.getLatestCommit(owner, repo, branch, token, settings.apiBaseUrl);
	}

	// IGitProviderPlugin - Pull Request operations

	async createPullRequest(options: CreatePROptions, token: string): Promise<GitPullRequest> {
		const settings = await this.getSettings();
		return this.apiService.createPullRequest(options, token, settings.apiBaseUrl);
	}

	async getPullRequest(owner: string, repo: string, prNumber: number, token: string): Promise<GitPullRequest | null> {
		const settings = await this.getSettings();
		return this.apiService.getPullRequest(owner, repo, prNumber, token, settings.apiBaseUrl);
	}

	async mergePullRequest(
		owner: string,
		repo: string,
		prNumber: number,
		options: MergeOptions | undefined,
		token: string
	): Promise<MergeResult> {
		const settings = await this.getSettings();
		return this.apiService.mergePullRequest(owner, repo, prNumber, options, token, settings.apiBaseUrl);
	}

	// Local git operations (via GitOperations)

	async cloneOrPull(options: GitCloneOptions): Promise<string> {
		this.ensureGitOps();
		return this.gitOps!.cloneOrPull(options);
	}

	async pull(dir: string, token: string, committer?: GitCommitter): Promise<void> {
		this.ensureGitOps();
		return this.gitOps!.pull(dir, token, committer);
	}

	async add(dir: string, paths: string | string[]): Promise<void> {
		this.ensureGitOps();
		return this.gitOps!.add(dir, paths);
	}

	async addAll(dir: string): Promise<void> {
		this.ensureGitOps();
		return this.gitOps!.addAll(dir);
	}

	async commit(dir: string, message: string, committer?: GitCommitter): Promise<string> {
		this.ensureGitOps();
		return this.gitOps!.commit(dir, message, committer);
	}

	async push(options: GitPushOptions): Promise<void> {
		this.ensureGitOps();
		return this.gitOps!.push(options);
	}

	async getCurrentBranch(dir: string): Promise<string | null> {
		this.ensureGitOps();
		return this.gitOps!.getCurrentBranch(dir);
	}

	async getMainBranch(dir: string): Promise<string | null> {
		this.ensureGitOps();
		return this.gitOps!.getMainBranch(dir);
	}

	async switchBranch(dir: string, branch: string, create?: boolean): Promise<string> {
		this.ensureGitOps();
		return this.gitOps!.switchBranch(dir, branch, create);
	}

	async getStatus(dir: string): Promise<GitFileChange[]> {
		this.ensureGitOps();
		return this.gitOps!.getStatus(dir);
	}

	getLocalDir(owner: string, repo: string): string {
		this.ensureGitOps();
		return this.gitOps!.getLocalDir(owner, repo);
	}

	async removeLocalDir(owner: string, repo: string): Promise<void> {
		this.ensureGitOps();
		return this.gitOps!.removeLocalDir(owner, repo);
	}

	// Content access methods

	async getFileContent(
		owner: string,
		repo: string,
		path: string,
		ref?: string,
		token?: string
	): Promise<{ content: string; encoding: string } | null> {
		const settings = await this.getSettings();
		return this.apiService.getFileContent(owner, repo, path, token || '', ref, settings.apiBaseUrl);
	}

	async getReadme(
		owner: string,
		repo: string,
		ref?: string,
		token?: string
	): Promise<{ content: string; path: string } | null> {
		const settings = await this.getSettings();
		return this.apiService.getReadme(owner, repo, token || '', ref, settings.apiBaseUrl);
	}

	getRawFileUrl(owner: string, repo: string, branch: string, path: string): string {
		return this.apiService.getRawFileUrl(owner, repo, branch, path);
	}

	async getDirectoryContents(
		owner: string,
		repo: string,
		path: string,
		token: string
	): Promise<Array<{ name: string; type: 'file' | 'dir' | 'submodule' | 'symlink'; path: string }> | null> {
		const settings = await this.getSettings();
		return this.apiService.getDirectoryContents(owner, repo, path, token, settings.apiBaseUrl);
	}

	// GitHub Actions specific operations

	async getRepositoryPublicKey(owner: string, repo: string, token: string): Promise<GitHubPublicKey> {
		const settings = await this.getSettings();
		return this.actionsService.getRepositoryPublicKey(owner, repo, token, settings.apiBaseUrl);
	}

	async setActionSecret(
		data: { key: string; value: string; repo: string; owner: string },
		publicKey: GitHubPublicKey,
		token: string
	): Promise<void> {
		const settings = await this.getSettings();
		return this.actionsService.setActionSecret(data, publicKey, token, settings.apiBaseUrl);
	}

	async setActionVariable(
		data: { key: string; value: string; repo: string; owner: string },
		token: string
	): Promise<void> {
		const settings = await this.getSettings();
		return this.actionsService.setActionVariable(data, token, settings.apiBaseUrl);
	}

	async enableDeploymentWorkflows(owner: string, repo: string, token: string, withDelay?: boolean): Promise<void> {
		const settings = await this.getSettings();
		return this.actionsService.enableDeploymentWorkflows(owner, repo, token, settings.apiBaseUrl, withDelay);
	}

	async dispatchWorkflow(
		data: {
			workflow: string;
			inputs?: Record<string, unknown>;
			branch: string;
			owner: string;
			repo: string;
		},
		token: string
	): Promise<void> {
		const settings = await this.getSettings();
		return this.actionsService.dispatchWorkflow(data, token, settings.apiBaseUrl);
	}

	// IOAuthPlugin implementation

	getAuthorizationUrl(state: string, config?: Partial<OAuthConfig>): string {
		const clientId = config?.clientId;
		const redirectUri = config?.redirectUri;
		const scopes = config?.scopes || DEFAULT_SCOPES;

		if (!clientId) {
			throw new Error('GitHub OAuth client ID not configured');
		}

		const params = new URLSearchParams({
			client_id: clientId,
			redirect_uri: redirectUri || '',
			scope: scopes.join(' '),
			state
		});

		return `https://github.com/login/oauth/authorize?${params.toString()}`;
	}

	async exchangeCodeForToken(code: string, config?: Partial<OAuthConfig>): Promise<OAuthToken> {
		const clientId = config?.clientId;
		const clientSecret = config?.clientSecret;
		const redirectUri = config?.redirectUri;

		if (!clientId || !clientSecret) {
			throw new Error('GitHub OAuth credentials not configured');
		}

		const response = await fetch('https://github.com/login/oauth/access_token', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json'
			},
			body: JSON.stringify({
				client_id: clientId,
				client_secret: clientSecret,
				code,
				redirect_uri: redirectUri
			})
		});

		const data = await response.json();

		if (data.error) {
			throw new Error(`GitHub OAuth error: ${data.error_description || data.error}`);
		}

		return {
			accessToken: data.access_token,
			tokenType: data.token_type || 'bearer',
			scope: data.scope,
			refreshToken: data.refresh_token
		};
	}

	async getAuthenticatedUser(token: string): Promise<OAuthUser> {
		const user = await this.getUser(token);
		return {
			id: user.id,
			username: user.login,
			email: user.email,
			name: user.name,
			avatarUrl: user.avatarUrl
		};
	}

	// IPlugin lifecycle

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		this.gitOps = new GitOperations(
			(token) => this.getAuth(token),
			(owner, repo) => this.getCloneUrl(owner, repo)
		);
		context.logger.log('GitHub Plugin loaded');
	}

	async onEnable(context: PluginContext): Promise<void> {
		context.logger.log('GitHub Plugin enabled');
	}

	async onDisable(context: PluginContext): Promise<void> {
		context.logger.log('GitHub Plugin disabled');
	}

	async onUnload(): Promise<void> {
		this.context = undefined;
		this.gitOps = undefined;
	}

	async validateSettings(settings: PluginSettings): Promise<ValidationResult> {
		const errors: Array<{ path: string; message: string }> = [];

		if (settings.apiBaseUrl && typeof settings.apiBaseUrl === 'string') {
			try {
				new URL(settings.apiBaseUrl);
			} catch {
				errors.push({
					path: 'apiBaseUrl',
					message: 'Invalid URL format'
				});
			}
		}

		return {
			valid: errors.length === 0,
			errors: errors.length > 0 ? errors : undefined
		};
	}

	async healthCheck(): Promise<PluginHealthCheck> {
		return {
			status: 'healthy',
			message: 'GitHub plugin is ready',
			checkedAt: Date.now()
		};
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description: 'GitHub integration for repository management, git operations, and GitHub Actions',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Ever Works Team' },
			license: 'MIT',
			builtIn: true,
			systemPlugin: true,
			autoInstall: true,
			autoEnable: true,
			visibility: 'user-only', // User-only, not shown in directory plugins list
			icon: {
				type: 'lucide',
				value: 'Github',
				backgroundColor: '#24292e'
			}
		};
	}

	// Private helpers

	private async getSettings(): Promise<GitHubSettings> {
		if (!this.context) {
			return {};
		}
		const settings = await this.context.getSettings();
		return {
			clientId: settings?.clientId as string | undefined,
			clientSecret: settings?.clientSecret as string | undefined,
			apiBaseUrl: (settings?.apiBaseUrl as string) || 'https://api.github.com'
		};
	}

	private ensureGitOps(): void {
		if (!this.gitOps) {
			this.gitOps = new GitOperations(
				(token) => this.getAuth(token),
				(owner, repo) => this.getCloneUrl(owner, repo)
			);
		}
	}
}

export default GitHubPlugin;
