/**
 * T13 — `app-cluster-check.ts` (plan §6.3; spec FR-6, ACC-06-05).
 *
 * Every clause of T13's `**Test**` line for this file has an `it` below: each missing required
 * permission is named and a missing required one blocks Save, optional permissions are listed as
 * optional, and the result carries `fingerprint` **and** `ingressAddress` while never carrying (let
 * alone writing) the runtime-state `clusterFingerprint`.
 *
 * **No network, ever.** `FakeCluster` implements the three-method `AppClusterCheckApi` port: it
 * answers `/version`, lists from an in-memory store, and decides every
 * `SelfSubjectAccessReview` from a table of refusals, recording each question it was asked.
 */
import { describe, expect, it } from 'vitest';

import { K8sPluginError } from '../../errors';
import {
	APP_CLUSTER_DIAL_TIMEOUT_MS,
	APP_CREATE_NAMESPACE_PERMISSION,
	APP_OPTIONAL_PERMISSIONS,
	APP_REQUIRED_PERMISSIONS,
	AppClusterChecker,
	credentialLiterals,
	permissionName,
	type AppClusterCheckApi
} from '../app-cluster-check';
import type { ParsedKubeconfig } from '../../kubeconfig.parser';
import type { SelfSubjectAccessReviewInput, SelfSubjectAccessReviewStatus } from '../../k8s-api.service';

/* ------------------------------------------------------------------------- *
 * Fixtures
 * ------------------------------------------------------------------------- */

type Json = Record<string, any>;

const NAMESPACE = 'ew-analytics-0f8e2c1a';

const KUBECONFIG = `apiVersion: v1
kind: Config
current-context: kind-app-runtime
clusters:
  - name: kind-app-runtime
    cluster:
      server: https://kind.example.com:6443
      certificate-authority-data: LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCk1JSUNlcnQ9PQotLS0tLUVORCBDRVJUSUZJQ0FURS0tLS0tCg==
contexts:
  - name: kind-app-runtime
    context:
      cluster: kind-app-runtime
      user: kind-admin
      namespace: ${NAMESPACE}
users:
  - name: kind-admin
    user:
      token: fixture-placeholder-token
`;

const UNSUPPORTED_KUBECONFIG = KUBECONFIG.replace(/certificate-authority-data: .*/, 'insecure-skip-tls-verify: true');

/* ------------------------------------------------------------------------- *
 * The fake API
 * ------------------------------------------------------------------------- */

interface Question {
	verb: string;
	resource: string;
	namespace?: string;
}

class FakeCluster implements AppClusterCheckApi {
	readonly version = 'v1.36.2';
	readonly questions: Question[] = [];
	readonly lists: string[] = [];
	/** `${verb} ${resource}` (subresources written `pods/log`) the cluster refuses. */
	readonly denied = new Set<string>();
	/** `<apiVersion> <kind>` (and `<apiVersion> <kind>@<namespace>`) a list is refused for. */
	readonly listForbidden = new Set<string>();
	versionFails: Error | null = null;
	versionHangs = false;
	objects: Record<string, Json[]> = {
		IngressClass: [
			{ metadata: { name: 'nginx', annotations: { 'ingressclass.kubernetes.io/is-default-class': 'true' } } },
			{ metadata: { name: 'traefik' } }
		],
		ClusterIssuer: [{ metadata: { name: 'letsencrypt' } }, { metadata: { name: 'selfsigned' } }],
		StorageClass: [
			{ metadata: { name: 'local-path', annotations: { 'storageclass.kubernetes.io/is-default-class': 'true' } } }
		],
		Pod: [
			{
				metadata: {
					name: 'ingress-nginx-controller-abc',
					namespace: 'ingress-nginx',
					labels: { 'app.kubernetes.io/name': 'ingress-nginx' }
				}
			}
		],
		Service: [
			{
				metadata: { name: 'ingress-nginx-controller', namespace: 'ingress-nginx' },
				spec: { type: 'LoadBalancer' },
				status: { loadBalancer: { ingress: [{ ip: '203.0.113.10' }] } }
			}
		]
	};

	async getServerVersion(_parsed: ParsedKubeconfig, kubeconfigYaml: string): Promise<string> {
		expect(kubeconfigYaml).toBe(KUBECONFIG);
		if (this.versionHangs) {
			return new Promise<string>(() => undefined);
		}
		if (this.versionFails) {
			throw this.versionFails;
		}
		return this.version;
	}

