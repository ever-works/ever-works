/**
 * APW-07 T20 — `k8s-inline-redis`: the Redis dependency on the owner's own cluster.
 *
 * Sources, in priority order:
 *
 * 1. `docs/specs/features/app-works/APW-07-app-env-and-dependencies/plan.md` §4.9:617 (the
 *    `k8s-inline-redis` row of the provider table), §4.9:575-580 (the labels and security contexts every
 *    in-cluster provider shares), §4.9:582-602 (reachability, rewritten 2026-09-17 by APW07-G01),
 *    §4.9:604-611 (the cluster permissions) and §4.9:620-628 (outputs, the ephemeral variant and
 *    deprovision with `deleteData` / `stopWorkloads`).
 * 2. `tasks.md:310-316` (T20) — the object list, `--maxmemory 400mb` with the declared policy, the
 *    `REDISCLI_AUTH` readiness, `readyReplicas == 1` inside the 5-minute deadline (ACC-07-16), the URL
 *    shape, and `dep-redis` applied before the workload.
 * 3. `spec.md` FR-36 ("Redis → a single-replica cache (with a volume only when persistence is
 *    declared)"), FR-37 (Redis's volume default is 1 GiB), FR-38 (reachable only from the App Work's own
 *    pods), FR-40 (`url`, `host`, `port`, `password`), FR-41 (the 5-minute Redis deadline), FR-43 (a
 *    definite failure fails at once with its reason), FR-48 (backup state `none` — the card's no-backup
 *    warning) and ACC-07-16.
 *
 * ## The one thing that chooses the workload kind
 *
 * `plan.md` §4.9:617 gives Redis two shapes: a **Deployment** with no persistence, and a **StatefulSet +
 * 1 GiB PVC** when the App spec declares `persistence: true`. The declared flag is the only input — no
 * size setting, no admin override and no cluster capability changes it, because "a volume only when
 * persistence is declared" (FR-36) is a promise about the owner's declaration, and a provider that
 * created a claim anyway would be charging for storage nobody asked for.
 *
 * ## The password never reaches an argument or a probe
 *
 * The plan's args are `--requirepass $(REDIS_PASSWORD) --maxmemory 400mb --maxmemory-policy <declared>`.
 * `$(REDIS_PASSWORD)` is Kubernetes's own dependent-variable expansion: the kubelet substitutes it from
 * the container's `env` **at container start**, so the value the manifest carries is the literal
 * `$(REDIS_PASSWORD)` and the password itself lives only in the `dep-redis` Secret. The readiness probe
 * reads `REDISCLI_AUTH` from the same Secret through `secretKeyRef`, so no probe and no argument ever
 * names the credential — which is also what T20's Test line pins ("readiness uses `REDISCLI_AUTH` (no
 * password in args)").
 *
 * ## Reachability is owned here, not by APW-06's isolation switch
 *
 * `dep-redis` is applied **before** the workload and is drawn whatever the App Work's isolation setting
 * is (plan §4.9:582-602, APW07-G01): this class has no isolation input at all, so there is nothing that
 * could switch the policy off. Only pods in the App Work's own namespace are admitted, and only on 6379
 * (FR-38) — a neighbour cannot reach an admin port, and nothing outside the namespace is admitted.
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
import { REDIS_DEFAULT_VERSION, redisImageFor } from './images.js';

/* ------------------------------------------------------------------------- *
 * Constants
 * ------------------------------------------------------------------------- */

/** The provider id — `APP_DEPENDENCY_PROVIDER_IDS[1]`, and what the owner's explicit choice names. */
export const REDIS_PROVIDER_ID = 'k8s-inline-redis';

/** The kind this provider serves. */
export const REDIS_PROVIDER_KIND: AppDependencyKind = 'redis';

/** The local part of every `dep-redis…` object name (plan §4.9:573, §4.9:617). */
export const REDIS_OBJECT_KIND = 'redis';

/** The port Redis is reached on — the third of the plan's three service ports (plan §4.9:588). */
export const REDIS_PORT = APP_DEPENDENCY_PORTS.redis;

/** The generated password's length — 16 random bytes, hex (the same shape Postgres's plain path uses). */
export const REDIS_PASSWORD_BYTES = 16;

/**
 * The plan's fixed `--maxmemory 400mb` (plan §4.9:617).
 *
 * It is deliberately **not** derived from the volume size or from the plugin's `memoryLimit` setting:
 * the plan fixes both the ceiling Redis evicts at and the memory limit of the container that runs it,
 * and a Redis whose `maxmemory` exceeded its cgroup limit would be OOM-killed instead of evicting —
 * which is the one failure mode `maxmemory-policy` exists to prevent.
 */
