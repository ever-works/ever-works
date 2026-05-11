export interface GitHubSettings {
	readonly clientId?: string;
	readonly clientSecret?: string;
	readonly apiBaseUrl?: string;
	/** Fine-grained GitHub PAT with `read:packages` scope.
	 * Used by the Kubernetes deploy provider to mint an imagePullSecret
	 * for private GHCR images. Optional — only required when the
	 * generated website repo (and therefore its GHCR image) is private. */
	readonly readPackagesPat?: string;
}

export interface GitHubWorkflow {
	readonly id: number;
	readonly name: string;
	readonly path: string;
	readonly state: 'active' | 'disabled_manually' | 'disabled_inactivity';
}

export interface GitHubPublicKey {
	readonly key_id: string;
	readonly key: string;
}

export interface GitHubActionSecret {
	readonly name: string;
	readonly created_at: string;
	readonly updated_at: string;
}

export const ACTIVE_WORKFLOW_NAMES = ['Vercel Deployment', 'Production deployment'] as const;
export const ACTIVE_WORKFLOW_FILES = [
	'.github/workflows/deploy_vercel.yaml',
	'.github/workflows/deploy_prod.yaml'
] as const;
