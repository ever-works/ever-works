/**
 * T19 — `app-dependencies/postgres.provider.ts`, the **plain path** (plan §4.9:616, §4.9:579-602, §4.9:620-628;
 * spec FR-36/FR-37/FR-38/FR-40/FR-43, ACC-07-14, ACC-07-20; APW07-G01, APW07-G10).
 *
 * Every clause of T19's `**Test**` line for this path has an `it` below: the StatefulSet for Postgres 16 with a
 * readiness probe and a 10 GiB claim; the no-backup warning `none`; the security context (uid/gid/fsGroup 999,
 * `runAsNonRoot`, `drop: [ALL]`); APW-06's labels plus `ever-works.io/dependency` and `ever-works.io/retain` on
 * the PVC; the `dep-postgres` NetworkPolicy applied **before** the StatefulSet, admitting same-namespace pods on
 * 5432 only — and drawn with isolation off too, because the context carries no isolation switch at all
 * (APW07-G01); `failed noDefaultStorageClass` with S18's own copy (ACC-07-20); a 403 on the StatefulSet create →
 * `clusterPermissionMissing` (APW07-G10); `directUrl` only when declared (FR-40).
 *
 * It also covers the rest of T19's `**Create**` line for this file — the extensions Job, the outputs, the
 * ephemeral variant (R-10, ACC-07-31) and deprovision including `stopWorkloads` — because those are behaviours
 * of the same file and the plan's separate `deprovision.spec.ts` / `ephemeral.spec.ts` are not T19's files.
 *
 * **No network, ever.** `FakeDependencyCluster` implements the five-method `AppDependencyApi` port over an
 * in-memory object list with Server-Side-Apply merge semantics, and the provider's clock, its only wait and its
 * poll interval are all injected — so "not ready yet" costs one loop, not ten minutes.
 */
import { describe, expect, it } from 'vitest';

import type { AppDependencyContext } from '@ever-works/plugin';

import { K8sPluginError } from '../../errors';
import { KubernetesPlugin } from '../../k8s.plugin';
import { APP_DEPENDENCY_POLICY_LABEL, APP_NAMESPACE_NAME_LABEL } from '../../app/app-network-policy.renderer';
import { APP_STORAGE_CLASS_DEFAULT_ANNOTATIONS } from '../../app/app-cluster-check';
import {
	APP_LABEL_KIND,
	APP_LABEL_MANAGED_BY,
	APP_LABEL_PART_OF,
	APP_LABEL_RETAIN,
	APP_LABEL_WORK_ID,
	dependencyNetworkPolicyName
} from '../../app/app-names';
import {
	APP_DEPENDENCY_OPERATOR_STATUS_PORT,
	APP_DEPENDENCY_PORTS,
	APP_DEPENDENCY_SIZE_DEFAULTS,
	type AppDependencyApi
} from '../common';
import { POSTGRES_DEFAULT_VERSION, everyDependencyImage, isDigestPinned } from '../images';
import {
	POSTGRES_APP_NAME,
	POSTGRES_MEMORY_LIMIT,
	POSTGRES_OBJECT_NAMES,
	POSTGRES_PORT,
	POSTGRES_PROVIDER_DESCRIPTOR,
	POSTGRES_PROVIDER_ID,
	PostgresDependencyProvider,
	warningCode
} from '../postgres.provider';
import type { KubernetesApiService } from '../../k8s-api.service';

/* ------------------------------------------------------------------------- *
 * Fixtures
 * ------------------------------------------------------------------------- */

type Json = Record<string, any>;

const WORK_ID = '0f8e2c1a-1111-4a2b-9c3d-4e5f60718293';
const WORK_SLUG = 'analytics';
const NAMESPACE = 'ew-analytics-0f8e2c1a';
const KUBECONFIG = 'kind-app-runtime-kubeconfig';

/** The S18 copy, quoted from `spec.md:161-163` — the sentence the card shows verbatim. */
const S18_MESSAGE = 'Your cluster has no default storage class. Choose one in Dependency settings.';

function context(overrides: Json = {}): AppDependencyContext {
	const base: Json = {
		workId: WORK_ID,
		appName: WORK_SLUG,
		target: 'your-cluster',
		declared: { version: 16 },
		sizeGiB: 10,
		cluster: {
			kubeconfig: KUBECONFIG,
			context: null,
			namespace: NAMESPACE,
			appLabels: { [APP_LABEL_PART_OF]: WORK_SLUG }
		},
		settings: {},
		signal: new AbortController().signal
	};

	return { ...base, ...overrides } as unknown as AppDependencyContext;
}

/* ------------------------------------------------------------------------- *
 * The fake API — the port, with Server-Side-Apply merge semantics
 * ------------------------------------------------------------------------- */

interface Call {
	op: 'apply' | 'read' | 'list' | 'delete' | 'ssar';
	apiVersion?: string;
	kind?: string;
	name?: string;
	namespace?: string;
	labelSelector?: string;
	object?: Json;
	verb?: string;
	resource?: string;
}

class FakeDependencyCluster implements AppDependencyApi {
	readonly calls: Call[] = [];
	/** `Kind/name` or `Kind` → the error an apply throws instead of succeeding. */
	readonly applyFails = new Map<string, Error>();
	/** What a synthesised StatefulSet reports as `status.readyReplicas`. */
	readyReplicas = 1;
	/** What a synthesised StatefulSet's claim reports as `status.phase`. */
	pvcPhase = 'Bound';
	/** What the extension Job reports. */
	jobStatus: Json = { succeeded: 1 };

	private readonly store: Json[] = [];

	// --- seeding ------------------------------------------------------------

	seed(object: Json): Json {
		this.upsert(object);
		return object;
	}

	/** A `StorageClass`; `isDefault: false` seeds one that is not marked default. */
	seedStorageClass(name: string, isDefault = true): void {
		this.seed({
			apiVersion: 'storage.k8s.io/v1',
			kind: 'StorageClass',
			metadata: {
				name,
				...(isDefault ? { annotations: { 'storageclass.kubernetes.io/is-default-class': 'true' } } : {})
			},
			provisioner: 'kubernetes.io/no-provisioner'
		});
	}

	// --- assertions' helpers ------------------------------------------------

	applied(): Json[] {
		return this.calls.filter((call) => call.op === 'apply').map((call) => call.object as Json);
	}

	appliedNames(): string[] {
		return this.calls.filter((call) => call.op === 'apply').map((call) => `${call.kind}/${call.name}`);
	}

	appliedOf(kind: string): Json[] {
		return this.applied().filter((object) => object.kind === kind);
	}

	deleted(): string[] {
		return this.calls.filter((call) => call.op === 'delete').map((call) => `${call.kind}/${call.name}`);
	}

