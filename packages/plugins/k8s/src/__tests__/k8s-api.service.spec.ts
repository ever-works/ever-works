import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { KubernetesApiService, type KubernetesClientFactory } from '../k8s-api.service';
import { K8sPluginError } from '../errors';
import { FIELD_MANAGER } from '../manifest.renderer';

const VALID = readFileSync(resolve(__dirname, 'fixtures/kubeconfig-valid.yml'), 'utf-8');

function makeFactory(overrides: Partial<KubernetesClientFactory> = {}): {
	factory: KubernetesClientFactory;
	versionApi: { getCode: ReturnType<typeof vi.fn> };
	networkingApi: {
		listIngressClass: ReturnType<typeof vi.fn>;
		readNamespacedIngress: ReturnType<typeof vi.fn>;
		patchNamespacedIngress: ReturnType<typeof vi.fn>;
	};
	appsApi: {
		listDeploymentForAllNamespaces: ReturnType<typeof vi.fn>;
		readNamespacedDeployment: ReturnType<typeof vi.fn>;
		patchNamespacedDeployment: ReturnType<typeof vi.fn>;
	};
	coreApi: {
		patchNamespacedService: ReturnType<typeof vi.fn>;
		patchNamespacedSecret: ReturnType<typeof vi.fn>;
		createNamespace: ReturnType<typeof vi.fn>;
		readNamespace: ReturnType<typeof vi.fn>;
	};
	createKubeConfig: ReturnType<typeof vi.fn>;
} {
	const versionApi = { getCode: vi.fn(async () => ({ gitVersion: 'v1.30.4', platform: 'linux/amd64' })) };
	const networkingApi = {
		listIngressClass: vi.fn(async () => ({
			items: [
				{
					metadata: {
						name: 'nginx',
						annotations: { 'ingressclass.kubernetes.io/is-default-class': 'true' }
					},
					spec: { controller: 'k8s.io/ingress-nginx' }
				},
				{
					metadata: { name: 'traefik' },
					spec: { controller: 'traefik.io/ingress-controller' }
				},
				{
					metadata: { name: 'gloo' },
					spec: { controller: 'gloo.solo.io/gloo' }
				}
			]
		})),
		readNamespacedIngress: vi.fn(async () => ({ metadata: { name: 'x' }, spec: { rules: [] } })),
		patchNamespacedIngress: vi.fn(async () => undefined),
		listNamespacedIngress: vi.fn(async () => ({ items: [] }))
	};
	const appsApi = {
		listDeploymentForAllNamespaces: vi.fn(async () => ({
			items: [
				{
					metadata: {
						name: 'site-a',
						namespace: 'ever-works',
						labels: { 'ever-works.io/work-id': 'work-a' }
					},
					status: { conditions: [{ type: 'Available', status: 'True' }] }
				}
			]
		})),
		readNamespacedDeployment: vi.fn(async () => ({
			metadata: { name: 'site-a', namespace: 'ever-works' },
			status: { conditions: [{ type: 'Available', status: 'True' }] }
		})),
		patchNamespacedDeployment: vi.fn(async () => undefined)
	};
	const coreApi = {
		patchNamespacedService: vi.fn(async () => undefined),
		patchNamespacedSecret: vi.fn(async () => undefined),
		createNamespace: vi.fn(async () => undefined),
		readNamespace: vi.fn(async () => undefined)
	};
	const createKubeConfig = vi.fn(() => ({
		loadFromString: vi.fn(),
		setCurrentContext: vi.fn(),
		makeApiClient: vi.fn()
	}));

	const factory: KubernetesClientFactory = {
		createKubeConfig: createKubeConfig as never,
		versionApi: () => versionApi as never,
		networkingV1Api: () => networkingApi as never,
		appsV1Api: () => appsApi as never,
		coreV1Api: () => coreApi as never,
		...overrides
	};

	return { factory, versionApi, networkingApi, appsApi, coreApi, createKubeConfig };
}

