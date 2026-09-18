/**
 * APW-07 T21 — `k8s-inline-minio`: object storage on the owner's own cluster.
 *
 * Sources, in priority order:
 *
 * 1. `docs/specs/features/app-works/APW-07-app-env-and-dependencies/plan.md` §4.9:618 (the
 *    `k8s-inline-minio` row of the provider table), §4.9:575-580 (the labels and security contexts every
 *    in-cluster provider shares), §4.9:582-602 (reachability, rewritten 2026-09-17 by APW07-G01),
 *    §4.9:604-611 (the cluster permissions) and §4.9:620-628 (outputs, the ephemeral variant and
 *    deprovision with `deleteData` / `stopWorkloads`).
 * 2. `tasks.md:318-328` (T21) — the StatefulSet with a 20 GiB claim, the init Job that creates **every**
 *    declared bucket, readiness only once that Job succeeded inside 10 minutes (ACC-07-16), anonymous
 *    download only on `publicBuckets`, the service-account keys in `dep-s3-app`, the outputs, and
 *    `dep-s3` applied before the init Job and the StatefulSet (APW07-G01).
 * 3. `spec.md` FR-36 ("object storage → a single-replica S3-compatible server with a volume"), FR-37
 *    (object storage's volume default is 20 GiB), FR-38 (reachable only from the App Work's own pods),
 *    FR-40 (`endpoint`, `region`, `accessKeyId`, `secretAccessKey`, `bucket.<name>`), FR-41 (the
 *    10-minute object-storage deadline), FR-43, FR-47 (credentials are never rotated implicitly),
 *    FR-48 (backup state `none`) and ACC-07-16.
 *
 * ## The object kind is `s3`, not `objectStorage`
 *
 * The plan names every object of this row `dep-s3…` (`plan.md` §4.9:618; `tasks.md:323-324` pins the
 * policy name `dep-s3`), so {@link OBJECT_STORAGE_OBJECT_KIND} is `s3` while the **dependency kind** is
 * `objectStorage`. That is the same split `postgres.provider.ts` records with its `POSTGRES_OBJECT_KIND`:
 * the object name is a cluster identifier, the kind is the contract's. Every name, the pod selector and
 * the `ever-works.io/dependency` label therefore carry `s3`, so the teardown label scan and the policy's
 * `podSelector` agree on one string.
 *
 * ## Every declared bucket is created, or the Job does not succeed
 *
 * FR-40's `bucket.<name>` outputs promise one bucket per declaration, and ACC-07-16 is "object storage
 * ready within 10 minutes **with every declared bucket**". The Job is therefore rendered from the full
 * validated list — one `mc mb` target per bucket — and readiness is `StatefulSet ready **and** Job
 * succeeded`, never merely "the server answered". A declaration the provider cannot honour (a name that
 * is not an App-spec `name`) is reported in `warnings`, never dropped quietly.
 *
 * ## Anonymous download only where the App spec says so
 *
 * `publicBuckets` gets one `mc anonymous set download` per bucket and nothing else does. The list is
 * intersected with `buckets` first, so a public name the App spec did not declare cannot open a bucket
 * that does not exist — and it is reported as `publicBucketUndeclared=<name>` rather than ignored.
 *
 * ## Two credentials, and only one of them leaves the namespace
 *
 * `dep-s3` holds the root user and password the server runs with; `dep-s3-app` holds the service
 * account's keys, and those are the outputs (FR-40). **This provider writes both** — the service
 * account's pair is generated here and registered with the server by the init Job — so the Job never
 * needs permission to write a Secret in the App Work's namespace, which is a cluster permission this
 * epic deliberately does not ask for (plan §4.9:604-611 lists only `statefulsets` as required).
 */
import { randomBytes } from 'node:crypto';

import type {
	AppDependencyBackupStatus,
	AppDependencyContext,
	AppDependencyDeprovisionOptions,
	AppDependencyDeprovisionOutcome,
	AppDependencyKind,
	AppDependencyProviderDescriptor,
	AppDependencyProvisionOutcome,
	AppDependencySupport,
	AppDependencyTarget
} from '@ever-works/plugin';

import { APP_DEPENDENCY_POLICY_LABEL } from '../app/app-network-policy.renderer.js';
import {
	APP_DEPENDENCY_PORTS,
	APP_DEPENDENCY_TEARDOWN_KINDS,
	dependencyContainerSecurityContext,
	dependencyLabels,
	dependencyName,
	dependencyPodSecurityContext,
	dependencyPodSelector,
	dependencyPvcLabels,
	dependencyResourceRefs,
	dependencySizeGiB,
	gibQuantity,
	isForbidden,
	planDependencyNetworkPolicy,
	type AppDependencyApi,
	type AppDependencyObjectRef,
	type AppDependencyRenderedObject
} from './common.js';
import { objectStorageClientImageFor, objectStorageImageFor } from './images.js';

/* ------------------------------------------------------------------------- *
 * Constants
 * ------------------------------------------------------------------------- */

/** The provider id — `APP_DEPENDENCY_PROVIDER_IDS[2]`, and what the owner's explicit choice names. */
export const OBJECT_STORAGE_PROVIDER_ID = 'k8s-inline-minio';

/** The kind this provider serves. */
export const OBJECT_STORAGE_PROVIDER_KIND: AppDependencyKind = 'objectStorage';

/**
 * The **object** kind: `dep-s3`, `dep-s3-app`, `dep-s3-init` (plan §4.9:618, `tasks.md:323-324`).
 *
 * Deliberately not `objectStorage`: the plan names every object of this row `s3`, and the NetworkPolicy
 * the reachability check looks for is `dep-s3`.
 */
export const OBJECT_STORAGE_OBJECT_KIND = 's3';

/** The port object storage is reached on — the last of the plan's three service ports (plan §4.9:588). */
export const OBJECT_STORAGE_PORT = APP_DEPENDENCY_PORTS.objectStorage;

/** The one region this provider reports (plan §4.9:618). */
export const OBJECT_STORAGE_REGION = 'us-east-1';

/**
 * The server's root user — a fixed, non-secret name, never a value the App spec or a caller can set.
 *
 * MinIO validates credentials with `IsAccessKeyValid` (3–20 characters) and `IsSecretKeyValid` (8–40), so
 * this name and every generated value below stay inside those bounds: the access key is 20 hex
 * characters and the secret keys are 40, both at the documented ceiling and never past it.
 */
export const OBJECT_STORAGE_ROOT_USER = 'ever-works';

/** The `dep-s3` keys, and the `dep-s3-app` keys — the latter are FR-40's output names. */
export const OBJECT_STORAGE_SECRET_KEYS = {
	rootUser: 'rootUser',
	rootPassword: 'rootPassword',
	accessKeyId: 'accessKeyId',
	secretAccessKey: 'secretAccessKey'
} as const;

/** The root password's length — 16 random bytes, hex (32 characters, inside MinIO's 8–40). */
export const OBJECT_STORAGE_ROOT_PASSWORD_BYTES = 16;

/** The service account's access key id — 10 random bytes, hex, uppercased (20 characters, MinIO's maximum). */
export const OBJECT_STORAGE_ACCESS_KEY_BYTES = 10;