	// --- the port -----------------------------------------------------------

	async applyObject(_kubeconfigYaml: string, manifest: Record<string, unknown>): Promise<void> {
		const object = manifest as Json;
		this.calls.push({
			op: 'apply',
			apiVersion: object.apiVersion,
			kind: object.kind,
			name: object.metadata?.name,
			namespace: object.metadata?.namespace,
			object
		});

		const failure =
			this.applyFails.get(`${String(object.kind)}/${String(object.metadata?.name)}`) ??
			this.applyFails.get(String(object.kind));
		if (failure) throw failure;

		this.upsert(object);
	}

	async readObject<T = Json>(
		_kubeconfigYaml: string,
		apiVersion: string,
		kind: string,
		namespace: string,
		name: string
	): Promise<T | null> {
		this.calls.push({ op: 'read', apiVersion, kind, namespace, name });
		return (this.find(apiVersion, kind, namespace, name) ?? null) as T | null;
	}

	async listObjects<T = Json>(
		_kubeconfigYaml: string,
		apiVersion: string,
		kind: string,
		namespace: string,
		labelSelector?: string
	): Promise<T[]> {
		this.calls.push({ op: 'list', apiVersion, kind, namespace, labelSelector });

		return this.store.filter(
			(object) =>
				object.kind === kind &&
				object.apiVersion === apiVersion &&
				// An empty namespace is a cluster-scoped list (the `StorageClass` list), so it must not filter on
				// the namespace at all.
				(!namespace || (object.metadata?.namespace ?? '') === namespace) &&
				matchesSelector(object, labelSelector)
		) as T[];
	}

	async deleteObject(
		_kubeconfigYaml: string,
		apiVersion: string,
		kind: string,
		namespace: string,
		name: string
	): Promise<void> {
		this.calls.push({ op: 'delete', apiVersion, kind, namespace, name });
		const index = this.store.findIndex(
			(object) =>
				object.kind === kind &&
				object.metadata?.name === name &&
				(object.metadata?.namespace ?? '') === namespace
		);
		if (index >= 0) this.store.splice(index, 1);
	}

	async createSelfSubjectAccessReview(
		_kubeconfigYaml: string,
		attributes: { verb: string; resource: string }
	): Promise<{ allowed: boolean }> {
		this.calls.push({ op: 'ssar', verb: attributes.verb, resource: attributes.resource });
		return { allowed: false };
	}

	/**
	 * APW-07 T18's helper (`k8s-api.service.ts:871`), as the port declares it: a missing CRD or an unserved
	 * version is `false`, and the caller decides what that means. The plain-path suite never seeds a CRD, so
	 * this answers `false` — the operator path is the operator spec's subject.
	 */
	async crdServed(_kubeconfigYaml: string, name: string, version: string): Promise<boolean> {
		this.calls.push({ op: 'read', kind: 'CustomResourceDefinition', name });
		const crd = this.find('apiextensions.k8s.io/v1', 'CustomResourceDefinition', '', name);
		if (!crd) return false;
		return (crd.spec?.versions ?? []).some((entry: Json) => entry?.name === version && entry?.served === true);
	}

	/** APW-07 T18's helper (`k8s-api.service.ts:899`): the default class's name, or `null`. */
	async defaultStorageClass(_kubeconfigYaml: string): Promise<string | null> {
		const classes = await this.listObjects<Json>('', 'storage.k8s.io/v1', 'StorageClass', '');
		for (const entry of classes) {
			const annotations = entry.metadata?.annotations ?? {};
			const isDefault = APP_STORAGE_CLASS_DEFAULT_ANNOTATIONS.some(
				(annotation) => annotations[annotation] === 'true'
			);
			if (isDefault && entry.metadata?.name) return String(entry.metadata.name);
		}
		return null;
	}

	// --- internals ----------------------------------------------------------

	private find(apiVersion: string, kind: string, namespace: string, name: string): Json | undefined {
		return this.store.find(
			(object) =>
				object.kind === kind &&
				object.apiVersion === apiVersion &&
				object.metadata?.name === name &&
				(object.metadata?.namespace ?? '') === namespace
		);
	}

	/** SSA-merge into the stored object, then synthesise the status a controller would report. */
	private upsert(manifest: Json): void {
		const existing = this.find(
			String(manifest.apiVersion),
			String(manifest.kind),
			String(manifest.metadata?.namespace ?? ''),
			String(manifest.metadata?.name)
		);
		const merged = existing ? deepMerge(existing, manifest) : clone(manifest);

		if (manifest.kind === 'StatefulSet') {
			merged.status = { readyReplicas: this.readyReplicas, replicas: merged.spec?.replicas ?? 1 };
			const claim = merged.spec?.volumeClaimTemplates?.[0];
			if (claim) {
				this.upsert({
					apiVersion: 'v1',
					kind: 'PersistentVolumeClaim',
					metadata: {
						name: `${String(merged.metadata?.name)}-${String(claim.metadata?.name)}-0`,
						namespace: merged.metadata?.namespace,
						labels: claim.metadata?.labels ?? {}
					},
					status: { phase: this.pvcPhase }
				});
			}
		}
		if (manifest.kind === 'Job') {
			merged.status = { ...this.jobStatus };
		}

		if (existing) Object.assign(existing, merged);
		else this.store.push(merged);
	}
}

/** `a=1,b=2` — the subset of a label selector this suite needs. */
function matchesSelector(object: Json, selector?: string): boolean {
	if (!selector) return true;
	return selector.split(',').every((pair) => {
		const [key, value] = pair.split('=');
		return String(object.metadata?.labels?.[String(key)] ?? '') === String(value ?? '');
	});
}

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

/** A shallow-but-recursive merge — enough for a Server-Side Apply of a partial object. */
function deepMerge(target: Json, patch: Json): Json {
	const out: Json = { ...target };
	for (const [key, value] of Object.entries(patch)) {
		out[key] =
			value && typeof value === 'object' && !Array.isArray(value) && out[key] && typeof out[key] === 'object'
				? deepMerge(out[key], value as Json)
				: clone(value);
	}
	return out;
}

/** The error `KubernetesApiService` raises for a 403: `scrubError`'s code, the original on `cause`. */
function forbidden(message = 'forbidden: statefulsets is forbidden'): K8sPluginError {
	return new K8sPluginError('UNAUTHORIZED', message, { statusCode: 403 });
}

/** A cluster whose CRD is absent (the plain path's own reason) and whose default class is `standard`. */
function plainCluster(overrides: { storageClass?: string | false } = {}): FakeDependencyCluster {
	const cluster = new FakeDependencyCluster();
	if (overrides.storageClass !== false) cluster.seedStorageClass(overrides.storageClass ?? 'standard');
	return cluster;
}