export const REDIS_MAXMEMORY = '400mb';

/** The container memory limit the plan fixes above {@link REDIS_MAXMEMORY} (plan §4.9:617). */
export const REDIS_MEMORY_LIMIT = '512Mi';

/** The App-spec `redis.maxmemoryPolicy` enum (`APW-03/schema.md:223`), in the schema's own order. */
export const REDIS_MAXMEMORY_POLICIES = [
	'noeviction',
	'allkeys-lru',
	'volatile-lru',
	'allkeys-lfu',
	'volatile-lfu'
] as const;

/** The App spec's default policy (`APW-03/schema.md:223`), and what an unusable declaration falls back to. */
export const REDIS_MAXMEMORY_POLICY_DEFAULT = 'noeviction';

/** The only `redis.version` the App spec can declare (`APW-03/schema.md:222`). */
export const REDIS_SUPPORTED_VERSION = String(REDIS_DEFAULT_VERSION);

/** The mount path every Redis image expects its data at (`--dir` is left at the image's default). */
export const REDIS_DATA_PATH = '/data';

/** The volume name of the persisted data directory. */
export const REDIS_VOLUME_NAME = 'data';

/** The object names, all `dep-<kind>…` per plan §4.9:573 / §4.9:617. */
export const REDIS_OBJECT_NAMES = {
	secret: dependencyName(REDIS_OBJECT_KIND),
	service: dependencyName(REDIS_OBJECT_KIND),
	deployment: dependencyName(REDIS_OBJECT_KIND),
	statefulSet: dependencyName(REDIS_OBJECT_KIND)
} as const;

/** The `dep-redis` Secret key the password is stored under — the same key name the Postgres path uses. */
export const REDIS_PASSWORD_KEY = 'password';

/** How often a readiness wait re-reads the cluster. */
export const REDIS_READY_POLL_MS = 5_000;

/**
 * The most observations one readiness wait makes before answering `pending`.
 *
 * An hour at the default poll interval — far past FR-41's five-minute Redis deadline, which reaches the
 * provider as `ctx.signal`'s abort. It exists so a caller that forgets to arm a signal gets a retryable
 * `pending` instead of a tight loop (the same runaway guard `postgres.provider.ts` carries).
 */
export const REDIS_READY_MAX_POLLS = 720;

/** How long a `deleteData` teardown keeps re-listing (plan §4.9:628 — "≤ 5 minutes"). */
export const REDIS_TEARDOWN_TIMEOUT_MS = 300_000;

/**
 * The descriptor the plugin publishes for this provider (plan §4.7:471-479, §4.8:544-546).
 *
 * `preference: 10` is the plan's number for every `k8s-inline-*` provider. `backupPolicy: 'none'` is the
 * plan's backup column for this row (plan §4.9:617) and FR-48's "No automatic backups (single-replica
 * in-cluster providers — shown as a warning)": nothing takes a backup of a cache, and the card says so
 * rather than reporting a state this provider could not honour.
 *
 * `label` is the card's provider line, taken verbatim from the normative copy table
 * (`spec.md:525` — `In your cluster · single instance`), not restated for Redis: the plan's own labels
 * are per *plugin class*, and the card already names the kind ("Redis 7", `spec.md:515`).
 */
export const REDIS_PROVIDER_DESCRIPTOR: AppDependencyProviderDescriptor = {
	id: REDIS_PROVIDER_ID,
	kind: REDIS_PROVIDER_KIND,
	targets: ['your-cluster'],
	label: 'In your cluster · single instance',
	preference: 10,
	backupPolicy: 'none'
};

/* ------------------------------------------------------------------------- *
 * What a call needs that the contract does not fix
 * ------------------------------------------------------------------------- */

/** Everything a provider call needs beyond the contract's context. */
export interface RedisProviderOptions {
	/** Epoch milliseconds. Defaults to `Date.now`; the specs inject a virtual clock. */
	now?: () => number;
	/** The only way this provider waits. Defaults to `setTimeout`; the specs inject a virtual clock. */
	sleep?: (millis: number) => Promise<void>;
	/** The readiness poll interval. Defaults to {@link REDIS_READY_POLL_MS}. */
	pollIntervalMs?: number;
	/**
	 * An optional **local** readiness bound, in ms. Unset by default and deliberately so: FR-41's
	 * five-minute Redis deadline belongs to the contract's `APP_DEPENDENCY_READY_DEADLINE_MS` and reaches
	 * a provider through `ctx.signal`, which the job aborts at the kind's deadline. A second copy of the
	 * number here would be a second source of truth for the same deadline, so this option exists only for
	 * a caller that wants a tighter bound of its own.
	 */
	readyTimeoutMs?: number;
	/** How many observations a readiness wait makes before answering `pending` (`READY_MAX_POLLS`). */
	maxPolls?: number;
	/** The `deleteData` teardown budget. Defaults to {@link REDIS_TEARDOWN_TIMEOUT_MS}. */
	teardownTimeoutMs?: number;
}

