export interface GitHubSettings {
	readonly clientId?: string;
	readonly clientSecret?: string;
	readonly apiBaseUrl?: string;
	/** Fine-grained GitHub PAT with `read:packages` scope.
	 * Used by the Kubernetes deploy provider to mint an imagePullSecret
	 * for private GHCR images. Optional — only required when the
	 * generated website repo (and therefore its GHCR image) is private.
	 * Note: GHCR has known compatibility issues with fine-grained PATs
	 * when packages are not explicitly repo-linked (`org.opencontainers.image.source`
	 * auto-link does not fire reliably). Prefer `readPackagesPatClassic`. */
	readonly readPackagesPat?: string;
	/** Classic GitHub PAT (`ghp_…`) with `repo` + `read:packages` +
	 * `write:packages` + `delete:packages` scopes. Used as the GHCR
	 * image-pull credential when deploying private images to Kubernetes.
	 * Classic PATs honor org membership directly and avoid the repo-package
	 * link requirement that breaks fine-grained PATs for org-level packages.
	 * The platform provides classic PATs for Works that publish to
	 * `ever-works` / `ever-works-cloud` orgs — this field is only needed
	 * for customer-owned GitHub orgs (cells B and D of the deploy matrix,
	 * see EW-615). */
	readonly readPackagesPatClassic?: string;
	/** GitHub login that owns the read-packages PAT. Used as
	 * REGISTRY_USERNAME by Kubernetes deploy workflows. */
	readonly readPackagesPatOwner?: string;
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