/** A provider over the fake, with a clock that never sleeps. */
function provider(cluster: FakeDependencyCluster, options: Json = {}): PostgresDependencyProvider {
	return new PostgresDependencyProvider(cluster, {
		now: () => 0,
		sleep: async () => undefined,
		pollIntervalMs: 1,
		...options
	});
}

/* ------------------------------------------------------------------------- *
 * ACC-07-14 / FR-36: the StatefulSet, its probe and its claim
 * ------------------------------------------------------------------------- */

describe('T19 plain path — the StatefulSet (ACC-07-14, FR-36/FR-37)', () => {
	it('provisions Postgres 16 as a single-replica StatefulSet with a readiness probe and a 10 GiB claim', async () => {
		const cluster = plainCluster();

		const outcome = await provider(cluster).provision(POSTGRES_PROVIDER_ID, context());

		expect(outcome.state).toBe('ready');
		if (outcome.state !== 'ready') return;
		expect(outcome.actualVersion).toBe('16');

		const statefulSet = cluster.appliedOf('StatefulSet')[0];
		expect(statefulSet).toBeDefined();
		expect(statefulSet.metadata.name).toBe(POSTGRES_OBJECT_NAMES.statefulSet);
		expect(statefulSet.metadata.namespace).toBe(NAMESPACE);
		expect(statefulSet.spec.replicas).toBe(1);

		const container = statefulSet.spec.template.spec.containers[0];
		expect(container.readinessProbe.exec.command).toEqual([
			'pg_isready',
			'-U',
			POSTGRES_APP_NAME,
			'-d',
			POSTGRES_APP_NAME
		]);
		expect(container.env).toEqual(
			expect.arrayContaining([
				{ name: 'POSTGRES_USER', value: POSTGRES_APP_NAME },
				{ name: 'POSTGRES_DB', value: POSTGRES_APP_NAME },
				{ name: 'PGDATA', value: '/var/lib/postgresql/data/pgdata' }
			])
		);
		expect(container.resources.requests).toEqual({ cpu: '250m', memory: '512Mi' });
		expect(container.resources.limits).toEqual({ memory: POSTGRES_MEMORY_LIMIT });
		// The image is the pinned Postgres 16 digest — never a tag (T19's `images.ts` clause).
		expect(container.image).toMatch(/^docker\.io\/library\/postgres@sha256:[0-9a-f]{64}$/);
		expect(container.image).toContain('sha256:f1c3376c26f2609ab9f29f71f824103fe2fcd8ee0346485cb6122a4f93df6f94');

		const claim = statefulSet.spec.volumeClaimTemplates[0];
		expect(claim.spec.resources.requests.storage).toBe('10Gi');
		expect(claim.spec.accessModes).toEqual(['ReadWriteOnce']);
		// The owner's storage class, when one is set, is what the claim asks for.
		const pinned = plainCluster({ storageClass: 'fast-ssd' });
		const pinnedOutcome = await provider(pinned).provision(POSTGRES_PROVIDER_ID, context());
		expect(pinnedOutcome.state).toBe('ready');
		expect(pinned.appliedOf('StatefulSet')[0].spec.volumeClaimTemplates[0].spec.storageClassName).toBe('fast-ssd');
	});

	it("honours the owner's declared size and the plugin's default size setting (FR-37)", async () => {
		const sized = plainCluster();
		await provider(sized).provision(POSTGRES_PROVIDER_ID, context({ sizeGiB: 42 }));
		expect(sized.appliedOf('StatefulSet')[0].spec.volumeClaimTemplates[0].spec.resources.requests.storage).toBe(
			'42Gi'
		);

		const bySetting = plainCluster();
		await provider(bySetting).provision(
			POSTGRES_PROVIDER_ID,
			context({ sizeGiB: undefined, settings: { appDependencySizes: { postgres: 25 } } })
		);
		expect(bySetting.appliedOf('StatefulSet')[0].spec.volumeClaimTemplates[0].spec.resources.requests.storage).toBe(
			'25Gi'
		);

		// Neither: FR-37's own default for Postgres.
		const byDefault = plainCluster();
		await provider(byDefault).provision(POSTGRES_PROVIDER_ID, context({ sizeGiB: undefined }));
		expect(byDefault.appliedOf('StatefulSet')[0].spec.volumeClaimTemplates[0].spec.resources.requests.storage).toBe(
			`${APP_DEPENDENCY_SIZE_DEFAULTS.postgres}Gi`
		);
	});

	it('renders both Services as ClusterIP — never a LoadBalancer or a NodePort (plan §4.9:580)', async () => {
		const cluster = plainCluster();
		await provider(cluster).provision(POSTGRES_PROVIDER_ID, context());

		const services = cluster.appliedOf('Service');
		expect(services.map((service) => service.metadata.name).sort()).toEqual(
			[POSTGRES_OBJECT_NAMES.headlessService, POSTGRES_OBJECT_NAMES.service].sort()
		);
		const headless = services.find(
			(service) => service.metadata.name === POSTGRES_OBJECT_NAMES.headlessService
		) as Json;
		const service = services.find((entry) => entry.metadata.name === POSTGRES_OBJECT_NAMES.service) as Json;
		expect(headless.spec.clusterIP).toBe('None');
		expect(service.spec.type).toBe('ClusterIP');
		for (const entry of services) {
			expect(['LoadBalancer', 'NodePort']).not.toContain(entry.spec.type);
			expect(entry.spec.ports).toEqual([
				{ name: 'postgres', port: POSTGRES_PORT, targetPort: POSTGRES_PORT, protocol: 'TCP' }
			]);
			expect(entry.spec.selector).toEqual({ [APP_DEPENDENCY_POLICY_LABEL]: 'postgres' });
		}
	});

	it('polls while the StatefulSet has no ready replica and fails volumeNotReady at the deadline', async () => {
		const cluster = plainCluster();
		cluster.readyReplicas = 0;
		const controller = new AbortController();
		let ticks = 0;

		// FR-41's deadline arrives as the signal's abort, so the loop must re-poll and then honour it.
		const outcome = await provider(cluster, {
			sleep: async () => {
				ticks += 1;
				if (ticks >= 3) controller.abort();
			}
		}).provision(POSTGRES_PROVIDER_ID, context({ signal: controller.signal }));

		expect(ticks).toBe(3);
		expect(outcome.state).toBe('failed');
		if (outcome.state !== 'failed') return;
		expect(outcome.reason).toBe('volumeNotReady');
		expect(outcome.transient).toBe(false);
		expect(outcome.detail?.aborted).toBe('true');
		// plan §4.9:616 says `failed noStorage`; the contract's member for that card line is `volumeNotReady`, and
		// the plan's own word is carried in the detail rather than lost.
		expect(outcome.detail?.planReason).toBe('noStorage');
	});

	it('answers pending, never a tight loop, when a caller forgets to arm the deadline signal', async () => {
		const cluster = plainCluster();
		cluster.readyReplicas = 0;

		// FR-41's deadline arrives as an abort; a caller that never arms one gets the observation bound instead of
		// a spin, and the job simply retries the `pending`.
		const outcome = await provider(cluster, { maxPolls: 2 }).provision(POSTGRES_PROVIDER_ID, context());

		expect(outcome).toMatchObject({ state: 'pending', retryAfterMs: 1 });
		if (outcome.state !== 'pending') return;
		expect(outcome.detail?.waitedPolls).toBe(2);
	});

	it('fails volumeNotReady at once when the caller’s deadline has already passed', async () => {
		const cluster = plainCluster();
		cluster.readyReplicas = 0;
		const controller = new AbortController();
		controller.abort();

		const outcome = await provider(cluster).provision(POSTGRES_PROVIDER_ID, context({ signal: controller.signal }));

		expect(outcome).toMatchObject({ state: 'failed', reason: 'volumeNotReady', transient: false });
	});
});

