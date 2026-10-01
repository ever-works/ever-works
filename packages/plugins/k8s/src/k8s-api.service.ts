/**
 * Wrapper around `@kubernetes/client-node` that makes mocking trivial in
 * Vitest tests and centralises error scrubbing.
 *
 * Real cluster I/O is delegated to the official client; we never construct
 * raw HTTP requests ourselves.
 */
import { createRequire } from 'node:module';
import type { ClusterNodeDescriptor, IngressClassDescriptor, KubernetesClusterInfo } from './types.js';
import type { ParsedKubeconfig } from './kubeconfig.parser.js';
import type { DeploymentStatusInput } from './status.mapper.js';
import { K8sPluginError, scrubError } from './errors.js';
import { parseKubeconfig } from './kubeconfig.parser.js';
import { FIELD_MANAGER } from './manifest.renderer.js';

export interface KubernetesApiClientLike {
	loadFromString(contents: string): void;
	setCurrentContext(name: string): void;
	makeApiClient<T>(api: new (...args: unknown[]) => T): T;
}

/**
 * Subset of @kubernetes/client-node Version API we depend on.
 */
interface VersionApiLike {
	getCode(): Promise<{ gitVersion?: string; platform?: string }>;
}

/**
 * Subset of NetworkingV1Api we depend on.
 */
interface NetworkingV1ApiLike {
	listIngressClass(): Promise<{
		items: Array<{
			metadata?: { name?: string; annotations?: Record<string, string> };
			spec?: { controller?: string };
		}>;
	}>;
	listNamespacedIngress(args: { namespace: string }): Promise<{
		items: Array<{ metadata?: { name?: string }; spec?: unknown }>;
	}>;
	readNamespacedIngress(args: { name: string; namespace: string }): Promise<{
		metadata?: { name?: string };
		spec?: unknown;
		status?: {
			loadBalancer?: {
				ingress?: Array<{ hostname?: string; ip?: string }>;
			};
		};
	}>;
	patchNamespacedIngress(args: {
		name: string;
		namespace: string;
		body: unknown;
		fieldManager?: string;
		force?: boolean;
	}): Promise<unknown>;
}

interface AppsV1ApiLike {
	listDeploymentForAllNamespaces(args?: { labelSelector?: string }): Promise<{
		items: Array<{
			metadata?: { name?: string; namespace?: string; labels?: Record<string, string> };
			status?: DeploymentStatusInput;
		}>;
	}>;
	readNamespacedDeployment(args: { name: string; namespace: string }): Promise<{
		metadata?: { name?: string; namespace?: string };
		status?: DeploymentStatusInput;
	}>;
	patchNamespacedDeployment(args: {
		name: string;
		namespace: string;
		body: unknown;
		fieldManager?: string;
		force?: boolean;
	}): Promise<unknown>;
}

interface CoreV1ApiLike {
	listNode(): Promise<{
		items: Array<{
			metadata?: { name?: string; labels?: Record<string, string> };
			status?: {
				conditions?: Array<{ type?: string; status?: string }>;
				nodeInfo?: {
					operatingSystem?: string;
					architecture?: string;
					kubeletVersion?: string;
				};
			};
		}>;
	}>;
	patchNamespacedService(args: {
		name: string;
		namespace: string;
		body: unknown;
		fieldManager?: string;
		force?: boolean;
	}): Promise<unknown>;
	patchNamespacedSecret(args: {
		name: string;
		namespace: string;
		body: unknown;
		fieldManager?: string;
		force?: boolean;
	}): Promise<unknown>;
	createNamespace(args: { body: unknown }): Promise<unknown>;
	readNamespace(args: { name: string }): Promise<unknown>;
	/**
	 * Pod log read. The object-parameter `CoreV1Api` flavour resolves to the
	 * log **text**, not a `RequestContext` (client-node v1.4.0 re-exports
	 * `ObjectCoreV1Api` as `CoreV1Api`).
	 */
	readNamespacedPodLog(args: {
		name: string;
		namespace: string;
		container?: string;
		follow?: boolean;
		limitBytes?: number;
		previous?: boolean;
		tailLines?: number;
	}): Promise<string>;
}

/**
 * Subset of AuthorizationV1Api (`ObjectAuthorizationV1Api`) we depend on.
 * `createSelfSubjectAccessReview` resolves to the deserialized
 * `V1SelfSubjectAccessReview` body, so the caller reads `.status`.
 */