/** The service account's secret — 20 random bytes, hex (40 characters, MinIO's maximum). */
export const OBJECT_STORAGE_SECRET_KEY_BYTES = 20;

/** The App spec's own cap on `objectStorage.buckets` (`APW-03/schema.md:225`). */
export const OBJECT_STORAGE_MAX_BUCKETS = 10;

/**
 * A bucket name this provider will create — **the App spec's `name` shape**, not a second rule
 * (`APW-03/schema.md:225` + the schema's `$defs.name`: 1–32 characters, `^[a-z]([-a-z0-9]{0,30}[a-z0-9])?$`).
 *
 * Reusing the App spec's rule is what makes "every declared bucket" achievable: a name the schema
 * accepts is a name `mc` accepts, so the intersection is never empty for a valid App spec, and a name
 * that fails here is a declaration this provider could not have honoured — reported, not skipped.
 */
export const S3_BUCKET_NAME_PATTERN = /^[a-z](?:[-a-z0-9]{0,30}[a-z0-9])?$/;

/** The uid/gid/fsGroup the S3-compatible server image runs as (its own built-in non-root user). */
export const OBJECT_STORAGE_UID = 1000;

/** The mount path the server is started with. */
export const OBJECT_STORAGE_DATA_PATH = '/data';

/** The volume name of the data directory. */
export const OBJECT_STORAGE_VOLUME_NAME = 'data';

/** The server's own readiness endpoint — no client binary is needed to ask it (quay.io/minio/minio). */
export const OBJECT_STORAGE_READINESS_PATH = '/minio/health/ready';

/**
 * Where the `mc` containers keep their config.
 *
 * `mc` writes `$HOME/.mc/config.json` on every invocation even when the alias arrives through `MC_HOST_*`,
 * and these containers run as a non-root uid (`runAsNonRoot: true` is not optional — plan §4.9:578), for
 * which the image's default `HOME` may not be writable. `/tmp` is world-writable in the image, so pointing
 * `HOME` at it is what keeps a correct manifest from failing at run time for a reason the manifest could
 * have prevented.
 */
export const OBJECT_STORAGE_MC_HOME = '/tmp';

/** The `mc` alias the init Job's commands address the server through (via the `MC_HOST_local` env var). */
export const OBJECT_STORAGE_ALIAS = 'local';

/** The built-in MinIO policy the service account is attached to — read and write, never `diagnostics`. */
export const OBJECT_STORAGE_APP_POLICY = 'readwrite';

/** The object names, all `dep-<kind>…` per plan §4.9:573 / §4.9:618. */
export const OBJECT_STORAGE_OBJECT_NAMES = {
	secret: dependencyName(OBJECT_STORAGE_OBJECT_KIND),
	appSecret: `${dependencyName(OBJECT_STORAGE_OBJECT_KIND)}-app`,
	service: dependencyName(OBJECT_STORAGE_OBJECT_KIND),
	statefulSet: dependencyName(OBJECT_STORAGE_OBJECT_KIND),
	initJob: `${dependencyName(OBJECT_STORAGE_OBJECT_KIND)}-init`
} as const;

/** The container names inside the init Job, in the order Kubernetes runs them. */
export const OBJECT_STORAGE_JOB_CONTAINERS = {
	buckets: 'buckets',
	serviceAccount: 'service-account',
	policy: 'policy'
} as const;

/** How often a readiness wait re-reads the cluster. */
export const OBJECT_STORAGE_READY_POLL_MS = 5_000;

/**
 * The most observations one readiness wait makes before answering `pending`.
 *
 * An hour at the default poll interval — far past FR-41's ten-minute deadline for this kind, which
 * reaches the provider as `ctx.signal`'s abort. The same runaway guard the other two providers carry.
 */
export const OBJECT_STORAGE_READY_MAX_POLLS = 720;

/** How long a `deleteData` teardown keeps re-listing (plan §4.9:628 — "≤ 5 minutes"). */
export const OBJECT_STORAGE_TEARDOWN_TIMEOUT_MS = 300_000;

/**
 * The descriptor the plugin publishes for this provider (plan §4.7:471-479, §4.8:544-546).
 *
 * `preference: 10` is the plan's number for every `k8s-inline-*` provider, which is what puts an
 * in-cluster server ahead of `s3-external`'s 20. `backupPolicy: 'none'` is the plan's backup column for
 * this row (plan §4.9:618) and FR-48's single-replica in-cluster answer; `label` is the card's provider
 * line, verbatim from the normative copy table (`spec.md:525`).
 */
export const OBJECT_STORAGE_PROVIDER_DESCRIPTOR: AppDependencyProviderDescriptor = {
	id: OBJECT_STORAGE_PROVIDER_ID,
	kind: OBJECT_STORAGE_PROVIDER_KIND,
	targets: ['your-cluster'],
	label: 'In your cluster · single instance',
	preference: 10,
	backupPolicy: 'none'
};

/* ------------------------------------------------------------------------- *
 * What a call needs that the contract does not fix
 * ------------------------------------------------------------------------- */

/** Everything a provider call needs beyond the contract's context. */
export interface ObjectStorageProviderOptions {
	/** Epoch milliseconds. Defaults to `Date.now`; the specs inject a virtual clock. */
	now?: () => number;
	/** The only way this provider waits. Defaults to `setTimeout`; the specs inject a virtual clock. */
	sleep?: (millis: number) => Promise<void>;
	/** The readiness poll interval. Defaults to {@link OBJECT_STORAGE_READY_POLL_MS}. */
	pollIntervalMs?: number;
	/**
	 * An optional **local** readiness bound, in ms. Unset by default: FR-41's ten-minute deadline for this
	 * kind belongs to the contract's `APP_DEPENDENCY_READY_DEADLINE_MS` and arrives as `ctx.signal`'s
	 * abort, so a second copy of the number here would be a second source of truth for one deadline.
	 */
	readyTimeoutMs?: number;
	/** How many observations a readiness wait makes before answering `pending` (`READY_MAX_POLLS`). */
	maxPolls?: number;
	/** The `deleteData` teardown budget. Defaults to {@link OBJECT_STORAGE_TEARDOWN_TIMEOUT_MS}. */
	teardownTimeoutMs?: number;
}

/** The cluster half of a context, once it is known to be present. */
export interface ObjectStorageDependencyCluster {
	kubeconfig: string;
	context?: string;
	namespace: string;
	workSlug: string;
}

/** The values one provisioning attempt renders from. */
export interface ObjectStorageProvisionInput {
	sizeGiB: number;
	/** Every bucket the Job creates, in the App spec's order, deduplicated and validated. */
	buckets: string[];
	/** The subset of {@link buckets} that gets anonymous download, in the App spec's order. */
	publicBuckets: string[];
	warnings: string[];
	ephemeral: boolean;
}

/** The service account's keys, as the init Job registers them and the outputs publish them. */
export interface ObjectStorageAppCredentials {
	accessKeyId: string;
	secretAccessKey: string;
}

/* ------------------------------------------------------------------------- *
 * The provider
 * ------------------------------------------------------------------------- */

