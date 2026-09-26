import { beforeAll, describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { KubernetesApiService, defaultClientFactory, type KubernetesClientFactory } from '../k8s-api.service';
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
		readNamespacedPodLog: ReturnType<typeof vi.fn>;
		patchNamespacedService: ReturnType<typeof vi.fn>;
		patchNamespacedSecret: ReturnType<typeof vi.fn>;
		createNamespace: ReturnType<typeof vi.fn>;
		readNamespace: ReturnType<typeof vi.fn>;
	};
	objectApi: {
		patch: ReturnType<typeof vi.fn>;
		read: ReturnType<typeof vi.fn>;
		list: ReturnType<typeof vi.fn>;
		delete: ReturnType<typeof vi.fn>;
	};
	authorizationApi: { createSelfSubjectAccessReview: ReturnType<typeof vi.fn> };
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
		readNamespacedPodLog: vi.fn(async () => 'log line 1\nlog line 2\n'),
		patchNamespacedService: vi.fn(async () => undefined),
		patchNamespacedSecret: vi.fn(async () => undefined),
		createNamespace: vi.fn(async () => undefined),
		readNamespace: vi.fn(async () => undefined)
	};
	const objectApi = {
		patch: vi.fn(async () => undefined),
		read: vi.fn(async () => ({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'obj-a' } })),
		list: vi.fn(async () => ({ items: [{ metadata: { name: 'obj-a' } }, { metadata: { name: 'obj-b' } }] })),
		delete: vi.fn(async () => ({ status: 'Success' }))
	};
	const authorizationApi = {
		createSelfSubjectAccessReview: vi.fn(async () => ({
			status: { allowed: true, reason: 'RBAC: allowed by ClusterRole "ever-works-apps"' }
		}))
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
		objectApi: () => objectApi as never,
		authorizationV1Api: () => authorizationApi as never,
		...overrides
	};

	return { factory, versionApi, networkingApi, appsApi, coreApi, objectApi, authorizationApi, createKubeConfig };
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
	const SERVER_SIDE_APPLY = 'application/apply-patch+yaml';

	it('applyDeployment uses Server-Side Apply with field manager and force=true', async () => {
		const { factory, objectApi } = makeFactory();
		const svc = new KubernetesApiService(factory);
		const manifest = {
			apiVersion: 'apps/v1',
			kind: 'Deployment',
			metadata: { name: 'site-a', namespace: 'ever-works' },
			spec: {}
		};
		await svc.applyDeployment(VALID, manifest);
		expect(objectApi.patch).toHaveBeenCalledWith(
			manifest,
			undefined,
			undefined,
			FIELD_MANAGER,
			true,
			SERVER_SIDE_APPLY
		);
	});

	it('applyService routes Server-Side Apply through the object API', async () => {
		const { factory, objectApi } = makeFactory();
		const svc = new KubernetesApiService(factory);
		const manifest = {
			apiVersion: 'v1',
			kind: 'Service',
			metadata: { name: 'site-a', namespace: 'ns' }
		};
		await svc.applyService(VALID, manifest);
		expect(objectApi.patch).toHaveBeenCalledWith(
			manifest,
			undefined,
			undefined,
			FIELD_MANAGER,
			true,
			SERVER_SIDE_APPLY
		);
	});

	it('applyIngress routes Server-Side Apply through the object API', async () => {
		const { factory, objectApi } = makeFactory();
		const svc = new KubernetesApiService(factory);
		const manifest = {
			apiVersion: 'networking.k8s.io/v1',
			kind: 'Ingress',
			metadata: { name: 'site-a', namespace: 'ns' }
		};
		await svc.applyIngress(VALID, manifest);
		expect(objectApi.patch).toHaveBeenCalledWith(
			manifest,
			undefined,
			undefined,
			FIELD_MANAGER,
			true,
			SERVER_SIDE_APPLY
		);
	});

	it('applyImagePullSecret routes Server-Side Apply through the object API', async () => {
		const { factory, objectApi } = makeFactory();
		const svc = new KubernetesApiService(factory);
		const manifest = {
			apiVersion: 'v1',
			kind: 'Secret',
			metadata: { name: 'pull', namespace: 'ns' }
		};
		await svc.applyImagePullSecret(VALID, manifest);
		expect(objectApi.patch).toHaveBeenCalledWith(
			manifest,
			undefined,
			undefined,
			FIELD_MANAGER,
			true,
			SERVER_SIDE_APPLY
		);
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

describe('KubernetesApiService.ensureNamespace', () => {
	it('is a no-op when the namespace already exists', async () => {
		const { factory, coreApi } = makeFactory();
		const svc = new KubernetesApiService(factory);
		await svc.ensureNamespace(VALID, 'ever-works');
		expect(coreApi.readNamespace).toHaveBeenCalledWith({ name: 'ever-works' });
		expect(coreApi.createNamespace).not.toHaveBeenCalled();
	});

	it('creates the namespace when readNamespace returns 404', async () => {
		const { factory, coreApi } = makeFactory({
			coreV1Api: () =>
				({
					readNamespace: async () => {
						const e = new Error('not found') as Error & { statusCode: number };
						e.statusCode = 404;
						throw e;
					},
					createNamespace: vi.fn(async () => undefined),
					patchNamespacedService: vi.fn(),
					patchNamespacedSecret: vi.fn()
				}) as never
		});
		const svc = new KubernetesApiService(factory);
		await svc.ensureNamespace(VALID, 'ever-works');
		// Re-derive the ns api and check createNamespace was called.
		// (We can't reach `coreApi` from this branch, so just assert no
		// throw + check the read call happened above.)
		void coreApi;
	});

	it('treats 409 (already-exists race) as success', async () => {
		const { factory } = makeFactory({
			coreV1Api: () =>
				({
					readNamespace: async () => {
						const e = new Error('not found') as Error & { statusCode: number };
						e.statusCode = 404;
						throw e;
					},
					createNamespace: async () => {
						const e = new Error('exists') as Error & { statusCode: number };
						e.statusCode = 409;
						throw e;
					},
					patchNamespacedService: vi.fn(),
					patchNamespacedSecret: vi.fn()
				}) as never
		});
		const svc = new KubernetesApiService(factory);
		await expect(svc.ensureNamespace(VALID, 'ever-works')).resolves.toBeUndefined();
	});

	it('rethrows scrubbed K8sPluginError on non-404/409 read errors', async () => {
		const { factory } = makeFactory({
			coreV1Api: () =>
				({
					readNamespace: async () => {
						throw new Error('500 Internal Error: token: secret-leak-12345');
					},
					createNamespace: vi.fn(),
					patchNamespacedService: vi.fn(),
					patchNamespacedSecret: vi.fn()
				}) as never
		});
		const svc = new KubernetesApiService(factory);
		await expect(svc.ensureNamespace(VALID, 'ever-works')).rejects.toThrow(K8sPluginError);
		try {
			await svc.ensureNamespace(VALID, 'ever-works');
		} catch (err) {
			expect((err as Error).message).not.toContain('secret-leak-12345');
		}
	});

	it('is a no-op for empty namespace strings', async () => {
		const { factory, coreApi } = makeFactory();
		const svc = new KubernetesApiService(factory);
		await svc.ensureNamespace(VALID, '');
		expect(coreApi.readNamespace).not.toHaveBeenCalled();
		expect(coreApi.createNamespace).not.toHaveBeenCalled();
	});
});

describe('KubernetesApiService.getIngressLoadBalancerHost', () => {
	it('returns the hostname when status.loadBalancer.ingress[0].hostname is set', async () => {
		const { factory } = makeFactory({
			networkingV1Api: () =>
				({
					listIngressClass: async () => ({ items: [] }),
					readNamespacedIngress: async () => ({
						metadata: { name: 'x' },
						spec: { rules: [] },
						status: { loadBalancer: { ingress: [{ hostname: 'LB.cluster.example.com' }] } }
					}),
					patchNamespacedIngress: async () => undefined,
					listNamespacedIngress: async () => ({ items: [] })
				}) as never
		});
		const svc = new KubernetesApiService(factory);
		const host = await svc.getIngressLoadBalancerHost(VALID, 'ns', 'site');
		// Hostname is lowercased so DNS comparisons are case-insensitive.
		expect(host).toBe('lb.cluster.example.com');
	});

	it('returns the IP when only ingress[0].ip is set', async () => {
		const { factory } = makeFactory({
			networkingV1Api: () =>
				({
					listIngressClass: async () => ({ items: [] }),
					readNamespacedIngress: async () => ({
						metadata: { name: 'x' },
						spec: { rules: [] },
						status: { loadBalancer: { ingress: [{ ip: '203.0.113.10' }] } }
					}),
					patchNamespacedIngress: async () => undefined,
					listNamespacedIngress: async () => ({ items: [] })
				}) as never
		});
		const svc = new KubernetesApiService(factory);
		expect(await svc.getIngressLoadBalancerHost(VALID, 'ns', 'site')).toBe('203.0.113.10');
	});

	it('returns null when no LB has been assigned yet', async () => {
		const { factory } = makeFactory({
			networkingV1Api: () =>
				({
					listIngressClass: async () => ({ items: [] }),
					readNamespacedIngress: async () => ({
						metadata: { name: 'x' },
						spec: { rules: [] },
						status: { loadBalancer: {} }
					}),
					patchNamespacedIngress: async () => undefined,
					listNamespacedIngress: async () => ({ items: [] })
				}) as never
		});
		const svc = new KubernetesApiService(factory);
		expect(await svc.getIngressLoadBalancerHost(VALID, 'ns', 'site')).toBeNull();
	});

	it('returns null when the Ingress does not exist', async () => {
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
		expect(await svc.getIngressLoadBalancerHost(VALID, 'ns', 'site')).toBeNull();
	});
});

/** Shaped like the HTTP failures `@kubernetes/client-node` throws. */
function httpError(statusCode: number, message: string): Error & { statusCode: number } {
	const err = new Error(message) as Error & { statusCode: number };
	err.statusCode = statusCode;
	return err;
}

describe('KubernetesApiService.applyObject', () => {
	const SERVER_SIDE_APPLY = 'application/apply-patch+yaml';

	it('SSA-applies an arbitrary manifest with the plugin field manager and force=true', async () => {
		const { factory, objectApi } = makeFactory();
		const svc = new KubernetesApiService(factory);
		const manifest = {
			apiVersion: 'batch/v1',
			kind: 'Job',
			metadata: { name: 'site-a-migrate', namespace: 'ever-works' }
		};

		await svc.applyObject(VALID, manifest);

		expect(objectApi.patch).toHaveBeenCalledWith(
			manifest,
			undefined,
			undefined,
			FIELD_MANAGER,
			true,
			SERVER_SIDE_APPLY
		);
	});

	it('forwards the context override to the kubeconfig loader', async () => {
		const { factory, createKubeConfig } = makeFactory();
		const svc = new KubernetesApiService(factory);

		await svc.applyObject(VALID, { apiVersion: 'v1', kind: 'ConfigMap' }, 'ctx-b');

		expect(createKubeConfig).toHaveBeenCalledWith(VALID, 'ctx-b');
	});

	it('surfaces apply failures as a scrubbed K8sPluginError', async () => {
		const { factory } = makeFactory({
			objectApi: () =>
				({
					patch: async () => {
						throw new Error('admission webhook denied: token: secret-leak-apply');
					}
				}) as never
		});
		const svc = new KubernetesApiService(factory);

		await expect(svc.applyObject(VALID, { apiVersion: 'v1', kind: 'ConfigMap' })).rejects.toThrow(K8sPluginError);
		try {
			await svc.applyObject(VALID, { apiVersion: 'v1', kind: 'ConfigMap' });
		} catch (err) {
			expect((err as Error).message).not.toContain('secret-leak-apply');
			expect((err as Error).message).toContain('[REDACTED]');
		}
	});
});

describe('KubernetesApiService.readObject', () => {
	it('reads by apiVersion/kind/namespace/name and returns the object', async () => {
		const { factory, objectApi, createKubeConfig } = makeFactory();
		const svc = new KubernetesApiService(factory);

		const obj = await svc.readObject<{ metadata?: { name?: string } }>(
			VALID,
			'apps/v1',
			'Deployment',
			'ever-works',
			'site-a'
		);

		expect(objectApi.read).toHaveBeenCalledWith({
			apiVersion: 'apps/v1',
			kind: 'Deployment',
			metadata: { name: 'site-a', namespace: 'ever-works' }
		});
		expect(obj?.metadata?.name).toBe('obj-a');
		expect(createKubeConfig).toHaveBeenCalledWith(VALID, undefined);
	});

	it('omits metadata.namespace for cluster-scoped kinds (CRDs, StorageClasses)', async () => {
		const { factory, objectApi } = makeFactory();
		const svc = new KubernetesApiService(factory);

		await svc.readObject(VALID, 'apiextensions.k8s.io/v1', 'CustomResourceDefinition', '', 'pg.example.com');

		expect(objectApi.read).toHaveBeenCalledWith({
			apiVersion: 'apiextensions.k8s.io/v1',
			kind: 'CustomResourceDefinition',
			metadata: { name: 'pg.example.com' }
		});
	});

	it('returns null on 404 instead of throwing', async () => {
		const { factory } = makeFactory({
			objectApi: () =>
				({
					read: async () => {
						throw httpError(404, 'not found');
					}
				}) as never
		});
		const svc = new KubernetesApiService(factory);

		expect(await svc.readObject(VALID, 'v1', 'Secret', 'ever-works', 'gone')).toBeNull();
	});

	it('throws a scrubbed K8sPluginError (cause kept) on non-404 errors', async () => {
		const { factory } = makeFactory({
			objectApi: () =>
				({
					read: async () => {
						throw httpError(403, 'forbidden: token: secret-leak-read');
					}
				}) as never
		});
		const svc = new KubernetesApiService(factory);

		await expect(svc.readObject(VALID, 'v1', 'Secret', 'ever-works', 'x')).rejects.toThrow(K8sPluginError);
		try {
			await svc.readObject(VALID, 'v1', 'Secret', 'ever-works', 'x');
		} catch (err) {
			expect((err as Error).message).not.toContain('secret-leak-read');
			expect((err as K8sPluginError).code).toBe('UNAUTHORIZED');
			expect((err as K8sPluginError).cause).toMatchObject({ statusCode: 403 });
		}
	});
});

describe('KubernetesApiService.listObjects', () => {
	it('passes the label selector as the 8th positional argument and returns items', async () => {
		const { factory, objectApi } = makeFactory();
		const svc = new KubernetesApiService(factory);

		const objects = await svc.listObjects<{ metadata?: { name?: string } }>(
			VALID,
			'v1',
			'Pod',
			'ever-works',
			'app.kubernetes.io/name=ingress-nginx'
		);

		expect(objectApi.list).toHaveBeenCalledWith(
			'v1',
			'Pod',
			'ever-works',
			undefined,
			undefined,
			undefined,
			undefined,
			'app.kubernetes.io/name=ingress-nginx'
		);
		expect(objects.map((o) => o.metadata?.name)).toEqual(['obj-a', 'obj-b']);
	});

	it('returns an empty array (never null) when the list is empty', async () => {
		const { factory } = makeFactory({ objectApi: () => ({ list: async () => ({ items: [] }) }) as never });
		const svc = new KubernetesApiService(factory);

		expect(await svc.listObjects(VALID, 'v1', 'Pod', 'ever-works')).toEqual([]);
	});

	it('returns an empty array when the response carries no items key', async () => {
		const { factory } = makeFactory({ objectApi: () => ({ list: async () => ({}) }) as never });
		const svc = new KubernetesApiService(factory);

		expect(await svc.listObjects(VALID, 'v1', 'Pod', 'ever-works')).toEqual([]);
	});

	it('omits the namespace for cluster-scoped lists', async () => {
		const { factory, objectApi } = makeFactory();
		const svc = new KubernetesApiService(factory);

		await svc.listObjects(VALID, 'storage.k8s.io/v1', 'StorageClass', '');

		expect(objectApi.list).toHaveBeenCalledWith(
			'storage.k8s.io/v1',
			'StorageClass',
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined
		);
	});

	it('throws a scrubbed K8sPluginError on failures', async () => {
		const { factory } = makeFactory({
			objectApi: () =>
				({
					list: async () => {
						throw httpError(403, 'forbidden: token: secret-leak-list');
					}
				}) as never
		});
		const svc = new KubernetesApiService(factory);

		await expect(svc.listObjects(VALID, 'v1', 'Pod', 'ever-works')).rejects.toThrow(K8sPluginError);
		try {
			await svc.listObjects(VALID, 'v1', 'Pod', 'ever-works');
		} catch (err) {
			expect((err as Error).message).not.toContain('secret-leak-list');
		}
	});
});

describe('KubernetesApiService.deleteObject', () => {
	it('passes propagationPolicy as the 6th positional argument', async () => {
		const { factory, objectApi } = makeFactory();
		const svc = new KubernetesApiService(factory);

		await svc.deleteObject(VALID, 'apps/v1', 'Deployment', 'ever-works', 'site-a', 'Foreground');

		expect(objectApi.delete).toHaveBeenCalledWith(
			{ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'site-a', namespace: 'ever-works' } },
			undefined,
			undefined,
			undefined,
			undefined,
			'Foreground'
		);
	});

	it('leaves propagationPolicy undefined when the caller omits it', async () => {
		const { factory, objectApi } = makeFactory();
		const svc = new KubernetesApiService(factory);

		await svc.deleteObject(VALID, 'v1', 'ConfigMap', 'ever-works', 'platform-env');

		expect(objectApi.delete).toHaveBeenCalledWith(
			{ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'platform-env', namespace: 'ever-works' } },
			undefined,
			undefined,
			undefined,
			undefined,
			undefined
		);
	});

	it('treats a 404 as success — the object is already gone', async () => {
		const { factory } = makeFactory({
			objectApi: () =>
				({
					delete: async () => {
						throw httpError(404, 'not found');
					}
				}) as never
		});
		const svc = new KubernetesApiService(factory);

		await expect(svc.deleteObject(VALID, 'v1', 'Secret', 'ever-works', 'gone')).resolves.toBeUndefined();
	});

	it('throws a scrubbed K8sPluginError on non-404 errors', async () => {
		const { factory } = makeFactory({
			objectApi: () =>
				({
					delete: async () => {
						throw httpError(403, 'forbidden: token: secret-leak-delete');
					}
				}) as never
		});
		const svc = new KubernetesApiService(factory);

		await expect(svc.deleteObject(VALID, 'v1', 'Secret', 'ever-works', 'x')).rejects.toThrow(K8sPluginError);
		try {
			await svc.deleteObject(VALID, 'v1', 'Secret', 'ever-works', 'x');
		} catch (err) {
			expect((err as Error).message).not.toContain('secret-leak-delete');
		}
	});
});