/** The cluster half of a context, once it is known to be present. */
export interface RedisDependencyCluster {
	kubeconfig: string;
	context?: string;
	namespace: string;
	workSlug: string;
}

/** The values one provisioning attempt renders from. */
export interface RedisProvisionInput {
	/** Always `7` — the only major the App spec can declare and {@link redisImageFor} can pin. */
	version: string;
	sizeGiB: number;
	persistence: boolean;
	maxmemoryPolicy: string;
	warnings: string[];
	ephemeral: boolean;
}

/* ------------------------------------------------------------------------- *
 * The provider
 * ------------------------------------------------------------------------- */

/**
 * `k8s-inline-redis` — one instance per plugin, stateless between calls: every fact a call needs is read
 * from the cluster or passed in, so a retry is a fresh attempt rather than a resumed one.
 */
export class RedisDependencyProvider {
	constructor(
		private readonly api: AppDependencyApi,
		private readonly options: RedisProviderOptions = {}
	) {}

	/** The descriptor the plugin publishes. A method, so the plugin never restates the object. */
	descriptor(): AppDependencyProviderDescriptor {
		return REDIS_PROVIDER_DESCRIPTOR;
	}

	/**
	 * Does this provider serve `(kind, target)`?
	 *
	 * The answer depends on the pair alone — whether the cluster can actually take the dependency is
	 * `provision`'s answer, with its own reason (the same division `postgres.provider.ts` records).
	 */
	async supports(kind: AppDependencyKind, target: AppDependencyTarget): Promise<AppDependencySupport> {
		if (kind === REDIS_PROVIDER_KIND && target === 'your-cluster') {
			return { supported: true, providerId: REDIS_PROVIDER_ID };
		}
		return { supported: false, reason: 'providerNotSupported' };
	}

