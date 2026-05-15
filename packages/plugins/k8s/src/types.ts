/**
 * Public types for the Kubernetes deployment plugin.
 */

/**
 * Container registry configuration. Discriminated by `kind`.
 *
 * Defaults to `{ kind: 'github' }` so users with a connected GitHub account
 * can deploy without configuring anything else.
 */
export type RegistryConfig = GitHubRegistryConfig | DockerHubRegistryConfig | GenericRegistryConfig;

export interface GitHubRegistryConfig {
	kind: 'github';
	/** GitHub owner (login or org). Defaults to the connected GitHub account. */
	owner?: string;
	/**
	 * Image visibility:
	 * - `auto` (default): mirror the website repo's visibility (public repo → public image).
	 * - `public`: image is public; no `imagePullSecret` is provisioned.
	 * - `private`: image is private; `imagePullSecret` is provisioned.
	 */
	visibility?: 'auto' | 'public' | 'private';
}

export interface DockerHubRegistryConfig {
	kind: 'dockerhub';
	username: string;
	password: string;
}

export interface GenericRegistryConfig {
	kind: 'generic';
	/** e.g. `registry.example.com` (no scheme, no path). */
	server: string;
	username: string;
	password: string;
}

export type RegistryKind = RegistryConfig['kind'];

/**
 * Image visibility resolved at deploy time. `'auto'` is never a deploy-time
 * value — it is resolved against the website repo before the deploy runs.
 */
export type ResolvedImageVisibility = 'public' | 'private';

/**
 * Where the kubeconfig used to talk to the target cluster comes from.
 *
 * - `'k8s-works'`        — Ever Works shared customer cluster. The
 *                          platform substitutes
 *                          `process.env.EVER_WORKS_K8S_WORKS_KUBECONFIG`
 *                          for the `K8S_TOKEN` GitHub Actions secret at
 *                          deploy time. The `kubeconfig` field below is
 *                          ignored.
 * - `'k8s-gauzy'`        — Ever Works internal platform cluster. Same
 *                          shape as `'k8s-works'` but uses
 *                          `process.env.EVER_WORKS_K8S_GAUZY_KUBECONFIG`.
 *                          Only allowed when the Work's website repo is
 *                          in the `ever-works` org (admin/internal
 *                          path).
 * - `'custom-kubeconfig'`— Customer pastes their own kubeconfig in the
 *                          `kubeconfig` field below. Only allowed when
 *                          the Work's website repo is NOT in an Ever
 *                          Works-shared org (the cell C exclusion).
 *
 * Validation of the (website-repo-owner, clusterSource) combination
 * happens in `DeployService.deploy()`. See the EW-615/EW-616 tickets
 * and `Workspace/knowledge/runbooks/EVER_WORKS_K8S_DEPLOY_TROUBLESHOOTING.md`
 * for the full supported-matrix table.
 */
export type ClusterSource = 'k8s-works' | 'k8s-gauzy' | 'custom-kubeconfig';

/**
 * Plugin settings as stored in `plugin_settings`.
 */
export interface KubernetesSettings {
	/** Where the kubeconfig for the target cluster comes from. Defaults
	 *  to `'custom-kubeconfig'` so existing Works (which pre-date this
	 *  field and have a user-pasted `kubeconfig`) keep working without
	 *  re-saving their settings. */
	clusterSource?: ClusterSource;
	/** Full kubeconfig YAML. Stored encrypted; never returned by the API.
	 *  Required when `clusterSource === 'custom-kubeconfig'`. Ignored
	 *  when `clusterSource` is a platform-managed value — the platform
	 *  substitutes the right env var at deploy time. */
	kubeconfig?: string;
	/** Override the kubeconfig's `current-context`. */
	kubeContext?: string;
	/** Default namespace for deployments. */
	namespace?: string;
	/** Container registry. Defaults to `{ kind: 'github' }`. */
	registry?: RegistryConfig;
	/** IngressClass name to use. Leave blank to use the cluster default. */
	ingressClass?: string;
	/** Default ingress host when a work has no custom domain. */
	ingressHost?: string;
	/** cert-manager `ClusterIssuer` name. */
	tlsIssuer?: string;
	/** Pod replicas (default 1, max 10 in v1). */
	replicas?: number;
}

/**
 * What `validateConnection.details` returns on success. Drives the UI
 * after a save: cluster identity + ingress dropdown contents.
 */
export interface KubernetesClusterInfo {
	clusterName: string;
	serverUrl: string;
	serverVersion: string;
	/** sha256(server URL || CA cert)[0..16] — non-reversible cluster identity. */
	serverFingerprint: string;
	/** Detected IngressClass resources, marked with `hasStrategy`. */
	ingressClasses: IngressClassDescriptor[];
	/** True if the kubeconfig uses an `exec` plugin (won't work in headless runners). */
	requiresExecPlugin: boolean;
}

/**
 * Per-IngressClass info reported by `validateConnection`.
 */
export interface IngressClassDescriptor {
	name: string;
	controller: string;
	isDefault: boolean;
	/** Whether the plugin has a built-in strategy for this controller. */
	hasStrategy: boolean;
}

/**
 * Inputs the manifest renderer needs.
 */
export interface ManifestRenderInputs {
	workId: string;
	workSlug: string;
	namespace: string;
	image: string;
	replicas: number;
	containerPort: number;
	pullSecretName?: string;
	hosts: string[];
	ingressClass?: string;
	tlsIssuer?: string;
	ingressController?: string;
}

/**
 * Inputs the registry strategies need.
 */
export interface RegistryDeployContext {
	workSlug: string;
	githubOwner?: string;
	websiteRepoIsPrivate?: boolean;
}

/**
 * Login step details an Actions workflow needs to authenticate to the registry.
 * Strategies return one or more of these so the workflow can set them up.
 */
export interface RegistryWorkflowLogin {
	/** Registry hostname (e.g. `ghcr.io`). */
	registry: string;
	/** Username env var or literal. */
	username: string;
	/** Password env var or literal. */
	passwordEnv: string;
}
