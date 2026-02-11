/**
 * Vercel plugin settings
 */
export interface VercelSettings {
	/** Vercel API token (user-scoped, required) */
	apiToken?: string;
	/** Default team scope for deployments */
	defaultTeamScope?: string;
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
