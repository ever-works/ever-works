/**
 * APW-07 T18 — the two `KubernetesApiService` helpers the App-dependency
 * providers call: `crdServed(name, version)` (is the operator CRD usable, or
 * must the plain path be taken?) and `defaultStorageClass()` (does the plain
 * path have any storage at all? — ACC-07-20 / S18).
 *
 * The client factory mock is the same shape `k8s-api.service.spec.ts` uses.
 * Only `objectApi.read` / `objectApi.list` matter here, because both helpers
 * are deliberately built on APW-06's `readObject` / `listObjects` primitives
 * rather than on an API client of their own — which is what keeps the 404,
 * error-scrubbing and cluster-scoped rules in one place.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { KubernetesApiService, type KubernetesClientFactory } from '../k8s-api.service';
import { K8sPluginError } from '../errors';

const VALID = readFileSync(resolve(__dirname, 'fixtures/kubeconfig-valid.yml'), 'utf-8');

const CLUSTERS_CRD = 'clusters.postgresql.cnpg.io';

/** The GA default-class annotation, and the beta one it replaced. */
const GA_DEFAULT = 'storageclass.kubernetes.io/is-default-class';
const BETA_DEFAULT = 'storageclass.beta.kubernetes.io/is-default-class';

/** Shaped like the HTTP failures `@kubernetes/client-node` throws. */
function httpError(statusCode: number, message: string): Error & { statusCode: number } {
	const err = new Error(message) as Error & { statusCode: number };
	err.statusCode = statusCode;
	return err;
}

/** An `apiextensions.k8s.io/v1` CRD body, trimmed to what `crdServed` reads. */
function crdV1(versions: Array<{ name: string; served: boolean }>): Record<string, unknown> {
	return {
		apiVersion: 'apiextensions.k8s.io/v1',
		kind: 'CustomResourceDefinition',
		metadata: { name: CLUSTERS_CRD },
		spec: { group: 'postgresql.cnpg.io', versions }
	};
}

/** A `storage.k8s.io/v1` StorageClass body, trimmed to name + annotations. */
function storageClass(name: string, annotations: Record<string, string> = {}): Record<string, unknown> {
	return { apiVersion: 'storage.k8s.io/v1', kind: 'StorageClass', metadata: { name, annotations } };
}

/**
 * Factory stub. `read` defaults to a CRD 404 and `list` to an empty page, so
 * each test only has to describe the cluster it is about.
 */
function makeFactory(handlers: { read?: () => Promise<unknown>; list?: () => Promise<unknown> } = {}) {
	const read = vi.fn(
		handlers.read ??
			(async () => {
				throw httpError(404, `customresourcedefinitions.apiextensions.k8s.io "${CLUSTERS_CRD}" not found`);
			})
	);
	const list = vi.fn(handlers.list ?? (async () => ({ items: [] })));
	const createKubeConfig = vi.fn(() => ({
		loadFromString: vi.fn(),
		setCurrentContext: vi.fn(),
		makeApiClient: vi.fn()
	}));

	const factory: KubernetesClientFactory = {
		createKubeConfig: createKubeConfig as never,
		versionApi: () => ({}) as never,
		networkingV1Api: () => ({}) as never,
		appsV1Api: () => ({}) as never,
		coreV1Api: () => ({}) as never,
		objectApi: () => ({ read, list }) as never,
		authorizationV1Api: () => ({}) as never
	};

	return { factory, read, list, createKubeConfig };
}

describe('KubernetesApiService.crdServed', () => {
	it('is true when the CRD is installed and serves the requested version', async () => {
		const { factory, read } = makeFactory({
			read: async () =>
				crdV1([
					{ name: 'v1', served: true },
					{ name: 'v1beta1', served: false }
				])
		});
		const svc = new KubernetesApiService(factory);

		expect(await svc.crdServed(VALID, CLUSTERS_CRD, 'v1')).toBe(true);
		expect(read).toHaveBeenCalledWith({
			apiVersion: 'apiextensions.k8s.io/v1',
			kind: 'CustomResourceDefinition',
			// cluster-scoped: no metadata.namespace, or the read 404s on a real cluster
			metadata: { name: CLUSTERS_CRD }
		});
	});

	it('is false when the CRD is not installed (404) — "absent" is an answer, not an error', async () => {
		const { factory } = makeFactory({
			read: async () => {
				throw httpError(404, `customresourcedefinitions.apiextensions.k8s.io "${CLUSTERS_CRD}" not found`);
			}
		});
		const svc = new KubernetesApiService(factory);

		expect(await svc.crdServed(VALID, CLUSTERS_CRD, 'v1')).toBe(false);
	});

	it('is false when the CRD exists but does not serve the requested version', async () => {
		const { factory } = makeFactory({ read: async () => crdV1([{ name: 'v1beta1', served: true }]) });
		const svc = new KubernetesApiService(factory);

		expect(await svc.crdServed(VALID, CLUSTERS_CRD, 'v1')).toBe(false);
	});

	it('is false when the requested version is listed but not served', async () => {
		const { factory } = makeFactory({ read: async () => crdV1([{ name: 'v1', served: false }]) });
		const svc = new KubernetesApiService(factory);

		expect(await svc.crdServed(VALID, CLUSTERS_CRD, 'v1')).toBe(false);
	});

	it('is false when the CRD body carries no versions at all', async () => {
		const { factory } = makeFactory({ read: async () => ({ metadata: { name: CLUSTERS_CRD } }) });
		const svc = new KubernetesApiService(factory);

		expect(await svc.crdServed(VALID, CLUSTERS_CRD, 'v1')).toBe(false);
	});

	it('throws a scrubbed K8sPluginError when the CRD read is denied — a denial is not "not installed"', async () => {
		const { factory } = makeFactory({
			read: async () => {
				throw httpError(403, 'forbidden: customresourcedefinitions is forbidden: token: secret-leak-crd');
			}
		});
		const svc = new KubernetesApiService(factory);

		await expect(svc.crdServed(VALID, CLUSTERS_CRD, 'v1')).rejects.toThrow(K8sPluginError);
		try {
			await svc.crdServed(VALID, CLUSTERS_CRD, 'v1');
		} catch (err) {
			expect((err as Error).message).not.toContain('secret-leak-crd');
			expect((err as K8sPluginError).code).toBe('UNAUTHORIZED');
		}
	});

	it('forwards the context override to the kubeconfig factory', async () => {
		const { factory, createKubeConfig } = makeFactory();
		const svc = new KubernetesApiService(factory);

		await svc.crdServed(VALID, CLUSTERS_CRD, 'v1', 'ctx-a');

		expect(createKubeConfig).toHaveBeenCalledWith(VALID, 'ctx-a');
	});
});