/* ------------------------------------------------------------------------- *
 * FR-38 / ACC-07-14 / APW07-G01: the dep-postgres policy
 * ------------------------------------------------------------------------- */

describe('T19 plain path — the dep-postgres NetworkPolicy (FR-38, ACC-07-14, APW07-G01)', () => {
	it('applies dep-postgres before the StatefulSet, admitting same-namespace pods on 5432 only', async () => {
		const cluster = plainCluster();

		await provider(cluster).provision(POSTGRES_PROVIDER_ID, context());

		// Order is the requirement: a policy drawn after the workload leaves a window in which any pod may connect.
		expect(cluster.appliedNames()[0]).toBe(`NetworkPolicy/${dependencyNetworkPolicyName('postgres')}`);

		const policy = cluster.appliedOf('NetworkPolicy')[0];
		expect(policy.metadata.name).toBe('dep-postgres');
		expect(policy.apiVersion).toBe('networking.k8s.io/v1');
		expect(policy.spec.podSelector).toEqual({ matchLabels: { [APP_DEPENDENCY_POLICY_LABEL]: 'postgres' } });
		expect(policy.spec.policyTypes).toEqual(['Ingress']);
		expect(policy.spec.ingress).toEqual([
			{
				from: [{ podSelector: {} }],
				ports: [{ protocol: 'TCP', port: APP_DEPENDENCY_PORTS.postgres }]
			}
		]);
		// Nothing outside the namespace: a same-namespace `podSelector` peer is the only one, and there is no
		// namespaceSelector and no ipBlock anywhere in the policy.
		expect(JSON.stringify(policy.spec.ingress)).not.toContain('namespaceSelector');
		expect(JSON.stringify(policy.spec.ingress)).not.toContain('ipBlock');
		expect(policy.spec.ingress[0].ports).toHaveLength(1);
	});

	it('draws the policy with isolation off too — the context carries no isolation switch (APW07-G01)', async () => {
		const cluster = plainCluster();

		// `isolation` is not a field of `AppDependencyContext`; a caller that hands one over anyway (the shape a
		// future APW-06 settings blob might take) must not be able to switch the policy off.
		const withIsolationOff = context({ isolation: false, network: { isolation: false } });
		await provider(cluster).provision(POSTGRES_PROVIDER_ID, withIsolationOff);

		expect(cluster.appliedOf('NetworkPolicy')).toHaveLength(1);
		expect(cluster.appliedNames()[0]).toBe('NetworkPolicy/dep-postgres');

		// And the plain path admits no operator namespace at all — that rule belongs to the operator path.
		expect(cluster.appliedOf('NetworkPolicy')[0].spec.ingress).toHaveLength(1);
	});

	it('carries the operator-namespace rule only where the operator path asks for it', async () => {
		// The renderer itself, exercised with the two operator shapes the plan fixes (plan §4.9:591-592).
		const { planDependencyNetworkPolicy } = await import('../common');

		const detected = planDependencyNetworkPolicy({
			kind: 'postgres',
			namespace: NAMESPACE,
			workId: WORK_ID,
			workSlug: WORK_SLUG,
			port: APP_DEPENDENCY_PORTS.postgres,
			operatorNamespace: 'cnpg-system'
		});
		expect(detected.warnings).toEqual([]);
		expect((detected.policy.spec as Json).ingress[1]).toEqual({
			from: [{ namespaceSelector: { matchLabels: { [APP_NAMESPACE_NAME_LABEL]: 'cnpg-system' } } }],
			ports: [
				{ protocol: 'TCP', port: APP_DEPENDENCY_PORTS.postgres },
				{ protocol: 'TCP', port: APP_DEPENDENCY_OPERATOR_STATUS_PORT }
			]
		});

		const fallback = planDependencyNetworkPolicy({
			kind: 'postgres',
			namespace: NAMESPACE,
			workId: WORK_ID,
			workSlug: WORK_SLUG,
			port: APP_DEPENDENCY_PORTS.postgres,
			operatorNamespace: null,
			operatorFallback: true
		});
		expect(fallback.warnings).toEqual(['operatorNamespaceUnknown']);
		// The fallback is wide on *namespaces* and narrow on *ports*: 5432 and the status port, nothing else.
		expect((fallback.policy.spec as Json).ingress[1]).toEqual({
			from: [{ namespaceSelector: {} }],
			ports: [
				{ protocol: 'TCP', port: APP_DEPENDENCY_PORTS.postgres },
				{ protocol: 'TCP', port: APP_DEPENDENCY_OPERATOR_STATUS_PORT }
			]
		});
	});

	it('labels the policy with APW-06’s set plus ever-works.io/dependency', async () => {
		const cluster = plainCluster();
		await provider(cluster).provision(POSTGRES_PROVIDER_ID, context());

		expect(cluster.appliedOf('NetworkPolicy')[0].metadata.labels).toMatchObject({
			[APP_LABEL_MANAGED_BY]: 'ever-works-k8s-plugin',
			[APP_LABEL_PART_OF]: WORK_SLUG,
			[APP_LABEL_WORK_ID]: WORK_ID,
			[APP_LABEL_KIND]: 'app',
			[APP_DEPENDENCY_POLICY_LABEL]: 'postgres'
		});
	});
});

/* ------------------------------------------------------------------------- *
 * FR-13 / plan §4.9:578-579: the security context
 * ------------------------------------------------------------------------- */

