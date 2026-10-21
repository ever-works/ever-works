import type {
	AppDependencyProviderDescriptor,
	AppDependencyTarget,
	AppDeployHooks,
	AppDeployResult,
	AppDestroyResult,
	AppLimitRangeInput,
	AppRenderInput,
	AppTargetRef,
	DeploymentConfig,
	DeploymentResult,
	PluginManifest
} from '@ever-works/plugin';
import {
	K8sPluginError,
	KubernetesApiService,
	KubernetesPlugin,
	OBJECT_STORAGE_PROVIDER_DESCRIPTOR,
	POSTGRES_PROVIDER_DESCRIPTOR,
	REDIS_PROVIDER_DESCRIPTOR,
	SMTP_PROVIDER_DESCRIPTOR,
	assertSupportedKubeconfig,
	renderNamespace
} from '@ever-works/k8s-plugin';

/** The prefix every managed namespace carries — what the operator's admission policy enforces. */
export const MANAGED_NAMESPACE_PREFIX = 'ewapp-';

/** `<namespace>/<name>` of the controller ServiceAccount the managed kubeconfig authenticates as. */
export const MANAGED_SERVICE_ACCOUNT_ENV = 'EVER_WORKS_APPS_MANAGED_SERVICE_ACCOUNT';
export const DEFAULT_MANAGED_SERVICE_ACCOUNT = 'ever-works-apps-system/ever-works-apps-controller';

/** The namespaced-admin ClusterRole each managed namespace's RoleBinding grants. */
export const MANAGED_NAMESPACE_ROLE_ENV = 'EVER_WORKS_APPS_MANAGED_NAMESPACE_ROLE';
export const DEFAULT_MANAGED_NAMESPACE_ROLE = 'ever-works-apps-namespace-admin';

/** `false` turns the per-namespace grant off (an operator who bound the role cluster-wide). */
export const MANAGED_NAMESPACE_GRANT_ENV = 'EVER_WORKS_APPS_MANAGED_NAMESPACE_GRANT';

/** The RoleBinding's own name inside each managed namespace. */
export const MANAGED_NAMESPACE_GRANT_NAME = 'ever-works-apps-controller';

/**
 * **APW-10 lite — Ever Works Apps (managed).** The `apps-tier` deployment plugin that runs App
 * Works on the PLATFORM's own Kubernetes cluster, one restricted namespace per App Work.
 *
 * The full APW-10 design reconciles a `Work` resource through an in-zone controller. This lite
 * version reuses the `your-cluster` machinery instead — the same renderer, deployer, lifecycle and
 * status reader of `@ever-works/k8s-plugin`, which already render the managed target's own policy
 * (`ResourceQuota`, the smaller `LimitRange`, the default-deny + same-namespace + DNS/internet
 * egress + ingress-controller-only NetworkPolicies, Pod Security `restricted`, the tier's
 * `runtimeClassName`) — dialled with the platform-held credential `AppsTierPolicy` hands out.
 *
 * ## What is different from the `k8s` plugin, and why
 *
 * 1. **Target.** It serves `ever-works-apps` ONLY (and the `k8s` plugin `your-cluster` only), so a
 *    member's kubeconfig can never reach this plugin and the platform credential can never reach
 *    the member's plugin. The runtime facade selects it by capability (`deployment` + `apps-tier`,
 *    `facades/app-runtime.facade.ts`), never by id.
 * 2. **The credential is the operator's, not a member's.** §6.1's public-address pinning exists to
 *    stop a member's kubeconfig from pointing the platform at an internal address (SSRF). The
 *    platform's own cluster is legitimately internal, so this plugin keeps the shape refusals
 *    (`assertSupportedKubeconfig`: no exec/auth-provider/file reads, inline CA required, https only)
 *    and skips the public-address step. The credential is RBAC-limited to `ewapp-*` namespaces on
 *    the cluster side (see `docs/features/app-works-managed-target.md`).
 * 3. **Removal deletes the namespace.** A managed namespace holds nothing the platform could hand
 *    back after the App Work is removed, so `destroyApp` always deletes the whole namespace (data
 *    included) rather than keeping volumes in the platform's cluster indefinitely.
 * 4. **No website deploys.** It is hidden from the deploy-provider lists and refuses the legacy
 *    website `deploy()` path outright.
 * 5. **Least privilege, per namespace.** Before the first write into a managed namespace the plugin
 *    applies the Namespace and a RoleBinding granting the controller ServiceAccount the operator's
 *    namespaced-admin ClusterRole IN that namespace only (see {@link managedNamespaceGrant}).
 * 6. **Dependencies in the App's namespace.** The same in-cluster Postgres / Redis / object-storage / smtp
 *    providers, published for `ever-works-apps` only (see {@link dependencyProviders}).
 */
