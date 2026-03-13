import type {
	IPlugin,
	IDeploymentPlugin,
	PluginContext,
	PluginCategory,
	PluginManifest,
	PluginHealthCheck,
	JsonSchema,
	DeploymentConfig,
	DeploymentResult,
	DeploymentProject,
	DeploymentDomain,
	AddDomainResult
} from '@ever-works/plugin';
import { VercelApiService } from './vercel-api.service.js';
import type { VercelSettings } from './types.js';

/**
 * Vercel deployment plugin
 *
 * Provides deployment capabilities to Vercel.
 * Uses 'user-required' configuration mode - users MUST provide their own Vercel token.
 */
export class VercelPlugin implements IPlugin, IDeploymentPlugin {
	readonly id = 'vercel';
	readonly name = 'Vercel';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'deployment';
	readonly capabilities: readonly string[] = ['deployment'];
	readonly providerName = 'vercel';

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			apiToken: {
				type: 'string',
				title: 'Vercel API Token',
				description: 'Your personal Vercel API token. Get one from https://vercel.com/account/tokens',
				'x-secret': true,
				'x-scope': 'user'
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
		const result = await this.apiService.lookupDeploymentAcrossScopes(projectName, token, (project) =>
			project.name.includes(projectName)
		);
		return {
			found: result.found,
			website: result.website,
			deploymentState: result.deploymentState,
			projectId: result.projectId
		};
	}

	async validateConnection(settings: Record<string, unknown>): Promise<{
		success: boolean;
		message: string;
		details?: Record<string, unknown>;
	}> {
		const token = settings.apiToken as string | undefined;
		if (!token) {
			return { success: false, message: 'Enter a Vercel API token before validating.' };
		}
		const valid = await this.validateToken(token);
		if (!valid) {
			return { success: false, message: 'Vercel rejected the API token.' };
		}
		const user = await this.getAuthenticatedUser(token);
		return {
			success: true,
			message: user?.username ? `Connected to Vercel as ${user.username}.` : 'Vercel connection verified.',
			details: user ? { username: user.username, email: user.email } : undefined
		};
	}

	async getAuthenticatedUser(token: string): Promise<{ username: string; email?: string } | null> {
		const user = await this.apiService.validateToken(token);
		if (!user) {
			return null;
		}
		return {
			username: user.username || user.name || user.email,
			email: user.email
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
			description: 'Publish your directory as a live website on Vercel',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Ever Works Team' },
			license: 'MIT',
			builtIn: true,
			systemPlugin: true,
			autoEnable: true,
			visibility: 'user-only',
			defaultForCapabilities: ['deployment'],
			readme: [
				'## What does the Vercel plugin do?',
				'',
				'This plugin deploys your directory as a live, publicly accessible website on Vercel. Once configured, publishing a directory produces a shareable URL backed by a global CDN.',
				'',
				'## Why use it?',
				'',
				'- **One-click publish** — deploy a directory as a live website directly from Ever Works',
				'- **Global CDN** — Vercel serves your site from edge locations worldwide for fast load times',
				'- **Automatic HTTPS** — every deployment receives a secure URL by default',
				'- **Custom domains** — connect your own domain through the Vercel dashboard',
				'',
				'## How it works in Ever Works',
				'',
				'When you deploy a directory, Ever Works pushes the generated site to a GitHub repository and triggers a Vercel build through a GitHub Actions workflow. Vercel builds and hosts the site as a static website. The deployment facade tracks build status and provides the resulting deployment URL.',
				'',
				'## Getting started',
				'',
				'1. Create a Vercel account at [vercel.com](https://vercel.com)',
				'2. Generate an API token from [vercel.com/account/tokens](https://vercel.com/account/tokens)',
				'3. Enter your token in the settings below',
				'4. Save settings to verify the token before using it for deployments'
			].join('\n'),
			homepage: 'https://vercel.com/account/tokens',
			uiHints: {
				setupLink: {
					url: 'https://vercel.com/account/tokens',
					label: 'Vercel Tokens',
					buttonLabel: 'Get Vercel API token',
					showWhenEmpty: ['apiToken']
				},
				validateOnSave: true,
				includeInOnboarding: true,
				onboardingPriority: 4,
				completionFields: ['apiToken'],
				onboardingDescription: 'Add a Vercel token to publish your directories as live websites.'
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
			defaultTeamScope: settings?.defaultTeamScope as string | undefined
		};
	}
}

export default VercelPlugin;