export interface AuthorizationV1ApiLike {
	createSelfSubjectAccessReview(args: { body: unknown }): Promise<{
		status?: {
			allowed?: boolean;
			denied?: boolean;
			reason?: string;
			evaluationError?: string;
		};
	}>;
}

/**
 * Minimum an object needs for `readObject` / `listObjects` / `deleteObject`
 * to build a request: `apiVersion` + `kind` + `metadata.name`, plus
 * `metadata.namespace` for namespaced kinds (omit it for cluster-scoped
 * kinds such as `CustomResourceDefinition` or `StorageClass`).
 */
export interface KubernetesObjectRefLike {
	apiVersion: string;
	kind: string;
	metadata: { name: string; namespace?: string };
}

/**
 * Subset of @kubernetes/client-node KubernetesObjectApi we depend on. Used
 * for Server-Side Apply so we can specify Content-Type
 * `application/apply-patch+yaml` and pass `force=true` — the typed
 * patchNamespaced* methods on AppsV1Api/CoreV1Api/NetworkingV1Api default to
 * Strategic Merge Patch, which rejects `force` with a 422.
 *
 * Unlike the object-parameter APIs above, `KubernetesObjectApi` takes
 * **positional** arguments; note that `propagationPolicy` is the 6th
 * argument of `delete` and `labelSelector` the 8th of `list`.
 */
export interface KubernetesObjectApiLike {
	patch(
		spec: Record<string, unknown>,
		pretty?: string,
		dryRun?: string,
		fieldManager?: string,
		force?: boolean,
		patchStrategy?: string
	): Promise<unknown>;
	read<T = Record<string, unknown>>(
		spec: KubernetesObjectRefLike,
		pretty?: string,
		exact?: boolean,
		exportt?: boolean
	): Promise<T>;
	list<T = Record<string, unknown>>(
		apiVersion: string,
		kind: string,
		namespace?: string,
		pretty?: string,
		exact?: boolean,
		exportt?: boolean,
		fieldSelector?: string,
		labelSelector?: string,
		limit?: number,
		continueToken?: string
	): Promise<{ items?: T[] }>;
	delete(
		spec: KubernetesObjectRefLike,
		pretty?: string,
		dryRun?: string,
		gracePeriodSeconds?: number,
		orphanDependents?: boolean,
		propagationPolicy?: string
	): Promise<unknown>;
}

/**
 * The parts of a `CustomResourceDefinition` that
 * {@link KubernetesApiService.crdServed} reads. `spec.versions[].served` is
 * required by the `apiextensions.k8s.io/v1` schema, so an entry that omits it
 * is not treated as served.
 */
interface CustomResourceDefinitionLike {
	spec?: { versions?: Array<{ name?: string; served?: boolean }> };
}

/** The parts of a `StorageClass` that {@link KubernetesApiService.defaultStorageClass} reads. */
interface StorageClassLike {
	metadata?: { name?: string; annotations?: Record<string, string> };
}

/** Options for {@link KubernetesApiService.readPodLog}. */
export interface PodLogOptions {
	/** Lines from the end of the log; the API returns the newest `tailLines`. */
	tailLines?: number;
	/**
	 * Byte cap on the response. This is what keeps a huge log from being
	 * pulled into memory: the API server stops streaming once `limitBytes`
	 * have been read, so the client never buffers more than that.
	 */
	limitBytes?: number;
	/** Read the previous (terminated) container instance instead of the live one. */
	previous?: boolean;
}

/** One "may I do X" question for {@link KubernetesApiService.createSelfSubjectAccessReview}. */
export interface SelfSubjectAccessReviewInput {
	/** `get`, `list`, `watch`, `create`, `patch`, `update`, `delete`, … */
	verb: string;
	/** API group; the empty string is the core group (`pods`, `secrets`, …). */
	group: string;
	/** Plural lowercase resource name, e.g. `deployments`. */
	resource: string;
	/** Subresource, e.g. `log` for `pods/log`. Omit for the resource itself. */
	subresource?: string;
	/** Namespace the verb is asked for; omit for cluster-scoped requests. */
	namespace?: string;
}

/** The `status` of a `SelfSubjectAccessReview`, flattened. */
export interface SelfSubjectAccessReviewStatus {
	allowed: boolean;
	denied?: boolean;
	reason?: string;
	evaluationError?: string;
}

/**
 * Hook so tests can inject mock clients without dynamic-importing the real
 * `@kubernetes/client-node` package.
 */
