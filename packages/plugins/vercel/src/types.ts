/**
 * Vercel plugin settings
 */
export interface VercelSettings {
	/** Vercel API token (user-scoped, required) — manual token fallback */
	apiToken?: string;
	/** Default team scope for deployments */
	defaultTeamScope?: string;
	/**
	 * Vercel OAuth Integration Client ID (admin/global).
	 * Sourced from the `VERCEL_OAUTH_CLIENT_ID` env var. When set together with
	 * `clientSecret` + `integrationSlug`, the plugin advertises the `oauth`
	 * capability and the "Connect with Vercel" flow becomes available.
	 */
	clientId?: string;
	/**
	 * Vercel OAuth Integration Client Secret (admin/global, secret).
	 * Sourced from the `VERCEL_OAUTH_CLIENT_SECRET` env var.
	 */
	clientSecret?: string;
	/**
	 * Vercel Integration URL slug (admin/global) used to build the install /
	 * authorize URL (`https://vercel.com/integrations/<slug>/new`).
	 * Sourced from the `VERCEL_INTEGRATION_SLUG` env var.
	 */
	integrationSlug?: string;
}

/**
 * Vercel team
 */
export interface VercelTeam {
	id: string;
	slug: string;
	name: string | null;
	createdAt?: number;
}

/**
 * Vercel project
 */
export interface VercelProject {
	id: string;
	name: string;
	link?: {
		type?: string;
		repo?: string;
		org?: string;
		repoId?: number;
		deployHooks?: unknown[];
		productionBranch?: string;
	};
	latestDeployments?: VercelDeployment[];
}

/**
 * Vercel deployment
 */
export interface VercelDeployment {
	uid: string;
	name: string;
	url?: string;
	readyState?: VercelDeploymentState;
	createdAt?: number;
	alias?: string[];
}

/**
 * Vercel deployment state
 */
export type VercelDeploymentState = 'BUILDING' | 'ERROR' | 'INITIALIZING' | 'QUEUED' | 'READY' | 'CANCELED' | 'TIMEOUT';

/**
 * Vercel user
 */
export interface VercelUser {
	id: string;
	email: string;
	name?: string;
	username?: string;
}