describe('KubernetesApiService.validateConnection', () => {
	it('returns cluster info with detected ingress classes', async () => {
		const { factory, networkingApi } = makeFactory();
		const svc = new KubernetesApiService(factory);

		const info = await svc.validateConnection(VALID, {
			hasStrategyFor: (c) => c === 'k8s.io/ingress-nginx' || c === 'traefik.io/ingress-controller'
		});

		expect(info.clusterName).toBe('kind-dev');
		expect(info.serverVersion).toBe('v1.30.4');
		expect(info.serverFingerprint).toMatch(/^[0-9a-f]{16}$/);
		expect(info.ingressClasses).toHaveLength(3);
		expect(info.ingressClasses[0]).toMatchObject({
			name: 'nginx',
			controller: 'k8s.io/ingress-nginx',
			isDefault: true,
			hasStrategy: true
		});
		expect(info.ingressClasses.find((c) => c.name === 'gloo')?.hasStrategy).toBe(false);
		expect(info.requiresExecPlugin).toBe(false);
		expect(networkingApi.listIngressClass).toHaveBeenCalledTimes(1);
	});

	it('runs the round-trip on every call (FR-24: no caching in v1)', async () => {
		const { factory, networkingApi } = makeFactory();
		const svc = new KubernetesApiService(factory);
		await svc.validateConnection(VALID, { hasStrategyFor: () => true });
		await svc.validateConnection(VALID, { hasStrategyFor: () => true });
		await svc.validateConnection(VALID, { hasStrategyFor: () => true });
		expect(networkingApi.listIngressClass).toHaveBeenCalledTimes(3);
	});

	it('wraps API errors in K8sPluginError with scrubbed message', async () => {
		const { factory } = makeFactory({
			versionApi: () =>
				({
					getCode: async () => {
						throw new Error('connection failed: token: super-secret-leak');
					}
				}) as never
		});
		const svc = new KubernetesApiService(factory);

		await expect(svc.validateConnection(VALID, { hasStrategyFor: () => true })).rejects.toThrow(K8sPluginError);

		try {
			await svc.validateConnection(VALID, { hasStrategyFor: () => true });
		} catch (err) {
			expect((err as Error).message).not.toContain('super-secret-leak');
			expect((err as Error).message).toContain('[REDACTED]');
		}
	});

	it('rejects malformed kubeconfigs at parse time (no API call)', async () => {
		const { factory, networkingApi } = makeFactory();
		const svc = new KubernetesApiService(factory);

		await expect(svc.validateConnection('not-yaml: [bad', { hasStrategyFor: () => true })).rejects.toThrow(
			K8sPluginError
		);

		expect(networkingApi.listIngressClass).not.toHaveBeenCalled();
	});
});

describe('KubernetesApiService.listIngressClasses', () => {
	it('returns descriptors with hasStrategy flagged correctly', async () => {
		const { factory } = makeFactory();
		const svc = new KubernetesApiService(factory);
		const classes = await svc.listIngressClasses(VALID, (c) => c === 'k8s.io/ingress-nginx');
		expect(classes.find((c) => c.name === 'nginx')?.hasStrategy).toBe(true);
		expect(classes.find((c) => c.name === 'traefik')?.hasStrategy).toBe(false);
	});
});

describe('KubernetesApiService.getDeployment', () => {
	it('returns the Deployment when present', async () => {
		const { factory } = makeFactory();
		const svc = new KubernetesApiService(factory);
		const d = await svc.getDeployment(VALID, 'ever-works', 'site-a');
		expect(d?.metadata?.name).toBe('site-a');
	});

	it('returns null on 404 instead of throwing', async () => {
		const { factory } = makeFactory({
			appsV1Api: () =>
				({
					readNamespacedDeployment: async () => {
						const e = new Error('not found') as Error & { statusCode: number };
						e.statusCode = 404;
						throw e;
					}
				}) as never
		});
		const svc = new KubernetesApiService(factory);
		const d = await svc.getDeployment(VALID, 'ever-works', 'site-a');
		expect(d).toBeNull();
	});

	it('throws (scrubbed) on non-404 errors', async () => {
		const { factory } = makeFactory({
			appsV1Api: () =>
				({
					readNamespacedDeployment: async () => {
						throw new Error('500 Internal Error: token: secret-leak-67890');
					}
				}) as never
		});
		const svc = new KubernetesApiService(factory);
		try {
			await svc.getDeployment(VALID, 'ever-works', 'site-a');
			throw new Error('expected throw');
		} catch (err) {
			expect((err as Error).message).not.toContain('secret-leak-67890');
		}
	});
});

