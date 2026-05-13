/**
 * Wrapper around `@kubernetes/client-node` that makes mocking trivial in
 * Vitest tests and centralises error scrubbing.
 *
 * Real cluster I/O is delegated to the official client; we never construct
 * raw HTTP requests ourselves.
 */
import { createRequire } from 'node:module';
import type { IngressClassDescriptor, KubernetesClusterInfo } from './types.js';
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
}

/**
 * Subset of @kubernetes/client-node KubernetesObjectApi we depend on. Used
 * for Server-Side Apply so we can specify Content-Type
 * `application/apply-patch+yaml` and pass `force=true` — the typed
 * patchNamespaced* methods on AppsV1Api/CoreV1Api/NetworkingV1Api default to
 * Strategic Merge Patch, which rejects `force` with a 422.
 */
interface KubernetesObjectApiLike {
	patch(
		spec: Record<string, unknown>,
		pretty?: string,
		dryRun?: string,
		fieldManager?: string,
		force?: boolean,
		patchStrategy?: string
	): Promise<unknown>;
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
	}
};

const DEFAULT_CLASS_ANNOTATION = 'ingressclass.kubernetes.io/is-default-class';

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