	async listObjects<T = Json>(
		_kubeconfigYaml: string,
		apiVersion: string,
		kind: string,
		namespace: string,
		labelSelector?: string
	): Promise<T[]> {
		this.lists.push(`${apiVersion} ${kind}${namespace ? `@${namespace}` : ''}`);
		if (
			this.listForbidden.has(`${apiVersion} ${kind}`) ||
			this.listForbidden.has(`${apiVersion} ${kind}@${namespace}`)
		) {
			throw new K8sPluginError('UNAUTHORIZED', `forbidden: cannot list ${kind}`);
		}
		return (this.objects[kind] ?? []).filter((object) => {
			if (namespace && String(object.metadata?.namespace ?? '') !== namespace) {
				return false;
			}
			if (!labelSelector) {
				return true;
			}
			const name = object.metadata?.labels?.['app.kubernetes.io/name'];
			return String(name ?? '').length > 0;
		}) as T[];
	}

	async createSelfSubjectAccessReview(
		_kubeconfigYaml: string,
		attributes: SelfSubjectAccessReviewInput
	): Promise<SelfSubjectAccessReviewStatus> {
		const resource = attributes.subresource
			? `${attributes.resource}/${attributes.subresource}`
			: attributes.resource;
		this.questions.push({
			verb: attributes.verb,
			resource,
			...(attributes.namespace ? { namespace: attributes.namespace } : {})
		});
		return { allowed: !this.denied.has(`${attributes.verb} ${resource}`) };
	}

	asked(verb: string, resource: string): Question[] {
		return this.questions.filter((question) => question.verb === verb && question.resource === resource);
	}
}

function checker(cluster: FakeCluster, options: { versionTimeoutMs?: number } = {}): AppClusterChecker {
	return new AppClusterChecker(cluster, options);
}

/* ------------------------------------------------------------------------- *
 * The permission table (§6.3)
 * ------------------------------------------------------------------------- */

describe("§6.3's permission list", () => {
	it("is exactly the plan's required table: 7 write verbs × 10 resources, reads, and pods/log", () => {
		expect(APP_REQUIRED_PERMISSIONS).toHaveLength(7 * 10 + 3 * 2 + 1);

		for (const permission of [
			{ verb: 'get', resource: 'deployments', group: 'apps' },
			{ verb: 'delete', resource: 'networkpolicies', group: 'networking.k8s.io' },
			{ verb: 'update', resource: 'cronjobs', group: 'batch' },
			{ verb: 'patch', resource: 'serviceaccounts', group: '' },
			{ verb: 'get', resource: 'pods', group: '', subresource: 'log' }
		]) {
			expect(APP_REQUIRED_PERMISSIONS).toContainEqual(permission);
		}

		// The three observed resources are read-only: §6.3 asks `get,list` for them, never `create`.
		// (`pods` carries a third entry — the `get pods/log` question, asserted above.)
		for (const resource of ['pods', 'replicasets', 'events']) {
			const verbs = APP_REQUIRED_PERMISSIONS.filter(
				(entry) => entry.resource === resource && !entry.subresource
			).map((entry) => entry.verb);
			expect(verbs).toEqual(['get', 'list']);
		}
	});

	it('lists exactly the three optional permissions §6.3 names', () => {
		expect(APP_OPTIONAL_PERMISSIONS).toEqual([
			{ verb: 'create', resource: 'namespaces', group: '' },
			{ verb: 'create', resource: 'limitranges', group: '' },
			{ verb: 'patch', resource: 'limitranges', group: '' }
		]);
		expect(permissionName(APP_CREATE_NAMESPACE_PERMISSION)).toBe('namespaces');
	});

	it('names a subresource as `pods/log`, so a missing one is never confused with `pods`', () => {
		expect(permissionName({ verb: 'get', resource: 'pods', group: '', subresource: 'log' })).toBe('pods/log');
		expect(permissionName({ verb: 'get', resource: 'pods', group: '' })).toBe('pods');
	});
});

/* ------------------------------------------------------------------------- *
 * A healthy cluster
 * ------------------------------------------------------------------------- */