describe('T19 plain path — the security context (plan §4.9:578-579)', () => {
	it('runs the pod as uid/gid/fsGroup 999, non-root, with a RuntimeDefault seccomp profile', async () => {
		const cluster = plainCluster();
		await provider(cluster).provision(POSTGRES_PROVIDER_ID, context());

		const statefulSet = cluster.appliedOf('StatefulSet')[0];
		expect(statefulSet.spec.template.spec.securityContext).toEqual({
			runAsNonRoot: true,
			seccompProfile: { type: 'RuntimeDefault' },
			runAsUser: 999,
			runAsGroup: 999,
			fsGroup: 999
		});
	});

	it('drops ALL capabilities and forbids privilege escalation on the container', async () => {
		const cluster = plainCluster();
		await provider(cluster).provision(POSTGRES_PROVIDER_ID, context());

		const container = cluster.appliedOf('StatefulSet')[0].spec.template.spec.containers[0];
		expect(container.securityContext).toEqual({
			allowPrivilegeEscalation: false,
			capabilities: { drop: ['ALL'] }
		});
	});

	it('never renders a root pod, whatever the caller passes', async () => {
		const { dependencyPodSecurityContext } = await import('../common');

		// `runAsNonRoot` is not a parameter: a caller cannot turn it off, and a non-integer id is dropped
		// rather than rounded into a uid the image may not have.
		expect(dependencyPodSecurityContext({ runAsUser: 'root' as unknown as number })).toEqual({
			runAsNonRoot: true,
			seccompProfile: { type: 'RuntimeDefault' }
		});
		expect(dependencyPodSecurityContext({ runAsUser: -1 }).runAsUser).toBeUndefined();
		expect(dependencyPodSecurityContext({}).runAsNonRoot).toBe(true);
	});
});

/* ------------------------------------------------------------------------- *
 * plan §4.9:578: the labels, and the PVC's retain
 * ------------------------------------------------------------------------- */

describe('T19 plain path — labels and the PVC (plan §4.9:578)', () => {
	it('puts APW-06’s labels plus dependency and retain on the PVC', async () => {
		const cluster = plainCluster();
		await provider(cluster).provision(POSTGRES_PROVIDER_ID, context());

		const labels = cluster.appliedOf('StatefulSet')[0].spec.volumeClaimTemplates[0].metadata.labels;
		expect(labels).toEqual({
			[APP_LABEL_MANAGED_BY]: 'ever-works-k8s-plugin',
			[APP_LABEL_PART_OF]: WORK_SLUG,
			[APP_LABEL_WORK_ID]: WORK_ID,
			[APP_LABEL_KIND]: 'app',
			[APP_DEPENDENCY_POLICY_LABEL]: 'postgres',
			[APP_LABEL_RETAIN]: 'true'
		});
		// APW-06's listing labels must never appear: they are the site path's selectors (plan §1.2 #6).
		expect(labels['ever-works.io/managed']).toBeUndefined();
		expect(labels['app.kubernetes.io/name']).toBeUndefined();

		// The pod template carries the selector the policy selects on.
		expect(cluster.appliedOf('StatefulSet')[0].spec.template.metadata.labels).toMatchObject({
			[APP_DEPENDENCY_POLICY_LABEL]: 'postgres'
		});
		expect(cluster.appliedOf('StatefulSet')[0].spec.selector).toEqual({
			matchLabels: { [APP_DEPENDENCY_POLICY_LABEL]: 'postgres' }
		});
	});

	it('labels every object it creates with ever-works.io/dependency: postgres', async () => {
		const cluster = plainCluster();
		await provider(cluster).provision(POSTGRES_PROVIDER_ID, context());

		for (const object of cluster.applied()) {
			expect(object.metadata.labels[APP_DEPENDENCY_POLICY_LABEL]).toBe('postgres');
			expect(object.metadata.namespace).toBe(NAMESPACE);
		}
	});
});

/* ------------------------------------------------------------------------- *
 * FR-48: the no-backup warning, FR-40: the outputs
 * ------------------------------------------------------------------------- */

describe('T19 plain path — backup state and outputs (FR-40/FR-48)', () => {
	it('reports backup state none — the no-backup warning (ACC-07-14)', async () => {
		const cluster = plainCluster();
		await provider(cluster).provision(POSTGRES_PROVIDER_ID, context());

		expect(await provider(cluster).backupStatus(POSTGRES_PROVIDER_ID, context())).toEqual({ state: 'none' });
	});

	it('emits every declared output, with directUrl only when the App spec declares it (FR-40)', async () => {
		const cluster = plainCluster();
		const outcome = await provider(cluster).provision(POSTGRES_PROVIDER_ID, context());

		expect(outcome.state).toBe('ready');
		if (outcome.state !== 'ready') return;
		expect(Object.keys(outcome.outputs).sort()).toEqual(['database', 'host', 'password', 'port', 'url', 'user']);
		expect(outcome.outputs.host).toBe(`dep-postgres.${NAMESPACE}.svc.cluster.local`);
		expect(outcome.outputs.port).toBe('5432');
		expect(outcome.outputs.database).toBe(POSTGRES_APP_NAME);
		expect(outcome.outputs.user).toBe(POSTGRES_APP_NAME);
		expect(outcome.outputs.password).toMatch(/^[0-9a-f]{32}$/);
		expect(outcome.outputs.url).toBe(
			`postgres://app:${outcome.outputs.password}@dep-postgres.${NAMESPACE}.svc.cluster.local:5432/app?sslmode=disable`
		);

		const declared = plainCluster();
		const withDirect = await provider(declared).provision(
			POSTGRES_PROVIDER_ID,
			context({ declared: { version: 16, directUrl: true } })
		);
		expect(withDirect.state).toBe('ready');
		if (withDirect.state !== 'ready') return;
		expect(withDirect.outputs.directUrl).toBe(withDirect.outputs.url);
	});

	it('reads the outputs back out of the cluster, never out of the provision result (FR-42)', async () => {
		const cluster = plainCluster();
		const first = await provider(cluster).provision(POSTGRES_PROVIDER_ID, context());
		expect(first.state).toBe('ready');
		if (first.state !== 'ready') return;

		const refreshed = await provider(cluster).getOutputs(POSTGRES_PROVIDER_ID, context());
		expect(refreshed).toEqual(first.outputs);

		// Re-provisioning reuses the stored password: a retry must never rotate a live database's password.
		const again = await provider(cluster).provision(POSTGRES_PROVIDER_ID, context());
		expect(again.state).toBe('ready');
		if (again.state !== 'ready') return;
		expect(again.outputs.password).toBe(first.outputs.password);
	});

	it('throws rather than answering an empty output set when the Secret is gone (plan §9.2:955)', async () => {
		const cluster = plainCluster();
		const empty = new FakeDependencyCluster();
		await expect(provider(empty).getOutputs(POSTGRES_PROVIDER_ID, context())).rejects.toThrow(/dep-postgres/);
		expect(cluster.applied()).toEqual([]);
	});
});