/**
 * `k8s-inline-minio` — one instance per plugin, stateless between calls: every fact a call needs is read
 * from the cluster or passed in, so a retry is a fresh attempt rather than a resumed one.
 */
export class ObjectStorageDependencyProvider {
	constructor(
		private readonly api: AppDependencyApi,
		private readonly options: ObjectStorageProviderOptions = {}
	) {}

	/** The descriptor the plugin publishes. A method, so the plugin never restates the object. */
	descriptor(): AppDependencyProviderDescriptor {
		return OBJECT_STORAGE_PROVIDER_DESCRIPTOR;
	}

	/**
	 * Does this provider serve `(kind, target)`?
	 *
	 * The answer depends on the pair alone — whether the cluster can actually take the dependency is
	 * `provision`'s answer, with its own reason. `s3-external` is the other provider for this kind, and it
	 * is offered for the same target at `preference` 20 (plan §4.8:545), so an in-cluster server is what
	 * the owner gets unless they choose otherwise.
	 */
	async supports(kind: AppDependencyKind, target: AppDependencyTarget): Promise<AppDependencySupport> {
		if (kind === OBJECT_STORAGE_PROVIDER_KIND && target === 'your-cluster') {
			return { supported: true, providerId: OBJECT_STORAGE_PROVIDER_ID };
		}
		return { supported: false, reason: 'providerNotSupported' };
	}

	/**
	 * Create (or re-observe) the App Work's object storage.
	 *
	 * The order is the plan's: policy, then both Secrets, then the Service, then the server, then the init
	 * Job — `dep-s3` **before** the init Job and the StatefulSet it protects (APW07-G01), so the bucket
	 * Job's own traffic is already governed by the same-namespace rule when it runs.
	 */
	async provision(providerId: string, ctx: AppDependencyContext): Promise<AppDependencyProvisionOutcome> {
		if (providerId !== OBJECT_STORAGE_PROVIDER_ID) {
			return { state: 'failed', reason: 'providerNotSupported', transient: false, detail: { providerId } };
		}

		const cluster = requireCluster(ctx);
		if (!cluster) {
			// The job builds `ctx.cluster` from APW-06's `prepareDependencyTarget`, so an absent one is an
			// upstream target failure this provider cannot fix; the retryable reason is the honest answer.
			return {
				state: 'failed',
				reason: 'clusterUnreachable',
				transient: true,
				detail: { target: String(ctx?.target ?? '') }
			};
		}

		const warnings: string[] = [];
		const buckets = declaredBuckets(ctx, warnings);
		const input: ObjectStorageProvisionInput = {
			sizeGiB: dependencySizeGiB('objectStorage', ctx?.settings, ctx?.sizeGiB),
			buckets,
			publicBuckets: declaredPublicBuckets(ctx, buckets, warnings),
			warnings,
			ephemeral: ctx?.ephemeral === true
		};
		if (input.buckets.length === 0) warnings.push('noBucketsDeclared');
		if (input.ephemeral) warnings.push('ephemeralNoPersistence');

		// The policy goes first — always, and whatever the App Work's isolation setting is (APW07-G01).
		try {
			await this.api.applyObject(
				cluster.kubeconfig,
				planDependencyNetworkPolicy({
					kind: OBJECT_STORAGE_OBJECT_KIND,
					namespace: cluster.namespace,
					workId: String(ctx?.workId ?? ''),
					workSlug: cluster.workSlug,
					port: OBJECT_STORAGE_PORT
				}).policy,
				cluster.context
			);
		} catch (error) {
			return applyFailure(error, 'NetworkPolicy');
		}

		// Both credentials are reused when they exist: re-provisioning must never rotate the root password of
		// a server holding the app's uploads, nor the service account the app is already authenticating with
		// (FR-47 — credentials are never rotated implicitly).
		const rootPassword =
			(await this.readSecretValue(
				cluster,
				OBJECT_STORAGE_OBJECT_NAMES.secret,
				OBJECT_STORAGE_SECRET_KEYS.rootPassword
			)) ?? generateRootPassword();
		const appCredentials = (await this.readAppCredentials(cluster)) ?? generateAppCredentials();

		try {
			await this.api.applyObject(
				cluster.kubeconfig,
				rootSecretManifest(ctx, cluster, rootPassword),
				cluster.context
			);
		} catch (error) {
			return applyFailure(error, 'Secret');
		}

		try {
			await this.api.applyObject(
				cluster.kubeconfig,
				appSecretManifest(ctx, cluster, appCredentials),
				cluster.context
			);
		} catch (error) {
			return applyFailure(error, 'Secret');
		}

		try {
			await this.api.applyObject(cluster.kubeconfig, serviceManifest(ctx, cluster), cluster.context);
		} catch (error) {
			return applyFailure(error, 'Service');
		}

		try {
			await this.api.applyObject(
				cluster.kubeconfig,
				statefulSetManifest(ctx, cluster, input, objectStorageImageFor(ctx?.settings)),
				cluster.context
			);
		} catch (error) {
			// plan §4.9:604-611 / APW07-G10: `statefulsets` is the one *required* permission this epic adds.
			if (isForbidden(error)) {
				return {
					state: 'failed',
					reason: 'clusterPermissionMissing',
					transient: false,
					detail: { resource: 'statefulsets', verb: 'create', namespace: cluster.namespace }
				};
			}
			return transientClusterFailure(error);
		}

		// A Job's pod template is immutable, so a Job that failed can never be re-run by re-applying it.
		// One replacement per provisioning attempt is what makes FR-43's retry mean anything for this
		// dependency; the keys in `dep-s3-app` are never regenerated, so a replacement re-registers the same
		// service account and cannot strand the app with keys the server does not know.
		await this.replaceFailedInitJob(cluster);

		try {
			await this.api.applyObject(
				cluster.kubeconfig,
				bucketInitJobManifest(ctx, cluster, input, objectStorageClientImageFor(ctx?.settings)),
				cluster.context
			);
		} catch (error) {
			if (isForbidden(error)) {
				return {
					state: 'failed',
					reason: 'clusterPermissionMissing',
					transient: false,
					detail: { resource: 'jobs', verb: 'create', namespace: cluster.namespace }
				};
			}
			return transientClusterFailure(error);
		}

		// The Job's success is the second half of ACC-07-16's gate: a server that answers before its buckets
		// exist is not a usable object store, and reporting `ready` there would hand the app an endpoint whose
		// buckets are missing. The Job is asked first every poll, and its answer is kept for the failure
		// detail below, so a failed wait never costs a third read of an unreachable cluster.
		let initJob: 'succeeded' | 'failed' | 'pending' | 'absent' = 'absent';
		const outcome = await this.waitFor(ctx, async () => {
			initJob = await this.initJobState(cluster);
			if (initJob !== 'succeeded') return false;

			const statefulSet = await this.api.readObject<{ status?: { readyReplicas?: number } }>(
				cluster.kubeconfig,
				'apps/v1',
				'StatefulSet',
				cluster.namespace,
				OBJECT_STORAGE_OBJECT_NAMES.statefulSet,
				cluster.context
			);
			return statefulSet?.status?.readyReplicas === 1;
		});
		if (outcome === 'exhausted') return exhaustedOutcome(this.pollIntervalMs(), this.maxPolls());
		if (outcome !== 'ready') return waitFailure(input, outcome, initJob);

		// Read the keys back out of the cluster rather than out of memory: the provision job encrypts these
		// into `outputsEncrypted` and drops its own copy, so what is published has to be what the cluster
		// holds. An absent Secret is `pending`, exactly as the Postgres operator path waits for its own.
		const stored = await this.readAppCredentials(cluster);
		if (!stored) {
			return {
				state: 'pending',
				retryAfterMs: this.pollIntervalMs(),
				detail: { waitingFor: OBJECT_STORAGE_OBJECT_NAMES.appSecret }
			};
		}

		return {
			state: 'ready',
			outputs: objectStorageOutputs(cluster, stored, input.buckets),
			resourceRefs: dependencyResourceRefs(
				cluster.namespace,
				[
					{ kind: 'NetworkPolicy', name: dependencyName(OBJECT_STORAGE_OBJECT_KIND) },
					{ kind: 'Secret', name: OBJECT_STORAGE_OBJECT_NAMES.secret },
					{ kind: 'Secret', name: OBJECT_STORAGE_OBJECT_NAMES.appSecret },
					{ kind: 'StatefulSet', name: OBJECT_STORAGE_OBJECT_NAMES.statefulSet },
					{ kind: 'Service', name: OBJECT_STORAGE_OBJECT_NAMES.service },
					{ kind: 'Job', name: OBJECT_STORAGE_OBJECT_NAMES.initJob }
				],
				{ buckets: input.buckets }
			),
			...(input.warnings.length > 0 ? { warnings: [...input.warnings] } : {})
		};
	}

