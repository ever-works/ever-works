/**
 * Deploy Facade Interface
 *
 * Provides a unified interface for deployment operations through the plugin system.
 * The facade resolves the appropriate deployment provider based on work configuration
 * and retrieves credentials from plugin settings.
 */

import type { PluginIcon } from '../contracts/plugin-manifest.types.js';
import type { DeploymentDomain, AddDomainResult } from '../contracts/capabilities/deployment.interface.js';

/**
 * Options for deploy facade operations
 */
export interface DeployFacadeOptions {
	/** User ID for token retrieval */
	readonly userId: string;
	/** Work ID for provider resolution */
	readonly workId: string;
}

/**
 * Team information from deployment provider
 */
export interface DeployFacadeTeam {
	/** Team ID */
	readonly id: string;
	/** Team slug/identifier */
	readonly slug: string;
	/** Team display name */
	readonly name: string | null;
}

/**
 * Provider information
 */
export interface DeployProviderInfo {
	/** Provider plugin ID */
	readonly id: string;
	/** Provider display name */
	readonly name: string;
	/** Whether the provider is enabled */
	readonly enabled: boolean;
	/** Whether the current user has configured credentials for this provider */
	readonly configured?: boolean;
	/** Provider icon from plugin manifest */
	readonly icon?: PluginIcon;
	/** Provider description from plugin manifest */
	readonly description?: string;
	/** Provider homepage URL (e.g. token management page) */
	readonly homepage?: string;
}

/**
 * Deployment lookup result
 */
export interface DeploymentLookupResult {
	/** Whether a deployment was found */
	readonly found: boolean;
	/** Website URL if deployed */
	readonly website?: string;
	/** Current deployment state */
	readonly deploymentState?: string;
	/** Project ID */
	readonly projectId?: string;
}

/**
 * Deploy facade interface
 *
 * Abstracts deployment operations across different providers (Vercel, Netlify, etc.)
 * using the plugin system for provider resolution and credential management.
 */
export interface IDeployFacade {
	/**
	 * Check if deployment is configured for a work
	 * @param options Facade options with user and work IDs
	 * @returns True if a deployment provider is configured with valid credentials
	 */
	isConfigured(options: DeployFacadeOptions): Promise<boolean>;

	/**
	 * Get list of available deployment providers
	 * @returns Array of provider information
	 */
	getAvailableProviders(): DeployProviderInfo[];

	/**
	 * Validate the user's deployment token
	 * @param options Facade options with user and work IDs
	 * @returns True if the token is valid
	 */
	validateToken(options: DeployFacadeOptions): Promise<boolean>;

	/**
	 * Get teams/organizations available to the user
	 * @param options Facade options with user and work IDs
	 * @returns Array of team information
	 */
	getTeams(options: DeployFacadeOptions): Promise<DeployFacadeTeam[]>;

	/**
	 * Initiate a deployment
	 * @param config Deployment configuration
	 * @param options Facade options with user and work IDs
	 * @returns True if deployment was initiated successfully
	 */
	deploy(
		config: {
			projectName: string;
			teamScope?: string;
		},
		options: DeployFacadeOptions
	): Promise<boolean>;

	/**
	 * Get status of a deployment
	 * @param deploymentId Deployment ID
	 * @param options Facade options with user and work IDs
	 * @returns Deployment status information
	 */
	getDeploymentStatus(
		deploymentId: string,
		options: DeployFacadeOptions
	): Promise<{
		status: string;
		url?: string;
		error?: string;
	}>;

	/**
	 * Lookup existing deployment for a work
	 * @param projectName Project name to look up
	 * @param options Facade options with user and work IDs
	 * @returns Deployment lookup result
	 */
	lookupExistingDeployment(projectName: string, options: DeployFacadeOptions): Promise<DeploymentLookupResult>;

	/**
	 * Get domains for a deployed work
	 * @param options Facade options with user and work IDs
	 * @returns Array of domain information
	 */
	getDomains(options: DeployFacadeOptions): Promise<DeploymentDomain[]>;

	/**
	 * Add a domain to a deployed work
	 * @param domain Domain name to add
	 * @param options Facade options with user and work IDs
	 * @returns Result of domain addition
	 */
	addDomain(domain: string, options: DeployFacadeOptions): Promise<AddDomainResult>;

	/**
	 * Remove a domain from a deployed work
	 * @param domain Domain name to remove
	 * @param options Facade options with user and work IDs
	 * @returns True if domain was removed
	 */
	removeDomain(domain: string, options: DeployFacadeOptions): Promise<boolean>;

	/**
	 * Verify a domain on a deployed work
	 * @param domain Domain name to verify
	 * @param options Facade options with user and work IDs
	 * @returns Updated domain information
	 */
	verifyDomain(domain: string, options: DeployFacadeOptions): Promise<DeploymentDomain>;
}
