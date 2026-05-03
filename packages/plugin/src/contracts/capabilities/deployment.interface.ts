import type { IPlugin } from '../plugin.interface.js';

/**
 * Deployment status
 */
export type DeploymentStatus = 'pending' | 'building' | 'deploying' | 'ready' | 'error' | 'cancelled';

/**
 * Deployment configuration
 */
export interface DeploymentConfig {
	/** Project/site name */
	readonly projectName: string;
	/** Source work to deploy */
	readonly sourceDir: string;
	/** Build command */
	readonly buildCommand?: string;
	/** Output work */
	readonly outputDir?: string;
	/** Environment variables */
	readonly env?: Record<string, string>;
	/** Custom domain */
	readonly domain?: string;
	/** Additional provider-specific options */
	readonly options?: Record<string, unknown>;
}

/**
 * Deployment result
 */
export interface DeploymentResult {
	/** Deployment ID */
	readonly id: string;
	/** Deployment status */
	readonly status: DeploymentStatus;
	/** Deployment URL */
	readonly url?: string;
	/** Preview URL (if different from main URL) */
	readonly previewUrl?: string;
	/** Error message if failed */
	readonly error?: string;
	/** Build logs URL */
	readonly logsUrl?: string;
	/** When deployment started */
	readonly createdAt: string;
	/** When deployment completed */
	readonly completedAt?: string;
}

/**
 * Deployment project/site information
 */
export interface DeploymentProject {
	/** Project ID */
	readonly id: string;
	/** Project name */
	readonly name: string;
	/** Production URL */
	readonly url?: string;
	/** Custom domains */
	readonly domains?: readonly string[];
	/** When project was created */
	readonly createdAt: string;
	/** Last deployment */
	readonly lastDeployment?: DeploymentResult;
}

/**
 * Domain information from deployment provider
 */
export interface DeploymentDomain {
	/** Domain name (e.g. 'example.com') */
	readonly name: string;
	/** Whether the domain is verified */
	readonly verified: boolean;
	/** Verification challenges if not verified */
	readonly verification?: readonly DeploymentDomainVerification[];
}

/**
 * DNS verification challenge for a domain
 */
export interface DeploymentDomainVerification {
	/** DNS record type (e.g. 'CNAME', 'TXT', 'A') */
	readonly type: string;
	/** DNS record name/host */
	readonly domain: string;
	/** DNS record value */
	readonly value: string;
	/** Human-readable reason for this record */
	readonly reason: string;
}

/**
 * Result of adding a domain
 */
export interface AddDomainResult {
	/** The domain that was added */
	readonly domain: DeploymentDomain;
	/** Whether the domain was verified immediately */
	readonly verified: boolean;
}

/**
 * Deployment plugin interface
 * Capability: 'deployment'
 */
export interface IDeploymentPlugin extends IPlugin {
	/** Provider name (e.g., 'vercel', 'netlify', 'cloudflare') */
	readonly providerName: string;

	/**
	 * Deploy a work
	 */
	deploy(config: DeploymentConfig, token: string): Promise<DeploymentResult>;

	/**
	 * Get deployment status
	 */
	getDeploymentStatus(deploymentId: string, token: string): Promise<DeploymentResult>;

	/**
	 * Validate API token
	 */
	validateToken?(token: string): Promise<boolean>;

	/**
	 * Get teams/organizations for the authenticated user
	 */
	getTeams?(token: string): Promise<Array<{ id: string; slug: string; name: string | null }>>;

	/**
	 * Lookup existing deployment for a project
	 */
	lookupExistingDeployment?(
		projectName: string,
		token: string,
		teamScope?: string
	): Promise<{
		found: boolean;
		website?: string;
		deploymentState?: string;
		projectId?: string;
	}>;

	/**
	 * Get authenticated user info
	 */
	getAuthenticatedUser?(token: string): Promise<{ username: string; email?: string } | null>;

	/**
	 * Get project information
	 */
	getProject?(projectId: string, token: string): Promise<DeploymentProject | null>;

	/**
	 * List all projects
	 */
	listProjects?(token: string): Promise<DeploymentProject[]>;

	/**
	 * Get domains for a project
	 */
	getDomains?(projectId: string, token: string, teamScope?: string): Promise<DeploymentDomain[]>;

	/**
	 * Add a domain to a project
	 */
	addDomain?(projectId: string, domain: string, token: string, teamScope?: string): Promise<AddDomainResult>;

	/**
	 * Remove a domain from a project
	 */
	removeDomain?(projectId: string, domain: string, token: string, teamScope?: string): Promise<boolean>;

	/**
	 * Verify a domain on a project
	 */
	verifyDomain?(projectId: string, domain: string, token: string, teamScope?: string): Promise<DeploymentDomain>;
}

/**
 * Type guard for deployment plugins
 */
export function isDeploymentPlugin(plugin: IPlugin): plugin is IDeploymentPlugin {
	return plugin.capabilities.includes('deployment');
}