export interface KubernetesClientFactory {
	createKubeConfig(yaml: string, contextOverride?: string): KubernetesApiClientLike;
	versionApi(client: KubernetesApiClientLike): VersionApiLike;
	networkingV1Api(client: KubernetesApiClientLike): NetworkingV1ApiLike;
	appsV1Api(client: KubernetesApiClientLike): AppsV1ApiLike;
	coreV1Api(client: KubernetesApiClientLike): CoreV1ApiLike;
	objectApi(client: KubernetesApiClientLike): KubernetesObjectApiLike;
	authorizationV1Api(client: KubernetesApiClientLike): AuthorizationV1ApiLike;
}

/** Content-Type for Kubernetes Server-Side Apply patches. */
const SERVER_SIDE_APPLY: string = 'application/apply-patch+yaml';

/**
 * Default factory using the real `@kubernetes/client-node`.
 *
 * The package ships as `"type": "module"` and tsup emits an ESM bundle, so
 * synchronous `require()` is **not available** at runtime in the ESM path.
 * Using `createRequire(import.meta.url)` here gives us the same lazy-load
 * behaviour as `require()` while staying ESM-safe. This avoids paying
 * `@kubernetes/client-node`'s parse cost in unit tests that mock the whole
 * factory.
 *
 * Calls are wrapped in a single cached load so we don't re-resolve the
 * module on every API client request.
 */
const k8sClientLoader = (() => {
	let cached: typeof import('@kubernetes/client-node') | null = null;
	return (): typeof import('@kubernetes/client-node') => {
		if (cached) return cached;
		const _require = createRequire(import.meta.url);
		cached = _require('@kubernetes/client-node') as typeof import('@kubernetes/client-node');
		return cached;
	};
})();

export const defaultClientFactory: KubernetesClientFactory = {
	createKubeConfig(yamlContent: string, contextOverride?: string) {
		const k8s = k8sClientLoader();
		const kc = new k8s.KubeConfig();
		kc.loadFromString(yamlContent);
		if (contextOverride) {
			kc.setCurrentContext(contextOverride);
		}
		return kc as unknown as KubernetesApiClientLike;
	},
	versionApi(client) {
		const k8s = k8sClientLoader();
		return client.makeApiClient(k8s.VersionApi as never);
	},
	networkingV1Api(client) {
		const k8s = k8sClientLoader();
		return client.makeApiClient(k8s.NetworkingV1Api as never);
	},
	appsV1Api(client) {
		const k8s = k8sClientLoader();
		return client.makeApiClient(k8s.AppsV1Api as never);
	},
	coreV1Api(client) {
		const k8s = k8sClientLoader();
		return client.makeApiClient(k8s.CoreV1Api as never);
	},
	objectApi(client) {
		const k8s = k8sClientLoader();
		// KubernetesObjectApi.makeApiClient consumes the KubeConfig directly
		// rather than going through makeApiClient(...), so it can pick up the
		// default namespace from the current context.
		return k8s.KubernetesObjectApi.makeApiClient(client as never) as unknown as KubernetesObjectApiLike;
	},
	authorizationV1Api(client) {
		const k8s = k8sClientLoader();
		return client.makeApiClient(k8s.AuthorizationV1Api as never);
	}
};

const DEFAULT_CLASS_ANNOTATION = 'ingressclass.kubernetes.io/is-default-class';

/** CRDs are read at `apiextensions.k8s.io/v1` — the only version this service speaks. */
const CRD_API_VERSION = 'apiextensions.k8s.io/v1';

/**
 * The annotations that mark a `StorageClass` as the cluster default: the GA
 * one, and the beta one it replaced. kubelet's own `IsDefaultAnnotation`
 * accepts both, so a cluster that still carries only the beta annotation must
 * not look defaultless to us.
 */
const DEFAULT_STORAGE_CLASS_ANNOTATIONS: readonly string[] = [
	'storageclass.kubernetes.io/is-default-class',
	'storageclass.beta.kubernetes.io/is-default-class'
];

export class KubernetesApiService {
	constructor(private readonly factory: KubernetesClientFactory = defaultClientFactory) {}