	/**
	 * Re-read what the dependency publishes (the `refresh` mode).
	 *
	 * The keys come out of `dep-s3-app` and the endpoint out of the Service name — never out of a stored
	 * copy. A missing Secret throws, which the caller reports as `degraded outputsUnavailable`
	 * (plan §9.2:955) rather than as an empty set of outputs.
	 */
	async getOutputs(providerId: string, ctx: AppDependencyContext): Promise<Record<string, string>> {
		if (providerId !== OBJECT_STORAGE_PROVIDER_ID) {
			throw dependencyError('providerNotSupported', `'${providerId}' is not served by this provider.`);
		}

		const cluster = requireCluster(ctx);
		if (!cluster) throw dependencyError('clusterUnreachable', 'The dependency has no cluster to read from.');

		const credentials = await this.readAppCredentials(cluster);
		if (!credentials) {
			throw dependencyError(
				'clusterUnreachable',
				`'${OBJECT_STORAGE_OBJECT_NAMES.appSecret}' is missing in namespace '${cluster.namespace}'.`
			);
		}

		return objectStorageOutputs(cluster, credentials, declaredBuckets(ctx));
	}

	/**
	 * Release, or destroy, the App Work's object storage (plan §4.9:624-628, §4.12).
	 *
	 * - `deleteData: false` **without** `stopWorkloads` makes **no cluster call at all** and answers
	 *   `released`; the server keeps running and its row becomes `kept`.
	 * - `deleteData: false` **with** `stopWorkloads` (App Work deletion, R-15) scales the StatefulSet to
	 *   zero and touches nothing else — no PVC, no Secret, no bucket, no NetworkPolicy.
	 * - `deleteData: true` deletes by the `ever-works.io/dependency` label and then the PVCs explicitly,
	 *   re-listing until nothing remains or the budget runs out (`pending` + `remaining`). The buckets live
	 *   inside the volume this deletes, which is why they need no separate step.
	 */
	async deprovision(
		providerId: string,
		ctx: AppDependencyContext,
		opts: AppDependencyDeprovisionOptions
	): Promise<AppDependencyDeprovisionOutcome> {
		if (providerId !== OBJECT_STORAGE_PROVIDER_ID) return { state: 'released' };

		const cluster = requireCluster(ctx);
		if (!cluster) return { state: 'released' };

		if (opts?.deleteData !== true) {
			if (opts?.stopWorkloads === true) await this.stopWorkloads(cluster);
			return { state: 'released' };
		}

		return this.deleteAll(cluster);
	}

	/**
	 * FR-48's one backup state for this card.
	 *
	 * `none` on every path and in every state — the plan's backup column for this row (plan §4.9:618) and
	 * FR-48's single-replica in-cluster answer. As with Redis, the answer does not depend on the cluster,
	 * so this makes no cluster call: an unreachable cluster cannot turn "nothing backs this up" into "we
	 * couldn't check".
	 */
	async backupStatus(_providerId: string, _ctx: AppDependencyContext): Promise<AppDependencyBackupStatus> {
		return { state: 'none' };
	}

	/* --------------------------------------------------------------------- *
	 * Cluster reads and writes
	 * --------------------------------------------------------------------- */

	/** One key of one Secret, decoded, or `null` when the Secret or the key is absent. */
	private async readSecretValue(
		cluster: ObjectStorageDependencyCluster,
		name: string,
		key: string
	): Promise<string | null> {
		const secret = await this.api.readObject<{ data?: Record<string, string> }>(
			cluster.kubeconfig,
			'v1',
			'Secret',
			cluster.namespace,
			name,
			cluster.context
		);
		return decodeSecretValue(secret?.data?.[key]);
	}

	/** The service account's keys, or `null` until `dep-s3-app` carries both of them. */
	private async readAppCredentials(
		cluster: ObjectStorageDependencyCluster
	): Promise<ObjectStorageAppCredentials | null> {
		const secret = await this.api.readObject<{ data?: Record<string, string> }>(
			cluster.kubeconfig,
			'v1',
			'Secret',
			cluster.namespace,
			OBJECT_STORAGE_OBJECT_NAMES.appSecret,
			cluster.context
		);
		const accessKeyId = decodeSecretValue(secret?.data?.[OBJECT_STORAGE_SECRET_KEYS.accessKeyId]);
		const secretAccessKey = decodeSecretValue(secret?.data?.[OBJECT_STORAGE_SECRET_KEYS.secretAccessKey]);
		return accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : null;
	}

	/** Has the init Job succeeded, failed, or not finished its first attempt? */
	private async initJobState(
		cluster: ObjectStorageDependencyCluster
	): Promise<'succeeded' | 'failed' | 'pending' | 'absent'> {
		const live = await this.api.readObject<{ status?: { succeeded?: number; failed?: number } }>(
			cluster.kubeconfig,
			'batch/v1',
			'Job',
			cluster.namespace,
			OBJECT_STORAGE_OBJECT_NAMES.initJob,
			cluster.context
		);
		if (!live) return 'absent';
		if ((live.status?.succeeded ?? 0) > 0) return 'succeeded';
		return (live.status?.failed ?? 0) > 0 ? 'failed' : 'pending';
	}

