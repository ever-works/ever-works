import type {
	IPlugin,
	IDeploymentPlugin,
	IOAuthPlugin,
	PluginContext,
	PluginCategory,
	PluginManifest,
	PluginHealthCheck,
	JsonSchema,
	DeploymentConfig,
	DeploymentResult,
	DeploymentProject,
	DeploymentDomain,
	AddDomainResult,
	ConnectionValidationResult,
	OAuthConfig,
	OAuthToken,
	OAuthUser
} from '@ever-works/plugin';
import { VercelApiService } from './vercel-api.service.js';
import type { VercelSettings } from './types.js';

/**
 * Environment variables that configure the Vercel OAuth ("Connect with Vercel")
 * Integration. These are set by the platform administrator AFTER registering a
 * Vercel OAuth Integration in the Vercel dashboard (which issues the
 * client_id/client_secret + URL slug). Until all three are present the plugin
 * keeps the manual API-token flow as the only path (see `isOAuthConfigured`).
 */
const ENV_OAUTH_CLIENT_ID = 'VERCEL_OAUTH_CLIENT_ID';
const ENV_OAUTH_CLIENT_SECRET = 'VERCEL_OAUTH_CLIENT_SECRET';
const ENV_INTEGRATION_SLUG = 'VERCEL_INTEGRATION_SLUG';

/**
 * Default OAuth scopes requested for the Vercel Integration. For classic
 * Vercel integrations the effective scopes are defined in the Integration
 * Console rather than the authorize URL, but they are still included for
 * providers/flows that honor the `scope` query parameter and for parity with
 * the GitHub plugin's scope handling.
 * @see https://vercel.com/docs/integrations/create-integration/vercel-api-integrations#scopes
 */
const VERCEL_OAUTH_SCOPES: readonly string[] = ['user', 'team', 'project', 'deployment', 'domain'];

/**
 * Vercel deployment plugin
 *
 * Provides deployment capabilities to Vercel.
 * Uses 'user-required' configuration mode - users MUST provide their own Vercel token.
 *
 * Also implements the OAuth ("Connect with Vercel") capability. The `oauth`
 * capability is env-gated: it is only advertised once a Vercel OAuth
 * Integration has been registered and its credentials wired via the
 * `VERCEL_OAUTH_CLIENT_ID` / `VERCEL_OAUTH_CLIENT_SECRET` /
 * `VERCEL_INTEGRATION_SLUG` env vars. Before that, the plugin falls back to the
 * manual `apiToken` field so nothing breaks.
 */
export class VercelPlugin implements IPlugin, IDeploymentPlugin, IOAuthPlugin {
	readonly id = 'vercel';
	readonly name = 'Vercel';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'deployment';
	readonly providerName = 'vercel';