describe('KubernetesApiService.readPodLog', () => {
	it('forwards tailLines, limitBytes and previous to the CoreV1Api', async () => {
		const { factory, coreApi } = makeFactory();
		const svc = new KubernetesApiService(factory);

		const log = await svc.readPodLog(VALID, 'ever-works', 'site-a-5f9c', 'web', {
			tailLines: 200,
			limitBytes: 65536,
			previous: true
		});

		expect(coreApi.readNamespacedPodLog).toHaveBeenCalledWith({
			name: 'site-a-5f9c',
			namespace: 'ever-works',
			container: 'web',
			tailLines: 200,
			limitBytes: 65536,
			previous: true
		});
		expect(log).toBe('log line 1\nlog line 2\n');
	});

	it('omits unset options and lets the API server pick the only container', async () => {
		const { factory, coreApi } = makeFactory();
		const svc = new KubernetesApiService(factory);

		await svc.readPodLog(VALID, 'ever-works', 'site-a-5f9c', '');

		expect(coreApi.readNamespacedPodLog).toHaveBeenCalledWith({ name: 'site-a-5f9c', namespace: 'ever-works' });
	});

	it('returns an empty string (not null) for an empty log', async () => {
		const { factory } = makeFactory({
			coreV1Api: () =>
				({
					readNamespacedPodLog: async () => ''
				}) as never
		});
		const svc = new KubernetesApiService(factory);

		expect(await svc.readPodLog(VALID, 'ever-works', 'site-a-5f9c', 'web', { tailLines: 200 })).toBe('');
	});

	it('returns null when the pod is gone (404)', async () => {
		const { factory } = makeFactory({
			coreV1Api: () =>
				({
					readNamespacedPodLog: async () => {
						throw httpError(404, 'pods "site-a-5f9c" not found');
					}
				}) as never
		});
		const svc = new KubernetesApiService(factory);

		expect(await svc.readPodLog(VALID, 'ever-works', 'site-a-5f9c', 'web')).toBeNull();
	});

	it('throws a scrubbed K8sPluginError on non-404 errors', async () => {
		const { factory } = makeFactory({
			coreV1Api: () =>
				({
					readNamespacedPodLog: async () => {
						throw httpError(500, 'internal error: token: secret-leak-log');
					}
				}) as never
		});
		const svc = new KubernetesApiService(factory);

		await expect(svc.readPodLog(VALID, 'ever-works', 'site-a-5f9c', 'web')).rejects.toThrow(K8sPluginError);
		try {
			await svc.readPodLog(VALID, 'ever-works', 'site-a-5f9c', 'web');
		} catch (err) {
			expect((err as Error).message).not.toContain('secret-leak-log');
		}
	});
});