	/**
	 * Delete an init Job that failed and never succeeded, so the re-apply below creates a fresh one.
	 *
	 * A Job's `spec.template` is immutable, so this is the only way a failed attempt can be retried at all
	 * (`backoffLimit` retries live inside one Job object, and a Job that exhausted them stays failed
	 * forever). The replacement registers the same generated service-account pair, so nothing the app holds
	 * goes stale.
	 */
	private async replaceFailedInitJob(cluster: ObjectStorageDependencyCluster): Promise<void> {
		if ((await this.initJobState(cluster)) !== 'failed') return;
		await this.api
			.deleteObject(
				cluster.kubeconfig,
				'batch/v1',
				'Job',
				cluster.namespace,
				OBJECT_STORAGE_OBJECT_NAMES.initJob,
				undefined,
				cluster.context
			)
			.catch(() => undefined);
	}

	/** `stopWorkloads` (R-15): scale the server to zero and touch nothing else. */
	private async stopWorkloads(cluster: ObjectStorageDependencyCluster): Promise<string[]> {
		const statefulSet = await this.api.readObject(
			cluster.kubeconfig,
			'apps/v1',
			'StatefulSet',
			cluster.namespace,
			OBJECT_STORAGE_OBJECT_NAMES.statefulSet,
			cluster.context
		);
		if (!statefulSet) return [];

		await this.api.applyObject(
			cluster.kubeconfig,
			{
				apiVersion: 'apps/v1',
				kind: 'StatefulSet',
				metadata: { name: OBJECT_STORAGE_OBJECT_NAMES.statefulSet, namespace: cluster.namespace },
				spec: { replicas: 0 }
			},
			cluster.context
		);
		return ['StatefulSet'];
	}

	/**
	 * `deleteData: true` — delete by label, then the PVCs, then re-list until nothing remains.
	 *
	 * The re-list covers **every** teardown kind including `PersistentVolumeClaim`: the volume holds the
	 * buckets, so "we deleted what we could find" is not good enough — the answer is `deleted` only when a
	 * fresh label scan finds nothing (plan §4.9:628).
	 */
	private async deleteAll(cluster: ObjectStorageDependencyCluster): Promise<AppDependencyDeprovisionOutcome> {
		const started = this.now();

		for (const kind of APP_DEPENDENCY_TEARDOWN_KINDS) {
			const objects = await this.listOwned(cluster, kind);
			for (const object of objects) {
				if (!object.name) continue;
				await this.api
					.deleteObject(
						cluster.kubeconfig,
						kind.apiVersion,
						kind.kind,
						cluster.namespace,
						object.name,
						undefined,
						cluster.context
					)
					.catch(() => undefined);
			}
		}

		let remaining = await this.remaining(cluster, APP_DEPENDENCY_TEARDOWN_KINDS);
		if (remaining.length > 0 && this.now() - started < this.teardownTimeoutMs()) {
			// A namespaced delete is asynchronous, so one more pass is what distinguishes "still terminating"
			// from "left behind"; only what survives it is reported.
			remaining = await this.remaining(cluster, APP_DEPENDENCY_TEARDOWN_KINDS);
		}

		return remaining.length === 0
			? { state: 'deleted' }
			: { state: 'pending', remaining: dependencyResourceRefs(cluster.namespace, remaining) };
	}

	/** What the label selector finds for one kind, as `{ kind, name }` pairs. */
	private async listOwned(
		cluster: ObjectStorageDependencyCluster,
		kind: { apiVersion: string; kind: string }
	): Promise<AppDependencyObjectRef[]> {
		const objects = await this.api
			.listObjects<{
				metadata?: { name?: string };
			}>(
				cluster.kubeconfig,
				kind.apiVersion,
				kind.kind,
				cluster.namespace,
				`${APP_DEPENDENCY_POLICY_LABEL}=${OBJECT_STORAGE_OBJECT_KIND}`,
				cluster.context
			)
			.catch(() => []);

		const found: AppDependencyObjectRef[] = [];
		for (const object of objects) {
			if (object?.metadata?.name) found.push({ kind: kind.kind, name: object.metadata.name });
		}
		return found;
	}

	/** Everything the label selector still finds across `kinds`. */
	private async remaining(
		cluster: ObjectStorageDependencyCluster,
		kinds: readonly { apiVersion: string; kind: string }[]
	): Promise<AppDependencyObjectRef[]> {
		const found: AppDependencyObjectRef[] = [];
		for (const kind of kinds) found.push(...(await this.listOwned(cluster, kind)));
		return found;
	}

	/* --------------------------------------------------------------------- *
	 * Waiting
	 * --------------------------------------------------------------------- */

	/**
	 * Poll `check` until it is true or the caller's signal aborts.
	 *
	 * The deadline is the contract's, delivered as an abort (FR-41's ten minutes for object storage), and
	 * the injected clock plus the injected `sleep` are the only timing this provider has — so a unit test's
	 * ten-minute deadline costs one loop rather than ten minutes of wall time (ACC-07-16's "ready within
	 * 10 minutes"). `'exhausted'` is the runaway guard, not a deadline.
	 */
	private async waitFor(
		ctx: AppDependencyContext,
		check: () => Promise<boolean>
	): Promise<'ready' | 'deadline' | 'aborted' | 'exhausted'> {
		const started = this.now();
		const localDeadline = this.options.readyTimeoutMs;
		const maxPolls = this.options.maxPolls ?? OBJECT_STORAGE_READY_MAX_POLLS;
		const aborted = (): boolean => ctx?.signal?.aborted === true;

		for (let polls = 1; ; polls += 1) {
			if (aborted()) return 'aborted';
			if (await check()) return 'ready';
			if (aborted()) return 'aborted';
			if (typeof localDeadline === 'number' && localDeadline > 0 && this.now() - started >= localDeadline) {
				return 'deadline';
			}
			if (polls >= maxPolls) return 'exhausted';
			await this.sleep(this.pollIntervalMs());
		}
	}

	private now(): number {
		return this.options.now ? this.options.now() : Date.now();
	}

	private pollIntervalMs(): number {
		return this.options.pollIntervalMs ?? OBJECT_STORAGE_READY_POLL_MS;
	}

	private teardownTimeoutMs(): number {
		return this.options.teardownTimeoutMs ?? OBJECT_STORAGE_TEARDOWN_TIMEOUT_MS;
	}

	private maxPolls(): number {
		return this.options.maxPolls ?? OBJECT_STORAGE_READY_MAX_POLLS;
	}

	private sleep(millis: number): Promise<void> {
		return this.options.sleep ? this.options.sleep(millis) : new Promise((resolve) => setTimeout(resolve, millis));
	}
}

/* ------------------------------------------------------------------------- *
 * Manifests (pure, and every one of them is asserted by a spec)
 * ------------------------------------------------------------------------- */

/** The `dep-s3` Secret: the server's own root credential (plan §4.9:618). */
export function rootSecretManifest(
	ctx: AppDependencyContext,
	cluster: ObjectStorageDependencyCluster,
	rootPassword: string
): AppDependencyRenderedObject {
	return {
		apiVersion: 'v1',
		kind: 'Secret',
		type: 'Opaque',
		metadata: {
			name: OBJECT_STORAGE_OBJECT_NAMES.secret,
			namespace: cluster.namespace,
			labels: dependencyLabels({
				workId: String(ctx?.workId ?? ''),
				workSlug: cluster.workSlug,
				kind: OBJECT_STORAGE_OBJECT_KIND
			})
		},
		// `data`, not `stringData`: what the API server stores is what a later read returns, so the stored
		// password is read back from the cluster instead of re-derived from a guess.
		data: {
			[OBJECT_STORAGE_SECRET_KEYS.rootUser]: Buffer.from(OBJECT_STORAGE_ROOT_USER, 'utf8').toString('base64'),
			[OBJECT_STORAGE_SECRET_KEYS.rootPassword]: Buffer.from(rootPassword, 'utf8').toString('base64')
		}
	};
}