describe('KubernetesApiService.listManagedDeployments', () => {
	it('passes the managed label selector and maps the response', async () => {
		const { factory, appsApi } = makeFactory();
		const svc = new KubernetesApiService(factory);
		const result = await svc.listManagedDeployments(VALID);
		expect(appsApi.listDeploymentForAllNamespaces).toHaveBeenCalledWith({
			labelSelector: 'ever-works.io/managed=true'
		});
		expect(result[0]).toMatchObject({
			name: 'site-a',
			namespace: 'ever-works',
			workId: 'work-a'
		});
	});
});

describe('KubernetesApiService SSA apply helpers', () => {
	it('applyDeployment uses the field manager and force=true', async () => {
		const { factory, appsApi } = makeFactory();
		const svc = new KubernetesApiService(factory);
		await svc.applyDeployment(VALID, {
			apiVersion: 'apps/v1',
			kind: 'Deployment',
			metadata: { name: 'site-a', namespace: 'ever-works' },
			spec: {}
		});
		expect(appsApi.patchNamespacedDeployment).toHaveBeenCalledWith(
			expect.objectContaining({
				name: 'site-a',
				namespace: 'ever-works',
				fieldManager: FIELD_MANAGER,
				force: true
			})
		);
	});

	it('applyService passes manifest body through to CoreV1', async () => {
		const { factory, coreApi } = makeFactory();
		const svc = new KubernetesApiService(factory);
		const manifest = {
			apiVersion: 'v1',
			kind: 'Service',
			metadata: { name: 'site-a', namespace: 'ns' }
		};
		await svc.applyService(VALID, manifest);
		expect(coreApi.patchNamespacedService).toHaveBeenCalledWith(
			expect.objectContaining({ body: manifest, fieldManager: FIELD_MANAGER })
		);
	});

	it('applyIngress passes manifest body through to NetworkingV1', async () => {
		const { factory, networkingApi } = makeFactory();
		const svc = new KubernetesApiService(factory);
		const manifest = {
			apiVersion: 'networking.k8s.io/v1',
			kind: 'Ingress',
			metadata: { name: 'site-a', namespace: 'ns' }
		};
		await svc.applyIngress(VALID, manifest);
		expect(networkingApi.patchNamespacedIngress).toHaveBeenCalledWith(
			expect.objectContaining({ body: manifest, fieldManager: FIELD_MANAGER })
		);
	});

	it('applyImagePullSecret patches the namespaced Secret', async () => {
		const { factory, coreApi } = makeFactory();
		const svc = new KubernetesApiService(factory);
		const manifest = {
			apiVersion: 'v1',
			kind: 'Secret',
			metadata: { name: 'pull', namespace: 'ns' }
		};
		await svc.applyImagePullSecret(VALID, manifest);
		expect(coreApi.patchNamespacedSecret).toHaveBeenCalled();
	});
});

describe('KubernetesApiService.readIngress', () => {
	it('returns null on 404', async () => {
		const { factory } = makeFactory({
			networkingV1Api: () =>
				({
					listIngressClass: async () => ({ items: [] }),
					readNamespacedIngress: async () => {
						const e = new Error('not found') as Error & { statusCode: number };
						e.statusCode = 404;
						throw e;
					},
					patchNamespacedIngress: async () => undefined,
					listNamespacedIngress: async () => ({ items: [] })
				}) as never
		});
		const svc = new KubernetesApiService(factory);
		const r = await svc.readIngress(VALID, 'ns', 'name');
		expect(r).toBeNull();
	});

	it('returns the Ingress object on success', async () => {
		const { factory } = makeFactory();
		const svc = new KubernetesApiService(factory);
		const r = await svc.readIngress(VALID, 'ever-works', 'site-a');
		expect(r?.metadata?.name).toBe('x');
	});
});