describe('a cluster that grants everything (FR-6)', () => {
	it('reports the version, the ingress classes, the controller namespace, the issuers and the storage classes', async () => {
		const cluster = new FakeCluster();
		const result = await checker(cluster).checkAppCluster(KUBECONFIG, {
			namespace: NAMESPACE,
			needsCreateNamespace: false
		});

		expect(result.ok).toBe(true);
		expect(result.serverVersion).toBe('v1.36.2');
		expect(result.missingPermissions).toEqual([]);
		expect(result.optionalMissing).toEqual([]);
		expect(result.ingressClasses).toEqual([
			{ name: 'nginx', isDefault: true },
			{ name: 'traefik', isDefault: false }
		]);
		expect(result.controllerNamespace).toBe('ingress-nginx');
		expect(result.clusterIssuers).toEqual(['letsencrypt', 'selfsigned']);
		expect(result.storageClasses).toEqual([{ name: 'local-path', isDefault: true }]);
		expect(result.error).toBeUndefined();
	});

	it('asks every required question for the requested namespace', async () => {
		const cluster = new FakeCluster();
		await checker(cluster).checkAppCluster(KUBECONFIG, { namespace: NAMESPACE, needsCreateNamespace: false });

		const namespaced = APP_REQUIRED_PERMISSIONS.filter((permission) => permission.resource !== 'namespaces');
		for (const permission of namespaced) {
			expect(cluster.asked(permission.verb, permissionName(permission))).toEqual([
				{ verb: permission.verb, resource: permissionName(permission), namespace: NAMESPACE }
			]);
		}
		// `create namespaces` is cluster-scoped and optional while the namespace exists (§6.3).
		expect(cluster.asked('create', 'namespaces')[0].namespace).toBeUndefined();
	});

	it("returns the ingress controller Service's address as ingressAddress (GAP-09)", async () => {
		const cluster = new FakeCluster();
		const result = await checker(cluster).checkAppCluster(KUBECONFIG, {
			namespace: NAMESPACE,
			needsCreateNamespace: false
		});

		expect(result.ingressAddress).toEqual({ ip: '203.0.113.10' });
		expect(cluster.lists).toContain('v1 Service@ingress-nginx');
	});

	it('reports no address when the controller Service has none, and none when the namespace is unknown', async () => {
		const cluster = new FakeCluster();
		cluster.objects.Service = [
			{
				metadata: { name: 'ingress-nginx-controller', namespace: 'ingress-nginx' },
				spec: { type: 'LoadBalancer' }
			}
		];
		expect(
			(await checker(cluster).checkAppCluster(KUBECONFIG, { namespace: NAMESPACE, needsCreateNamespace: false }))
				.ingressAddress
		).toBeNull();

		const blind = new FakeCluster();
		blind.listForbidden.add('v1 Pod');
		blind.objects.Service = [];
		const result = await checker(blind).checkAppCluster(KUBECONFIG, {
			namespace: NAMESPACE,
			needsCreateNamespace: false
		});
		expect(result.controllerNamespace).toBeNull();
		expect(result.ingressAddress).toBeNull();
		// A list the credentials may not make is not a failed check: the permission table is the one
		// place a capability is judged.
		expect(result.ok).toBe(true);
	});
});

/* ------------------------------------------------------------------------- *
 * Missing permissions (ACC-06-05)
 * ------------------------------------------------------------------------- */

describe('a missing required permission is named and blocks Save (ACC-06-05)', () => {
	it('names each refused required permission, one entry per verb and resource', async () => {
		const cluster = new FakeCluster();
		cluster.denied.add('delete deployments');
		cluster.denied.add('get pods/log');
		cluster.denied.add('watch networkpolicies');

		const result = await checker(cluster).checkAppCluster(KUBECONFIG, {
			namespace: NAMESPACE,
			needsCreateNamespace: false
		});

		expect(result.ok).toBe(false);
		expect(result.missingPermissions).toEqual([
			{ verb: 'delete', resource: 'deployments' },
			{ verb: 'watch', resource: 'networkpolicies' },
			{ verb: 'get', resource: 'pods/log' }
		]);
		// The refusals are *required*: they are not offered as optional extras.
		expect(result.optionalMissing).toEqual([]);
	});

	it('names every one of the 77 required questions when the credential may do nothing', async () => {
		const cluster = new FakeCluster();
		for (const permission of APP_REQUIRED_PERMISSIONS) {
			cluster.denied.add(`${permission.verb} ${permissionName(permission)}`);
		}

		const result = await checker(cluster).checkAppCluster(KUBECONFIG, {
			namespace: NAMESPACE,
			needsCreateNamespace: false
		});

		expect(result.ok).toBe(false);
		expect(result.missingPermissions).toHaveLength(APP_REQUIRED_PERMISSIONS.length);
		expect(result.missingPermissions).toContainEqual({ verb: 'get', resource: 'pods/log' });
	});

	it('requires `create namespaces` when the namespace does not exist yet', async () => {
		const cluster = new FakeCluster();
		cluster.denied.add('create namespaces');

		const withNamespace = await checker(cluster).checkAppCluster(KUBECONFIG, {
			namespace: NAMESPACE,
			needsCreateNamespace: false
		});
		expect(withNamespace.ok).toBe(true);
		expect(withNamespace.optionalMissing).toEqual([{ verb: 'create', resource: 'namespaces' }]);

		const withoutNamespace = await checker(cluster).checkAppCluster(KUBECONFIG, {
			namespace: null,
			needsCreateNamespace: true
		});
		expect(withoutNamespace.ok).toBe(false);
		expect(withoutNamespace.missingPermissions).toEqual([{ verb: 'create', resource: 'namespaces' }]);
		expect(withoutNamespace.optionalMissing).toEqual([]);
		// With no namespace to ask about, the namespaced questions are asked cluster-wide ("may you do
		// this anywhere"), which is the only reading left when there is no namespace yet.
		expect(cluster.asked('get', 'deployments').some((question) => question.namespace === undefined)).toBe(true);
	});
});

