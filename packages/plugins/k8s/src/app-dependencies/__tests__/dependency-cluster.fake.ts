/**
 * The fake cluster the APW-07 T20/T21 specs share (the same five-method `AppDependencyApi` port T19's two
 * specs implement inline, lifted into one module because three suites now need it).
 *
 * **No network, ever.** Objects live in an in-memory store with Server-Side-Apply merge semantics, and the
 * status a real controller would report is synthesised on apply: a `StatefulSet`/`Deployment` gets
 * `status.readyReplicas` and each of its `volumeClaimTemplates` becomes a `PersistentVolumeClaim` carrying
 * the claim's own labels (which is what lets the teardown's label scan — and the "the PVC is deleted
 * explicitly" assertions — see the volume at all), and a `Job` gets whatever `jobStatus` says.
 *
 * The provider's clock, its only wait and its poll interval are all injected by each spec, so "not ready
 * yet" costs one loop rather than five or ten minutes of wall time.
 */
import type { AppDependencyApi } from '../common.js';
import { APP_STORAGE_CLASS_DEFAULT_ANNOTATIONS } from '../../app/app-cluster-check.js';

export type Json = Record<string, any>;

export interface Call {
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

export class FakeDependencyCluster implements AppDependencyApi {
	readonly calls: Call[] = [];
	/** `Kind/name` or `Kind` → the error an apply throws instead of succeeding. */
	readonly applyFails = new Map<string, Error>();
	/** What a synthesised StatefulSet/Deployment reports as `status.readyReplicas`. */
	readyReplicas = 1;
	/**
	 * What a synthesised Job reports. `{ succeeded: 1 }` by default — the init Job's happy path.
	 *
	 * Both fields are read on **every** `readObject` rather than baked in at apply time, so a spec can let
	 * the controller catch up mid-provision (`sleep` sets `readyReplicas = 1`, `jobStatus = { succeeded: 1 }`)
	 * — which is the only way "not ready yet, then ready" can be expressed without a second apply.
	 */
	jobStatus: Json = { succeeded: 1 };
	/** What one `SelfSubjectAccessReview` answers. */
	accessReviewAllowed = false;

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

	/** The CloudNativePG `Cluster` CRD, served at `v1` — the operator path's precondition. */
	seedCrd(name = 'clusters.postgresql.cnpg.io', version = 'v1'): void {
		this.seed({
			apiVersion: 'apiextensions.k8s.io/v1',
			kind: 'CustomResourceDefinition',
			metadata: { name },
			spec: { versions: [{ name: version, served: true }] }
		});
	}

	/** The operator's own Deployment, which is how its namespace is detected. */
	seedOperatorDeployment(namespace = 'cnpg-system'): void {
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

	/** Every call of one operation, in order — how "the re-list happened after the delete" is asserted. */
	ops(op: Call['op']): Call[] {
		return this.calls.filter((call) => call.op === op);
	}

	/** What the store currently holds for one kind, for the "the PVC survived" assertions. */
	stored(kind: string): Json[] {
		return this.store.filter((object) => object.kind === kind);
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
		const found = this.find(apiVersion, kind, namespace, name);
		if (found) this.synthesiseStatus(found);
		return (found ?? null) as T | null;
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
				// An empty namespace is a cluster-scoped list (the `StorageClass` list, the operator
				// Deployment lookup), so it must not filter on the namespace at all.
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
	 * version is `false`, and a caller that may not look at all is a thrown error.
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

		this.synthesiseStatus(merged);

		if (manifest.kind === 'StatefulSet') {
			// A claim template is not an object of its own until the controller creates it; the labels the
			// template carries are the labels the PVC gets, which is what the teardown's scan looks for.
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
					status: { phase: 'Bound' }
				});
			}
		}

		if (existing) Object.assign(existing, merged);
		else this.store.push(merged);
	}

	/**
	 * The status a controller would report, from the current flags — read on every apply **and** every
	 * read, so a spec that lets the controller catch up mid-provision is exercising the provider's poll loop
	 * rather than the fake's bookkeeping.
	 */
	private synthesiseStatus(object: Json): void {
		if (object.kind === 'StatefulSet' || object.kind === 'Deployment') {
			object.status = { readyReplicas: this.readyReplicas, replicas: object.spec?.replicas ?? 1 };
		}
		if (object.kind === 'Job') {
			object.status = { ...this.jobStatus };
		}
	}
}

/** `a=1,b=2` — the subset of a label selector this suite needs. */
export function matchesSelector(object: Json, selector?: string): boolean {
	if (!selector) return true;
	return selector.split(',').every((pair) => {
		const [key, value] = pair.split('=');
		return String(object.metadata?.labels?.[String(key)] ?? '') === String(value ?? '');
	});
}

export function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

/** A shallow-but-recursive merge — enough for a Server-Side Apply of a partial object. */
export function deepMerge(target: Json, patch: Json): Json {
	const out: Json = { ...target };
	for (const [key, value] of Object.entries(patch)) {
		out[key] =
			value && typeof value === 'object' && !Array.isArray(value) && out[key] && typeof out[key] === 'object'
				? deepMerge(out[key], value as Json)
				: clone(value);
	}
	return out;
}