/* ------------------------------------------------------------------------- *
 * ACC-07-20 / S18: no default storage class
 * ------------------------------------------------------------------------- */

describe('T19 plain path — ACC-07-20 (S18)', () => {
	it('fails noDefaultStorageClass, with S18’s own copy, before writing anything', async () => {
		const cluster = plainCluster({ storageClass: false });

		const outcome = await provider(cluster).provision(POSTGRES_PROVIDER_ID, context());

		expect(outcome).toMatchObject({ state: 'failed', reason: 'noDefaultStorageClass', transient: false });
		if (outcome.state !== 'failed') return;
		expect(outcome.detail?.message).toBe(S18_MESSAGE);
		// A definite failure fails at once (FR-43) and leaves nothing behind.
		expect(cluster.applied()).toEqual([]);
	});

	it('accepts a cluster whose default class is annotated on the beta spelling too', async () => {
		const cluster = new FakeDependencyCluster();
		cluster.seedStorageClass('standard', false);
		cluster.seed({
			apiVersion: 'storage.k8s.io/v1',
			kind: 'StorageClass',
			metadata: {
				name: 'legacy',
				annotations: { 'storageclass.beta.kubernetes.io/is-default-class': 'true' }
			}
		});

		const outcome = await provider(cluster).provision(POSTGRES_PROVIDER_ID, context());

		expect(outcome.state).toBe('ready');
	});

	it('does not need a default class when the owner names one in the settings', async () => {
		const cluster = plainCluster({ storageClass: false });

		const outcome = await provider(cluster).provision(
			POSTGRES_PROVIDER_ID,
			context({ settings: { appDependencyStorageClass: 'fast-ssd' } })
		);

		expect(outcome.state).toBe('ready');
		expect(cluster.appliedOf('StatefulSet')[0].spec.volumeClaimTemplates[0].spec.storageClassName).toBe('fast-ssd');
	});
});

/* ------------------------------------------------------------------------- *
 * APW07-G10: a 403 on the StatefulSet create
 * ------------------------------------------------------------------------- */

describe('T19 plain path — APW07-G10', () => {
	it('fails clusterPermissionMissing when the credential may not create a StatefulSet', async () => {
		const cluster = plainCluster();
		cluster.applyFails.set(`StatefulSet/${POSTGRES_OBJECT_NAMES.statefulSet}`, forbidden());

		const outcome = await provider(cluster).provision(POSTGRES_PROVIDER_ID, context());

		expect(outcome).toMatchObject({ state: 'failed', reason: 'clusterPermissionMissing', transient: false });
		if (outcome.state !== 'failed') return;
		expect(outcome.detail?.resource).toBe('statefulsets');
	});

	it('treats a refusal on any other object the same way, and an outage as a retry', async () => {
		const forbiddenCluster = plainCluster();
		forbiddenCluster.applyFails.set('Secret', forbidden('forbidden: secrets is forbidden'));
		expect(await provider(forbiddenCluster).provision(POSTGRES_PROVIDER_ID, context())).toMatchObject({
			state: 'failed',
			reason: 'clusterPermissionMissing',
			transient: false
		});

		const broken = plainCluster();
		broken.applyFails.set('NetworkPolicy', new K8sPluginError('UNKNOWN', 'dial tcp: i/o timeout'));
		expect(await provider(broken).provision(POSTGRES_PROVIDER_ID, context())).toMatchObject({
			state: 'failed',
			reason: 'clusterUnreachable',
			transient: true
		});
	});
});

/* ------------------------------------------------------------------------- *
 * plan §4.9:616: the extensions Job
 * ------------------------------------------------------------------------- */

describe('T19 plain path — extensions (plan §4.9:616)', () => {
	it('runs a psql Job, one -c per declared extension, and refuses a name that is not an identifier', async () => {
		const cluster = plainCluster();

		const outcome = await provider(cluster).provision(
			POSTGRES_PROVIDER_ID,
			context({ declared: { version: 16, extensions: ['pgcrypto', 'citext', 'bad; DROP TABLE users'] } })
		);

		expect(outcome.state).toBe('ready');
		const job = cluster.appliedOf('Job')[0];
		expect(job.metadata.name).toBe(POSTGRES_OBJECT_NAMES.extensionsJob);
		expect(job.spec.template.spec.containers[0].command).toEqual([
			'psql',
			'-h',
			'dep-postgres',
			'-U',
			'app',
			'-d',
			'app',
			'-v',
			'ON_ERROR_STOP=1'
		]);
		expect(job.spec.template.spec.containers[0].args).toEqual([
			'-c',
			'CREATE EXTENSION IF NOT EXISTS "pgcrypto";',
			'-c',
			'CREATE EXTENSION IF NOT EXISTS "citext";'
		]);
		// The SQL-injection attempt is dropped, not escaped into the statement.
		expect(JSON.stringify(job)).not.toContain('DROP TABLE');
		expect(job.spec.template.spec.containers[0].env).toEqual([
			{ name: 'PGPASSWORD', valueFrom: { secretKeyRef: { name: 'dep-postgres', key: 'password' } } }
		]);
	});

	it('runs no Job when nothing is declared, and reports extensionUnavailable when the Job fails', async () => {
		const silent = plainCluster();
		await provider(silent).provision(POSTGRES_PROVIDER_ID, context({ declared: { version: 16 } }));
		expect(silent.appliedOf('Job')).toEqual([]);

		const failing = plainCluster();
		failing.jobStatus = { failed: 1 };
		const outcome = await provider(failing).provision(
			POSTGRES_PROVIDER_ID,
			context({ declared: { version: 16, extensions: ['pgcrypto'] } })
		);
		expect(outcome).toMatchObject({ state: 'failed', reason: 'extensionUnavailable', transient: false });
	});
});

/* ------------------------------------------------------------------------- *
 * R-10 / FR-60 / ACC-07-31: the ephemeral variant
 * ------------------------------------------------------------------------- */