	/**
	 * Validate kubeconfig + cluster connectivity. Returns rich cluster info
	 * suitable for surfacing in the UI on save.
	 *
	 * @param hasStrategyFor Predicate the plugin uses to mark each detected
	 * IngressClass as "we have a built-in strategy for this controller".
	 */
	async validateConnection(
		kubeconfigYaml: string,
		options: {
			contextOverride?: string;
			hasStrategyFor: (controller: string) => boolean;
		}
	): Promise<KubernetesClusterInfo> {
		const parsed = parseKubeconfig(kubeconfigYaml, options.contextOverride);
		const client = this.factory.createKubeConfig(kubeconfigYaml, parsed.currentContext);

		try {
			const versionApi = this.factory.versionApi(client);
			const versionResp = await versionApi.getCode();
			const networkingApi = this.factory.networkingV1Api(client);
			const ingressClasses = await this.listIngressClassesInternal(networkingApi, options.hasStrategyFor);

			return {
				clusterName: parsed.clusterName,
				serverUrl: parsed.server,
				serverVersion: versionResp?.gitVersion ?? 'unknown',
				serverFingerprint: parsed.fingerprint,
				ingressClasses,
				requiresExecPlugin: parsed.requiresExecPlugin
			};
		} catch (err) {
			const scrubbed = scrubError(err);
			throw new K8sPluginError(scrubbed.code, scrubbed.message, err);
		}
	}

	async getServerVersion(parsed: ParsedKubeconfig, kubeconfigYaml: string): Promise<string> {
		const client = this.factory.createKubeConfig(kubeconfigYaml, parsed.currentContext);
		const versionApi = this.factory.versionApi(client);
		const resp = await versionApi.getCode();
		return resp?.gitVersion ?? 'unknown';
	}

	async listIngressClasses(
		kubeconfigYaml: string,
		hasStrategyFor: (controller: string) => boolean,
		contextOverride?: string
	): Promise<IngressClassDescriptor[]> {
		const client = this.factory.createKubeConfig(kubeconfigYaml, contextOverride);
		const networkingApi = this.factory.networkingV1Api(client);
		return this.listIngressClassesInternal(networkingApi, hasStrategyFor);
	}

	private async listIngressClassesInternal(
		api: NetworkingV1ApiLike,
		hasStrategyFor: (controller: string) => boolean
	): Promise<IngressClassDescriptor[]> {
		const resp = await api.listIngressClass();
		return (resp.items ?? []).map((item) => {
			const name = item.metadata?.name ?? '';
			const controller = item.spec?.controller ?? '';
			const isDefault = item.metadata?.annotations?.[DEFAULT_CLASS_ANNOTATION] === 'true';
			return {
				name,
				controller,
				isDefault,
				hasStrategy: hasStrategyFor(controller)
			};
		});
	}

	/**
	 * Node inventory for the Fleet surface (Wave 12) — read-only summary
	 * of every node in the cluster the kubeconfig points at. Callers are
	 * responsible for the cluster-source boundary (custom kubeconfigs
	 * only); this method just lists what the credentials can see.
	 */
	async listNodes(kubeconfigYaml: string, contextOverride?: string): Promise<ClusterNodeDescriptor[]> {
		const client = this.factory.createKubeConfig(kubeconfigYaml, contextOverride);
		const core = this.factory.coreV1Api(client);
		try {
			const resp = await core.listNode();
			return (resp.items ?? []).map((item) => {
				const labels = item.metadata?.labels ?? {};
				const roles = Object.keys(labels)
					.filter((key) => key.startsWith('node-role.kubernetes.io/'))
					.map((key) => key.slice('node-role.kubernetes.io/'.length))
					.filter((role) => role.length > 0);
				const ready = (item.status?.conditions ?? []).some(
					(condition) => condition.type === 'Ready' && condition.status === 'True'
				);
				const info = item.status?.nodeInfo;
				const platform =
					info?.operatingSystem && info?.architecture
						? `${info.operatingSystem}/${info.architecture}`
						: undefined;
				return {
					name: item.metadata?.name ?? '',
					ready,
					...(platform ? { platform } : {}),
					...(info?.kubeletVersion ? { version: info.kubeletVersion } : {}),
					...(roles.length > 0 ? { roles } : {})
				};
			});
		} catch (err) {
			const scrubbed = scrubError(err);
			throw new K8sPluginError(scrubbed.code, scrubbed.message, err);
		}
	}

	async getDeployment(
		kubeconfigYaml: string,
		namespace: string,
		name: string,
		contextOverride?: string
	): Promise<{ metadata?: { name?: string; namespace?: string }; status?: DeploymentStatusInput } | null> {
		const client = this.factory.createKubeConfig(kubeconfigYaml, contextOverride);
		const appsApi = this.factory.appsV1Api(client);
		try {
			return await appsApi.readNamespacedDeployment({ name, namespace });
		} catch (err) {
			if (isNotFound(err)) return null;
			const scrubbed = scrubError(err);
			throw new K8sPluginError(scrubbed.code, scrubbed.message, err);
		}
	}