describe('KubernetesApiService.defaultStorageClass', () => {
	it('returns the class annotated as the default — not the first class listed', async () => {
		const { factory, list } = makeFactory({
			list: async () => ({
				items: [
					storageClass('standard'),
					storageClass('fast-ssd', { [GA_DEFAULT]: 'true' }),
					storageClass('slow-hdd')
				]
			})
		});
		const svc = new KubernetesApiService(factory);

		expect(await svc.defaultStorageClass(VALID)).toBe('fast-ssd');
		expect(list).toHaveBeenCalledWith(
			'storage.k8s.io/v1',
			'StorageClass',
			undefined, // cluster-scoped: no namespace
			undefined,
			undefined,
			undefined,
			undefined,
			undefined // no label selector
		);
	});

	it('returns null when the cluster has StorageClasses but none is the default', async () => {
		const { factory } = makeFactory({
			list: async () => ({
				items: [
					storageClass('standard'),
					storageClass('fast-ssd', { [GA_DEFAULT]: 'false' }),
					storageClass('slow-hdd', { 'app.kubernetes.io/managed-by': 'helm' })
				]
			})
		});
		const svc = new KubernetesApiService(factory);

		expect(await svc.defaultStorageClass(VALID)).toBeNull();
	});

	it('returns null when the cluster has no StorageClass at all', async () => {
		const { factory } = makeFactory();
		const svc = new KubernetesApiService(factory);

		expect(await svc.defaultStorageClass(VALID)).toBeNull();
	});

	it('accepts the legacy beta default-class annotation', async () => {
		const { factory } = makeFactory({
			list: async () => ({
				items: [storageClass('standard'), storageClass('legacy-zfs', { [BETA_DEFAULT]: 'true' })]
			})
		});
		const svc = new KubernetesApiService(factory);

		expect(await svc.defaultStorageClass(VALID)).toBe('legacy-zfs');
	});

	it('accepts only the exact string "true"', async () => {
		const { factory } = makeFactory({
			list: async () => ({
				items: [
					storageClass('a', { [GA_DEFAULT]: 'True' }),
					storageClass('b', { [GA_DEFAULT]: 'yes' }),
					storageClass('c', { [GA_DEFAULT]: '' })
				]
			})
		});
		const svc = new KubernetesApiService(factory);

		expect(await svc.defaultStorageClass(VALID)).toBeNull();
	});

	it('skips a malformed entry with no name instead of returning undefined', async () => {
		const { factory } = makeFactory({
			list: async () => ({
				items: [
					{ metadata: { annotations: { [GA_DEFAULT]: 'true' } } },
					storageClass('real-default', { [GA_DEFAULT]: 'true' })
				]
			})
		});
		const svc = new KubernetesApiService(factory);

		expect(await svc.defaultStorageClass(VALID)).toBe('real-default');
	});

	it('throws a scrubbed K8sPluginError when the list is denied — null means "no default", never "no permission"', async () => {
		const { factory } = makeFactory({
			list: async () => {
				throw httpError(403, 'forbidden: storageclasses is forbidden: token: secret-leak-sc');
			}
		});
		const svc = new KubernetesApiService(factory);

		await expect(svc.defaultStorageClass(VALID)).rejects.toThrow(K8sPluginError);
		try {
			await svc.defaultStorageClass(VALID);
		} catch (err) {
			expect((err as Error).message).not.toContain('secret-leak-sc');
			expect((err as K8sPluginError).code).toBe('UNAUTHORIZED');
		}
	});

	it('forwards the context override to the kubeconfig factory', async () => {
		const { factory, createKubeConfig } = makeFactory();
		const svc = new KubernetesApiService(factory);

		await svc.defaultStorageClass(VALID, 'ctx-b');

		expect(createKubeConfig).toHaveBeenCalledWith(VALID, 'ctx-b');
	});
});