describe('T19 plain path — the ephemeral variant (R-10, FR-60, ACC-07-31)', () => {
	it('uses emptyDir and no PVC, never the operator path, and says so', async () => {
		const cluster = plainCluster();
		// The operator is fully usable: the ephemeral variant must still take the plain path.
		cluster.seed({
			apiVersion: 'apiextensions.k8s.io/v1',
			kind: 'CustomResourceDefinition',
			metadata: { name: 'clusters.postgresql.cnpg.io' },
			spec: { versions: [{ name: 'v1', served: true }] }
		});

		const outcome = await provider(cluster).provision(POSTGRES_PROVIDER_ID, context({ ephemeral: true }));

		expect(outcome.state).toBe('ready');
		if (outcome.state !== 'ready') return;
		expect(warningCode(outcome.warnings?.[0] ?? '')).toBe('ephemeralNoPersistence');
		expect(cluster.appliedOf('Cluster')).toEqual([]);

		const statefulSet = cluster.appliedOf('StatefulSet')[0];
		expect(statefulSet.spec.volumeClaimTemplates).toBeUndefined();
		expect(statefulSet.spec.template.spec.volumes).toEqual([{ name: 'data', emptyDir: {} }]);
		// The claim is what ACC-07-31 forbids; the emptyDir is what replaces it.
		expect(JSON.stringify(statefulSet)).not.toContain('PersistentVolumeClaim');
	});

	it('needs no default storage class and no operator probe when there is no claim to bind', async () => {
		const cluster = plainCluster({ storageClass: false });

		const outcome = await provider(cluster).provision(POSTGRES_PROVIDER_ID, context({ ephemeral: true }));

		expect(outcome.state).toBe('ready');
		// The only reads are the Secret lookup and the readiness poll: no CRD read, no StorageClass list.
		expect(cluster.calls.filter((call) => call.op === 'list' && call.kind === 'StorageClass')).toEqual([]);
		expect(cluster.calls.filter((call) => call.kind === 'CustomResourceDefinition')).toEqual([]);
	});
});

/* ------------------------------------------------------------------------- *
 * plan §4.9:624-628, FR-46/FR-50: deprovision
 * ------------------------------------------------------------------------- */

describe('T19 plain path — deprovision (plan §4.9:624-628)', () => {
	it('makes no cluster call at all when data is kept and the workload is not stopped', async () => {
		const cluster = plainCluster();
		await provider(cluster).provision(POSTGRES_PROVIDER_ID, context());
		const before = cluster.calls.length;

		const outcome = await provider(cluster).deprovision(POSTGRES_PROVIDER_ID, context(), { deleteData: false });

		expect(outcome).toEqual({ state: 'released' });
		expect(cluster.calls.length).toBe(before);
	});

	it('scales the StatefulSet to zero for stopWorkloads and touches nothing else', async () => {
		const cluster = plainCluster();
		await provider(cluster).provision(POSTGRES_PROVIDER_ID, context());

		const outcome = await provider(cluster).deprovision(POSTGRES_PROVIDER_ID, context(), {
			deleteData: false,
			stopWorkloads: true
		});

		expect(outcome).toEqual({ state: 'released' });
		const scaled = cluster.applied().at(-1) as Json;
		expect(scaled).toMatchObject({ kind: 'StatefulSet', spec: { replicas: 0 } });
		// Nothing but the scale: no delete, and the PVC, the Secret and the policy are all still there.
		expect(cluster.deleted()).toEqual([]);
		expect(await provider(cluster).backupStatus(POSTGRES_PROVIDER_ID, context())).toEqual({ state: 'none' });
		expect((await provider(cluster).getOutputs(POSTGRES_PROVIDER_ID, context())).password).toBeTruthy();
		expect(cluster.calls.some((call) => call.op === 'delete')).toBe(false);
	});

	it('deletes the workload, the Services, the Secret and the PVCs when data is deleted', async () => {
		const cluster = plainCluster();
		await provider(cluster).provision(POSTGRES_PROVIDER_ID, context());

		const outcome = await provider(cluster).deprovision(POSTGRES_PROVIDER_ID, context(), { deleteData: true });

		expect(outcome).toEqual({ state: 'deleted' });
		const deleted = cluster.deleted();
		expect(deleted).toEqual(
			expect.arrayContaining([
				'NetworkPolicy/dep-postgres',
				'StatefulSet/dep-postgres',
				'Secret/dep-postgres',
				'Service/dep-postgres',
				'Service/dep-postgres-hl',
				'PersistentVolumeClaim/dep-postgres-data-0'
			])
		);
		// The PVC is deleted explicitly, after the workload — never merely orphaned with its StatefulSet.
		expect(deleted[deleted.length - 1]).toBe('PersistentVolumeClaim/dep-postgres-data-0');
	});

	it('reports remaining when something survives the teardown', async () => {
		const cluster = plainCluster();
		await provider(cluster).provision(POSTGRES_PROVIDER_ID, context());
		// A PVC that refuses to go, as a finalizer would make it.
		const original = cluster.deleteObject.bind(cluster);
		cluster.deleteObject = (async (
			kubeconfig: string,
			apiVersion: string,
			kind: string,
			namespace: string,
			name: string
		) => {
			if (kind !== 'PersistentVolumeClaim') {
				return original(kubeconfig, apiVersion, kind, namespace, name);
			}
			return undefined;
		}) as typeof cluster.deleteObject;

		const outcome = await provider(cluster).deprovision(POSTGRES_PROVIDER_ID, context(), { deleteData: true });

		expect(outcome.state).toBe('pending');
		expect(outcome.remaining?.objects).toEqual([{ kind: 'PersistentVolumeClaim', name: 'dep-postgres-data-0' }]);
	});
});

/* ------------------------------------------------------------------------- *
 * T19: the images are digest-pinned, every one of them
 * ------------------------------------------------------------------------- */