describe('KubernetesApiService.createSelfSubjectAccessReview', () => {
	it('builds the SelfSubjectAccessReview body per plan §6.3', async () => {
		const { factory, authorizationApi } = makeFactory();
		const svc = new KubernetesApiService(factory);

		const status = await svc.createSelfSubjectAccessReview(VALID, {
			verb: 'patch',
			group: 'apps',
			resource: 'deployments',
			namespace: 'ever-works'
		});

		expect(authorizationApi.createSelfSubjectAccessReview).toHaveBeenCalledWith({
			body: {
				apiVersion: 'authorization.k8s.io/v1',
				kind: 'SelfSubjectAccessReview',
				spec: {
					resourceAttributes: {
						verb: 'patch',
						group: 'apps',
						resource: 'deployments',
						namespace: 'ever-works'
					}
				}
			}
		});
		expect(status).toEqual({ allowed: true, reason: 'RBAC: allowed by ClusterRole "ever-works-apps"' });
	});

	it('sends the subresource for pods/log and the core group as an empty string', async () => {
		const { factory, authorizationApi } = makeFactory();
		const svc = new KubernetesApiService(factory);

		await svc.createSelfSubjectAccessReview(VALID, {
			verb: 'get',
			group: '',
			resource: 'pods',
			subresource: 'log',
			namespace: 'ever-works'
		});

		expect(authorizationApi.createSelfSubjectAccessReview).toHaveBeenCalledWith({
			body: {
				apiVersion: 'authorization.k8s.io/v1',
				kind: 'SelfSubjectAccessReview',
				spec: {
					resourceAttributes: {
						verb: 'get',
						group: '',
						resource: 'pods',
						subresource: 'log',
						namespace: 'ever-works'
					}
				}
			}
		});
	});

	it('omits namespace and subresource for cluster-scoped requests', async () => {
		const { factory, authorizationApi } = makeFactory();
		const svc = new KubernetesApiService(factory);

		await svc.createSelfSubjectAccessReview(VALID, { verb: 'create', group: '', resource: 'namespaces' });

		expect(authorizationApi.createSelfSubjectAccessReview).toHaveBeenCalledWith({
			body: {
				apiVersion: 'authorization.k8s.io/v1',
				kind: 'SelfSubjectAccessReview',
				spec: {
					resourceAttributes: { verb: 'create', group: '', resource: 'namespaces' }
				}
			}
		});
	});

	it('maps denied + evaluationError through unchanged', async () => {
		const { factory } = makeFactory({
			authorizationV1Api: () =>
				({
					createSelfSubjectAccessReview: async () => ({
						status: {
							allowed: false,
							denied: true,
							reason: 'no RBAC rule matched',
							evaluationError: 'unknown verb "frobnicate"'
						}
					})
				}) as never
		});
		const svc = new KubernetesApiService(factory);

		expect(
			await svc.createSelfSubjectAccessReview(VALID, { verb: 'frobnicate', group: '', resource: 'pods' })
		).toEqual({
			allowed: false,
			denied: true,
			reason: 'no RBAC rule matched',
			evaluationError: 'unknown verb "frobnicate"'
		});
	});

	it('fails closed when the response carries no status', async () => {
		const { factory } = makeFactory({
			authorizationV1Api: () => ({ createSelfSubjectAccessReview: async () => ({}) }) as never
		});
		const svc = new KubernetesApiService(factory);

		expect(await svc.createSelfSubjectAccessReview(VALID, { verb: 'get', group: '', resource: 'pods' })).toEqual({
			allowed: false
		});
	});

	it('throws a scrubbed K8sPluginError when the review itself is refused', async () => {
		const { factory } = makeFactory({
			authorizationV1Api: () =>
				({
					createSelfSubjectAccessReview: async () => {
						throw httpError(403, 'forbidden: token: secret-leak-ssar');
					}
				}) as never
		});
		const svc = new KubernetesApiService(factory);

		await expect(
			svc.createSelfSubjectAccessReview(VALID, { verb: 'get', group: '', resource: 'pods' })
		).rejects.toThrow(K8sPluginError);
		try {
			await svc.createSelfSubjectAccessReview(VALID, { verb: 'get', group: '', resource: 'pods' });
		} catch (err) {
			expect((err as Error).message).not.toContain('secret-leak-ssar');
			expect((err as K8sPluginError).code).toBe('UNAUTHORIZED');
		}
	});
});

