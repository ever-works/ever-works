import type { Vercel } from '@vercel/sdk';
import type { VercelTeam, VercelProject, VercelDeployment, VercelDeploymentState, VercelUser } from './types.js';

/**
 * Service for interacting with the Vercel API
 */
export class VercelApiService {
	/**
	 * Create a new Vercel SDK instance
	 */
	async createSDK(token: string): Promise<Vercel> {
		const { Vercel } = await import('@vercel/sdk');
		return new Vercel({ bearerToken: token });
	}

	/**
	 * Validate an API token
	 */
	async validateToken(token: string): Promise<VercelUser | null> {
		if (!token) {
			return null;
		}
		try {
			const vercel = await this.createSDK(token);
			const response = await vercel.user.getAuthUser();
			const user = (response as any)?.user;
			if (!user) {
				return null;
			}
			return {
				id: user.id,
				email: user.email,
				name: user.name ?? undefined,
				username: user.username
			};
		} catch {
			return null;
		}
	}

	/**
	 * Get teams for the authenticated user
	 */
	async getTeams(token: string): Promise<VercelTeam[]> {
		if (!token) {
			return [];
		}
		try {
			const vercel = await this.createSDK(token);
			const response = await vercel.teams.getTeams({});
			return (response.teams || []).map((team) => ({
				id: team.id,
				slug: team.slug,
				name: team.name ?? null,
				createdAt: team.createdAt
			}));
		} catch {
			return [];
		}
	}

	/**
	 * Get projects
	 */
	async getProjects(
		token: string,
		options?: { search?: string; teamScope?: string; limit?: number }
	): Promise<VercelProject[]> {
		if (!token) {
			return [];
		}
		try {
			const vercel = await this.createSDK(token);
			const response = await vercel.projects.getProjects({
				search: options?.search,
				slug: options?.teamScope,
				limit: options?.limit?.toString() || '100'
			});
			// The response can be either an object with projects array or the array directly
			const projects = Array.isArray(response) ? response : (response as any).projects;
			if (!projects) {
				return [];
			}
			return projects.map((p: any) => this.mapProject(p));
		} catch (error: any) {
			// Handle case where response is in rawValue
			const raw = error?.rawValue;
			if (raw?.projects) {
				return raw.projects.map((p: any) => this.mapProject(p));
			}
			// Return empty array for API errors (invalid token, etc.)
			return [];
		}
	}

	/**
	 * Get project domains
	 */
	async getProjectDomains(
		projectId: string,
		token: string,
		teamScope?: string
	): Promise<Array<{ name: string; verified: boolean; verification?: Array<{ type: string; domain: string; value: string; reason: string }> }>> {
		if (!token) {
			return [];
		}
		try {
			const vercel = await this.createSDK(token);
			const response = await vercel.projects.getProjectDomains({
				idOrName: projectId,
				slug: teamScope
			});
			return response.domains.map((d: any) => ({
				name: d.name,
				verified: d.verified ?? false,
				verification: d.verification?.length
					? d.verification.map((v: any) => ({
							type: v.type || 'TXT',
							domain: v.domain || d.name,
							value: v.value || '',
							reason: v.reason || 'Domain verification'
						}))
					: undefined
			}));
		} catch {
			return [];
		}
	}

	/**
	 * Add a domain to a project
	 */
	async addProjectDomain(
		projectId: string,
		domain: string,
		token: string,
		teamScope?: string
	): Promise<{ name: string; verified: boolean; verification?: Array<{ type: string; domain: string; value: string; reason: string }> }> {
		const vercel = await this.createSDK(token);
		const response: any = await vercel.projects.addProjectDomain({
			idOrName: projectId,
			slug: teamScope,
			requestBody: { name: domain }
		});
		return {
			name: response.name,
			verified: response.verified ?? false,
			verification: response.verification?.length
				? response.verification.map((v: any) => ({
						type: v.type || 'TXT',
						domain: v.domain || response.name,
						value: v.value || '',
						reason: v.reason || 'Domain verification'
					}))
				: undefined
		};
	}

	/**
	 * Remove a domain from a project
	 */
	async removeProjectDomain(
		projectId: string,
		domain: string,
		token: string,
		teamScope?: string
	): Promise<boolean> {
		const vercel = await this.createSDK(token);
		await vercel.projects.removeProjectDomain({
			idOrName: projectId,
			domain,
			slug: teamScope
		});
		return true;
	}