	/**
	 * Capabilities are env-gated: the `oauth` capability is only advertised when
	 * a Vercel OAuth Integration is configured (see `isOAuthConfigured`). When it
	 * is not, only `deployment` is advertised and the UI keeps showing the manual
	 * API-token field (the fallback). This is a getter (not a static field) so
	 * the live signal is correct for the OAuth facade's `isOAuthPlugin()` gate
	 * and other consumers that read the plugin instance directly.
	 */
	get capabilities(): readonly string[] {
		return this.isOAuthConfigured() ? ['deployment', 'oauth'] : ['deployment'];
	}

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			apiToken: {
				type: 'string',
				title: 'Vercel API Token',
				description: 'Your personal Vercel API token. Get one from https://vercel.com/account/tokens',
				'x-secret': true,
				'x-scope': 'user'
			},
			clientId: {
				type: 'string',
				title: 'OAuth Client ID',
				description: 'Vercel OAuth Integration Client ID (from the Vercel Integration Console)',
				'x-envVar': ENV_OAUTH_CLIENT_ID,
				'x-adminOnly': true,
				'x-scope': 'global'
			},
			clientSecret: {
				type: 'string',
				title: 'OAuth Client Secret',
				description: 'Vercel OAuth Integration Client Secret (from the Vercel Integration Console)',
				'x-secret': true,
				'x-envVar': ENV_OAUTH_CLIENT_SECRET,
				'x-adminOnly': true,
				'x-scope': 'user'
			},
			integrationSlug: {
				type: 'string',
				title: 'Integration URL slug',
				description:
					'Vercel Integration URL slug used to build the install/authorize URL (https://vercel.com/integrations/<slug>/new)',
				'x-envVar': ENV_INTEGRATION_SLUG,
				'x-adminOnly': true,
				'x-scope': 'global'
			}
		},
		required: ['apiToken']
	};

	readonly configurationMode: 'admin-only' | 'user-required' | 'hybrid' = 'user-required';

	private context?: PluginContext;
	private apiService = new VercelApiService();

	// IDeploymentPlugin implementation

	async deploy(config: DeploymentConfig, token: string): Promise<DeploymentResult> {
		// This plugin doesn't handle direct deployment via the SDK
		// Deployment is triggered via GitHub Actions workflow dispatch
		// The deploy method is called by the DeployFacade but actual deployment
		// is orchestrated through git operations
		return {
			id: `pending-${Date.now()}`,
			status: 'pending',
			createdAt: new Date().toISOString()
		};
	}

	async getDeploymentStatus(deploymentId: string, token: string): Promise<DeploymentResult> {
		// For workflow-based deployments, status is tracked through the verifier service
		return {
			id: deploymentId,
			status: 'pending',
			createdAt: new Date().toISOString()
		};
	}

	async validateToken(token: string): Promise<boolean> {
		const user = await this.apiService.validateToken(token);
		return user !== null;
	}

	async getTeams(token: string): Promise<Array<{ id: string; slug: string; name: string | null }>> {
		return this.apiService.getTeams(token);
	}

	async lookupExistingDeployment(
		projectName: string,
		token: string,
		teamScope?: string
	): Promise<{
		found: boolean;
		website?: string;
		deploymentState?: string;
		projectId?: string;
	}> {
		if (teamScope) {
			// Search in specific team scope
			const result = await this.apiService.lookupProject(projectName, token, teamScope);
			return {
				found: result.found,
				website: result.website,
				deploymentState: result.deploymentState,
				projectId: result.project?.id
			};
		}

		// Search across all scopes
		// Security: require an exact project-name match instead of a substring match. The
		// Vercel `search` query already performs prefix filtering server-side, so a loose
		// `includes` could match a different project (e.g. searching `my-site` matching
		// `my-site-v2`), letting a strategically named project hijack another work's
		// deployment lookup. Exact equality mirrors the primary check in `lookupProject`.
		const result = await this.apiService.lookupDeploymentAcrossScopes(
			projectName,
			token,
			(project) => project.name === projectName
		);
		return {
			found: result.found,
			website: result.website,
			deploymentState: result.deploymentState,
			projectId: result.projectId
		};
	}

	async validateConnection(settings: Record<string, unknown>): Promise<ConnectionValidationResult> {
		const token = settings.apiToken as string | undefined;
		if (!token) {
			return { success: false, message: 'Enter a Vercel API token before validating.' };
		}
		const valid = await this.validateToken(token);
		if (!valid) {
			return { success: false, message: 'Vercel rejected the API token.' };
		}
		// `getAuthenticatedUser` throws if the identity lookup fails (OAuth
		// contract); the token was just validated so this normally succeeds, but
		// degrade to a generic success message rather than surfacing a throw.
		let user: OAuthUser | null = null;
		try {
			user = await this.getAuthenticatedUser(token);
		} catch {
			user = null;
		}
		return {
			success: true,
			message: user?.username ? `Connected to Vercel as ${user.username}.` : 'Vercel connection verified.',
			details: user ? { username: user.username, email: user.email } : undefined
		};
	}

	/**
	 * IOAuthPlugin + IDeploymentPlugin: resolve the identity behind a token.
	 * Returns the richer `OAuthUser` shape (which is structurally assignable to
	 * the deployment interface's `{ username; email? }`). Throws when the token
	 * resolves to no user — the OAuth facade calls this straight after a token
	 * exchange and dereferences `user.id`/`user.username`, so a null would break
	 * it; a throw is surfaced as a clear connection error instead.
	 */
	async getAuthenticatedUser(token: string): Promise<OAuthUser> {
		const user = await this.apiService.validateToken(token);
		if (!user) {
			throw new Error('Failed to resolve Vercel user for the provided token');
		}
		return {
			id: user.id,
			username: user.username || user.name || user.email,
			email: user.email,
			name: user.name
		};
	}

	// IOAuthPlugin implementation ("Connect with Vercel")
	//
	// Uses Vercel's classic Integration OAuth flow: the user is sent to the
	// integration's install/authorize URL, and the returned `code` is exchanged
	// server-side for a long-lived access token.
	// @see https://vercel.com/docs/integrations/create-integration/vercel-api-integrations#create-an-access-token

	/**
	 * Build the Vercel Integration install/authorize URL. For classic Vercel
	 * integrations the entry point is `https://vercel.com/integrations/<slug>/new`;
	 * Vercel echoes the `state` back to the configured Redirect URL together with
	 * the `code`. `clientId`/`redirectUri`/`scopes` come from the generic OAuth
	 * service config (env-resolved via the settings `x-envVar` bindings); the
	 * integration slug is not part of the generic `OAuthConfig`, so it is read
	 * from `VERCEL_INTEGRATION_SLUG` (its declared `x-envVar`).
	 * @see https://vercel.com/docs/integrations/create-integration/vercel-api-integrations
	 */
	getAuthorizationUrl(state: string, config?: Partial<OAuthConfig>): string {
		const slug = this.getIntegrationSlug();
		if (!slug) {
			throw new Error(`Vercel OAuth is not configured: set ${ENV_INTEGRATION_SLUG}`);
		}

		const clientId = config?.clientId || process.env[ENV_OAUTH_CLIENT_ID];
		if (!clientId) {
			throw new Error(`Vercel OAuth client ID not configured: set ${ENV_OAUTH_CLIENT_ID}`);
		}

		const redirectUri = config?.redirectUri;
		const scopes = config?.scopes && config.scopes.length > 0 ? config.scopes : VERCEL_OAUTH_SCOPES;

		const params = new URLSearchParams({
			client_id: clientId,
			state,
			scope: scopes.join(' ')
		});
		// The Redirect URL is primarily configured in the Integration Console;
		// passing it here keeps parity with providers that honor it and makes the
		// intended callback explicit.
		if (redirectUri) {
			params.set('redirect_uri', redirectUri);
		}

		return `https://vercel.com/integrations/${encodeURIComponent(slug)}/new?${params.toString()}`;
	}

	/**
	 * Exchange the authorization `code` for a long-lived access token via
	 * `POST https://api.vercel.com/v2/oauth/access_token`. The body MUST be
	 * `application/x-www-form-urlencoded` with `client_id`, `client_secret`,
	 * `code`, and `redirect_uri`.
	 * @see https://vercel.com/docs/integrations/create-integration/vercel-api-integrations#exchange-code-for-access-token
	 */
	async exchangeCodeForToken(code: string, config?: Partial<OAuthConfig>): Promise<OAuthToken> {
		const clientId = config?.clientId || process.env[ENV_OAUTH_CLIENT_ID];
		const clientSecret = config?.clientSecret || process.env[ENV_OAUTH_CLIENT_SECRET];
		const redirectUri = config?.redirectUri;

		if (!clientId || !clientSecret) {
			throw new Error(
				`Vercel OAuth credentials not configured: set ${ENV_OAUTH_CLIENT_ID} and ${ENV_OAUTH_CLIENT_SECRET}`
			);
		}

		const body = new URLSearchParams({
			client_id: clientId,
			client_secret: clientSecret,
			code
		});
		if (redirectUri) {
			body.set('redirect_uri', redirectUri);
		}

		const response = await fetch('https://api.vercel.com/v2/oauth/access_token', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
				Accept: 'application/json'
			},
			body: body.toString()
		});

		const data = (await response.json().catch(() => ({}))) as {
			access_token?: string;
			token_type?: string;
			scope?: string;
			error?: string;
			error_description?: string;
		};

		if (!response.ok || data.error || !data.access_token) {
			// Security (log-injection): `error`/`error_description` are
			// attacker-influenceable strings from the OAuth authorization server.
			// Strip control characters and cap the length before surfacing them in
			// a thrown (and likely logged) Error. Mirrors the GitHub plugin.
			const detail = String(data.error_description || data.error || `HTTP ${response.status}`)
				// eslint-disable-next-line no-control-regex
				.replace(/[\x00-\x1f\x7f]+/g, ' ')
				.trim()
				.slice(0, 300);
			throw new Error(`Vercel OAuth error: ${detail}`);
		}

		return {
			accessToken: data.access_token,
			tokenType: data.token_type || 'bearer',
			scope: data.scope
		};
	}

	async listProjects(token: string): Promise<DeploymentProject[]> {
		const settings = await this.getSettings();
		const projects = await this.apiService.getProjects(token, {
			teamScope: settings.defaultTeamScope
		});
		return projects.map((p) => ({
			id: p.id,
			name: p.name,
			createdAt: new Date().toISOString()
		}));
	}

	async getProject(projectId: string, token: string): Promise<DeploymentProject | null> {
		const settings = await this.getSettings();
		const projects = await this.apiService.getProjects(token, {
			teamScope: settings.defaultTeamScope
		});
		const project = projects.find((p) => p.id === projectId);
		if (!project) {
			return null;
		}
		return {
			id: project.id,
			name: project.name,
			createdAt: new Date().toISOString()
		};
	}

	// Domain management methods

	async getDomains(projectId: string, token: string, teamScope?: string): Promise<DeploymentDomain[]> {
		const domains = await this.apiService.getProjectDomains(projectId, token, teamScope);
		return domains.map((d) => ({
			name: d.name,
			verified: d.verified,
			verification: d.verification
		}));
	}

	async addDomain(projectId: string, domain: string, token: string, teamScope?: string): Promise<AddDomainResult> {
		const result = await this.apiService.addProjectDomain(projectId, domain, token, teamScope);
		return {
			domain: {
				name: result.name,
				verified: result.verified,
				verification: result.verification
			},
			verified: result.verified
		};
	}

	async removeDomain(projectId: string, domain: string, token: string, teamScope?: string): Promise<boolean> {
		return this.apiService.removeProjectDomain(projectId, domain, token, teamScope);
	}

	async verifyDomain(
		projectId: string,
		domain: string,
		token: string,
		teamScope?: string
	): Promise<DeploymentDomain> {
		const result = await this.apiService.verifyProjectDomain(projectId, domain, token, teamScope);
		return {
			name: result.name,
			verified: result.verified,
			verification: result.verification
		};
	}

	getWorkflowFilenames(): string[] {
		return ['deploy_vercel.yaml', 'deploy_prod.yaml'];
	}

	async getDeploymentSecrets(_settings: Record<string, unknown>): Promise<Record<string, string>> {
		return {};
	}

	// IPlugin lifecycle

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		context.logger.log('Vercel Plugin loaded');
	}

	async onUnload(): Promise<void> {
		this.context = undefined;
	}

	async healthCheck(): Promise<PluginHealthCheck> {
		return {
			status: 'healthy',
			message: 'Vercel plugin is ready',
			checkedAt: Date.now()
		};
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description: 'Publish your work as a live website on Vercel',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Ever Works Team' },
			license: 'AGPL-3.0',
			builtIn: true,
			systemPlugin: true,
			autoEnable: true,
			visibility: 'user-only',
			defaultForCapabilities: ['deployment'],
			readme: [
				'## What does the Vercel plugin do?',
				'',
				'This plugin deploys your work as a live, publicly accessible website on Vercel. Once configured, publishing a work produces a shareable URL backed by a global CDN.',
				'',
				'## Why use it?',
				'',
				'- **One-click publish** — deploy a work as a live website directly from Ever Works',
				'- **Global CDN** — Vercel serves your site from edge locations worldwide for fast load times',
				'- **Automatic HTTPS** — every deployment receives a secure URL by default',
				'- **Custom domains** — connect your own domain through the Vercel dashboard',
				'',
				'## How it works in Ever Works',
				'',
				'When you deploy a work, Ever Works pushes the generated site to a GitHub repository and triggers a Vercel build through a GitHub Actions workflow. Vercel builds and hosts the site as a static website. The deployment facade tracks build status and provides the resulting deployment URL.',
				'',
				'## Getting started',
				'',
				'1. Create a Vercel account at [vercel.com](https://vercel.com)',
				'2. Generate an API token from [vercel.com/account/tokens](https://vercel.com/account/tokens)',
				'3. Enter your token in the settings below',
				'4. Save settings to verify the token before using it for deployments',
				'',
				'## Connect with Vercel (OAuth)',
				'',
				'If the platform administrator has registered a Vercel OAuth Integration, you can connect your Vercel account with one click instead of pasting an API token. The manual API-token field above always remains available as a fallback.'
			].join('\n'),
			homepage: 'https://vercel.com/account/tokens',
			uiHints: {
				setupLink: {
					url: 'https://vercel.com/account/tokens',
					label: 'Vercel Tokens',
					buttonLabel: 'Get Vercel API token',
					showWhenEmpty: ['apiToken']
				},
				includeInOnboarding: true,
				onboardingPriority: 4,
				completionFields: ['apiToken'],
				onboardingDescription: 'Add a Vercel token to publish your works as live websites.',
				showReadmeInOnboarding: true
			},
			icon: {
				type: 'lucide',
				value: 'Triangle',
				backgroundColor: '#000000'
			}
		};
	}

	// Expose API service for direct use by facades
	getApiService(): VercelApiService {
		return this.apiService;
	}

	// Private helpers

	private async getSettings(): Promise<VercelSettings> {
		if (!this.context) {
			return {};
		}
		const settings = await this.context.getSettings();
		return {
			apiToken: settings?.apiToken as string | undefined,
			defaultTeamScope: settings?.defaultTeamScope as string | undefined,
			clientId: settings?.clientId as string | undefined,
			clientSecret: settings?.clientSecret as string | undefined,
			integrationSlug: settings?.integrationSlug as string | undefined
		};
	}

	/**
	 * The integration slug used to build the install/authorize URL. Read from
	 * the declared `VERCEL_INTEGRATION_SLUG` env var. `getAuthorizationUrl` is
	 * synchronous (per the IOAuthPlugin contract) and the slug is not part of the
	 * generic `OAuthConfig`, so it is resolved from the environment directly —
	 * the same pattern other bundled plugins (aws-s3, cloudflare-dns) use for
	 * env-sourced settings.
	 */
	private getIntegrationSlug(): string | undefined {
		const slug = process.env[ENV_INTEGRATION_SLUG];
		return slug && slug.trim().length > 0 ? slug.trim() : undefined;
	}

	/**
	 * True only when the Vercel OAuth Integration is fully wired via env vars
	 * (client id + secret + integration slug). Gates the `oauth` capability so it
	 * is advertised only once the owner has registered the integration; before
	 * that the plugin keeps the manual `apiToken` field as the working fallback.
	 *
	 * Env-based (not settings-based) because `capabilities` is a synchronous
	 * getter with no async settings access, and env vars are the documented
	 * activation mechanism.
	 */
	private isOAuthConfigured(): boolean {
		return (
			!!process.env[ENV_OAUTH_CLIENT_ID] && !!process.env[ENV_OAUTH_CLIENT_SECRET] && !!this.getIntegrationSlug()
		);
	}
}

export default VercelPlugin;