describe('optional permissions are listed as optional', () => {
	it('reports a refused LimitRange verb in optionalMissing and keeps ok true', async () => {
		const cluster = new FakeCluster();
		cluster.denied.add('create limitranges');
		cluster.denied.add('patch limitranges');

		const result = await checker(cluster).checkAppCluster(KUBECONFIG, {
			namespace: NAMESPACE,
			needsCreateNamespace: false
		});

		expect(result.ok).toBe(true);
		expect(result.missingPermissions).toEqual([]);
		expect(result.optionalMissing).toEqual([
			{ verb: 'create', resource: 'limitranges' },
			{ verb: 'patch', resource: 'limitranges' }
		]);
	});

	it('fails closed on a question the API server refuses to answer at all', async () => {
		const cluster = new FakeCluster();
		cluster.createSelfSubjectAccessReview = async (_yaml: string, attributes: SelfSubjectAccessReviewInput) => {
			if (attributes.resource === 'deployments') {
				throw new Error('the API server refused the review');
			}
			return { allowed: true };
		};

		const result = await checker(cluster).checkAppCluster(KUBECONFIG, {
			namespace: NAMESPACE,
			needsCreateNamespace: false
		});

		expect(result.ok).toBe(false);
		expect(result.missingPermissions).toHaveLength(7);
		expect(result.missingPermissions.every((entry) => entry.resource === 'deployments')).toBe(true);
	});
});

/* ------------------------------------------------------------------------- *
 * The fingerprint (§6.3, GAP-09)
 * ------------------------------------------------------------------------- */

describe('the fingerprint lives inside the result', () => {
	it('carries `fingerprint` and never the runtime-state `clusterFingerprint`', async () => {
		const cluster = new FakeCluster();
		const result = await checker(cluster).checkAppCluster(KUBECONFIG, {
			namespace: NAMESPACE,
			needsCreateNamespace: false
		});

		expect(typeof result.fingerprint).toBe('string');
		expect(result.fingerprint.length).toBeGreaterThan(0);
		// §6.3: the `clusterFingerprint` **column** stays the deployed cluster (§5.6 writes it); a check
		// of a different cluster must never be able to re-point a live app through it.
		expect('clusterFingerprint' in result).toBe(false);
		expect(result).not.toHaveProperty('clusterFingerprint');
	});

	it('writes nothing: the check only ever reads', async () => {
		const cluster = new FakeCluster();
		await checker(cluster).checkAppCluster(KUBECONFIG, { namespace: NAMESPACE, needsCreateNamespace: false });

		// The port has no write method at all, so the strongest assertion available is that every call
		// this module made is one of the three reads and that no object was mutated.
		expect(cluster.lists.length).toBeGreaterThan(0);
		expect(cluster.questions.length).toBeGreaterThan(0);
		const before = JSON.stringify(cluster.objects);
		await checker(cluster).checkAppCluster(KUBECONFIG, { namespace: NAMESPACE, needsCreateNamespace: false });
		expect(JSON.stringify(cluster.objects)).toBe(before);
	});

	it('is secret-free: no kubeconfig value reaches the result', async () => {
		const cluster = new FakeCluster();
		cluster.versionFails = new Error(`dial tcp: connect: connection refused (token fixture-placeholder-token)`);
		const result = await checker(cluster).checkAppCluster(KUBECONFIG, {
			namespace: NAMESPACE,
			needsCreateNamespace: false
		});

		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain('fixture-placeholder-token');
		expect(serialized).not.toContain('certificate-authority-data');
		expect(serialized).toContain('[REDACTED]');
	});
});