/**
 * The `dep-s3-app` Secret: the service account's keys, under FR-40's own output names.
 *
 * This provider writes it (see the module header), which is why the init Job needs no `create secret`
 * permission — the pair it registers is already in the namespace, read through `secretKeyRef`.
 */
export function appSecretManifest(
	ctx: AppDependencyContext,
	cluster: ObjectStorageDependencyCluster,
	credentials: ObjectStorageAppCredentials
): AppDependencyRenderedObject {
	return {
		apiVersion: 'v1',
		kind: 'Secret',
		type: 'Opaque',
		metadata: {
			name: OBJECT_STORAGE_OBJECT_NAMES.appSecret,
			namespace: cluster.namespace,
			labels: dependencyLabels({
				workId: String(ctx?.workId ?? ''),
				workSlug: cluster.workSlug,
				kind: OBJECT_STORAGE_OBJECT_KIND
			})
		},
		data: {
			[OBJECT_STORAGE_SECRET_KEYS.accessKeyId]: Buffer.from(credentials.accessKeyId, 'utf8').toString('base64'),
			[OBJECT_STORAGE_SECRET_KEYS.secretAccessKey]: Buffer.from(credentials.secretAccessKey, 'utf8').toString(
				'base64'
			)
		}
	};
}

/**
 * `dep-s3:9000` (plan §4.9:618) — the one Service, `ClusterIP`.
 *
 * `type: ClusterIP` is stated rather than left to the default, because plan §4.9:580 forbids a
 * LoadBalancer or a NodePort for a dependency. The plan's known gap is explicit that in-cluster object
 * storage is **internal-only** (§12, APW07-G17's neighbourhood): browser-facing uploads require Your own
 * S3 storage, so this Service being cluster-internal is the intended shape and not a missing ingress.
 */
export function serviceManifest(
	ctx: AppDependencyContext,
	cluster: ObjectStorageDependencyCluster
): AppDependencyRenderedObject {
	return {
		apiVersion: 'v1',
		kind: 'Service',
		metadata: {
			name: OBJECT_STORAGE_OBJECT_NAMES.service,
			namespace: cluster.namespace,
			labels: dependencyLabels({
				workId: String(ctx?.workId ?? ''),
				workSlug: cluster.workSlug,
				kind: OBJECT_STORAGE_OBJECT_KIND
			})
		},
		spec: {
			type: 'ClusterIP',
			selector: dependencyPodSelector(OBJECT_STORAGE_OBJECT_KIND),
			ports: [
				{
					name: OBJECT_STORAGE_OBJECT_KIND,
					port: OBJECT_STORAGE_PORT,
					targetPort: OBJECT_STORAGE_PORT,
					protocol: 'TCP'
				}
			]
		}
	};
}

/**
 * The `dep-s3` StatefulSet: one server, a 20 GiB claim, started on {@link OBJECT_STORAGE_DATA_PATH}
 * (plan §4.9:618).
 *
 * The claim's labels carry `ever-works.io/retain: "true"`, which is why the volume survives its
 * StatefulSet and why APW-06's `destroyApp` refuses to delete it without `deleteVolumes` (R-15). In the
 * ephemeral variant (R-10) the pod runs on an `emptyDir` instead: the verification namespace must leave
 * nothing behind, so no claim is rendered.
 */
export function statefulSetManifest(
	ctx: AppDependencyContext,
	cluster: ObjectStorageDependencyCluster,
	input: ObjectStorageProvisionInput,
	image: string
): AppDependencyRenderedObject {
	const labels = dependencyLabels({
		workId: String(ctx?.workId ?? ''),
		workSlug: cluster.workSlug,
		kind: OBJECT_STORAGE_OBJECT_KIND
	});

	const manifest: AppDependencyRenderedObject = {
		apiVersion: 'apps/v1',
		kind: 'StatefulSet',
		metadata: { name: OBJECT_STORAGE_OBJECT_NAMES.statefulSet, namespace: cluster.namespace, labels },
		spec: {
			serviceName: OBJECT_STORAGE_OBJECT_NAMES.service,
			replicas: 1,
			selector: { matchLabels: dependencyPodSelector(OBJECT_STORAGE_OBJECT_KIND) },
			template: {
				metadata: { labels: { ...labels, ...dependencyPodSelector(OBJECT_STORAGE_OBJECT_KIND) } },
				spec: {
					securityContext: dependencyPodSecurityContext({
						runAsUser: OBJECT_STORAGE_UID,
						runAsGroup: OBJECT_STORAGE_UID,
						fsGroup: OBJECT_STORAGE_UID
					}),
					containers: [
						{
							name: OBJECT_STORAGE_OBJECT_KIND,
							image,
							imagePullPolicy: 'IfNotPresent',
							args: ['server', OBJECT_STORAGE_DATA_PATH],
							ports: [
								{
									name: OBJECT_STORAGE_OBJECT_KIND,
									containerPort: OBJECT_STORAGE_PORT,
									protocol: 'TCP'
								}
							],
							env: rootEnv(),
							// The server's own health endpoint: it needs no client binary, and it answers 200 only
							// once the server is ready to serve requests.
							readinessProbe: {
								httpGet: { path: OBJECT_STORAGE_READINESS_PATH, port: OBJECT_STORAGE_PORT },
								initialDelaySeconds: 5,
								periodSeconds: 5,
								timeoutSeconds: 3,
								failureThreshold: 12
							},
							securityContext: dependencyContainerSecurityContext(),
							volumeMounts: [{ name: OBJECT_STORAGE_VOLUME_NAME, mountPath: OBJECT_STORAGE_DATA_PATH }]
						}
					]
				}
			}
		}
	};

	const spec = manifest.spec as Record<string, unknown>;

	if (input.ephemeral) {
		(manifest.spec as { template: { spec: Record<string, unknown> } }).template.spec.volumes = [
			{ name: OBJECT_STORAGE_VOLUME_NAME, emptyDir: {} }
		];
		return manifest;
	}

	spec.volumeClaimTemplates = [
		{
			metadata: {
				name: OBJECT_STORAGE_VOLUME_NAME,
				labels: dependencyPvcLabels({
					workId: String(ctx?.workId ?? ''),
					workSlug: cluster.workSlug,
					kind: OBJECT_STORAGE_OBJECT_KIND
				})
			},
			spec: {
				accessModes: ['ReadWriteOnce'],
				resources: { requests: { storage: gibQuantity(input.sizeGiB) } }
			}
		}
	];

	return manifest;
}