describe('T19 — images.ts (T19: "digest-pinned images")', () => {
	it('emits a digest-pinned reference for every Postgres version 14–17, its client, Redis 7 and the S3 pair', () => {
		const images = everyDependencyImage();

		expect(images.length).toBe(11);
		for (const image of images) {
			expect(isDigestPinned(image), image).toBe(true);
		}
		expect(images.filter((image) => image.includes('postgres@')).length).toBe(8);
		expect(images.some((image) => image.includes('redis@'))).toBe(true);
		expect(images.some((image) => image.includes('minio/minio@'))).toBe(true);
		expect(images.some((image) => image.includes('minio/mc@'))).toBe(true);
	});

	it('reduces a declared version to a supported major, or the pinned default 16', async () => {
		const { normalisePostgresVersion, isSupportedPostgresVersion, postgresImage, dependencyImageOverride } =
			await import('../images');

		expect(normalisePostgresVersion(14)).toBe(14);
		expect(normalisePostgresVersion('17')).toBe(17);
		expect(normalisePostgresVersion('v15.4')).toBe(15);
		expect(normalisePostgresVersion('latest')).toBe(POSTGRES_DEFAULT_VERSION);
		expect(normalisePostgresVersion(undefined)).toBe(POSTGRES_DEFAULT_VERSION);
		expect(isSupportedPostgresVersion('18')).toBe(false);
		// A caller's version can never become part of the reference.
		expect(postgresImage('16@sha256:' + 'a'.repeat(64))).toContain('postgres@sha256:');
		expect(postgresImage('16@sha256:' + 'a'.repeat(64))).not.toContain('aaaa');
		// An override that is not a digest is ignored rather than trusted.
		expect(dependencyImageOverride('postgres:16')).toBeNull();
		expect(dependencyImageOverride('sha256:' + 'b'.repeat(64), 'docker.io/library/postgres')).toBe(
			'docker.io/library/postgres@sha256:' + 'b'.repeat(64)
		);
	});

	it('fails a declared version this plugin cannot pin with a warning naming the request', async () => {
		const cluster = plainCluster();

		const outcome = await provider(cluster).provision(POSTGRES_PROVIDER_ID, context({ declared: { version: 18 } }));

		expect(outcome.state).toBe('ready');
		if (outcome.state !== 'ready') return;
		expect(outcome.actualVersion).toBe('16');
		expect(outcome.warnings).toContain('postgresVersionUnsupported=18');
	});

	it('honours an admin image override, per version', async () => {
		const cluster = plainCluster();
		const override = 'sha256:' + 'c'.repeat(64);

		const outcome = await provider(cluster).provision(
			POSTGRES_PROVIDER_ID,
			context({ settings: { appDependencyImages: { postgres: { 16: override } } } })
		);

		expect(outcome.state).toBe('ready');
		expect(cluster.appliedOf('StatefulSet')[0].spec.template.spec.containers[0].image).toBe(
			`docker.io/library/postgres@${override}`
		);
	});
});

/* ------------------------------------------------------------------------- *
 * T19: the plugin's own wiring
 * ------------------------------------------------------------------------- */

/** The fake as the service the plugin's constructor declares — the same cast `k8s.plugin.spec.ts` uses. */
function pluginOver(cluster: FakeDependencyCluster): KubernetesPlugin {
	return new KubernetesPlugin({ api: cluster as unknown as KubernetesApiService });
}

describe('T19 — the k8s plugin publishes and delegates (plan §4.9:570, tasks.md:291-294)', () => {
	it('declares the app-dependency capability alongside deployment', () => {
		const plugin = new KubernetesPlugin();

		expect(plugin.capabilities).toContain('deployment');
		expect(plugin.capabilities).toContain('app-dependency');
		expect(plugin.getManifest().capabilities).toEqual(['deployment', 'app-dependency']);
	});

	it('publishes the postgres descriptor, with the plan’s preference and backup policy', () => {
		const plugin = new KubernetesPlugin();

		// T20/T21 appended theirs to this list (plan §4.9:570 — "dependencyProviders for the three ids"); the
		// full three-entry list and its order are pinned by `object-storage.spec.ts`, which owns T21.
		expect(plugin.dependencyProviders).toContainEqual(POSTGRES_PROVIDER_DESCRIPTOR);
		expect(plugin.dependencyProviders[0]).toEqual({
			id: 'k8s-inline-postgres',
			kind: 'postgres',
			targets: ['your-cluster'],
			label: 'In your cluster · single instance',
			preference: 10,
			backupPolicy: 'operator'
		});
	});

	it('answers supports for the pair it serves and for nothing else', async () => {
		const plugin = pluginOver(plainCluster());

		expect(await plugin.supports('postgres', 'your-cluster', context())).toEqual({
			supported: true,
			providerId: POSTGRES_PROVIDER_ID
		});
		// R-5: never the managed tier, never another kind.
		expect(await plugin.supports('postgres', 'ever-works-apps', context())).toEqual({
			supported: false,
			reason: 'providerNotSupported'
		});
		// `redis` and `objectStorage` are served by this plugin too since T20/T21 (each has its own spec);
		// `smtp` is `app-dependencies-external`'s, so this plugin answers for nothing there.
		expect(await plugin.supports('smtp', 'your-cluster', context())).toEqual({
			supported: false,
			reason: 'providerNotSupported'
		});
	});

	it('delegates provision, getOutputs, deprovision and backupStatus to the provider', async () => {
		const cluster = plainCluster();
		const plugin = pluginOver(cluster);

		const outcome = await plugin.provision(POSTGRES_PROVIDER_ID, context());
		expect(outcome.state).toBe('ready');
		expect(cluster.appliedOf('StatefulSet')).toHaveLength(1);
		// Going through the plugin, the `dep-postgres` policy is still applied first.
		expect(cluster.appliedNames()[0]).toBe('NetworkPolicy/dep-postgres');

		expect(await plugin.getOutputs(POSTGRES_PROVIDER_ID, context())).toMatchObject({ host: expect.any(String) });
		expect(await plugin.backupStatus(POSTGRES_PROVIDER_ID, context())).toEqual({ state: 'none' });
		expect(await plugin.deprovision(POSTGRES_PROVIDER_ID, context(), { deleteData: false })).toEqual({
			state: 'released'
		});

		// An unpublished provider id is refused, never served by a fallback (plan §4.8:543-544). `s3-external`
		// is `app-dependencies-external`'s provider, so no entry here will ever publish it — unlike
		// `k8s-inline-minio` and `k8s-inline-redis`, which T20/T21 have since registered.
		expect(await plugin.provision('s3-external', context())).toMatchObject({
			state: 'failed',
			reason: 'providerNotSupported'
		});
		await expect(plugin.getOutputs('s3-external', context())).rejects.toThrow(/s3-external/);
		expect(await plugin.backupStatus('s3-external', context())).toEqual({ state: 'none' });
		expect(await plugin.deprovision('s3-external', context(), { deleteData: true })).toEqual({
			state: 'released'
		});
	});

	it('declares the dependency settings the provider reads, with FR-37’s defaults', () => {
		const plugin = new KubernetesPlugin();
		const properties = plugin.settingsSchema.properties ?? {};

		expect(properties.appDependencyStorageClass).toBeDefined();
		expect(properties.appDependencySizes?.properties).toMatchObject({
			postgres: { type: 'integer', default: APP_DEPENDENCY_SIZE_DEFAULTS.postgres },
			objectStorage: { type: 'integer', default: APP_DEPENDENCY_SIZE_DEFAULTS.objectStorage },
			redis: { type: 'integer', default: APP_DEPENDENCY_SIZE_DEFAULTS.redis }
		});
		const images = properties.appDependencyImages;
		expect(images?.['x-adminOnly']).toBe(true);
		expect(Object.keys(images?.properties ?? {}).sort()).toEqual([
			'objectStorage',
			'objectStorageClient',
			'postgres',
			'postgresClient',
			'redis'
		]);
	});
});
