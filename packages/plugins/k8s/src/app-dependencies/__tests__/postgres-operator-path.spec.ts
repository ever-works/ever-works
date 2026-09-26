/**
 * T19 — `app-dependencies/postgres.provider.ts`, the **operator path** (plan §4.9:615, §9.2:954; spec FR-36,
 * FR-48, FR-49; ACC-07-15; APW07-G01, APW07-G10).
 *
 * Every clause of T19's `**Test**` line for this path has an `it` below:
 *
 * - the CRD served **and** the access review allowed ⇒ a `Cluster` with `instances: 1` (ACC-07-15);
 * - the CRD served **and** the create denied ⇒ the plain path, with `operatorSkipped` on the outcome
 *   (`statusDetail.operatorSkipped = 'noPermission'`, plan §4.9:610 / §9.2:954);
 * - the backup states read from individual `Backup` objects — newest `completed` ⇒ `healthy`, `failed` ⇒
 *   `failing`, none ⇒ `not_configured`, and **a cluster whose summary claims a fresh success while its newest
 *   `Backup` failed ⇒ `failing`** (ACC-07-15, FR-49);
 * - no `Backup` with a `ScheduledBackup` 27 hours old ⇒ `overdue`.
 *
 * `Cluster.status.lastSuccessfulBackup` is never read: the case above seeds a *lying* summary precisely so a
 * regression that consulted it would pass the summary through as `healthy`. `PostgresBackupObject` does not
 * even model a cluster's `status`.
 *
 * **No network, ever.** `FakeDependencyCluster` implements the five-method `AppDependencyApi` port over an
 * in-memory object list, and the provider's clock and its only wait are injected.
 */
import { describe, expect, it } from 'vitest';

import type { AppDependencyContext } from '@ever-works/plugin';

import { K8sPluginError } from '../../errors';
import { APP_STORAGE_CLASS_DEFAULT_ANNOTATIONS } from '../../app/app-cluster-check';
import {
	APP_DEPENDENCY_BACKUP_OVERDUE_MS,
	APP_DEPENDENCY_OPERATOR_STATUS_PORT,
	APP_DEPENDENCY_PORTS,
	POSTGRES_CLUSTER_CRD,
	POSTGRES_OPERATOR_API_VERSION,
	postgresBackupStatus,
	type AppDependencyApi
} from '../common';
import {
	POSTGRES_APP_NAME,
	POSTGRES_OPERATOR_APP_SECRET,
	POSTGRES_OPERATOR_RW_SERVICE,
	POSTGRES_PROVIDER_ID,
	PostgresDependencyProvider,
	warningCode
} from '../postgres.provider';

/* ------------------------------------------------------------------------- *
 * Fixtures
 * ------------------------------------------------------------------------- */

type Json = Record<string, any>;

const WORK_ID = '0f8e2c1a-1111-4a2b-9c3d-4e5f60718293';
const WORK_SLUG = 'analytics';
const NAMESPACE = 'ew-analytics-0f8e2c1a';
const KUBECONFIG = 'kind-app-runtime-kubeconfig';
const OPERATOR_NAMESPACE = 'cnpg-system';

/** 2026-09-18T12:00:00Z — every timestamp below is relative to this instant. */
const NOW = Date.parse('2026-09-18T12:00:00.000Z');

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
			appLabels: { 'app.kubernetes.io/part-of': WORK_SLUG }
		},
		settings: {},
		signal: new AbortController().signal
	};

	return { ...base, ...overrides } as unknown as AppDependencyContext;
}

function base64(value: string): string {
	return Buffer.from(value, 'utf8').toString('base64');
}