	/**
	 * Create (or re-observe) the App Work's Redis.
	 *
	 * The order is the plan's: policy, then Secret, then Service, then workload — the `dep-redis` policy
	 * **before** the workload it protects (APW07-G01). `pending` means "not ready yet, ask again" and
	 * carries the poll interval; `failed` always carries one of the contract's reasons and says whether a
	 * retry could help (FR-43).
	 */
	async provision(providerId: string, ctx: AppDependencyContext): Promise<AppDependencyProvisionOutcome> {
		if (providerId !== REDIS_PROVIDER_ID) {
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
		const input: RedisProvisionInput = {
			version: declaredVersion(ctx, warnings),
			sizeGiB: dependencySizeGiB('redis', ctx?.settings, ctx?.sizeGiB),
			persistence: declaredPersistence(ctx),
			maxmemoryPolicy: declaredMaxmemoryPolicy(ctx, warnings),
			warnings,
			ephemeral: ctx?.ephemeral === true
		};
		if (input.ephemeral) warnings.push('ephemeralNoPersistence');

		// The policy goes first — always, and whatever the App Work's isolation setting is (APW07-G01).
		try {
			await this.api.applyObject(
				cluster.kubeconfig,
				planDependencyNetworkPolicy({
					kind: REDIS_OBJECT_KIND,
					namespace: cluster.namespace,
					workId: String(ctx?.workId ?? ''),
					workSlug: cluster.workSlug,
					port: REDIS_PORT
				}).policy,
				cluster.context
			);
		} catch (error) {
			return applyFailure(error, 'NetworkPolicy');
		}

		// Reuse the stored password when there is one: re-provisioning must never rotate the credential of
		// a cache the app is already connected to (FR-47 — credentials are never rotated implicitly).
		const existing = await this.readStoredPassword(cluster);
		const password = existing ?? generatePassword();

		try {
			await this.api.applyObject(cluster.kubeconfig, secretManifest(ctx, cluster, password), cluster.context);
		} catch (error) {
			return applyFailure(error, 'Secret');
		}

		try {
			await this.api.applyObject(cluster.kubeconfig, serviceManifest(ctx, cluster), cluster.context);
		} catch (error) {
			return applyFailure(error, 'Service');
		}

		const persisted = input.persistence;
		try {
			await this.api.applyObject(
				cluster.kubeconfig,
				persisted ? statefulSetManifest(ctx, cluster, input) : deploymentManifest(ctx, cluster, input),
				cluster.context
			);
		} catch (error) {
			// APW07-G10: `statefulsets` is the one *required* permission this epic adds; a Deployment is the
			// non-persistent path's object. Either way a refusal is a definite failure naming what was refused
			// rather than a silent downgrade — a Redis without persistence would still answer, but it would
			// be a different dependency than the one the owner declared.
			if (isForbidden(error)) {
				return {
					state: 'failed',
					reason: 'clusterPermissionMissing',
					transient: false,
					detail: {
						resource: persisted ? 'statefulsets' : 'deployments',
						verb: 'create',
						namespace: cluster.namespace
					}
				};
			}
			return transientClusterFailure(error);
		}

		const outcome = await this.waitFor(ctx, async () => {
			const live = await this.api.readObject<{ status?: { readyReplicas?: number } }>(
				cluster.kubeconfig,
				'apps/v1',
				persisted ? 'StatefulSet' : 'Deployment',
				cluster.namespace,
				persisted ? REDIS_OBJECT_NAMES.statefulSet : REDIS_OBJECT_NAMES.deployment,
				cluster.context
			);
			return live?.status?.readyReplicas === 1;
		});
		if (outcome === 'exhausted') return exhaustedOutcome(this.pollIntervalMs(), this.maxPolls());
		if (outcome !== 'ready') return waitFailure(input, outcome);

		const objects: AppDependencyObjectRef[] = [
			{ kind: 'NetworkPolicy', name: dependencyName(REDIS_OBJECT_KIND) },
			{ kind: 'Secret', name: REDIS_OBJECT_NAMES.secret },
			{ kind: 'Service', name: REDIS_OBJECT_NAMES.service },
			{ kind: persisted ? 'StatefulSet' : 'Deployment', name: dependencyName(REDIS_OBJECT_KIND) }
		];

		return {
			state: 'ready',
			outputs: redisOutputs(cluster, password),
			actualVersion: String(input.version),
			resourceRefs: dependencyResourceRefs(cluster.namespace, objects),
			...(input.warnings.length > 0 ? { warnings: [...input.warnings] } : {})
		};
	}

	/**
	 * Re-read what the dependency publishes (the `refresh` mode).
	 *
	 * The outputs always come back out of the cluster — a Secret's key and a Service name — never out of a
	 * stored copy, so a refresh sees a password an operator rotated by hand. A missing Secret throws,
	 * which the caller reports as `degraded outputsUnavailable` (plan §9.2:955) rather than as an empty
	 * set of outputs.
	 */
	async getOutputs(providerId: string, ctx: AppDependencyContext): Promise<Record<string, string>> {
		if (providerId !== REDIS_PROVIDER_ID) {
			throw dependencyError('providerNotSupported', `'${providerId}' is not served by this provider.`);
		}

		const cluster = requireCluster(ctx);
		if (!cluster) throw dependencyError('clusterUnreachable', 'The dependency has no cluster to read from.');

		const password = await this.readStoredPassword(cluster);
		if (!password) {
			throw dependencyError(
				'clusterUnreachable',
				`'${REDIS_OBJECT_NAMES.secret}' has no '${REDIS_PASSWORD_KEY}' in namespace '${cluster.namespace}'.`
			);
		}

		return redisOutputs(cluster, password);
	}

	/**
	 * Release, or destroy, the App Work's Redis (plan §4.9:624-628, §4.12).
	 *
	 * - `deleteData: false` **without** `stopWorkloads` makes **no cluster call at all** and answers
	 *   `released`; the cache keeps running and its row becomes `kept`.
	 * - `deleteData: false` **with** `stopWorkloads` (App Work deletion, R-15) scales the workload to zero
	 *   and touches nothing else — no PVC, no Secret, no NetworkPolicy and no Service.
	 * - `deleteData: true` deletes by the `ever-works.io/dependency` label and then the PVCs explicitly,
	 *   re-listing until nothing remains or the budget runs out (`pending` + `remaining`).
	 */
	async deprovision(
		providerId: string,
		ctx: AppDependencyContext,
		opts: AppDependencyDeprovisionOptions
	): Promise<AppDependencyDeprovisionOutcome> {
		if (providerId !== REDIS_PROVIDER_ID) return { state: 'released' };

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
	 * `none` on every path and in every state — the plan's backup column for this row (plan §4.9:617) and
	 * FR-48's single-replica in-cluster answer, which the card renders as "No automatic backups. If this
	 * volume is lost, the data is gone." The answer does not depend on the cluster, so this deliberately
	 * makes no cluster call: there is nothing to read, and an unreachable cluster therefore cannot turn
	 * "nothing backs this up" into "we couldn't check".
	 */
	async backupStatus(_providerId: string, _ctx: AppDependencyContext): Promise<AppDependencyBackupStatus> {
		return { state: 'none' };
	}

	/* --------------------------------------------------------------------- *
	 * Cluster reads and writes
	 * --------------------------------------------------------------------- */

	/** The stored password, or `null` when the Secret or its key is absent. */
	private async readStoredPassword(cluster: RedisDependencyCluster): Promise<string | null> {
		const secret = await this.api.readObject<{ data?: Record<string, string> }>(
			cluster.kubeconfig,
			'v1',
			'Secret',
			cluster.namespace,
			REDIS_OBJECT_NAMES.secret,
			cluster.context
		);
		return decodeSecretValue(secret?.data?.[REDIS_PASSWORD_KEY]);
	}

	/** `stopWorkloads` (R-15): scale to zero and touch nothing else. */
	private async stopWorkloads(cluster: RedisDependencyCluster): Promise<string[]> {
		const stopped: string[] = [];

		// Both shapes are read, not inferred from the declaration: an App Work whose App spec gained or lost
		// `persistence` can have either object on the cluster, and the plan's rule is about the workload that
		// exists ("scales the dependency's StatefulSet/Deployment … to 0", §4.9:625).
		const statefulSet = await this.api.readObject(
			cluster.kubeconfig,
			'apps/v1',
			'StatefulSet',
			cluster.namespace,
			REDIS_OBJECT_NAMES.statefulSet,
			cluster.context
		);
		if (statefulSet) {
			await this.api.applyObject(
				cluster.kubeconfig,
				scaleToZero('StatefulSet', REDIS_OBJECT_NAMES.statefulSet, cluster.namespace),
				cluster.context
			);
			stopped.push('StatefulSet');
		}

		const deployment = await this.api.readObject(
			cluster.kubeconfig,
			'apps/v1',
			'Deployment',
			cluster.namespace,
			REDIS_OBJECT_NAMES.deployment,
			cluster.context
		);
		if (deployment) {
			await this.api.applyObject(
				cluster.kubeconfig,
				scaleToZero('Deployment', REDIS_OBJECT_NAMES.deployment, cluster.namespace),
				cluster.context
			);
			stopped.push('Deployment');
		}

		return stopped;
	}

	/**
	 * `deleteData: true` — delete by label, then the PVCs, then re-list until nothing remains.
	 *
	 * The re-list deliberately covers **every** teardown kind including `PersistentVolumeClaim`: the
	 * volume is the one thing this call exists to destroy, so "we deleted what we could find" is not good
	 * enough — the answer is `deleted` only when a fresh label scan finds nothing (plan §4.9:628).
	 */
	private async deleteAll(cluster: RedisDependencyCluster): Promise<AppDependencyDeprovisionOutcome> {
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
		cluster: RedisDependencyCluster,
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
				`${APP_DEPENDENCY_POLICY_LABEL}=${REDIS_OBJECT_KIND}`,
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
		cluster: RedisDependencyCluster,
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
	 * The deadline is the contract's, delivered as an abort (FR-41's five minutes for Redis), and the
	 * injected clock plus the injected `sleep` are the only timing this provider has — so a unit test's
	 * five-minute deadline costs one loop rather than five minutes of wall time (ACC-07-16's "ready within
	 * 5 minutes"). `'exhausted'` is the runaway guard, not a deadline: a caller whose signal is never
	 * armed would otherwise spin forever.
	 */
	private async waitFor(
		ctx: AppDependencyContext,
		check: () => Promise<boolean>
	): Promise<'ready' | 'deadline' | 'aborted' | 'exhausted'> {
		const started = this.now();
		const localDeadline = this.options.readyTimeoutMs;
		const maxPolls = this.options.maxPolls ?? REDIS_READY_MAX_POLLS;
		// A function, not a local: the signal is aborted from outside (the job's own timer), so TypeScript's
		// narrowing of the first read must not make the second read look impossible.
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
		return this.options.pollIntervalMs ?? REDIS_READY_POLL_MS;
	}

	private teardownTimeoutMs(): number {
		return this.options.teardownTimeoutMs ?? REDIS_TEARDOWN_TIMEOUT_MS;
	}

	private maxPolls(): number {
		return this.options.maxPolls ?? REDIS_READY_MAX_POLLS;
	}

	private sleep(millis: number): Promise<void> {
		return this.options.sleep ? this.options.sleep(millis) : new Promise((resolve) => setTimeout(resolve, millis));
	}
}

/* ------------------------------------------------------------------------- *
 * Manifests (pure, and every one of them is asserted by a spec)
 * ------------------------------------------------------------------------- */

/** The `dep-redis` Secret — this provider's own generated password (plan §4.9:617). */
export function secretManifest(
	ctx: AppDependencyContext,
	cluster: RedisDependencyCluster,
	password: string
): AppDependencyRenderedObject {
	return {
		apiVersion: 'v1',
		kind: 'Secret',
		type: 'Opaque',
		metadata: {
			name: REDIS_OBJECT_NAMES.secret,
			namespace: cluster.namespace,
			labels: dependencyLabels({
				workId: String(ctx?.workId ?? ''),
				workSlug: cluster.workSlug,
				kind: REDIS_OBJECT_KIND
			})
		},
		// `data` rather than `stringData`: what the API server stores is what a later read returns, so
		// `getOutputs` reads back exactly the password this call generated instead of re-encoding a guess.
		data: { [REDIS_PASSWORD_KEY]: Buffer.from(password, 'utf8').toString('base64') }
	};
}

/**
 * `dep-redis:6379` (plan §4.9:617) — the one Service, `ClusterIP`.
 *
 * `type: ClusterIP` is stated rather than left to the default, because plan §4.9:580 forbids a
 * LoadBalancer or a NodePort for a dependency: nothing outside the cluster may reach Redis. The plan's
 * object list for this row names exactly one Service, so this provider renders one; a StatefulSet's
 * `serviceName` is required by the API but headlessness is not, and a headless Service would add a
 * second object the plan does not ask for.
 */
export function serviceManifest(
	ctx: AppDependencyContext,
	cluster: RedisDependencyCluster
): AppDependencyRenderedObject {
	return {
		apiVersion: 'v1',
		kind: 'Service',
		metadata: {
			name: REDIS_OBJECT_NAMES.service,
			namespace: cluster.namespace,
			labels: dependencyLabels({
				workId: String(ctx?.workId ?? ''),
				workSlug: cluster.workSlug,
				kind: REDIS_OBJECT_KIND
			})
		},
		spec: {
			type: 'ClusterIP',
			selector: dependencyPodSelector(REDIS_OBJECT_KIND),
			ports: [{ name: REDIS_OBJECT_KIND, port: REDIS_PORT, targetPort: REDIS_PORT, protocol: 'TCP' }]
		}
	};
}

/**
 * The `redis-server` arguments, in the plan's order (plan §4.9:617).
 *
 * `$(REDIS_PASSWORD)` is a Kubernetes dependent-variable reference, not this module's interpolation: the
 * literal string is what the manifest carries and the kubelet substitutes the Secret's value at container
 * start. `--appendonly yes` is the plan's own marker for the persistent shape only — a Deployment with
 * AOF would write to a container filesystem nobody keeps.
 */
export function redisServerArgs(input: { maxmemoryPolicy: string; persistence: boolean }): string[] {
	const args = [
		'--requirepass',
		'$(REDIS_PASSWORD)',
		'--maxmemory',
		REDIS_MAXMEMORY,
		'--maxmemory-policy',
		input.maxmemoryPolicy
	];
	if (input.persistence) args.push('--appendonly', 'yes');
	return args;
}

/**
 * The container's environment: the password twice, both times through `secretKeyRef`.
 *
 * `REDIS_PASSWORD` is what the kubelet expands `$(REDIS_PASSWORD)` from in the args, and `REDISCLI_AUTH`
 * is what `redis-cli` reads — so the readiness probe below names no credential and neither does any
 * argument (T20's Test line).
 */
export function redisContainerEnv(): Record<string, unknown>[] {
	const fromSecret = (name: string): Record<string, unknown> => ({
		name,
		valueFrom: { secretKeyRef: { name: REDIS_OBJECT_NAMES.secret, key: REDIS_PASSWORD_KEY } }
	});
	return [fromSecret('REDIS_PASSWORD'), fromSecret('REDISCLI_AUTH')];
}

/** The single container both shapes run. */
function redisContainer(ctx: AppDependencyContext, input: RedisProvisionInput): Record<string, unknown> {
	return {
		name: REDIS_OBJECT_KIND,
		image: redisImageFor(ctx?.settings),
		imagePullPolicy: 'IfNotPresent',
		args: redisServerArgs(input),
		ports: [{ name: REDIS_OBJECT_KIND, containerPort: REDIS_PORT, protocol: 'TCP' }],
		env: redisContainerEnv(),
		// `redis-cli ping` answers `PONG` only once the server has loaded its dataset and accepts
		// authenticated commands; REDISCLI_AUTH (above) is what makes the probe authenticated without ever
		// putting the password in the command. `initialDelaySeconds` is generous for the same reason Redis's
		// deadline is five minutes: loading a large AOF is legitimate work, not a hang.
		readinessProbe: {
			exec: { command: ['redis-cli', 'ping'] },
			initialDelaySeconds: 5,
			periodSeconds: 5,
			timeoutSeconds: 3,
			failureThreshold: 12
		},
		// The plan fixes the memory limit and nothing else (plan §4.9:617): the App Work's namespace carries
		// APW-06's `LimitRange` (`ew-defaults`, plan §4.8:552), which supplies the request defaults for a
		// container that declares none.
		resources: { limits: { memory: REDIS_MEMORY_LIMIT } },
		securityContext: dependencyContainerSecurityContext()
	};
}

/**
 * The non-persistent shape: a Deployment, one replica, no volume at all (plan §4.9:617, FR-36).
 *
 * `strategy: Recreate` rather than the default rolling update: two Redis pods would briefly both answer
 * on the Service while the old one still holds the AOF and the cache, and there is nothing to drain.
 */
export function deploymentManifest(
	ctx: AppDependencyContext,
	cluster: RedisDependencyCluster,
	input: RedisProvisionInput
): AppDependencyRenderedObject {
	const labels = dependencyLabels({
		workId: String(ctx?.workId ?? ''),
		workSlug: cluster.workSlug,
		kind: REDIS_OBJECT_KIND
	});

	return {
		apiVersion: 'apps/v1',
		kind: 'Deployment',
		metadata: { name: REDIS_OBJECT_NAMES.deployment, namespace: cluster.namespace, labels },
		spec: {
			replicas: 1,
			strategy: { type: 'Recreate' },
			selector: { matchLabels: dependencyPodSelector(REDIS_OBJECT_KIND) },
			template: {
				metadata: { labels: { ...labels, ...dependencyPodSelector(REDIS_OBJECT_KIND) } },
				spec: {
					securityContext: dependencyPodSecurityContext({}),
					containers: [redisContainer(ctx, input)]
				}
			}
		}
	};
}

/**
 * The persistent shape: a StatefulSet with a claim sized by FR-37 / `ctx.sizeGiB` (plan §4.9:617).
 *
 * The claim's `metadata.labels` are what the created PVC carries — including
 * `ever-works.io/retain: "true"`, which is why the volume survives its StatefulSet and why APW-06's
 * `destroyApp` refuses to delete it without `deleteVolumes` (R-15). In the ephemeral variant (R-10) the
 * pod runs on an `emptyDir` instead: nothing may outlive the verification namespace, so a claim — even
 * one with a `storageClassName` — is never rendered.
 */
export function statefulSetManifest(
	ctx: AppDependencyContext,
	cluster: RedisDependencyCluster,
	input: RedisProvisionInput
): AppDependencyRenderedObject {
	const labels = dependencyLabels({
		workId: String(ctx?.workId ?? ''),
		workSlug: cluster.workSlug,
		kind: REDIS_OBJECT_KIND
	});

	const manifest: AppDependencyRenderedObject = {
		apiVersion: 'apps/v1',
		kind: 'StatefulSet',
		metadata: { name: REDIS_OBJECT_NAMES.statefulSet, namespace: cluster.namespace, labels },
		spec: {
			serviceName: REDIS_OBJECT_NAMES.service,
			replicas: 1,
			selector: { matchLabels: dependencyPodSelector(REDIS_OBJECT_KIND) },
			template: {
				metadata: { labels: { ...labels, ...dependencyPodSelector(REDIS_OBJECT_KIND) } },
				spec: {
					securityContext: dependencyPodSecurityContext({}),
					containers: [
						{
							...redisContainer(ctx, input),
							volumeMounts: [{ name: REDIS_VOLUME_NAME, mountPath: REDIS_DATA_PATH }]
						}
					]
				}
			}
		}
	};

	const spec = manifest.spec as Record<string, unknown>;

	if (input.ephemeral) {
		(manifest.spec as { template: { spec: Record<string, unknown> } }).template.spec.volumes = [
			{ name: REDIS_VOLUME_NAME, emptyDir: {} }
		];
		return manifest;
	}

	spec.volumeClaimTemplates = [
		{
			metadata: {
				name: REDIS_VOLUME_NAME,
				labels: dependencyPvcLabels({
					workId: String(ctx?.workId ?? ''),
					workSlug: cluster.workSlug,
					kind: REDIS_OBJECT_KIND
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

/* ------------------------------------------------------------------------- *
 * Pure helpers
 * ------------------------------------------------------------------------- */

/** The plan's four outputs (plan §4.9:617, FR-40). */
export function redisOutputs(cluster: RedisDependencyCluster, password: string): Record<string, string> {
	const host = `${REDIS_OBJECT_NAMES.service}.${cluster.namespace}.svc.cluster.local`;
	return {
		host,
		port: String(REDIS_PORT),
		password,
		url: `redis://:${encodeURIComponent(password)}@${host}:${REDIS_PORT}/0`
	};
}

/** A 32-hex password from `node:crypto` — never a predictable or derived value. */
export function generatePassword(bytes: number = REDIS_PASSWORD_BYTES): string {
	return randomBytes(bytes).toString('hex');
}

/**
 * The declared `redis.version`, reduced to the one major this plugin can pin.
 *
 * `"7"` and `7` are the App spec's own spellings (`APW-03/schema.md:222`); anything else — absent,
 * `latest`, `"6"` — is {@link REDIS_DEFAULT_VERSION} with a warning naming the request, because a value
 * this plugin cannot honour must be reported rather than silently swapped. The version never reaches an
 * image reference: {@link redisImageFor} pins the digest from `images.ts`.
 */
export function declaredVersion(ctx: AppDependencyContext, warnings: string[] = []): string {
	const declared = (ctx?.declared ?? {}) as Record<string, unknown>;
	const raw = declared.version;
	const text = raw === undefined || raw === null ? '' : String(raw).trim();
	if (!text) return REDIS_SUPPORTED_VERSION;
	if (text === REDIS_SUPPORTED_VERSION) return REDIS_SUPPORTED_VERSION;

	warnings.push(`redisVersionUnsupported=${text}`);
	return REDIS_SUPPORTED_VERSION;
}

/** `redis.persistence` — only the boolean `true` asks for a volume (FR-36). */
export function declaredPersistence(ctx: AppDependencyContext): boolean {
	const declared = (ctx?.declared ?? {}) as Record<string, unknown>;
	return declared.persistence === true;
}

/**
 * The declared `redis.maxmemoryPolicy`, validated against the App spec's closed set.
 *
 * A declaration reaches `redis-server`'s `--maxmemory-policy`, so a value outside the enum is **dropped**
 * for the documented default with a warning — never passed through. `noeviction` is the schema's own
 * default and the safe one: an unknown policy silently accepted as `allkeys-lru` would let Redis evict a
 * queue the app treats as durable.
 */
export function declaredMaxmemoryPolicy(ctx: AppDependencyContext, warnings: string[] = []): string {
	const declared = (ctx?.declared ?? {}) as Record<string, unknown>;
	const raw = declared.maxmemoryPolicy;
	if (raw === undefined || raw === null || raw === '') return REDIS_MAXMEMORY_POLICY_DEFAULT;

	const text = String(raw).trim();
	if ((REDIS_MAXMEMORY_POLICIES as readonly string[]).includes(text)) return text;

	warnings.push(`maxmemoryPolicyUnsupported=${text}`);
	return REDIS_MAXMEMORY_POLICY_DEFAULT;
}

/** A `replicas: 0` patch — the shape `stopWorkloads` writes and nothing else does. */
function scaleToZero(kind: string, name: string, namespace: string): Record<string, unknown> {
	return {
		apiVersion: 'apps/v1',
		kind,
		metadata: { name, namespace },
		spec: { replicas: 0 }
	};
}

/** The work slug: APW-06's own `part-of` label when it is there, the context's app name otherwise. */
function workSlugOf(ctx: AppDependencyContext): string {
	const labelled = ctx?.cluster?.appLabels?.['app.kubernetes.io/part-of'];
	const slug = typeof labelled === 'string' && labelled.trim() ? labelled.trim() : String(ctx?.appName ?? '');
	return slug.trim();
}

/** The context's cluster half, or `null` when the caller handed us nothing to write to. */
function requireCluster(ctx: AppDependencyContext): RedisDependencyCluster | null {
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
	maxPolls: number = REDIS_READY_MAX_POLLS
): AppDependencyProvisionOutcome {
	return {
		state: 'pending',
		retryAfterMs: pollIntervalMs,
		detail: { kind: REDIS_PROVIDER_KIND, waitedPolls: maxPolls }
	};
}

/**
 * The failure a readiness wait ends in — the kind's deadline, or the caller's own abort (FR-41).
 *
 * A persistent Redis whose pod never became ready is reported as `volumeNotReady` (the contract's member
 * for the card line "The volume didn't become ready within {minutes} minutes"), because the claim is the
 * one thing that could keep the pod unschedulable; the non-persistent shape has no such excuse and reads
 * `deadlineExceeded`.
 */
function waitFailure(input: RedisProvisionInput, outcome: 'deadline' | 'aborted'): AppDependencyProvisionOutcome {
	return {
		state: 'failed',
		reason: input.persistence && !input.ephemeral ? 'volumeNotReady' : 'deadlineExceeded',
		transient: false,
		detail: {
			kind: REDIS_PROVIDER_KIND,
			aborted: outcome === 'aborted' ? 'true' : 'false',
			persistence: input.persistence ? 'true' : 'false'
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
