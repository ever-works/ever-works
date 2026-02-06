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
				'x-adminOnly': true,
				'x-scope': 'global'
			},
			clientSecret: {
				type: 'string',
				title: 'Client Secret',
				description: 'GitHub OAuth App Client Secret',
				'x-secret': true,
				'x-envVar': 'PLUGIN_GITHUB_CLIENT_SECRET',
				'x-adminOnly': true,
				'x-scope': 'global'
			},
			apiBaseUrl: {
				type: 'string',
				title: 'API Base URL',
				description: 'GitHub API base URL (for GitHub Enterprise)',
				default: 'https://api.github.com',
				'x-hidden': true,
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
		const forceConsent = config?.forceConsent || false;

		if (!clientId) {
			throw new Error('GitHub OAuth client ID not configured');
		}

		const params = new URLSearchParams({
			client_id: clientId,
			redirect_uri: redirectUri || '',
			scope: scopes.join(' '),
			...(forceConsent && { prompt: 'consent' }),
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
			description: 'Connect to GitHub for source code management and deployment workflows',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Ever Works Team' },
			license: 'MIT',
			builtIn: true,
			systemPlugin: true,
			autoEnable: true,
			visibility: 'user-only', // User-only, not shown in directory plugins list
			readme: [
				'## What does the GitHub plugin do?',
				'',
				'This plugin provides the Git operations and OAuth integration that underpin the deployment pipeline. It manages repositories, branches, commits, and pull requests on GitHub, and enables GitHub-based authentication.',
				'',
				'## Key features',
				'',
				'- **OAuth authentication** — sign in to Ever Works using a GitHub account',
				'- **Repository management** — automatically creates and manages repositories for deployed directories',
				'- **Git operations** — handles cloning, committing, pushing, and branch management',
				'- **Pull request workflow** — creates and merges pull requests as part of the deployment process',
				'',
				'## How it works in Ever Works',
				'',
				'GitHub is a core component of the deployment pipeline. When a directory is deployed, Ever Works creates or updates a GitHub repository with the generated site, commits the changes, and triggers a GitHub Actions workflow that builds and deploys to the hosting provider. The OAuth facade also uses this plugin to handle GitHub-based sign-in.',
				'',
				'## Getting started',
				'',
				'The GitHub plugin is managed by the platform administrator. If you signed in with GitHub, it is already connected. The admin configures GitHub OAuth app credentials at the platform level.'
			].join('\n'),
			icon: {
				type: 'svg',
				value: '<svg fill="#000000" viewBox="0 -0.5 25 25" xmlns="http://www.w3.org/2000/svg"><g id="SVGRepo_bgCarrier" stroke-width="0"></g><g id="SVGRepo_tracerCarrier" stroke-linecap="round" stroke-linejoin="round"></g><g id="SVGRepo_iconCarrier"><path d="m12.301 0h.093c2.242 0 4.34.613 6.137 1.68l-.055-.031c1.871 1.094 3.386 2.609 4.449 4.422l.031.058c1.04 1.769 1.654 3.896 1.654 6.166 0 5.406-3.483 10-8.327 11.658l-.087.026c-.063.02-.135.031-.209.031-.162 0-.312-.054-.433-.144l.002.001c-.128-.115-.208-.281-.208-.466 0-.005 0-.01 0-.014v.001q0-.048.008-1.226t.008-2.154c.007-.075.011-.161.011-.249 0-.792-.323-1.508-.844-2.025.618-.061 1.176-.163 1.718-.305l-.076.017c.573-.16 1.073-.373 1.537-.642l-.031.017c.508-.28.938-.636 1.292-1.058l.006-.007c.372-.476.663-1.036.84-1.645l.009-.035c.209-.683.329-1.468.329-2.281 0-.045 0-.091-.001-.136v.007c0-.022.001-.047.001-.072 0-1.248-.482-2.383-1.269-3.23l.003.003c.168-.44.265-.948.265-1.479 0-.649-.145-1.263-.404-1.814l.011.026c-.115-.022-.246-.035-.381-.035-.334 0-.649.078-.929.216l.012-.005c-.568.21-1.054.448-1.512.726l.038-.022-.609.384c-.922-.264-1.981-.416-3.075-.416s-2.153.152-3.157.436l.081-.02q-.256-.176-.681-.433c-.373-.214-.814-.421-1.272-.595l-.066-.022c-.293-.154-.64-.244-1.009-.244-.124 0-.246.01-.364.03l.013-.002c-.248.524-.393 1.139-.393 1.788 0 .531.097 1.04.275 1.509l-.01-.029c-.785.844-1.266 1.979-1.266 3.227 0 .025 0 .051.001.076v-.004c-.001.039-.001.084-.001.13 0 .809.12 1.591.344 2.327l-.015-.057c.189.643.476 1.202.85 1.693l-.009-.013c.354.435.782.793 1.267 1.062l.022.011c.432.252.933.465 1.46.614l.046.011c.466.125 1.024.227 1.595.284l.046.004c-.431.428-.718 1-.784 1.638l-.001.012c-.207.101-.448.183-.699.236l-.021.004c-.256.051-.549.08-.85.08-.022 0-.044 0-.066 0h.003c-.394-.008-.756-.136-1.055-.348l.006.004c-.371-.259-.671-.595-.881-.986l-.007-.015c-.198-.336-.459-.614-.768-.827l-.009-.006c-.225-.169-.49-.301-.776-.38l-.016-.004-.32-.048c-.023-.002-.05-.003-.077-.003-.14 0-.273.028-.394.077l.007-.003q-.128.072-.08.184c.039.086.087.16.145.225l-.001-.001c.061.072.13.135.205.19l.003.002.112.08c.283.148.516.354.693.603l.004.006c.191.237.359.505.494.792l.01.024.16.368c.135.402.38.738.7.981l.005.004c.3.234.662.402 1.057.478l.016.002c.33.064.714.104 1.106.112h.007c.045.002.097.002.15.002.261 0 .517-.021.767-.062l-.027.004.368-.064q0 .609.008 1.418t.008.873v.014c0 .185-.08.351-.208.466h-.001c-.119.089-.268.143-.431.143-.075 0-.147-.011-.214-.032l.005.001c-4.929-1.689-8.409-6.283-8.409-11.69 0-2.268.612-4.393 1.681-6.219l-.032.058c1.094-1.871 2.609-3.386 4.422-4.449l.058-.031c1.739-1.034 3.835-1.645 6.073-1.645h.098-.005zm-7.64 17.666q.048-.112-.112-.192-.16-.048-.208.032-.048.112.112.192.144.096.208-.032zm.497.545q.112-.08-.032-.256-.16-.144-.256-.048-.112.08.032.256.159.157.256.047zm.48.72q.144-.112 0-.304-.128-.208-.272-.096-.144.08 0 .288t.272.112zm.672.673q.128-.128-.064-.304-.192-.192-.32-.048-.144.128.064.304.192.192.32.044zm.913.4q.048-.176-.208-.256-.24-.064-.304.112t.208.24q.24.097.304-.096zm1.009.08q0-.208-.272-.176-.256 0-.256.176 0 .208.272.176.256.001.256-.175zm.929-.16q-.032-.176-.288-.144-.256.048-.224.24t.288.128.225-.224z"></path></g></svg>',
				darkValue: `<svg fill="#fff" viewBox="0 -0.5 25 25" xmlns="http://www.w3.org/2000/svg"><g id="SVGRepo_bgCarrier" stroke-width="0"></g><g id="SVGRepo_tracerCarrier" stroke-linecap="round" stroke-linejoin="round"></g><g id="SVGRepo_iconCarrier"><path d="m12.301 0h.093c2.242 0 4.34.613 6.137 1.68l-.055-.031c1.871 1.094 3.386 2.609 4.449 4.422l.031.058c1.04 1.769 1.654 3.896 1.654 6.166 0 5.406-3.483 10-8.327 11.658l-.087.026c-.063.02-.135.031-.209.031-.162 0-.312-.054-.433-.144l.002.001c-.128-.115-.208-.281-.208-.466 0-.005 0-.01 0-.014v.001q0-.048.008-1.226t.008-2.154c.007-.075.011-.161.011-.249 0-.792-.323-1.508-.844-2.025.618-.061 1.176-.163 1.718-.305l-.076.017c.573-.16 1.073-.373 1.537-.642l-.031.017c.508-.28.938-.636 1.292-1.058l.006-.007c.372-.476.663-1.036.84-1.645l.009-.035c.209-.683.329-1.468.329-2.281 0-.045 0-.091-.001-.136v.007c0-.022.001-.047.001-.072 0-1.248-.482-2.383-1.269-3.23l.003.003c.168-.44.265-.948.265-1.479 0-.649-.145-1.263-.404-1.814l.011.026c-.115-.022-.246-.035-.381-.035-.334 0-.649.078-.929.216l.012-.005c-.568.21-1.054.448-1.512.726l.038-.022-.609.384c-.922-.264-1.981-.416-3.075-.416s-2.153.152-3.157.436l.081-.02q-.256-.176-.681-.433c-.373-.214-.814-.421-1.272-.595l-.066-.022c-.293-.154-.64-.244-1.009-.244-.124 0-.246.01-.364.03l.013-.002c-.248.524-.393 1.139-.393 1.788 0 .531.097 1.04.275 1.509l-.01-.029c-.785.844-1.266 1.979-1.266 3.227 0 .025 0 .051.001.076v-.004c-.001.039-.001.084-.001.13 0 .809.12 1.591.344 2.327l-.015-.057c.189.643.476 1.202.85 1.693l-.009-.013c.354.435.782.793 1.267 1.062l.022.011c.432.252.933.465 1.46.614l.046.011c.466.125 1.024.227 1.595.284l.046.004c-.431.428-.718 1-.784 1.638l-.001.012c-.207.101-.448.183-.699.236l-.021.004c-.256.051-.549.08-.85.08-.022 0-.044 0-.066 0h.003c-.394-.008-.756-.136-1.055-.348l.006.004c-.371-.259-.671-.595-.881-.986l-.007-.015c-.198-.336-.459-.614-.768-.827l-.009-.006c-.225-.169-.49-.301-.776-.38l-.016-.004-.32-.048c-.023-.002-.05-.003-.077-.003-.14 0-.273.028-.394.077l.007-.003q-.128.072-.08.184c.039.086.087.16.145.225l-.001-.001c.061.072.13.135.205.19l.003.002.112.08c.283.148.516.354.693.603l.004.006c.191.237.359.505.494.792l.01.024.16.368c.135.402.38.738.7.981l.005.004c.3.234.662.402 1.057.478l.016.002c.33.064.714.104 1.106.112h.007c.045.002.097.002.15.002.261 0 .517-.021.767-.062l-.027.004.368-.064q0 .609.008 1.418t.008.873v.014c0 .185-.08.351-.208.466h-.001c-.119.089-.268.143-.431.143-.075 0-.147-.011-.214-.032l.005.001c-4.929-1.689-8.409-6.283-8.409-11.69 0-2.268.612-4.393 1.681-6.219l-.032.058c1.094-1.871 2.609-3.386 4.422-4.449l.058-.031c1.739-1.034 3.835-1.645 6.073-1.645h.098-.005zm-7.64 17.666q.048-.112-.112-.192-.16-.048-.208.032-.048.112.112.192.144.096.208-.032zm.497.545q.112-.08-.032-.256-.16-.144-.256-.048-.112.08.032.256.159.157.256.047zm.48.72q.144-.112 0-.304-.128-.208-.272-.096-.144.08 0 .288t.272.112zm.672.673q.128-.128-.064-.304-.192-.192-.32-.048-.144.128.064.304.192.192.32.044zm.913.4q.048-.176-.208-.256-.24-.064-.304.112t.208.24q.24.097.304-.096zm1.009.08q0-.208-.272-.176-.256 0-.256.176 0 .208.272.176.256.001.256-.175zm.929-.16q-.032-.176-.288-.144-.256.048-.224.24t.288.128.225-.224z"></path></g></svg>`
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