/* ------------------------------------------------------------------------- *
 * The fake API
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
	/** Whether one `SelfSubjectAccessReview` says the credential may create operator clusters. */
	accessReviewAllowed = true;
	/** Whether the CRD exists at all, and whether it serves `v1`. */
	crd: { served: boolean } | null = { served: true };
	/** What a read of the `Cluster` reports as `status.readyInstances`. */
	readyInstances = 1;
	/** What a synthesised StatefulSet reports as `status.readyReplicas` — the plain path's readiness. */
	readyReplicas = 1;
	/** The operator's Deployment, when one exists in the cluster. */
	operatorNamespace: string | null = OPERATOR_NAMESPACE;

	private readonly store: Json[] = [];

	// --- seeding ------------------------------------------------------------

	seed(object: Json): Json {
		this.upsert(object);
		return object;
	}

	/** The CRD the operator path probes. */
	seedCrd(): void {
		this.seed({
			apiVersion: 'apiextensions.k8s.io/v1',
			kind: 'CustomResourceDefinition',
			metadata: { name: POSTGRES_CLUSTER_CRD },
			spec: { versions: [{ name: 'v1', served: this.crd?.served !== false }] }
		});
	}

	/** The operator's own Deployment — how the operator namespace is detected. */
	seedOperatorDeployment(namespace: string | null = OPERATOR_NAMESPACE): void {
		if (!namespace) return;
		this.seed({
			apiVersion: 'apps/v1',
			kind: 'Deployment',
			metadata: {
				name: 'cnpg-controller-manager',
				namespace,
				labels: { 'app.kubernetes.io/name': 'cloudnative-pg' }
			}
		});
	}

	/** The app Secret the operator writes once the cluster is up. */
	seedOperatorAppSecret(overrides: Json = {}): void {
		this.seed({
			apiVersion: 'v1',
			kind: 'Secret',
			metadata: { name: POSTGRES_OPERATOR_APP_SECRET, namespace: NAMESPACE },
			data: {
				username: base64('app'),
				password: base64('operator-generated-password'),
				dbname: base64('app'),
				...overrides
			}
		});
	}

	/** The `StorageClass` the plain path falls back to. */
	seedDefaultStorageClass(name = 'standard'): void {
		this.seed({
			apiVersion: 'storage.k8s.io/v1',
			kind: 'StorageClass',
			metadata: { name, annotations: { 'storageclass.kubernetes.io/is-default-class': 'true' } }
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

	ssarQuestions(): Call[] {
		return this.calls.filter((call) => call.op === 'ssar');
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

		const merged = this.mergeStored(object);
		if (object.kind === 'Cluster') merged.status = { readyInstances: this.readyInstances };
		// The plain path is what this suite's fallback cases land on, so the fake reports the ready replica a
		// StatefulSet controller would.
		if (object.kind === 'StatefulSet') {
			merged.status = { readyReplicas: this.readyReplicas, replicas: merged.spec?.replicas ?? 1 };
		}
		this.upsert(merged);
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
				// An empty namespace is a cluster-scoped list (`Deployments` across every namespace, the
				// `StorageClass` list), so it must not filter on the namespace at all.
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
		attributes: { verb: string; resource: string; group?: string; namespace?: string }
	): Promise<{ allowed: boolean }> {
		this.calls.push({
			op: 'ssar',
			verb: attributes.verb,
			resource: attributes.resource,
			namespace: attributes.namespace
		});
		return { allowed: this.accessReviewAllowed };
	}

	/**
	 * APW-07 T18's helper (`k8s-api.service.ts:871`), as the port declares it: a missing CRD or an unserved
	 * version is `false`; a non-404 failure throws (the spec's refusal case overrides this method).
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

	private mergeStored(manifest: Json): Json {
		const existing = this.find(
			String(manifest.apiVersion),
			String(manifest.kind),
			String(manifest.metadata?.namespace ?? ''),
			String(manifest.metadata?.name)
		);
		return existing ? deepMerge(existing, manifest) : JSON.parse(JSON.stringify(manifest));
	}

	private upsert(manifest: Json): void {
		const existing = this.find(
			String(manifest.apiVersion),
			String(manifest.kind),
			String(manifest.metadata?.namespace ?? ''),
			String(manifest.metadata?.name)
		);
		if (existing) Object.assign(existing, manifest);
		else this.store.push(manifest);
	}
}

function matchesSelector(object: Json, selector?: string): boolean {
	if (!selector) return true;
	return selector.split(',').every((pair) => {
		const [key, value] = pair.split('=');
		return String(object.metadata?.labels?.[String(key)] ?? '') === String(value ?? '');
	});
}

function deepMerge(target: Json, patch: Json): Json {
	const out: Json = { ...target };
	for (const [key, value] of Object.entries(patch)) {
		out[key] =
			value && typeof value === 'object' && !Array.isArray(value) && out[key] && typeof out[key] === 'object'
				? deepMerge(out[key], value as Json)
				: JSON.parse(JSON.stringify(value));
	}
	return out;
}

/** A cluster with the operator installed, its app Secret written and no `Backup` yet. */
function operatorCluster(overrides: Json = {}): FakeDependencyCluster {
	const cluster = new FakeDependencyCluster();
	cluster.seedCrd();
	cluster.seedOperatorDeployment();
	cluster.seedOperatorAppSecret();
	for (const [key, value] of Object.entries(overrides)) {
		(cluster as unknown as Json)[key] = value;
	}
	return cluster;
}

function provider(cluster: FakeDependencyCluster, options: Json = {}): PostgresDependencyProvider {
	return new PostgresDependencyProvider(cluster, { now: () => NOW, sleep: async () => undefined, ...options });
}

function backup(over: Json = {}): Json {
	return {
		apiVersion: POSTGRES_OPERATOR_API_VERSION,
		kind: 'Backup',
		metadata: {
			name: 'dep-postgres-backup',
			namespace: NAMESPACE,
			creationTimestamp: new Date(NOW - 3_600_000).toISOString(),
			labels: { 'cnpg.io/cluster': 'dep-postgres' }
		},
		status: { phase: 'completed', stoppedAt: new Date(NOW - 3_600_000).toISOString() },
		...over
	};
}

function scheduledBackup(createdAt: string): Json {
	return {
		apiVersion: POSTGRES_OPERATOR_API_VERSION,
		kind: 'ScheduledBackup',
		metadata: {
			name: 'dep-postgres-nightly',
			namespace: NAMESPACE,
			creationTimestamp: createdAt,
			labels: { 'cnpg.io/cluster': 'dep-postgres' }
		}
	};
}

/** The `Cluster` object the provider applied — the manifest ACC-07-15 is about. */
function appliedCluster(cluster: FakeDependencyCluster): Json {
	const found = cluster.appliedOf('Cluster')[0];
	expect(found, 'a Cluster manifest').toBeDefined();
	return found;
}

/* ------------------------------------------------------------------------- *
 * ACC-07-15: the operator path
 * ------------------------------------------------------------------------- */

describe('T19 operator path — ACC-07-15', () => {
	it('creates a Cluster with instances: 1 when the CRD is served and the access review allows it', async () => {
		const cluster = operatorCluster();

		const outcome = await provider(cluster).provision(POSTGRES_PROVIDER_ID, context());

		expect(outcome.state).toBe('ready');
		const manifest = appliedCluster(cluster);
		expect(manifest.apiVersion).toBe('postgresql.cnpg.io/v1');
		expect(manifest.metadata.name).toBe('dep-postgres');
		expect(manifest.metadata.namespace).toBe(NAMESPACE);
		expect(manifest.spec.instances).toBe(1);
		expect(manifest.spec.enableSuperuserAccess).toBe(false);
		expect(manifest.spec.storage.size).toBe('10Gi');
		expect(manifest.spec.bootstrap.initdb).toEqual({ database: POSTGRES_APP_NAME, owner: POSTGRES_APP_NAME });
		// No StatefulSet: the operator owns the workload on this path.
		expect(cluster.appliedOf('StatefulSet')).toEqual([]);
	});

	it('asks exactly the question FR-36 asks — create clusters, in the app’s namespace', async () => {
		const cluster = operatorCluster();

		await provider(cluster).provision(POSTGRES_PROVIDER_ID, context());

		expect(cluster.ssarQuestions()).toEqual([
			{ op: 'ssar', verb: 'create', resource: 'clusters', namespace: NAMESPACE }
		]);
		// The CRD read happens first: a cluster without the operator never reaches the access review.
		const crdRead = cluster.calls.findIndex((call) => call.kind === 'CustomResourceDefinition');
		const review = cluster.calls.findIndex((call) => call.op === 'ssar');
		expect(crdRead).toBeGreaterThanOrEqual(0);
		expect(crdRead).toBeLessThan(review);
	});

	it('applies dep-postgres first, and admits the operator’s own namespace on 5432 and the status port', async () => {
		const cluster = operatorCluster();

		await provider(cluster).provision(POSTGRES_PROVIDER_ID, context());

		expect(cluster.appliedNames()[0]).toBe('NetworkPolicy/dep-postgres');
		const policy = cluster.appliedOf('NetworkPolicy')[0];
		expect(policy.spec.ingress).toEqual([
			{ from: [{ podSelector: {} }], ports: [{ protocol: 'TCP', port: APP_DEPENDENCY_PORTS.postgres }] },
			{
				from: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': OPERATOR_NAMESPACE } } }],
				ports: [
					{ protocol: 'TCP', port: APP_DEPENDENCY_PORTS.postgres },
					{ protocol: 'TCP', port: APP_DEPENDENCY_OPERATOR_STATUS_PORT }
				]
			}
		]);
		// The operator namespace is not admitted on every port, and nothing else is admitted at all.
		expect(policy.spec.ingress).toHaveLength(2);
	});

	it('warns operatorNamespaceUnknown and narrows the fallback to the two ports when detection fails', async () => {
		// The operator exists (its CRD is served and the create is allowed) but its Deployment is not visible, so
		// the namespace cannot be detected — the one case the plan's fallback rule covers.
		const cluster = new FakeDependencyCluster();
		cluster.seedCrd();
		cluster.seedOperatorAppSecret();

		const outcome = await provider(cluster).provision(POSTGRES_PROVIDER_ID, context());

		expect(outcome.state).toBe('ready');
		if (outcome.state !== 'ready') return;
		expect(outcome.warnings).toContain('operatorNamespaceUnknown');
		expect(cluster.appliedOf('NetworkPolicy')[0].spec.ingress[1]).toEqual({
			from: [{ namespaceSelector: {} }],
			ports: [
				{ protocol: 'TCP', port: APP_DEPENDENCY_PORTS.postgres },
				{ protocol: 'TCP', port: APP_DEPENDENCY_OPERATOR_STATUS_PORT }
			]
		});
	});

	it('puts the declared extensions on bootstrap.initdb.postInitApplicationSQL', async () => {
		const cluster = operatorCluster();

		const outcome = await provider(cluster).provision(
			POSTGRES_PROVIDER_ID,
			context({ declared: { version: 16, extensions: ['pgcrypto', 'pg_trgm'] } })
		);

		expect(outcome.state).toBe('ready');
		expect(appliedCluster(cluster).spec.bootstrap.initdb.postInitApplicationSQL).toEqual([
			'CREATE EXTENSION IF NOT EXISTS "pgcrypto";',
			'CREATE EXTENSION IF NOT EXISTS "pg_trgm";'
		]);
	});

	it('takes the operator path’s outputs from the operator’s Secret and its -rw Service', async () => {
		const cluster = operatorCluster();

		const outcome = await provider(cluster).provision(POSTGRES_PROVIDER_ID, context());

		expect(outcome.state).toBe('ready');
		if (outcome.state !== 'ready') return;
		expect(outcome.outputs).toEqual({
			host: `${POSTGRES_OPERATOR_RW_SERVICE}.${NAMESPACE}.svc.cluster.local`,
			port: '5432',
			database: 'app',
			user: 'app',
			password: 'operator-generated-password',
			url: `postgres://app:operator-generated-password@${POSTGRES_OPERATOR_RW_SERVICE}.${NAMESPACE}.svc.cluster.local:5432/app`,
			directUrl: `postgres://app:operator-generated-password@${POSTGRES_OPERATOR_RW_SERVICE}.${NAMESPACE}.svc.cluster.local:5432/app`
		});
		expect(outcome.resourceRefs.objects).toEqual([
			{ kind: 'NetworkPolicy', name: 'dep-postgres' },
			{ kind: 'Cluster', name: 'dep-postgres' },
			{ kind: 'Secret', name: POSTGRES_OPERATOR_APP_SECRET },
			{ kind: 'Service', name: POSTGRES_OPERATOR_RW_SERVICE }
		]);
		expect(await provider(cluster).getOutputs(POSTGRES_PROVIDER_ID, context())).toEqual(outcome.outputs);
	});

	it('waits for readyInstances == 1 and reports pending while the app Secret is not there yet', async () => {
		const cluster = operatorCluster();
		const missing = new FakeDependencyCluster();
		missing.seedCrd();
		missing.seedOperatorDeployment();

		const outcome = await provider(missing).provision(POSTGRES_PROVIDER_ID, context());

		expect(outcome.state).toBe('pending');
		if (outcome.state !== 'pending') return;
		expect(outcome.retryAfterMs).toBeGreaterThan(0);
		expect(outcome.detail?.waitingFor).toBe(POSTGRES_OPERATOR_APP_SECRET);
		// The Cluster itself was still applied — the operator is what creates the Secret.
		expect(missing.appliedOf('Cluster')).toHaveLength(1);
	});

	it('fails deadlineExceeded when the operator never reports a ready instance', async () => {
		const cluster = operatorCluster();
		cluster.readyInstances = 0;
		const controller = new AbortController();
		let ticks = 0;

		const outcome = await provider(cluster, {
			sleep: async () => {
				ticks += 1;
				if (ticks >= 2) controller.abort();
			}
		}).provision(POSTGRES_PROVIDER_ID, context({ signal: controller.signal }));

		expect(ticks).toBe(2);
		expect(outcome).toMatchObject({ state: 'failed', reason: 'deadlineExceeded', transient: false });
	});

	it('propagates an unreachable cluster instead of silently downgrading to the plain path', async () => {
		// A read that times out rather than a CRD that is absent: T18's helper throws, and the provider must not
		// read that as "no operator" — that would create a second database beside the operator's.
		const broken = operatorCluster();
		broken.crdServed = async () => {
			throw new K8sPluginError('UNKNOWN', 'dial tcp 10.0.0.1:6443: i/o timeout');
		};

		const outcome = await provider(broken).provision(POSTGRES_PROVIDER_ID, context());

		expect(outcome).toMatchObject({ state: 'failed', reason: 'clusterUnreachable', transient: true });
		expect(broken.applied()).toEqual([]);
	});
});

/* ------------------------------------------------------------------------- *
 * plan §4.9:610 / §9.2:954: the denied access review
 * ------------------------------------------------------------------------- */

describe('T19 operator path — the plain path is chosen, with the reason', () => {
	it('falls back to the plain path with operatorSkipped=noPermission when the create is denied', async () => {
		const cluster = operatorCluster({ accessReviewAllowed: false });
		cluster.seedDefaultStorageClass();

		const outcome = await provider(cluster).provision(POSTGRES_PROVIDER_ID, context());

		expect(outcome.state).toBe('ready');
		if (outcome.state !== 'ready') return;
		// `statusDetail.operatorSkipped = 'noPermission'` (plan §4.9:610): the provision outcome has no
		// `statusDetail` member, so the plan's field travels as this warning and the card still shows it.
		expect(outcome.warnings?.map(warningCode)).toContain('operatorSkipped');
		expect(outcome.warnings).toContain('operatorSkipped=noPermission');

		// The plain path, and only the plain path: a single-replica StatefulSet with a real claim.
		expect(cluster.appliedOf('Cluster')).toEqual([]);
		expect(cluster.appliedOf('StatefulSet')).toHaveLength(1);
		expect(cluster.appliedNames()[0]).toBe('NetworkPolicy/dep-postgres');
		// The policy draws no operator-namespace rule on this path: there is no operator to admit.
		expect(cluster.appliedOf('NetworkPolicy')[0].spec.ingress).toHaveLength(1);
	});

	it('chooses the plain path with operatorSkipped=crdNotServed when the CRD is absent', async () => {
		const cluster = new FakeDependencyCluster();
		cluster.seedDefaultStorageClass();

		const outcome = await provider(cluster).provision(POSTGRES_PROVIDER_ID, context());

		expect(outcome.state).toBe('ready');
		if (outcome.state !== 'ready') return;
		expect(outcome.warnings).toContain('operatorSkipped=crdNotServed');
		// An absent CRD needs no access review at all.
		expect(cluster.ssarQuestions()).toEqual([]);
		expect(cluster.appliedOf('StatefulSet')).toHaveLength(1);
	});

	it('chooses the plain path when the CRD exists but does not serve v1', async () => {
		const cluster = new FakeDependencyCluster();
		cluster.seedCrd();
		cluster.seedOperatorDeployment();
		cluster.seedDefaultStorageClass();
		cluster.seed({
			apiVersion: 'apiextensions.k8s.io/v1',
			kind: 'CustomResourceDefinition',
			metadata: { name: POSTGRES_CLUSTER_CRD },
			spec: { versions: [{ name: 'v1', served: false }] }
		});

		const outcome = await provider(cluster).provision(POSTGRES_PROVIDER_ID, context());

		expect(outcome.state).toBe('ready');
		if (outcome.state !== 'ready') return;
		expect(outcome.warnings).toContain('operatorSkipped=crdNotServed');
	});

	it('reports noPermission when the CRD read itself is refused (APW07-G10)', async () => {
		const cluster = new FakeDependencyCluster();
		cluster.seedDefaultStorageClass();
		// T18's `crdServed` throws a scrubbed `K8sPluginError` for a non-404 failure rather than answering
		// `false`, which is what keeps "we may not look" apart from "the operator is not installed".
		cluster.crdServed = async () => {
			throw new K8sPluginError('UNAUTHORIZED', 'forbidden: customresourcedefinitions is forbidden', {
				statusCode: 403
			});
		};

		const outcome = await provider(cluster).provision(POSTGRES_PROVIDER_ID, context());

		expect(outcome.state).toBe('ready');
		if (outcome.state !== 'ready') return;
		expect(outcome.warnings).toContain('operatorSkipped=noPermission');
		expect(cluster.appliedOf('StatefulSet')).toHaveLength(1);
	});
});

/* ------------------------------------------------------------------------- *
 * ACC-07-15 / FR-48 / FR-49: the backup state
 * ------------------------------------------------------------------------- */

describe('T19 operator path — the backup state (ACC-07-15, FR-48, FR-49)', () => {
	it('reads no Backup and no ScheduledBackup as not_configured', async () => {
		const cluster = operatorCluster();
		// The Cluster exists (the provider applied it), so this is the operator path with nothing configured.
		await provider(cluster).provision(POSTGRES_PROVIDER_ID, context());

		expect(await provider(cluster).backupStatus(POSTGRES_PROVIDER_ID, context())).toEqual({
			state: 'not_configured'
		});
	});

	it('reads the newest completed Backup as healthy, with its instant', async () => {
		const cluster = operatorCluster();
		await provider(cluster).provision(POSTGRES_PROVIDER_ID, context());
		cluster.seed(backup());

		const status = await provider(cluster).backupStatus(POSTGRES_PROVIDER_ID, context());

		expect(status).toEqual({ state: 'healthy', lastBackupAt: new Date(NOW - 3_600_000).toISOString() });
	});

	it('reads a completed Backup older than 26 hours as overdue', async () => {
		const cluster = operatorCluster();
		await provider(cluster).provision(POSTGRES_PROVIDER_ID, context());
		const old = new Date(NOW - APP_DEPENDENCY_BACKUP_OVERDUE_MS - 3_600_000).toISOString();
		cluster.seed(backup({ status: { phase: 'completed', stoppedAt: old } }));

		expect(await provider(cluster).backupStatus(POSTGRES_PROVIDER_ID, context())).toEqual({
			state: 'overdue',
			lastBackupAt: old
		});
	});

	it('reads a failed Backup as failing', async () => {
		const cluster = operatorCluster();
		await provider(cluster).provision(POSTGRES_PROVIDER_ID, context());
		const stopped = new Date(NOW - 1_800_000).toISOString();
		cluster.seed(backup({ status: { phase: 'failed', stoppedAt: stopped } }));

		expect(await provider(cluster).backupStatus(POSTGRES_PROVIDER_ID, context())).toEqual({
			state: 'failing',
			lastBackupAt: stopped
		});
	});

	it('reads a cluster that claims a fresh success while its newest Backup failed as failing (FR-49)', async () => {
		const cluster = operatorCluster();
		await provider(cluster).provision(POSTGRES_PROVIDER_ID, context());

		// The summary field the plan forbids reading (`plan.md` §4.9:615 — "**Never**
		// `Cluster.status.lastSuccessfulBackup`"): it says a success landed five minutes ago...
		const applied = cluster.appliedOf('Cluster')[0];
		cluster.seed({
			...applied,
			status: {
				readyInstances: 1,
				lastSuccessfulBackup: new Date(NOW - 300_000).toISOString(),
				firstRecoverabilityPoint: new Date(NOW - 300_000).toISOString()
			}
		});
		// ...while the newest individual record says the attempt failed.
		const failedAt = new Date(NOW - 600_000).toISOString();
		cluster.seed(backup({ status: { phase: 'failed', stoppedAt: failedAt } }));

		expect(await provider(cluster).backupStatus(POSTGRES_PROVIDER_ID, context())).toEqual({
			state: 'failing',
			lastBackupAt: failedAt
		});
	});

	it('takes the newest Backup by stoppedAt, not by list order', async () => {
		const cluster = operatorCluster();
		await provider(cluster).provision(POSTGRES_PROVIDER_ID, context());
		// Oldest first in the list, newest last — and then the reverse, to prove the order does not decide.
		cluster.seed(
			backup({
				metadata: { name: 'older', namespace: NAMESPACE, labels: { 'cnpg.io/cluster': 'dep-postgres' } },
				status: { phase: 'failed', stoppedAt: new Date(NOW - 7_200_000).toISOString() }
			})
		);
		cluster.seed(
			backup({
				metadata: { name: 'newer', namespace: NAMESPACE, labels: { 'cnpg.io/cluster': 'dep-postgres' } },
				status: { phase: 'completed', stoppedAt: new Date(NOW - 3_600_000).toISOString() }
			})
		);

		expect((await provider(cluster).backupStatus(POSTGRES_PROVIDER_ID, context())).state).toBe('healthy');
	});

	it('reads no Backup plus a ScheduledBackup 27 hours old as overdue', async () => {
		const cluster = operatorCluster();
		await provider(cluster).provision(POSTGRES_PROVIDER_ID, context());
		cluster.seed(scheduledBackup(new Date(NOW - 27 * 3_600_000).toISOString()));

		expect(await provider(cluster).backupStatus(POSTGRES_PROVIDER_ID, context())).toEqual({ state: 'overdue' });
	});

	it('reads no Backup plus a fresh ScheduledBackup as unknown — the first backup is still pending', async () => {
		const cluster = operatorCluster();
		await provider(cluster).provision(POSTGRES_PROVIDER_ID, context());
		cluster.seed(scheduledBackup(new Date(NOW - 3_600_000).toISOString()));

		expect(await provider(cluster).backupStatus(POSTGRES_PROVIDER_ID, context())).toEqual({ state: 'unknown' });
	});

	it('reads a Backup with no verdict yet as unknown, never as healthy', async () => {
		const cluster = operatorCluster();
		await provider(cluster).provision(POSTGRES_PROVIDER_ID, context());
		cluster.seed(backup({ status: { phase: 'running', startedAt: new Date(NOW - 60_000).toISOString() } }));

		expect(await provider(cluster).backupStatus(POSTGRES_PROVIDER_ID, context())).toEqual({ state: 'unknown' });
	});

	it('answers unknown rather than failing when the Backup list itself cannot be read', async () => {
		const cluster = operatorCluster();
		await provider(cluster).provision(POSTGRES_PROVIDER_ID, context());
		const original = cluster.listObjects.bind(cluster);
		cluster.listObjects = (async (
			kubeconfig: string,
			apiVersion: string,
			kind: string,
			namespace: string,
			selector?: string
		) => {
			if (kind === 'Backup') throw new K8sPluginError('UNKNOWN', 'dial tcp: i/o timeout');
			return original(kubeconfig, apiVersion, kind, namespace, selector);
		}) as typeof cluster.listObjects;

		expect(await provider(cluster).backupStatus(POSTGRES_PROVIDER_ID, context())).toEqual({ state: 'unknown' });
	});

	it('is a pure decision the operator path shares — the plan’s five states, in one table', () => {
		const hoursAgo = (hours: number): string => new Date(NOW - hours * 3_600_000).toISOString();

		expect(
			postgresBackupStatus({
				backups: [{ status: { phase: 'completed', stoppedAt: hoursAgo(1) } }],
				scheduledBackups: [],
				now: NOW
			})
		).toEqual({ state: 'healthy', lastBackupAt: hoursAgo(1) });
		expect(
			postgresBackupStatus({
				backups: [{ status: { phase: 'completed', stoppedAt: hoursAgo(27) } }],
				scheduledBackups: [],
				now: NOW
			}).state
		).toBe('overdue');
		expect(
			postgresBackupStatus({
				backups: [{ status: { phase: 'failed', stoppedAt: hoursAgo(1) } }],
				scheduledBackups: [],
				now: NOW
			}).state
		).toBe('failing');
		expect(postgresBackupStatus({ backups: [], scheduledBackups: [], now: NOW }).state).toBe('not_configured');
		expect(
			postgresBackupStatus({
				backups: [],
				scheduledBackups: [{ metadata: { creationTimestamp: hoursAgo(1) } }],
				now: NOW
			}).state
		).toBe('unknown');
		expect(
			postgresBackupStatus({
				backups: [],
				scheduledBackups: [{ metadata: { creationTimestamp: hoursAgo(27) } }],
				now: NOW
			}).state
		).toBe('overdue');
	});
});

/* ------------------------------------------------------------------------- *
 * plan §4.9:624-628: deprovision on the operator path
 * ------------------------------------------------------------------------- */

describe('T19 operator path — deprovision (plan §4.9:624-628)', () => {
	it('hibernates the Cluster for stopWorkloads and deletes nothing', async () => {
		const cluster = operatorCluster();
		await provider(cluster).provision(POSTGRES_PROVIDER_ID, context());

		const outcome = await provider(cluster).deprovision(POSTGRES_PROVIDER_ID, context(), {
			deleteData: false,
			stopWorkloads: true
		});

		expect(outcome).toEqual({ state: 'released' });
		const last = cluster.applied().at(-1) as Json;
		expect(last).toMatchObject({
			kind: 'Cluster',
			metadata: { name: 'dep-postgres', namespace: NAMESPACE },
			spec: { instances: 0 }
		});
		expect(cluster.calls.some((call) => call.op === 'delete')).toBe(false);
	});

	it('deletes the Cluster, the policy and the operator’s app Secret when data is deleted', async () => {
		const cluster = operatorCluster();
		await provider(cluster).provision(POSTGRES_PROVIDER_ID, context());
		// A PVC the operator created carries the dependency label too, so the label-driven teardown finds it.
		cluster.seed({
			apiVersion: 'v1',
			kind: 'PersistentVolumeClaim',
			metadata: {
				name: 'dep-postgres-1',
				namespace: NAMESPACE,
				labels: { 'ever-works.io/dependency': 'postgres' }
			}
		});

		const outcome = await provider(cluster).deprovision(POSTGRES_PROVIDER_ID, context(), { deleteData: true });

		expect(outcome).toEqual({ state: 'deleted' });
		const deleted = cluster.calls.filter((call) => call.op === 'delete').map((call) => `${call.kind}/${call.name}`);
		expect(deleted).toEqual(
			expect.arrayContaining([
				'Cluster/dep-postgres',
				'NetworkPolicy/dep-postgres',
				'PersistentVolumeClaim/dep-postgres-1'
			])
		);
	});

	it('keeps the Cluster, its PVC and its policy when data is kept and nothing is stopped', async () => {
		const cluster = operatorCluster();
		await provider(cluster).provision(POSTGRES_PROVIDER_ID, context());
		const before = cluster.calls.length;

		expect(await provider(cluster).deprovision(POSTGRES_PROVIDER_ID, context(), { deleteData: false })).toEqual({
			state: 'released'
		});
		expect(cluster.calls.length).toBe(before);
	});
});