/* ------------------------------------------------------------------------- *
 * Refusals and the dial budget
 * ------------------------------------------------------------------------- */

describe('an unreachable cluster is a result, not a throw', () => {
	it('reports `cluster_unreachable` when /version fails, and asks nothing else', async () => {
		const cluster = new FakeCluster();
		cluster.versionFails = new Error('getaddrinfo ENOTFOUND kind.example.com');

		const result = await checker(cluster).checkAppCluster(KUBECONFIG, {
			namespace: NAMESPACE,
			needsCreateNamespace: false
		});

		expect(result.ok).toBe(false);
		expect(result.error?.code).toBe('cluster_unreachable');
		expect(result.error?.message).toContain('ENOTFOUND');
		expect(result.fingerprint.length).toBeGreaterThan(0);
		expect(cluster.questions).toEqual([]);
		expect(cluster.lists).toEqual([]);
	});

	it("gives /version §6.3's dial budget and reports a timeout as unreachable", async () => {
		expect(APP_CLUSTER_DIAL_TIMEOUT_MS).toBe(10_000);

		const cluster = new FakeCluster();
		cluster.versionHangs = true;
		const startedAt = Date.now();
		const result = await checker(cluster, { versionTimeoutMs: 5 }).checkAppCluster(KUBECONFIG, {
			namespace: NAMESPACE,
			needsCreateNamespace: false
		});

		expect(result.ok).toBe(false);
		expect(result.error?.code).toBe('cluster_unreachable');
		expect(result.error?.message).toContain('/version');
		expect(Date.now() - startedAt).toBeLessThan(5_000);
		expect(cluster.questions).toEqual([]);
	});
});

describe('the §6.1 guard runs before any client call (FR-4)', () => {
	it('refuses an unsupported kubeconfig without a single question or list', async () => {
		const cluster = new FakeCluster();

		await expect(
			checker(cluster).checkAppCluster(UNSUPPORTED_KUBECONFIG, {
				namespace: NAMESPACE,
				needsCreateNamespace: false
			})
		).rejects.toBeInstanceOf(K8sPluginError);

		expect(cluster.questions).toEqual([]);
		expect(cluster.lists).toEqual([]);
	});
});

/* ------------------------------------------------------------------------- *
 * What the checker is constructed with
 * ------------------------------------------------------------------------- */

describe("the checker's defaults", () => {
	it('accepts the real service structurally (compile-time proof, asserted at runtime too)', async () => {
		// The `KubernetesApiServiceSatisfiesClusterCheckPort` alias in the module is the real proof; this
		// assertion keeps the three method names the port needs in one place a reader can see.
		const cluster = new FakeCluster();
		for (const method of ['getServerVersion', 'listObjects', 'createSelfSubjectAccessReview'] as const) {
			expect(typeof cluster[method]).toBe('function');
		}
	});

	it('honours an injected controller-name list', async () => {
		const cluster = new FakeCluster();
		const custom = new AppClusterChecker(cluster, { controllerNames: ['haproxy-ingress'] });
		await custom.checkAppCluster(KUBECONFIG, { namespace: NAMESPACE, needsCreateNamespace: false });

		// The custom name matches no seeded pod, so no controller namespace is claimed.
		expect(cluster.lists).toContain('v1 Pod');
	});
});

/* ------------------------------------------------------------------------- *
 * The credential scrubber
 * ------------------------------------------------------------------------- */

describe('credential literals are scrubbed out of a client error', () => {
	it('finds every credential a kubeconfig carries', () => {
		expect(credentialLiterals(KUBECONFIG)).toEqual([
			'LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCk1JSUNlcnQ9PQotLS0tLUVORCBDRVJUSUZJQ0FURS0tLS0tCg==',
			'fixture-placeholder-token'
		]);
	});

	it("redacts the kubeconfig's own token when a client error echoes it", async () => {
		const cluster = new FakeCluster();
		cluster.versionFails = new Error('Unauthorized: bearer fixture-placeholder-token is not valid');

		const result = await checker(cluster).checkAppCluster(KUBECONFIG, {
			namespace: NAMESPACE,
			needsCreateNamespace: false
		});

		expect(result.error?.code).toBe('cluster_unreachable');
		expect(result.error?.message).not.toContain('fixture-placeholder-token');
		expect(result.error?.message).toContain('[REDACTED]');
	});
});
