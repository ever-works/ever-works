import type {
	RegistryConfig,
	RegistryDeployContext,
	RegistryKind,
	RegistryWorkflowLogin,
	ResolvedImageVisibility,
} from '../types.js';

/**
 * Strategy interface for container registry kinds.
 *
 * The deploy code never branches on registry kind — it consults a strategy
 * via `RegistryProviderRegistry.resolve(kind)`. New kinds (ECR, GCR, ACR,
 * GitLab CR, …) plug in by registering an additional strategy.
 */
export interface RegistryProvider {
	readonly kind: RegistryKind;

	/**
	 * Build the image reference base, e.g. `ghcr.io/acme` or
	 * `docker.io/acme`. Combined with `<workSlug>:<sha>` at deploy time.
	 */
	imageBase(config: RegistryConfig, ctx: RegistryDeployContext): string;

	/**
	 * Resolve the effective image visibility for this deploy.
	 *
	 * - `github` with `visibility: 'auto'` returns `'private'` if the
	 *   website repo is private, else `'public'`.
	 * - All other strategies return `'private'` (their auth is always
	 *   needed to pull).
	 */
	resolveVisibility(config: RegistryConfig, ctx: RegistryDeployContext): ResolvedImageVisibility;

	/**
	 * Workflow `docker login` step description. The deploy workflow uses
	 * this to authenticate before `docker push`.
	 */
	workflowLogin(config: RegistryConfig): RegistryWorkflowLogin;

	/**
	 * Pull-secret credentials to materialise into a `docker-registry`
	 * Secret in the cluster. Returns `null` when the resolved visibility
	 * is `'public'` (no pull secret needed).
	 */
	pullSecretCredentials(
		config: RegistryConfig,
		ctx: RegistryDeployContext,
		visibility: ResolvedImageVisibility,
	): { server: string; username: string; password: string } | null;
}