export class KubernetesAppsTierPlugin extends KubernetesPlugin {
	private readonly tierApi: KubernetesApiService;
	private readonly env: NodeJS.ProcessEnv;

	constructor(opts: ConstructorParameters<typeof KubernetesPlugin>[0] & { env?: NodeJS.ProcessEnv } = {}) {
		const api = opts?.api ?? new KubernetesApiService();
		super({ ...opts, api });
		this.tierApi = api;
		this.env = opts?.env ?? process.env;
	}

	override readonly id: string = 'k8s-apps-tier';
	override readonly name: string = 'Ever Works Apps (managed)';
	override readonly capabilities: readonly string[] = ['deployment', 'apps-tier', 'app-dependency'];

	/**
	 * Point 6: the k8s plugin's in-cluster providers (Postgres, Redis, S3-compatible object storage and — lane
	 * aw-env-smtp, GAP-22 — the `smtp` mail sink / bring-your-own server), published for `ever-works-apps` ONLY. They provision inside the App's own `ewapp-*` namespace — so every byte
	 * counts against its ResourceQuota and goes when the namespace goes — dialled with the platform credential
	 * the dependency job assembles through the runtime facade (`prepareDependencyTarget`).
	 */
	override readonly dependencyProviders: readonly AppDependencyProviderDescriptor[] = [
		POSTGRES_PROVIDER_DESCRIPTOR,
		REDIS_PROVIDER_DESCRIPTOR,
		OBJECT_STORAGE_PROVIDER_DESCRIPTOR,
		SMTP_PROVIDER_DESCRIPTOR
	].map((descriptor) => ({
		...descriptor,
		targets: ['ever-works-apps'],
		label: `On Ever Works · ${descriptor.label.replace(/^In your cluster · /, '')}`
	}));
	override readonly providerName: string = 'ever-works-apps-k8s';

	override getManifest(): PluginManifest {
		return {
			...super.getManifest(),
			id: this.id,
			name: this.name,
			description:
				"Runs App Works on the platform's own Kubernetes cluster, one restricted namespace per App Work",
			capabilities: [...this.capabilities],
			visibility: 'hidden'
		};
	}

	protected override servesAppTarget(target: string | undefined): boolean {
		return target === 'ever-works-apps';
	}

	/** The in-cluster providers implement `your-cluster`; on the managed tier they run the same way. */
	protected override dependencyProviderTarget(target: AppDependencyTarget): AppDependencyTarget {
		return target === 'ever-works-apps' ? 'your-cluster' : target;
	}

	/** Shape refusals only — see the class docstring, point 2. */
	protected override async guardedAppCredential(credential: string, kubeContext?: string | null): Promise<string> {
		assertSupportedKubeconfig(credential, kubeContext ?? undefined);
		return credential;
	}

