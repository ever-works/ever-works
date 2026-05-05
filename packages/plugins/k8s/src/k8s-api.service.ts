/**
 * Wrapper around `@kubernetes/client-node` that makes mocking trivial in
 * Vitest tests and centralises error scrubbing.
 *
 * Real cluster I/O is delegated to the official client; we never construct
 * raw HTTP requests ourselves.
 */
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
 * Hook so tests can inject mock clients without dynamic-importing the real
 * `@kubernetes/client-node` package.
 */
export interface KubernetesClientFactory {
	createKubeConfig(yaml: string, contextOverride?: string): KubernetesApiClientLike;
	versionApi(client: KubernetesApiClientLike): VersionApiLike;
	networkingV1Api(client: KubernetesApiClientLike): NetworkingV1ApiLike;
	appsV1Api(client: KubernetesApiClientLike): AppsV1ApiLike;
	coreV1Api(client: KubernetesApiClientLike): CoreV1ApiLike;
}

/**
 * Default factory using the real `@kubernetes/client-node`. Loaded with
 * dynamic import so this module is fast to import even when only the
 * pure parts (parser, renderer) are needed.
 */
export const defaultClientFactory: KubernetesClientFactory = {
	createKubeConfig(yamlContent: string, contextOverride?: string) {
		// Lazy require avoids paying client-node's load cost in unit tests
		// that mock the factory entirely.
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const k8s = require('@kubernetes/client-node');
		const kc = new k8s.KubeConfig();
		kc.loadFromString(yamlContent);
		if (contextOverride) {
			kc.setCurrentContext(contextOverride);
		}
		return kc;
	},
	versionApi(client) {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const k8s = require('@kubernetes/client-node');
		return client.makeApiClient(k8s.VersionApi);
	},
	networkingV1Api(client) {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const k8s = require('@kubernetes/client-node');
		return client.makeApiClient(k8s.NetworkingV1Api);
	},
	appsV1Api(client) {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const k8s = require('@kubernetes/client-node');
		return client.makeApiClient(k8s.AppsV1Api);
	},
	coreV1Api(client) {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const k8s = require('@kubernetes/client-node');
		return client.makeApiClient(k8s.CoreV1Api);
	},
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
		},
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
				requiresExecPlugin: parsed.requiresExecPlugin,
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
		contextOverride?: string,
	): Promise<IngressClassDescriptor[]> {
		const client = this.factory.createKubeConfig(kubeconfigYaml, contextOverride);
		const networkingApi = this.factory.networkingV1Api(client);
		return this.listIngressClassesInternal(networkingApi, hasStrategyFor);
	}

	private async listIngressClassesInternal(
		api: NetworkingV1ApiLike,
		hasStrategyFor: (controller: string) => boolean,
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
				hasStrategy: hasStrategyFor(controller),
			};
		});
	}

	async getDeployment(
		kubeconfigYaml: string,
		namespace: string,
		name: string,
		contextOverride?: string,
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
		contextOverride?: string,
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
			labelSelector: 'ever-works.io/managed=true',
		});
		return (resp.items ?? []).map((item) => ({
			name: item.metadata?.name ?? '',
			namespace: item.metadata?.namespace ?? '',
			workId: item.metadata?.labels?.['ever-works.io/work-id'],
			status: item.status,
		}));
	}

	async applyDeployment(
		kubeconfigYaml: string,
		manifest: Record<string, unknown>,
		contextOverride?: string,
	): Promise<void> {
		const client = this.factory.createKubeConfig(kubeconfigYaml, contextOverride);
		const apps = this.factory.appsV1Api(client);
		const meta = (manifest.metadata as { name?: string; namespace?: string }) ?? {};
		await apps.patchNamespacedDeployment({
			name: meta.name ?? '',
			namespace: meta.namespace ?? '',
			body: manifest,
			fieldManager: FIELD_MANAGER,
			force: true,
		});
	}

	async applyService(
		kubeconfigYaml: string,
		manifest: Record<string, unknown>,
		contextOverride?: string,
	): Promise<void> {
		const client = this.factory.createKubeConfig(kubeconfigYaml, contextOverride);
		const core = this.factory.coreV1Api(client);
		const meta = (manifest.metadata as { name?: string; namespace?: string }) ?? {};
		await core.patchNamespacedService({
			name: meta.name ?? '',
			namespace: meta.namespace ?? '',
			body: manifest,
			fieldManager: FIELD_MANAGER,
			force: true,
		});
	}

	async applyIngress(
		kubeconfigYaml: string,
		manifest: Record<string, unknown>,
		contextOverride?: string,
	): Promise<void> {
		const client = this.factory.createKubeConfig(kubeconfigYaml, contextOverride);
		const net = this.factory.networkingV1Api(client);
		const meta = (manifest.metadata as { name?: string; namespace?: string }) ?? {};
		await net.patchNamespacedIngress({
			name: meta.name ?? '',
			namespace: meta.namespace ?? '',
			body: manifest,
			fieldManager: FIELD_MANAGER,
			force: true,
		});
	}

	async applyImagePullSecret(
		kubeconfigYaml: string,
		manifest: Record<string, unknown>,
		contextOverride?: string,
	): Promise<void> {
		const client = this.factory.createKubeConfig(kubeconfigYaml, contextOverride);
		const core = this.factory.coreV1Api(client);
		const meta = (manifest.metadata as { name?: string; namespace?: string }) ?? {};
		await core.patchNamespacedSecret({
			name: meta.name ?? '',
			namespace: meta.namespace ?? '',
			body: manifest,
			fieldManager: FIELD_MANAGER,
			force: true,
		});
	}

	async readIngress(
		kubeconfigYaml: string,
		namespace: string,
		name: string,
		contextOverride?: string,
	): Promise<{ metadata?: { name?: string }; spec?: unknown } | null> {
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
}

function isNotFound(err: unknown): boolean {
	if (err && typeof err === 'object') {
		const e = err as { statusCode?: number; code?: number; response?: { statusCode?: number } };
		return e.statusCode === 404 || e.code === 404 || e.response?.statusCode === 404;
	}
	return false;
}