	/**
	 * Verify a domain on a project
	 */
	async verifyProjectDomain(
		projectId: string,
		domain: string,
		token: string,
		teamScope?: string
	): Promise<{ name: string; verified: boolean; verification?: Array<{ type: string; domain: string; value: string; reason: string }> }> {
		const vercel = await this.createSDK(token);
		const response: any = await vercel.projects.verifyProjectDomain({
			idOrName: projectId,
			domain,
			slug: teamScope
		});
		return {
			name: response.name,
			verified: response.verified ?? false,
			verification: response.verification?.length
				? response.verification.map((v: any) => ({
						type: v.type || 'TXT',
						domain: v.domain || response.name,
						value: v.value || '',
						reason: v.reason || 'Domain verification'
					}))
				: undefined
		};
	}

	/**
	 * Get deployments for a project
	 */
	async getDeployments(
		projectId: string,
		token: string,
		options?: { teamScope?: string; limit?: number }
	): Promise<VercelDeployment[]> {
		if (!token) {
			return [];
		}
		try {
			const vercel = await this.createSDK(token);
			const response = await vercel.deployments.getDeployments({
				projectId,
				slug: options?.teamScope,
				limit: options?.limit
			});
			return (response.deployments || []).map((d: any) => ({
				uid: d.uid,
				name: d.name,
				url: d.url,
				readyState: d.readyState as VercelDeploymentState | undefined,
				createdAt: d.createdAt,
				alias: d.alias
			}));
		} catch (error: any) {
			// Handle case where response is in rawValue
			const raw = error?.rawValue;
			if (raw?.deployments) {
				return (raw.deployments || []).map((d: any) => ({
					uid: d.uid,
					name: d.name,
					url: d.url,
					readyState: d.readyState as VercelDeploymentState | undefined,
					createdAt: d.createdAt,
					alias: d.alias
				}));
			}
			// Return empty array for API errors
			return [];
		}
	}

	/**
	 * Lookup a project by name
	 */
	async lookupProject(
		projectName: string,
		token: string,
		teamScope?: string
	): Promise<{
		found: boolean;
		project?: VercelProject;
		website?: string;
		deploymentState?: VercelDeploymentState;
	}> {
		// Try to find the project by searching
		const projects = await this.getProjects(token, {
			search: projectName,
			teamScope
		});

		const project = projects.find((p) => p.name === projectName || p.name.includes(projectName));

		if (!project) {
			return { found: false };
		}

		// Get domains for the project
		const domains = await this.getProjectDomains(project.id, token, teamScope);
		const customDomain =
			domains.find((d) => !d.name.endsWith('.vercel.app')) || domains.find((d) => d.name.endsWith('.vercel.app'));

		// Get latest deployment
		const deployments = await this.getDeployments(project.id, token, {
			teamScope,
			limit: 1
		});
		const latestDeployment = deployments[0];

		const website = customDomain?.name
			? `https://${customDomain.name}`
			: latestDeployment?.url
				? `https://${latestDeployment.url}`
				: undefined;

		return {
			found: true,
			project,
			website,
			deploymentState: latestDeployment?.readyState
		};
	}

	/**
	 * Lookup deployment across all teams/scopes
	 */
	async lookupDeploymentAcrossScopes(
		projectName: string,
		token: string,
		matcher: (project: VercelProject) => boolean
	): Promise<{
		found: boolean;
		website?: string;
		deploymentState?: VercelDeploymentState;
		teamScope?: string;
		projectId?: string;
	}> {
		// Get all teams
		const teams = await this.getTeams(token);
		const scopes = [
			undefined, // personal account
			...teams.map((t) => t.slug)
		];

		for (const scope of scopes) {
			const projects = await this.getProjects(token, {
				search: projectName,
				teamScope: scope
			});

			const project = projects.find(matcher);
			if (!project) {
				continue;
			}

			const domains = await this.getProjectDomains(project.id, token, scope);
			const customDomain =
				domains.find((d) => !d.name.endsWith('.vercel.app')) ||
				domains.find((d) => d.name.endsWith('.vercel.app'));

			const deployments = await this.getDeployments(project.id, token, {
				teamScope: scope,
				limit: 1
			});
			const latestDeployment = deployments[0];

			const website = customDomain?.name
				? `https://${customDomain.name}`
				: latestDeployment?.url
					? `https://${latestDeployment.url}`
					: undefined;

			return {
				found: true,
				website,
				deploymentState: latestDeployment?.readyState,
				teamScope: scope,
				projectId: project.id
			};
		}

		return { found: false };
	}

	private mapProject(p: any): VercelProject {
		return {
			id: p.id,
			name: p.name,
			link: p.link,
			latestDeployments: p.latestDeployments?.map((d: any) => ({
				uid: d.uid,
				name: d.name,
				url: d.url,
				readyState: d.readyState,
				createdAt: d.createdAt,
				alias: d.alias
			}))
		};
	}
}