	async listManagedDeployments(
		kubeconfigYaml: string,
		contextOverride?: string
	): Promise<
		Array<{
			name: string;
			namespace: string;
			workId?: string;
			status?: DeploymentStatusInput;
		}>
	> {
		const client = this.factory.createKubeConfig(kubeconfigYaml, contextOverride);
		const appsApi = this.factory.appsV1Api(client);
		const resp = await appsApi.listDeploymentForAllNamespaces({
			labelSelector: 'ever-works.io/managed=true'
		});
		return (resp.items ?? []).map((item) => ({
			name: item.metadata?.name ?? '',
			namespace: item.metadata?.namespace ?? '',
			workId: item.metadata?.labels?.['ever-works.io/work-id'],
			status: item.status
		}));
	}

	async applyDeployment(
		kubeconfigYaml: string,
		manifest: Record<string, unknown>,
		contextOverride?: string
	): Promise<void> {
		const client = this.factory.createKubeConfig(kubeconfigYaml, contextOverride);
		const objects = this.factory.objectApi(client);
		await objects.patch(manifest, undefined, undefined, FIELD_MANAGER, true, SERVER_SIDE_APPLY);
	}

	async applyService(
		kubeconfigYaml: string,
		manifest: Record<string, unknown>,
		contextOverride?: string
	): Promise<void> {
		const client = this.factory.createKubeConfig(kubeconfigYaml, contextOverride);
		const objects = this.factory.objectApi(client);
		await objects.patch(manifest, undefined, undefined, FIELD_MANAGER, true, SERVER_SIDE_APPLY);
	}

	/**
	 * Idempotently create a namespace if it doesn't already exist. Apply
	 * helpers (`applyDeployment`, `applyService`, `applyIngress`) target a
	 * specific namespace and will 404 against a fresh cluster, so callers
	 * should run this first.
	 */
	async ensureNamespace(kubeconfigYaml: string, namespace: string, contextOverride?: string): Promise<void> {
		if (!namespace) return;
		const client = this.factory.createKubeConfig(kubeconfigYaml, contextOverride);
		const core = this.factory.coreV1Api(client);
		try {
			await core.readNamespace({ name: namespace });
			return;
		} catch (err) {
			if (!isNotFound(err)) {
				const scrubbed = scrubError(err);
				throw new K8sPluginError(scrubbed.code, scrubbed.message, err);
			}
		}
		try {
			await core.createNamespace({
				body: {
					apiVersion: 'v1',
					kind: 'Namespace',
					metadata: {
						name: namespace,
						labels: {
							'ever-works.io/managed': 'true',
							'app.kubernetes.io/managed-by': FIELD_MANAGER
						}
					}
				}
			});
		} catch (err) {
			// 409 (already-exists) is fine — the readNamespace race lost.
			if (isAlreadyExists(err)) return;
			const scrubbed = scrubError(err);
			throw new K8sPluginError(scrubbed.code, scrubbed.message, err);
		}
	}

	async applyIngress(
		kubeconfigYaml: string,
		manifest: Record<string, unknown>,
		contextOverride?: string
	): Promise<void> {
		const client = this.factory.createKubeConfig(kubeconfigYaml, contextOverride);
		const objects = this.factory.objectApi(client);
		await objects.patch(manifest, undefined, undefined, FIELD_MANAGER, true, SERVER_SIDE_APPLY);
	}

	async applyImagePullSecret(
		kubeconfigYaml: string,
		manifest: Record<string, unknown>,
		contextOverride?: string
	): Promise<void> {
		const client = this.factory.createKubeConfig(kubeconfigYaml, contextOverride);
		const objects = this.factory.objectApi(client);
		await objects.patch(manifest, undefined, undefined, FIELD_MANAGER, true, SERVER_SIDE_APPLY);
	}

	/**
	 * SSA-apply an arbitrary Secret manifest (runtime-env for server-side
	 * deploys). Same mechanics as `applyImagePullSecret` — kept as its own
	 * method so call sites say what they mean.
	 */
	async applySecret(
		kubeconfigYaml: string,
		manifest: Record<string, unknown>,
		contextOverride?: string
	): Promise<void> {
		const client = this.factory.createKubeConfig(kubeconfigYaml, contextOverride);
		const objects = this.factory.objectApi(client);
		await objects.patch(manifest, undefined, undefined, FIELD_MANAGER, true, SERVER_SIDE_APPLY);
	}