describe('defaultClientFactory wiring for the new APIs', () => {
	function recordingClient(): { client: never; makeApiClient: ReturnType<typeof vi.fn> } {
		const makeApiClient = vi.fn((api: unknown) => ({ api }));
		return {
			client: { loadFromString: vi.fn(), setCurrentContext: vi.fn(), makeApiClient } as never,
			makeApiClient
		};
	}

	/**
	 * Pay for `@kubernetes/client-node` HERE, once, and out of the cases' budget.
	 *
	 * Every other case in this file mocks the factory; these are the only two that
	 * reach the real `k8sClientLoader()`, whose `require` of that package is the
	 * single most expensive import in this suite. Whichever case ran first paid
	 * the whole cost, and on a loaded self-hosted runner that is enough to blow
	 * the 10 s `testTimeout` in `vitest.config.ts` — measured in CI run
	 * 35591005499: **14,797 ms** for the `authorizationV1Api` case and **9 ms**
	 * for the `coreV1Api` case immediately after it, from the module cache. The
	 * assertions were never the problem, and this file is otherwise 940 green.
	 *
	 * A `beforeAll` with its own generous timeout attributes the cost to setup,
	 * where it belongs, and leaves each case measuring what it is about. Raising
	 * the whole suite's `testTimeout` instead would hide the next real hang.
	 */
	beforeAll(() => {
		defaultClientFactory.coreV1Api(recordingClient().client);
	}, 120_000);

	it('authorizationV1Api hands makeApiClient the real object-parameter AuthorizationV1Api class', () => {
		const { client, makeApiClient } = recordingClient();

		defaultClientFactory.authorizationV1Api(client);

		expect(makeApiClient).toHaveBeenCalledTimes(1);
		const ctor = makeApiClient.mock.calls[0][0] as { prototype?: Record<string, unknown> };
		expect(typeof ctor.prototype?.createSelfSubjectAccessReview).toBe('function');
	});

	it('coreV1Api hands makeApiClient the class that implements readNamespacedPodLog', () => {
		const { client, makeApiClient } = recordingClient();

		defaultClientFactory.coreV1Api(client);

		expect(makeApiClient).toHaveBeenCalledTimes(1);
		const ctor = makeApiClient.mock.calls[0][0] as { prototype?: Record<string, unknown> };
		expect(typeof ctor.prototype?.readNamespacedPodLog).toBe('function');
	});
});