	/**
	 * Point 5: the per-namespace grant comes first. The managed credential holds only cluster-wide
	 * namespace + RoleBinding rights (the operator's admission policy narrows both to `ewapp-*`);
	 * everything inside a namespace — Secrets included — is granted by a RoleBinding IN that
	 * namespace, so the credential can never read another tenant's or the platform's objects.
	 */
	override async deployApp(
		input: AppRenderInput,
		credential: string,
		hooks: AppDeployHooks
	): Promise<AppDeployResult> {
		this.assertThisPluginServes(input?.ref);
		const guarded = await this.guardedAppCredential(credential, input?.ref?.kubeContext);
		await this.ensureNamespaceGrant(input, guarded);
		return super.deployApp(input, credential, hooks);
	}

	override async prepareAppNamespace(
		ref: AppTargetRef,
		credential: string,
		opts: { isolation: boolean; limitRange: AppLimitRangeInput }
	): Promise<{ warnings: Array<{ code: string; message: string }> }> {
		this.assertThisPluginServes(ref);
		const guarded = await this.guardedAppCredential(credential, ref?.kubeContext);
		await this.ensureNamespaceGrant(
			{ ref, workSlug: '', policy: { podSecurity: 'restricted' } } as unknown as AppRenderInput,
			guarded
		);
		return super.prepareAppNamespace(ref, credential, opts);
	}

	/**
	 * The Namespace (rendered by the same renderer the deployer uses, so its server-side apply is the
	 * same body) and the RoleBinding that makes it workable — both idempotent.
	 */
	private async ensureNamespaceGrant(input: AppRenderInput, credential: string): Promise<void> {
		const namespace = String(input?.ref?.namespace ?? '');
		if (!namespace.startsWith(MANAGED_NAMESPACE_PREFIX)) {
			throw new K8sPluginError(
				'NOT_CONFIGURED',
				`Managed App namespaces must start with '${MANAGED_NAMESPACE_PREFIX}' (got '${namespace}').`
			);
		}
		if ((this.env[MANAGED_NAMESPACE_GRANT_ENV] ?? '').trim() === 'false') return;

		const context = input?.ref?.kubeContext ?? undefined;
		await this.tierApi.applyObject(
			credential,
			renderNamespace(input) as unknown as Record<string, unknown>,
			context
		);
		await this.tierApi.applyObject(credential, managedNamespaceGrant(namespace, this.env), context);
	}

	/** Point 3: the managed namespace goes, data included. */
	override async destroyApp(
		ref: AppTargetRef,
		credential: string,
		_opts: { deleteVolumes: boolean }
	): Promise<AppDestroyResult> {
		return super.destroyApp(ref, credential, { deleteVolumes: true });
	}

	/** Point 4: website deploys never run on the managed tier. */
	override async deploy(_config: DeploymentConfig, _kubeconfig: string): Promise<DeploymentResult> {
		throw new K8sPluginError(
			'NOT_CONFIGURED',
			'Ever Works Apps (managed) runs App Works only; it is not a website deployment provider.'
		);
	}
}

/** The RoleBinding that grants the controller its namespaced-admin role inside ONE managed namespace. */
export function managedNamespaceGrant(
	namespace: string,
	env: NodeJS.ProcessEnv = process.env
): Record<string, unknown> {
	const [saNamespace, saName] = (
		(env[MANAGED_SERVICE_ACCOUNT_ENV] ?? '').trim() || DEFAULT_MANAGED_SERVICE_ACCOUNT
	).split('/');
	const role = (env[MANAGED_NAMESPACE_ROLE_ENV] ?? '').trim() || DEFAULT_MANAGED_NAMESPACE_ROLE;
	return {
		apiVersion: 'rbac.authorization.k8s.io/v1',
		kind: 'RoleBinding',
		metadata: {
			name: MANAGED_NAMESPACE_GRANT_NAME,
			namespace,
			labels: { 'app.kubernetes.io/managed-by': 'ever-works', 'app.kubernetes.io/part-of': 'ever-works-apps' }
		},
		roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: role },
		subjects: [
			{
				kind: 'ServiceAccount',
				name: saName || 'ever-works-apps-controller',
				namespace: saNamespace || 'ever-works-apps-system'
			}
		]
	};
}