	async readIngress(
		kubeconfigYaml: string,
		namespace: string,
		name: string,
		contextOverride?: string
	): Promise<{
		metadata?: { name?: string };
		spec?: unknown;
		status?: { loadBalancer?: { ingress?: Array<{ hostname?: string; ip?: string }> } };
	} | null> {
		const client = this.factory.createKubeConfig(kubeconfigYaml, contextOverride);
		const net = this.factory.networkingV1Api(client);
		try {
			return await net.readNamespacedIngress({ name, namespace });
		} catch (err) {
			if (isNotFound(err)) return null;
			const scrubbed = scrubError(err);
			throw new K8sPluginError(scrubbed.code, scrubbed.message, err);
		}
	}

	/**
	 * Read the cluster-side ingress load-balancer host/IP for a work's
	 * Ingress, used as the expected DNS target when verifying custom
	 * domains. Returns null when:
	 *   - the Ingress doesn't exist yet (no `ingressHost` configured),
	 *   - the cluster hasn't assigned a LoadBalancer address yet
	 *     (ingress controller still spinning up).
	 *
	 * Without a target, `verifyDomain` falls back to "any A/CNAME exists"
	 * which is a false-positive trap — see [`domain.handler.spec.ts`].
	 */
	async getIngressLoadBalancerHost(
		kubeconfigYaml: string,
		namespace: string,
		name: string,
		contextOverride?: string
	): Promise<string | null> {
		const ingress = await this.readIngress(kubeconfigYaml, namespace, name, contextOverride);
		const lb = ingress?.status?.loadBalancer?.ingress?.[0];
		return lb?.hostname?.toLowerCase() || lb?.ip || null;
	}

	/**
	 * Generic Server-Side Apply for any object the App path renders
	 * (Deployment, Service, Ingress, ConfigMap, Job, NetworkPolicy, …).
	 *
	 * Same mechanics as `applySecret`/`applyIngress`: `KubernetesObjectApi`
	 * with Content-Type `application/apply-patch+yaml`, `FIELD_MANAGER` and
	 * `force=true`. Unlike those five older helpers this one scrubs and wraps
	 * failures in `K8sPluginError` (the original error stays reachable on
	 * `cause`) — the App path never surfaces a raw client error.
	 */
	async applyObject(
		kubeconfigYaml: string,
		manifest: Record<string, unknown>,
		contextOverride?: string
	): Promise<void> {
		const client = this.factory.createKubeConfig(kubeconfigYaml, contextOverride);
		const objects = this.factory.objectApi(client);
		try {
			await objects.patch(manifest, undefined, undefined, FIELD_MANAGER, true, SERVER_SIDE_APPLY);
		} catch (err) {
			const scrubbed = scrubError(err);
			throw new K8sPluginError(scrubbed.code, scrubbed.message, err);
		}
	}

	/**
	 * Read any object by `apiVersion`/`kind`/name. Returns `null` on 404 —
	 * "absent" is not an error for a read; the caller decides whether it is
	 * a failure (see `ensureNamespace` for the create-if-missing pattern).
	 *
	 * Pass an empty `namespace` for cluster-scoped kinds
	 * (`CustomResourceDefinition`, `StorageClass`, `ClusterIssuer`, …).
	 */
	async readObject<T = Record<string, unknown>>(
		kubeconfigYaml: string,
		apiVersion: string,
		kind: string,
		namespace: string,
		name: string,
		contextOverride?: string
	): Promise<T | null> {
		const client = this.factory.createKubeConfig(kubeconfigYaml, contextOverride);
		const objects = this.factory.objectApi(client);
		try {
			return await objects.read<T>(objectRef(apiVersion, kind, namespace, name));
		} catch (err) {
			if (isNotFound(err)) return null;
			const scrubbed = scrubError(err);
			throw new K8sPluginError(scrubbed.code, scrubbed.message, err);
		}
	}