/**
 * `Job dep-s3-init`: the buckets, the public ones, and the service account (plan §4.9:618).
 *
 * The steps are **init containers**, which Kubernetes runs one after another, plus one final container —
 * so the Job's `succeeded` means every step of the plan's list has happened, in order:
 *
 * 1. `mc mb --ignore-existing` for **every** declared bucket, one target each in a single invocation;
 * 2. one `mc anonymous set download` per bucket in `publicBuckets`, and never for any other;
 * 3. `mc admin user add` registering the key pair already stored in `dep-s3-app`;
 * 4. `mc admin policy attach … readwrite` as the container that decides the Job's result.
 *
 * No shell is involved: every command is `mc` with an argument list, so a bucket name cannot become a
 * shell word, and the credentials arrive through `secretKeyRef` and Kubernetes's own `$(VAR)` expansion
 * rather than as literals. `MC_HOST_local` is that same mechanism — the kubelet substitutes the two
 * Secret-backed variables declared before it into the alias URL, so the root password is never written
 * into the Job manifest.
 */
export function bucketInitJobManifest(
	ctx: AppDependencyContext,
	cluster: ObjectStorageDependencyCluster,
	input: ObjectStorageProvisionInput,
	clientImage: string
): AppDependencyRenderedObject {
	const labels = dependencyLabels({
		workId: String(ctx?.workId ?? ''),
		workSlug: cluster.workSlug,
		kind: OBJECT_STORAGE_OBJECT_KIND
	});
	const podLabels = { ...labels, ...dependencyPodSelector(OBJECT_STORAGE_OBJECT_KIND) };

	const initContainers: Record<string, unknown>[] = [];

	if (input.buckets.length > 0) {
		initContainers.push(
			mcContainer(
				clientImage,
				OBJECT_STORAGE_JOB_CONTAINERS.buckets,
				mcRootEnv(),
				['mb', '--ignore-existing'],
				[...input.buckets.map(mcTarget)]
			)
		);
	}

	for (const bucket of input.publicBuckets) {
		initContainers.push(
			mcContainer(
				clientImage,
				`public-${bucket}`,
				mcRootEnv(),
				['anonymous', 'set', 'download'],
				[mcTarget(bucket)]
			)
		);
	}

	initContainers.push(
		mcContainer(
			clientImage,
			OBJECT_STORAGE_JOB_CONTAINERS.serviceAccount,
			appEnv(),
			['admin', 'user', 'add'],
			[OBJECT_STORAGE_ALIAS, '$(APP_ACCESS_KEY)', '$(APP_SECRET_KEY)']
		)
	);

	return {
		apiVersion: 'batch/v1',
		kind: 'Job',
		metadata: { name: OBJECT_STORAGE_OBJECT_NAMES.initJob, namespace: cluster.namespace, labels },
		spec: {
			backoffLimit: 1,
			ttlSecondsAfterFinished: 3_600,
			template: {
				metadata: { labels: podLabels },
				spec: {
					restartPolicy: 'Never',
					securityContext: dependencyPodSecurityContext({
						runAsUser: OBJECT_STORAGE_UID,
						runAsGroup: OBJECT_STORAGE_UID,
						fsGroup: OBJECT_STORAGE_UID
					}),
					initContainers,
					containers: [
						mcContainer(
							clientImage,
							OBJECT_STORAGE_JOB_CONTAINERS.policy,
							appEnv(),
							['admin', 'policy', 'attach'],
							[OBJECT_STORAGE_ALIAS, OBJECT_STORAGE_APP_POLICY, '--user', '$(APP_ACCESS_KEY)']
						)
					]
				}
			}
		}
	};
}

/* ------------------------------------------------------------------------- *
 * Pure helpers
 * ------------------------------------------------------------------------- */

/** One `mc` container: an image, an argument list, and environment that carries the credentials. */
function mcContainer(
	image: string,
	name: string,
	env: Record<string, unknown>[],
	command: string[],
	args: string[]
): Record<string, unknown> {
	return {
		name,
		image,
		imagePullPolicy: 'IfNotPresent',
		command: ['mc', ...command],
		args,
		// `HOME` last, after the credential entries, so nothing above depends on it.
		env: [...env, { name: 'HOME', value: OBJECT_STORAGE_MC_HOME }],
		securityContext: dependencyContainerSecurityContext()
	};
}

/** `local/<bucket>` — the `mc` target of one bucket. */
function mcTarget(bucket: string): string {
	return `${OBJECT_STORAGE_ALIAS}/${bucket}`;
}

/** The server container's environment: the root credential, both halves through `secretKeyRef`. */
function rootEnv(): Record<string, unknown>[] {
	return [
		{
			name: 'MINIO_ROOT_USER',
			valueFrom: {
				secretKeyRef: { name: OBJECT_STORAGE_OBJECT_NAMES.secret, key: OBJECT_STORAGE_SECRET_KEYS.rootUser }
			}
		},
		{
			name: 'MINIO_ROOT_PASSWORD',
			valueFrom: {
				secretKeyRef: {
					name: OBJECT_STORAGE_OBJECT_NAMES.secret,
					key: OBJECT_STORAGE_SECRET_KEYS.rootPassword
				}
			}
		}
	];
}

/**
 * The `mc` containers' environment: {@link rootEnv} plus `MC_HOST_local`, the alias `mc` reads its endpoint
 * and credentials from.
 *
 * The alias URL is assembled by the kubelet, not by this module: `$(MINIO_ROOT_USER)` and
 * `$(MINIO_ROOT_PASSWORD)` are dependent-variable references to the two entries above, and they are
 * declared first precisely because Kubernetes only expands variables a container has already defined.
 * Building the URL here instead would put the root password in the Job manifest, which is the one thing
 * the `secretKeyRef`s exist to prevent.
 */
function mcRootEnv(): Record<string, unknown>[] {
	return [
		...rootEnv(),
		{
			name: 'MC_HOST_local',
			value: `http://$(MINIO_ROOT_USER):$(MINIO_ROOT_PASSWORD)@${OBJECT_STORAGE_OBJECT_NAMES.service}:${OBJECT_STORAGE_PORT}`
		}
	];
}

/** {@link mcRootEnv} plus the service account's pair, for the two `mc admin` steps. */
function appEnv(): Record<string, unknown>[] {
	const fromAppSecret = (name: string, key: string): Record<string, unknown> => ({
		name,
		valueFrom: { secretKeyRef: { name: OBJECT_STORAGE_OBJECT_NAMES.appSecret, key } }
	});

	return [
		...mcRootEnv(),
		fromAppSecret('APP_ACCESS_KEY', OBJECT_STORAGE_SECRET_KEYS.accessKeyId),
		fromAppSecret('APP_SECRET_KEY', OBJECT_STORAGE_SECRET_KEYS.secretAccessKey)
	];
}

/** The plan's five outputs (plan §4.9:618, FR-40), with one `bucket.<name>` per declared bucket. */
export function objectStorageOutputs(
	cluster: ObjectStorageDependencyCluster,
	credentials: ObjectStorageAppCredentials,
	buckets: readonly string[]
): Record<string, string> {
	const host = `${OBJECT_STORAGE_OBJECT_NAMES.service}.${cluster.namespace}.svc.cluster.local`;
	const outputs: Record<string, string> = {
		endpoint: `http://${host}:${OBJECT_STORAGE_PORT}`,
		region: OBJECT_STORAGE_REGION,
		accessKeyId: credentials.accessKeyId,
		secretAccessKey: credentials.secretAccessKey
	};

	for (const bucket of buckets) outputs[`bucket.${bucket}`] = bucket;

	return outputs;
}