	/**
	 * List objects by `apiVersion`/`kind`, optionally filtered by
	 * `labelSelector`. Always resolves to an array: an empty list is `[]`,
	 * never `null`.
	 *
	 * Pass an empty `namespace` for cluster-scoped kinds.
	 */
	async listObjects<T = Record<string, unknown>>(
		kubeconfigYaml: string,
		apiVersion: string,
		kind: string,
		namespace: string,
		labelSelector?: string,
		contextOverride?: string
	): Promise<T[]> {
		const client = this.factory.createKubeConfig(kubeconfigYaml, contextOverride);
		const objects = this.factory.objectApi(client);
		try {
			const resp = await objects.list<T>(
				apiVersion,
				kind,
				namespace || undefined, // namespace
				undefined, // pretty
				undefined, // exact
				undefined, // exportt
				undefined, // fieldSelector
				labelSelector // labelSelector — the 8th positional argument
			);
			return resp?.items ?? [];
		} catch (err) {
			const scrubbed = scrubError(err);
			throw new K8sPluginError(scrubbed.code, scrubbed.message, err);
		}
	}

	/**
	 * Delete any object by `apiVersion`/`kind`/name.
	 *
	 * A 404 is **not** an error here: deleting something that is already gone
	 * is what the caller asked for (App teardown runs over
	 * partially-created namespaces), so it returns quietly.
	 *
	 * @param propagationPolicy `Foreground` | `Background` | `Orphan`; passed
	 * as the 6th positional argument of `KubernetesObjectApi.delete`.
	 */
	async deleteObject(
		kubeconfigYaml: string,
		apiVersion: string,
		kind: string,
		namespace: string,
		name: string,
		propagationPolicy?: string,
		contextOverride?: string
	): Promise<void> {
		const client = this.factory.createKubeConfig(kubeconfigYaml, contextOverride);
		const objects = this.factory.objectApi(client);
		try {
			await objects.delete(
				objectRef(apiVersion, kind, namespace, name),
				undefined, // pretty
				undefined, // dryRun
				undefined, // gracePeriodSeconds
				undefined, // orphanDependents
				propagationPolicy
			);
		} catch (err) {
			if (isNotFound(err)) return;
			const scrubbed = scrubError(err);
			throw new K8sPluginError(scrubbed.code, scrubbed.message, err);
		}
	}

	/**
	 * Read one container's log.
	 *
	 * `limitBytes` is what keeps a huge log from being pulled into memory:
	 * the API server stops streaming once that many bytes have been read, so
	 * the client never buffers more than the cap. `tailLines` bounds the
	 * line count but not the size of a single line, so App log reads pass
	 * both.
	 *
	 * Returns the log text, or `null` when the pod/container is gone (404) —
	 * same "absent reads are not errors" rule as `readObject`. An empty log
	 * is `''`, not `null`.
	 *
	 * @param container Pass an empty string to let the API server pick the
	 * pod's only container.
	 */
	async readPodLog(
		kubeconfigYaml: string,
		namespace: string,
		pod: string,
		container: string,
		options: PodLogOptions = {},
		contextOverride?: string
	): Promise<string | null> {
		const client = this.factory.createKubeConfig(kubeconfigYaml, contextOverride);
		const core = this.factory.coreV1Api(client);
		try {
			return await core.readNamespacedPodLog({
				name: pod,
				namespace,
				...(container ? { container } : {}),
				...(options.tailLines !== undefined ? { tailLines: options.tailLines } : {}),
				...(options.limitBytes !== undefined ? { limitBytes: options.limitBytes } : {}),
				...(options.previous !== undefined ? { previous: options.previous } : {})
			});
		} catch (err) {
			if (isNotFound(err)) return null;
			const scrubbed = scrubError(err);
			throw new K8sPluginError(scrubbed.code, scrubbed.message, err);
		}
	}

	/**
	 * Ask the API server whether the kubeconfig's **own** credentials may
	 * perform `verb` on a resource — the `SelfSubjectAccessReview` half of
	 * the cluster connection check (plan §6.3).
	 *
	 * Returns the flattened `status`. A response without a `status` is
	 * reported as `allowed: false` (fail closed) rather than as success.
	 */
	async createSelfSubjectAccessReview(
		kubeconfigYaml: string,
		attributes: SelfSubjectAccessReviewInput,
		contextOverride?: string
	): Promise<SelfSubjectAccessReviewStatus> {
		const client = this.factory.createKubeConfig(kubeconfigYaml, contextOverride);
		const authorization = this.factory.authorizationV1Api(client);
		try {
			const resp = await authorization.createSelfSubjectAccessReview({
				body: {
					apiVersion: 'authorization.k8s.io/v1',
					kind: 'SelfSubjectAccessReview',
					spec: {
						resourceAttributes: {
							verb: attributes.verb,
							group: attributes.group,
							resource: attributes.resource,
							...(attributes.subresource ? { subresource: attributes.subresource } : {}),
							...(attributes.namespace ? { namespace: attributes.namespace } : {})
						}
					}
				}
			});
			const status = resp?.status;
			return {
				allowed: status?.allowed === true,
				...(status?.denied !== undefined ? { denied: status.denied } : {}),
				...(status?.reason !== undefined ? { reason: status.reason } : {}),
				...(status?.evaluationError !== undefined ? { evaluationError: status.evaluationError } : {})
			};
		} catch (err) {
			const scrubbed = scrubError(err);
			throw new K8sPluginError(scrubbed.code, scrubbed.message, err);
		}
	}

	/**
	 * Is `name`'s CustomResourceDefinition installed **and serving
	 * `version`**? This is the gate the App-dependency providers use to decide
	 * whether an operator path exists at all (APW-07 plan §4.9 calls it as
	 * `crdServed('clusters.postgresql.cnpg.io', 'v1')`).
	 *
	 * The CRD is read from `apiextensions.k8s.io/v1` `CustomResourceDefinitions`
	 * — cluster-scoped, so no namespace — and matched against
	 * `spec.versions[]`: a version that is absent, or present with
	 * `served: false`, is **not** served. A 404 is `false` ("not installed" is
	 * an answer, not an error — same rule as `readObject`).
	 *
	 * A non-404 failure (403, unreachable cluster) **throws** a scrubbed
	 * `K8sPluginError` instead of answering `false`. The caller has to tell
	 * "the operator is not installed" (→ plain path) apart from "we may not
	 * look" (→ `statusDetail.operatorSkipped = 'noPermission'`, APW07-G10),
	 * and a bare `false` would hide the permission problem behind a design
	 * choice.
	 */
	async crdServed(kubeconfigYaml: string, name: string, version: string, contextOverride?: string): Promise<boolean> {
		const crd = await this.readObject<CustomResourceDefinitionLike>(
			kubeconfigYaml,
			CRD_API_VERSION,
			'CustomResourceDefinition',
			'', // cluster-scoped
			name,
			contextOverride
		);
		if (!crd) return false;
		return (crd.spec?.versions ?? []).some((entry) => entry?.name === version && entry?.served === true);
	}

	/**
	 * Name of the cluster's default `StorageClass`, or `null` when the cluster
	 * has none — the precondition the plain Postgres path fails on with the
	 * definite reason `noDefaultStorageClass` (APW-07 S18 / ACC-07-20).
	 *
	 * A class counts as default only when one of its annotations is exactly
	 * `'true'` (the GA annotation, or the beta one it replaced), and the
	 * **first class carrying one** wins. Never "the first class in the list":
	 * on a cluster with several classes and no default that would hand back an
	 * arbitrary one instead of reporting the missing default.
	 *
	 * As with the other reads here, a non-404 API failure throws a scrubbed
	 * `K8sPluginError`, so `null` always means "the cluster really has no
	 * default".
	 */
	async defaultStorageClass(kubeconfigYaml: string, contextOverride?: string): Promise<string | null> {
		const storageClasses = await this.listObjects<StorageClassLike>(
			kubeconfigYaml,
			'storage.k8s.io/v1',
			'StorageClass',
			'', // cluster-scoped
			undefined,
			contextOverride
		);
		for (const storageClass of storageClasses) {
			const name = storageClass?.metadata?.name;
			if (!name) continue;
			const annotations = storageClass.metadata?.annotations ?? {};
			const isDefault = DEFAULT_STORAGE_CLASS_ANNOTATIONS.some(
				(annotation) => annotations[annotation] === 'true'
			);
			if (isDefault) return name;
		}
		return null;
	}
}

/**
 * Build the `{ apiVersion, kind, metadata }` header `KubernetesObjectApi`
 * reads and lists with. `namespace` is omitted entirely (rather than sent as
 * `undefined`) for cluster-scoped kinds.
 */
function objectRef(apiVersion: string, kind: string, namespace: string, name: string): KubernetesObjectRefLike {
	return { apiVersion, kind, metadata: namespace ? { name, namespace } : { name } };
}

function isNotFound(err: unknown): boolean {
	return isStatusCode(err, 404);
}

function isAlreadyExists(err: unknown): boolean {
	return isStatusCode(err, 409);
}

function isStatusCode(err: unknown, code: number): boolean {
	if (err && typeof err === 'object') {
		const e = err as { statusCode?: number; code?: number; response?: { statusCode?: number } };
		return e.statusCode === code || e.code === code || e.response?.statusCode === code;
	}
	return false;
}