/** A 32-hex root password from `node:crypto`. */
export function generateRootPassword(bytes: number = OBJECT_STORAGE_ROOT_PASSWORD_BYTES): string {
	return randomBytes(bytes).toString('hex');
}

/** A 20-character access key and a 40-character secret, both inside MinIO's documented bounds. */
export function generateAppCredentials(): ObjectStorageAppCredentials {
	return {
		accessKeyId: randomBytes(OBJECT_STORAGE_ACCESS_KEY_BYTES).toString('hex').toUpperCase(),
		secretAccessKey: randomBytes(OBJECT_STORAGE_SECRET_KEY_BYTES).toString('hex')
	};
}

/**
 * The declared buckets, deduplicated and validated, in the App spec's order.
 *
 * A name fails {@link S3_BUCKET_NAME_PATTERN} only when the App spec itself could not have produced it, and
 * the refusal is reported as `bucketNameInvalid=<name>` so the card can say what was left out. Everything
 * that passes is created — this list is the Job's target list, verbatim.
 */
export function declaredBuckets(ctx: AppDependencyContext, warnings: string[] = []): string[] {
	const declared = (ctx?.declared ?? {}) as Record<string, unknown>;
	const raw = declared.buckets;
	if (!Array.isArray(raw)) return [];

	const buckets: string[] = [];
	for (const entry of raw) {
		const name = typeof entry === 'string' ? entry.trim() : '';
		if (!name) continue;
		if (!S3_BUCKET_NAME_PATTERN.test(name)) {
			warnings.push(`bucketNameInvalid=${name}`);
			continue;
		}
		if (buckets.includes(name)) continue;
		if (buckets.length >= OBJECT_STORAGE_MAX_BUCKETS) {
			warnings.push(`bucketLimitExceeded=${name}`);
			continue;
		}
		buckets.push(name);
	}

	return buckets;
}

/**
 * The declared `publicBuckets`, intersected with the buckets that will exist.
 *
 * A public name the App spec did not declare is reported as `publicBucketUndeclared=<name>`: opening a
 * bucket nobody asked for is exactly the "anonymous download" mistake this intersection prevents, and
 * FR-40's schema records the same rule as an App-spec error (`public_bucket_undeclared`).
 */
export function declaredPublicBuckets(
	ctx: AppDependencyContext,
	buckets: readonly string[],
	warnings: string[] = []
): string[] {
	const declared = (ctx?.declared ?? {}) as Record<string, unknown>;
	const raw = declared.publicBuckets;
	if (!Array.isArray(raw)) return [];

	const publicBuckets: string[] = [];
	for (const entry of raw) {
		const name = typeof entry === 'string' ? entry.trim() : '';
		if (!name) continue;
		if (!buckets.includes(name)) {
			warnings.push(`publicBucketUndeclared=${name}`);
			continue;
		}
		if (!publicBuckets.includes(name)) publicBuckets.push(name);
	}

	return publicBuckets;
}

/** The work slug: APW-06's own `part-of` label when it is there, the context's app name otherwise. */
function workSlugOf(ctx: AppDependencyContext): string {
	const labelled = ctx?.cluster?.appLabels?.['app.kubernetes.io/part-of'];
	const slug = typeof labelled === 'string' && labelled.trim() ? labelled.trim() : String(ctx?.appName ?? '');
	return slug.trim();
}

/** The context's cluster half, or `null` when the caller handed us nothing to write to. */
function requireCluster(ctx: AppDependencyContext): ObjectStorageDependencyCluster | null {
	const cluster = ctx?.cluster;
	const kubeconfig = typeof cluster?.kubeconfig === 'string' ? cluster.kubeconfig : '';
	const namespace = typeof cluster?.namespace === 'string' ? cluster.namespace.trim() : '';
	if (!kubeconfig || !namespace) return null;
	return {
		kubeconfig,
		context: typeof cluster?.context === 'string' && cluster.context ? cluster.context : undefined,
		namespace,
		workSlug: workSlugOf(ctx)
	};
}

/** The plain value of a Secret key, or `null` when the key is absent or empty. */
function decodeSecretValue(value: unknown): string | null {
	if (typeof value !== 'string' || !value) return null;
	const decoded = Buffer.from(value, 'base64').toString('utf8');
	return decoded ? decoded : null;
}

/** A readiness wait that ran past its own observation bound: not ready *yet*, so ask again. */
function exhaustedOutcome(
	pollIntervalMs: number,
	maxPolls: number = OBJECT_STORAGE_READY_MAX_POLLS
): AppDependencyProvisionOutcome {
	return {
		state: 'pending',
		retryAfterMs: pollIntervalMs,
		detail: { kind: OBJECT_STORAGE_PROVIDER_KIND, waitedPolls: maxPolls }
	};
}

/**
 * The failure a readiness wait ends in — the kind's deadline, or the caller's own abort (FR-41).
 *
 * The state of the init Job decides between the contract's two honest answers. A Job that never succeeded
 * means the buckets are not there, and the card says **"Provisioning didn't finish in time."**
 * (`deadlineExceeded`); a Job that succeeded while the server never reported a ready replica means the
 * claim is what held the pod back, which is `volumeNotReady` ("The volume didn't become ready within
 * {minutes} minutes."). The Job's own state travels in the detail because "the buckets were never created"
 * is a different investigation from "the server never came up".
 */
function waitFailure(
	input: ObjectStorageProvisionInput,
	outcome: 'deadline' | 'aborted',
	job: 'succeeded' | 'failed' | 'pending' | 'absent'
): AppDependencyProvisionOutcome {
	return {
		state: 'failed',
		reason: job === 'succeeded' ? 'volumeNotReady' : 'deadlineExceeded',
		transient: false,
		detail: {
			kind: OBJECT_STORAGE_PROVIDER_KIND,
			aborted: outcome === 'aborted' ? 'true' : 'false',
			buckets: String(input.buckets.length),
			initJob: job,
			ephemeral: input.ephemeral ? 'true' : 'false'
		}
	};
}

/** A cluster-side error on an apply: a refusal is definite, anything else is worth retrying (FR-43). */
function applyFailure(error: unknown, kind: string): AppDependencyProvisionOutcome {
	if (isForbidden(error)) {
		return { state: 'failed', reason: 'clusterPermissionMissing', transient: false, detail: { object: kind } };
	}
	return transientClusterFailure(error);
}

function transientClusterFailure(error: unknown): AppDependencyProvisionOutcome {
	const message = error instanceof Error ? error.message : String(error ?? '');
	return { state: 'failed', reason: 'clusterUnreachable', transient: true, detail: { error: message.slice(0, 200) } };
}

/** A typed error for the reads that cannot answer — the caller maps it to its own card reason. */
function dependencyError(code: string, message: string): Error & { code: string } {
	const error = new Error(`${code}: ${message}`) as Error & { code: string };
	error.code = code;
	return error;
}
