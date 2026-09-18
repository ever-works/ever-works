/**
 * APW-07 T19 — `k8s-inline-postgres`: the Postgres dependency on the owner's own cluster.
 *
 * Sources, in priority order:
 *
 * 1. `docs/specs/features/app-works/APW-07-app-env-and-dependencies/plan.md` §4.9:613-633 — the two rows of the
 *    provider table (operator path and plain path), the readiness rules, the outputs and the backup state.
 * 2. `plan.md` §4.9:620-628 — outputs read from cluster Secrets, the ephemeral variant (R-10), and deprovision
 *    with `deleteData` / `stopWorkloads`.
 * 3. `spec.md` FR-36 (the operator when its resources exist **and** access may create them, otherwise a
 *    single-replica database with a persistent volume), FR-38 (reachable only from the App Work's own pods),
 *    FR-40 (`directUrl` only when declared), FR-43 (a definite failure fails at once with its reason),
 *    FR-48/FR-49 (the backup line comes from individual records, never a summary) and ACC-07-14/-15.
 *
 * ## The two paths, and the one thing that chooses between them
 *
 * {@link probePostgresOperator} answers FR-36's conjunction: the `Cluster` CRD is **served** and one
 * `SelfSubjectAccessReview` says the credential **may create** `clusters` in the App Work's namespace. Both
 * false answers are a *reason*, not a failure — the plain path runs instead and the card is told why through
 * the warning `operatorSkipped=<noPermission|crdNotServed>` (`statusDetail.operatorSkipped`, plan §4.9:610 /
 * §9.2:954; the provision outcome has no `statusDetail` member, so the plan's field travels as this warning).
 *
 * A genuinely unreachable cluster — not a refusal — is the one case that does **not** fall back: provisioning
 * a second, unmanaged database beside an operator's cluster because a read timed out is worse than retrying,
 * so that error propagates and the caller records the transient `clusterUnreachable` (FR-43).
 *
 * ## Nothing is read from a summary
 *
 * `Cluster.status.lastSuccessfulBackup` is never read (FR-49, plan §4.9:615): the backup state comes from the
 * individual `Backup` objects. `PostgresBackupObject` deliberately does not even model a cluster's `status`,
 * so the forbidden read is unavailable rather than merely avoided.
 *
 * ## Every write is ordered
 *
 * The `dep-postgres` NetworkPolicy is applied **before** the `Cluster` / StatefulSet it protects
 * (plan §4.9:582-602, APW07-G01), and it is drawn whatever the App Work's isolation setting is: this class has
 * no isolation input at all, so there is nothing that could switch it off.
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
	POSTGRES_OPERATOR_API_VERSION,
	defaultStorageClass,
	dependencyContainerSecurityContext,
	dependencyLabels,
	dependencyName,
	dependencyPodSecurityContext,
	dependencyPodSelector,
	dependencyProviderSettings,
	dependencyPvcLabels,
	dependencyResourceRefs,
	dependencySizeGiB,
	gibQuantity,
	isForbidden,
	planDependencyNetworkPolicy,
	postgresBackupStatus,
	postgresOperatorLabelSelector,
	probePostgresOperator,
	type AppDependencyApi,
	type AppDependencyObjectRef,
	type AppDependencyOperatorSkipped,
	type AppDependencyRenderedObject,
	type PostgresBackupObject,
	type PostgresScheduledBackupObject
} from './common.js';
import {
	POSTGRES_DEFAULT_VERSION,
	dependencyImageOverrides,
	isSupportedPostgresVersion,
	normalisePostgresVersion,
	postgresClientImage,
	postgresImage,
	type PostgresMajorVersion
} from './images.js';

/* ------------------------------------------------------------------------- *
 * Constants
 * ------------------------------------------------------------------------- */

/** The provider id — `APP_DEPENDENCY_PROVIDER_IDS[0]`, and what the owner's explicit choice names. */
export const POSTGRES_PROVIDER_ID = 'k8s-inline-postgres';

/** The kind this provider serves. */
export const POSTGRES_PROVIDER_KIND: AppDependencyKind = 'postgres';

/** The local part of every `dep-postgres…` object name (plan §4.9:573). */
export const POSTGRES_OBJECT_KIND = 'postgres';

/** The database, its owner and the application user are all `app` (plan §4.9:615-616). */
export const POSTGRES_APP_NAME = 'app';

/** The output port (plan §4.9:616). */
export const POSTGRES_PORT = APP_DEPENDENCY_PORTS.postgres;

/** The `PGDATA` the official image needs, one level below the mount, to keep its cluster in the volume. */
export const POSTGRES_PGDATA = '/var/lib/postgresql/data/pgdata';

/** The volume-mount path. */
export const POSTGRES_DATA_PATH = '/var/lib/postgresql/data';

/** The plain path's generated password length — 16 random bytes, hex (plan §4.9:616 "password = 32 hex"). */
export const POSTGRES_PASSWORD_BYTES = 16;

/** The plain path's container requests (plan §4.9:616 — "requests 250m/512Mi, memory limit 1Gi"). */
export const POSTGRES_REQUESTS = { cpu: '250m', memory: '512Mi' } as const;

/** The plain path's memory limit. */
export const POSTGRES_MEMORY_LIMIT = '1Gi';

/** The uid/gid/fsGroup the official image runs as (plan §4.9:616). */
export const POSTGRES_UID = 999;

/** The operator's app Secret — the operator creates and owns it (plan §4.9:615). */
export const POSTGRES_OPERATOR_APP_SECRET = 'dep-postgres-app';

/** The operator's read-write Service — the one the outputs point at. */
export const POSTGRES_OPERATOR_RW_SERVICE = 'dep-postgres-rw';

/** The plain path's object names, all `dep-<kind>…` per plan §4.9:573. */
export const POSTGRES_OBJECT_NAMES = {
	secret: dependencyName(POSTGRES_OBJECT_KIND),
	statefulSet: dependencyName(POSTGRES_OBJECT_KIND),
	headlessService: `${dependencyName(POSTGRES_OBJECT_KIND)}-hl`,
	service: dependencyName(POSTGRES_OBJECT_KIND),
	extensionsJob: `${dependencyName(POSTGRES_OBJECT_KIND)}-ext`
} as const;

/** A SQL identifier — the ONLY shape an App-spec-declared extension name may have. */
const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/** How often a readiness wait re-reads the cluster. */
export const POSTGRES_READY_POLL_MS = 5_000;

/**
 * The most observations one readiness wait makes before answering `pending`.
 *
 * An hour at the default poll interval — far past every kind's FR-41 deadline, so a real caller (whose signal
 * the job aborts at that deadline) is never affected. It exists so a caller that forgets to arm a signal gets a
 * retryable `pending` instead of a tight loop.
 */
export const POSTGRES_READY_MAX_POLLS = 720;

/** How long a `deleteData` teardown keeps re-listing (plan §4.9:628 — "≤ 5 minutes"). */
export const POSTGRES_TEARDOWN_TIMEOUT_MS = 300_000;

/**
 * The descriptor the plugin publishes for this provider (plan §4.7:471-479, §4.8:544-546).
 *
 * `preference: 10` is the plan's number for every `k8s-inline-*` provider, and `backupPolicy: 'operator'` is
 * the one that matches the operator row of §4.9's table: the plain path answers `none`, which is the card's
 * no-backup warning.
 */
export const POSTGRES_PROVIDER_DESCRIPTOR: AppDependencyProviderDescriptor = {
	id: POSTGRES_PROVIDER_ID,
	kind: POSTGRES_PROVIDER_KIND,
	targets: ['your-cluster'],
	label: 'In your cluster · single instance',
	preference: 10,
	backupPolicy: 'operator'
};

/* ------------------------------------------------------------------------- *
 * What a call needs that the contract does not fix
 * ------------------------------------------------------------------------- */

/** Everything a provider call needs beyond the contract's context. */
export interface PostgresProviderOptions {
	/** Epoch milliseconds. Defaults to `Date.now`; the specs inject a virtual clock. */
	now?: () => number;
	/** The only way this provider waits. Defaults to `setTimeout`; the specs inject a virtual clock. */
	sleep?: (millis: number) => Promise<void>;
	/** The readiness poll interval. Defaults to {@link POSTGRES_READY_POLL_MS}. */
	pollIntervalMs?: number;
	/**
	 * An optional **local** readiness bound, in ms. Unset by default, and that is deliberate: FR-41's deadline
	 * belongs to the contract's `APP_DEPENDENCY_READY_DEADLINE_MS` and reaches a provider through
	 * `ctx.signal`, which the job aborts at the kind's deadline ("Aborted at the kind's readiness deadline
	 * (FR-41) — providers must honour it", `app-dependency.interface.ts`). A second copy of the number here
	 * would be a second source of truth for the same deadline, so this option exists only for a caller that
	 * wants a tighter bound of its own.
	 */
	readyTimeoutMs?: number;
	/**
	 * How many observations a readiness wait makes before answering `pending` instead of looping
	 * (`{@link POSTGRES_READY_MAX_POLLS}` by default). A runaway guard for a caller whose signal is never
	 * armed — never the kind's deadline, which arrives as the abort.
	 */
	maxPolls?: number;
	/** The `deleteData` teardown budget. Defaults to {@link POSTGRES_TEARDOWN_TIMEOUT_MS}. */
	teardownTimeoutMs?: number;
}

/** The cluster half of a context, once it is known to be present. */
export interface PostgresDependencyCluster {
	kubeconfig: string;
	context?: string;
	namespace: string;
	workSlug: string;
}

/** The values one provisioning attempt renders from. */
export interface PostgresProvisionInput {
	version: PostgresMajorVersion;
	sizeGiB: number;
	extensions: string[];
	warnings: string[];
	storageClass: string | null;
	ephemeral: boolean;
}

/* ------------------------------------------------------------------------- *
 * The provider
 * ------------------------------------------------------------------------- */

/**
 * `k8s-inline-postgres` — one instance per plugin, stateless between calls: every fact a call needs is read
 * from the cluster or passed in, so a retry is a fresh attempt rather than a resumed one.
 */
export class PostgresDependencyProvider {
	constructor(
		private readonly api: AppDependencyApi,
		private readonly options: PostgresProviderOptions = {}
	) {}

	/** The descriptor the plugin publishes. A method, so the plugin never restates the object. */
	descriptor(): AppDependencyProviderDescriptor {
		return POSTGRES_PROVIDER_DESCRIPTOR;
	}

	/**
	 * Does this provider serve `(kind, target)`?
	 *
	 * The answer depends on the pair alone: the plan gives the context to `supports` for providers whose
	 * *offer* depends on it (`platform-smtp-relay` is offered only while its admin settings are complete), and
	 * an in-cluster Postgres is offered to every `your-cluster` App Work. Whether the cluster can actually take
	 * it is `provision`'s answer, with its own reason.
	 */
	async supports(kind: AppDependencyKind, target: AppDependencyTarget): Promise<AppDependencySupport> {
		if (kind === POSTGRES_PROVIDER_KIND && target === 'your-cluster') {
			return { supported: true, providerId: POSTGRES_PROVIDER_ID };
		}
		return { supported: false, reason: 'providerNotSupported' };
	}

	/**
	 * Create (or re-observe) the App Work's Postgres.
	 *
	 * The order is the plan's: probe, then policy, then workload. `pending` means "not ready yet, ask again" and
	 * carries the poll interval; `failed` always carries one of the contract's reasons and says whether a retry
	 * could help (FR-43).
	 */
	async provision(providerId: string, ctx: AppDependencyContext): Promise<AppDependencyProvisionOutcome> {
		if (providerId !== POSTGRES_PROVIDER_ID) {
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
		const version = declaredVersion(ctx, warnings);
		const input: PostgresProvisionInput = {
			version,
			sizeGiB: dependencySizeGiB('postgres', ctx?.settings, ctx?.sizeGiB),
			extensions: declaredExtensions(ctx),
			warnings,
			storageClass: dependencyProviderSettings(ctx?.settings).storageClass,
			ephemeral: ctx?.ephemeral === true
		};
		if (input.ephemeral) warnings.push('ephemeralNoPersistence');

		if (!input.ephemeral) {
			let probe;
			try {
				probe = await probePostgresOperator(this.api, cluster.kubeconfig, cluster.namespace, cluster.context);
			} catch (error) {
				return transientClusterFailure(error);
			}
			if (probe.usable) return this.provisionWithOperator(ctx, cluster, input, probe.operatorNamespace);
			warnings.push(operatorSkippedWarning(probe.operatorSkipped));
		}

		return this.provisionPlain(ctx, cluster, input);
	}

	/**
	 * Re-read what the dependency publishes (the `refresh` mode).
	 *
	 * The outputs always come back out of the cluster — a Secret's keys and a Service name — never out of a
	 * stored copy, so a refresh sees a rotated password. A missing Secret throws, which the caller reports as
	 * `degraded outputsUnavailable` (plan §9.2:955) rather than as an empty set of outputs.
	 */
	async getOutputs(providerId: string, ctx: AppDependencyContext): Promise<Record<string, string>> {
		if (providerId !== POSTGRES_PROVIDER_ID) {
			throw dependencyError('providerNotSupported', `'${providerId}' is not served by this provider.`);
		}

		const cluster = requireCluster(ctx);
		if (!cluster) throw dependencyError('clusterUnreachable', 'The dependency has no cluster to read from.');

		const plain = await this.readPlainCredentials(ctx, cluster);
		if (plain) return plain.outputs;

		const operator = await this.readOperatorCredentials(cluster);
		if (operator) return operator.outputs;

		throw dependencyError(
			'clusterUnreachable',
			`Neither '${POSTGRES_OBJECT_NAMES.secret}' nor '${POSTGRES_OPERATOR_APP_SECRET}' exists in namespace '${cluster.namespace}'.`
		);
	}

	/**
	 * Release, or destroy, the App Work's Postgres (plan §4.9:624-628, §4.12).
	 *
	 * - `deleteData: false` **without** `stopWorkloads` makes **no cluster call at all** and answers
	 *   `released`; the dependency keeps running and its row becomes `kept`.
	 * - `deleteData: false` **with** `stopWorkloads` (App Work deletion, R-15) scales the workload to zero and
	 *   touches nothing else — no PVC, no Secret, no NetworkPolicy.
	 * - `deleteData: true` deletes by the `ever-works.io/dependency` label and then the PVCs explicitly,
	 *   re-listing until nothing is left or the budget runs out (`pending` + `remaining`).
	 */
	async deprovision(
		providerId: string,
		ctx: AppDependencyContext,
		opts: AppDependencyDeprovisionOptions
	): Promise<AppDependencyDeprovisionOutcome> {
		if (providerId !== POSTGRES_PROVIDER_ID) return { state: 'released' };

		const cluster = requireCluster(ctx);
		if (!cluster) return { state: 'released' };

		if (opts?.deleteData !== true) {
			if (opts?.stopWorkloads === true) await this.stopWorkloads(cluster);
			return { state: 'released' };
		}

		return this.deleteAll(cluster);
	}

	/**
	 * FR-48/FR-49's one backup state.
	 *
	 * No `Cluster` object means the plain path provisioned this dependency — nothing takes backups, so the card
	 * reads `none` (its no-backup warning). With a `Cluster`, the state is computed from the individual `Backup`
	 * objects by `postgresBackupStatus`; a read that fails answers `unknown` rather than `failing`, because "we
	 * could not check" and "the last attempt failed" are different cards.
	 */
	async backupStatus(providerId: string, ctx: AppDependencyContext): Promise<AppDependencyBackupStatus> {
		if (providerId !== POSTGRES_PROVIDER_ID) return { state: 'none' };

		const cluster = requireCluster(ctx);
		if (!cluster) return { state: 'unknown' };

		try {
			const live = await this.api.readObject(
				cluster.kubeconfig,
				POSTGRES_OPERATOR_API_VERSION,
				'Cluster',
				cluster.namespace,
				dependencyName(POSTGRES_OBJECT_KIND),
				cluster.context
			);
			if (!live) return { state: 'none' };

			const selector = postgresOperatorLabelSelector(dependencyName(POSTGRES_OBJECT_KIND));
			const backups = await this.api.listObjects<PostgresBackupObject>(
				cluster.kubeconfig,
				POSTGRES_OPERATOR_API_VERSION,
				'Backup',
				cluster.namespace,
				selector,
				cluster.context
			);
			const scheduled = await this.api.listObjects<PostgresScheduledBackupObject>(
				cluster.kubeconfig,
				POSTGRES_OPERATOR_API_VERSION,
				'ScheduledBackup',
				cluster.namespace,
				selector,
				cluster.context
			);

			return postgresBackupStatus({ backups, scheduledBackups: scheduled, now: this.now() });
		} catch {
			return { state: 'unknown' };
		}
	}

	/* --------------------------------------------------------------------- *
	 * The operator path
	 * --------------------------------------------------------------------- */

	private async provisionWithOperator(
		ctx: AppDependencyContext,
		cluster: PostgresDependencyCluster,
		input: PostgresProvisionInput,
		operatorNamespace: string | null
	): Promise<AppDependencyProvisionOutcome> {
		const policy = planDependencyNetworkPolicy({
			kind: POSTGRES_OBJECT_KIND,
			namespace: cluster.namespace,
			workId: String(ctx?.workId ?? ''),
			workSlug: cluster.workSlug,
			port: POSTGRES_PORT,
			operatorNamespace,
			operatorFallback: operatorNamespace === null
		});

		// The policy goes first — always, and whatever the App Work's isolation setting is (APW07-G01).
		try {
			await this.api.applyObject(cluster.kubeconfig, policy.policy, cluster.context);
		} catch (error) {
			return applyFailure(error, 'NetworkPolicy');
		}

		// `operatorNamespaceUnknown` is the *policy's* warning (plan §4.9:591-592): drawing the fallback rule is
		// what produced it, so it travels with the object that carries it.
		const warnings = [...input.warnings, ...policy.warnings];

		try {
			await this.api.applyObject(
				cluster.kubeconfig,
				operatorClusterManifest(ctx, cluster, input),
				cluster.context
			);
		} catch (error) {
			return applyFailure(error, 'Cluster');
		}

		const outcome = await this.waitFor(ctx, async () => {
			const live = await this.api.readObject<{ status?: { readyInstances?: number } }>(
				cluster.kubeconfig,
				POSTGRES_OPERATOR_API_VERSION,
				'Cluster',
				cluster.namespace,
				dependencyName(POSTGRES_OBJECT_KIND),
				cluster.context
			);
			return live?.status?.readyInstances === 1;
		});
		if (outcome === 'exhausted') return exhaustedOutcome(this.pollIntervalMs(), 'operator', this.maxPolls());
		if (outcome !== 'ready') return waitFailure(input, 'operator', outcome);

		const credentials = await this.readOperatorCredentials(cluster);
		if (!credentials) {
			return {
				state: 'pending',
				retryAfterMs: this.pollIntervalMs(),
				detail: { waitingFor: POSTGRES_OPERATOR_APP_SECRET }
			};
		}

		return {
			state: 'ready',
			outputs: credentials.outputs,
			actualVersion: String(input.version),
			resourceRefs: dependencyResourceRefs(
				cluster.namespace,
				[
					{ kind: 'NetworkPolicy', name: dependencyName(POSTGRES_OBJECT_KIND) },
					{ kind: 'Cluster', name: dependencyName(POSTGRES_OBJECT_KIND) },
					{ kind: 'Secret', name: POSTGRES_OPERATOR_APP_SECRET },
					{ kind: 'Service', name: POSTGRES_OPERATOR_RW_SERVICE }
				],
				{ databases: [POSTGRES_APP_NAME] }
			),
			...(warnings.length > 0 ? { warnings: [...warnings] } : {})
		};
	}

	/* --------------------------------------------------------------------- *
	 * The plain path
	 * --------------------------------------------------------------------- */

	private async provisionPlain(
		ctx: AppDependencyContext,
		cluster: PostgresDependencyCluster,
		input: PostgresProvisionInput
	): Promise<AppDependencyProvisionOutcome> {
		let storageClass = input.storageClass;

		if (!input.ephemeral && !storageClass) {
			try {
				storageClass = await defaultStorageClass(this.api, cluster.kubeconfig, cluster.context);
			} catch (error) {
				return transientClusterFailure(error);
			}
			if (!storageClass) {
				// ACC-07-20 / S18: a definite failure carrying the reason the card renders verbatim. No object is
				// written — a StatefulSet whose claim can never bind would leave a Pending PVC behind.
				return {
					state: 'failed',
					reason: 'noDefaultStorageClass',
					transient: false,
					detail: {
						message: 'Your cluster has no default storage class. Choose one in Dependency settings.',
						kind: POSTGRES_PROVIDER_KIND
					}
				};
			}
		}

		const path: PostgresProvisionInput = { ...input, storageClass };

		const policy = planDependencyNetworkPolicy({
			kind: POSTGRES_OBJECT_KIND,
			namespace: cluster.namespace,
			workId: String(ctx?.workId ?? ''),
			workSlug: cluster.workSlug,
			port: POSTGRES_PORT
		});

		// The policy goes first — always, and whatever the App Work's isolation setting is (APW07-G01).
		try {
			await this.api.applyObject(cluster.kubeconfig, policy.policy, cluster.context);
		} catch (error) {
			return applyFailure(error, 'NetworkPolicy');
		}

		// Reuse the stored password when there is one: re-provisioning must never rotate the password of a
		// database that already holds data.
		const existing = await this.readPlainCredentials(ctx, cluster);
		const password = existing?.password ?? generatePassword();

		try {
			await this.api.applyObject(
				cluster.kubeconfig,
				plainSecretManifest(ctx, cluster, password),
				cluster.context
			);
		} catch (error) {
			return applyFailure(error, 'Secret');
		}

		for (const object of plainServiceManifests(ctx, cluster)) {
			try {
				await this.api.applyObject(cluster.kubeconfig, object, cluster.context);
			} catch (error) {
				return applyFailure(error, String(object.kind));
			}
		}

		try {
			await this.api.applyObject(
				cluster.kubeconfig,
				plainStatefulSetManifest(ctx, cluster, path),
				cluster.context
			);
		} catch (error) {
			// plan §4.9:604-611 / APW07-G10: `statefulsets` is the one *required* permission this epic adds, so a
			// refusal here is a definite failure naming it rather than a silent downgrade.
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

		const outcome = await this.waitFor(ctx, async () => {
			const live = await this.api.readObject<{ status?: { readyReplicas?: number } }>(
				cluster.kubeconfig,
				'apps/v1',
				'StatefulSet',
				cluster.namespace,
				POSTGRES_OBJECT_NAMES.statefulSet,
				cluster.context
			);
			return live?.status?.readyReplicas === 1;
		});
		if (outcome === 'exhausted') return exhaustedOutcome(this.pollIntervalMs(), 'plain', this.maxPolls());
		if (outcome !== 'ready') return waitFailure(path, 'plain', outcome);

		if (path.extensions.length > 0) {
			try {
				await this.api.applyObject(
					cluster.kubeconfig,
					extensionsJobManifest(ctx, cluster, path.extensions, path.version),
					cluster.context
				);
			} catch (error) {
				return applyFailure(error, 'Job');
			}

			const applied = await this.extensionsApplied(cluster);
			if (applied === 'failed') {
				return {
					state: 'failed',
					reason: 'extensionUnavailable',
					transient: false,
					detail: { extensions: [...path.extensions] }
				};
			}
			if (applied === 'pending') {
				return { state: 'pending', retryAfterMs: this.pollIntervalMs(), detail: { waitingFor: 'extensions' } };
			}
		}

		const objects: AppDependencyObjectRef[] = [
			{ kind: 'NetworkPolicy', name: dependencyName(POSTGRES_OBJECT_KIND) },
			{ kind: 'Secret', name: POSTGRES_OBJECT_NAMES.secret },
			{ kind: 'StatefulSet', name: POSTGRES_OBJECT_NAMES.statefulSet },
			{ kind: 'Service', name: POSTGRES_OBJECT_NAMES.service },
			{ kind: 'Service', name: POSTGRES_OBJECT_NAMES.headlessService }
		];
		if (path.extensions.length > 0) {
			objects.push({ kind: 'Job', name: POSTGRES_OBJECT_NAMES.extensionsJob });
		}

		return {
			state: 'ready',
			outputs: plainOutputs(cluster, { password, directUrl: declaredDirectUrl(ctx) }),
			actualVersion: String(path.version),
			resourceRefs: dependencyResourceRefs(cluster.namespace, objects, { databases: [POSTGRES_APP_NAME] }),
			...(path.warnings.length > 0 ? { warnings: [...path.warnings] } : {})
		};
	}

	/** Has the extension Job finished, and did it succeed? */
	private async extensionsApplied(cluster: PostgresDependencyCluster): Promise<'succeeded' | 'failed' | 'pending'> {
		const live = await this.api.readObject<{ status?: { succeeded?: number; failed?: number } }>(
			cluster.kubeconfig,
			'batch/v1',
			'Job',
			cluster.namespace,
			POSTGRES_OBJECT_NAMES.extensionsJob,
			cluster.context
		);
		if ((live?.status?.failed ?? 0) > 0) return 'failed';
		return (live?.status?.succeeded ?? 0) > 0 ? 'succeeded' : 'pending';
	}

	/** The plain path's credentials, read back out of its own Secret — `null` when the Secret is absent. */
	private async readPlainCredentials(
		ctx: AppDependencyContext,
		cluster: PostgresDependencyCluster
	): Promise<{ password: string; outputs: Record<string, string> } | null> {
		const secret = await this.api.readObject<{ data?: Record<string, string> }>(
			cluster.kubeconfig,
			'v1',
			'Secret',
			cluster.namespace,
			POSTGRES_OBJECT_NAMES.secret,
			cluster.context
		);
		const password = decodeSecretValue(secret?.data?.password);
		if (!password) return null;
		return { password, outputs: plainOutputs(cluster, { password, directUrl: declaredDirectUrl(ctx) }) };
	}

	/** The operator's app credentials, read out of the Secret it writes — `null` until it exists. */
	private async readOperatorCredentials(
		cluster: PostgresDependencyCluster
	): Promise<{ outputs: Record<string, string> } | null> {
		const secret = await this.api.readObject<{ data?: Record<string, string> }>(
			cluster.kubeconfig,
			'v1',
			'Secret',
			cluster.namespace,
			POSTGRES_OPERATOR_APP_SECRET,
			cluster.context
		);
		if (!secret?.data) return null;

		const user = decodeSecretValue(secret.data.username) ?? POSTGRES_APP_NAME;
		const password = decodeSecretValue(secret.data.password);
		const database = decodeSecretValue(secret.data.dbname) ?? POSTGRES_APP_NAME;
		if (!password) return null;

		const host = `${POSTGRES_OPERATOR_RW_SERVICE}.${cluster.namespace}.svc.cluster.local`;
		// The plan fixes `sslmode=disable` for the plain path only (plan.md §4.9:616); the operator's own Service
		// speaks TLS, so this URL carries no `sslmode` and libpq's own default (negotiate, then fall back) applies
		// rather than a value this module would have had to invent.
		const url = `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${POSTGRES_PORT}/${encodeURIComponent(database)}`;

		return { outputs: { host, port: String(POSTGRES_PORT), database, user, password, url, directUrl: url } };
	}

	/** `stopWorkloads` (R-15): scale to zero and touch nothing else. */
	private async stopWorkloads(cluster: PostgresDependencyCluster): Promise<void> {
		const operatorCluster = await this.api.readObject(
			cluster.kubeconfig,
			POSTGRES_OPERATOR_API_VERSION,
			'Cluster',
			cluster.namespace,
			dependencyName(POSTGRES_OBJECT_KIND),
			cluster.context
		);

		if (operatorCluster) {
			// The operator's own hibernation: `instances: 0` keeps the Cluster, its PVCs and its Secrets.
			await this.api.applyObject(
				cluster.kubeconfig,
				{
					apiVersion: POSTGRES_OPERATOR_API_VERSION,
					kind: 'Cluster',
					metadata: { name: dependencyName(POSTGRES_OBJECT_KIND), namespace: cluster.namespace },
					spec: { instances: 0 }
				},
				cluster.context
			);
			return;
		}

		const statefulSet = await this.api.readObject(
			cluster.kubeconfig,
			'apps/v1',
			'StatefulSet',
			cluster.namespace,
			POSTGRES_OBJECT_NAMES.statefulSet,
			cluster.context
		);
		if (!statefulSet) return;

		await this.api.applyObject(
			cluster.kubeconfig,
			{
				apiVersion: 'apps/v1',
				kind: 'StatefulSet',
				metadata: { name: POSTGRES_OBJECT_NAMES.statefulSet, namespace: cluster.namespace },
				spec: { replicas: 0 }
			},
			cluster.context
		);
	}

	/**
	 * `deleteData: true` — delete by label, then the PVCs, then re-list until nothing remains.
	 *
	 * The re-list deliberately covers **every** teardown kind including `PersistentVolumeClaim`: the volumes are
	 * the one thing this call exists to destroy, so "we deleted what we could find" is not good enough — the
	 * answer is `deleted` only when a fresh label scan finds nothing (plan §4.9:628 — "it re-lists until zero
	 * remain (≤ 5 minutes) or reports `remaining`").
	 */
	private async deleteAll(cluster: PostgresDependencyCluster): Promise<AppDependencyDeprovisionOutcome> {
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
		cluster: PostgresDependencyCluster,
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
				`${APP_DEPENDENCY_POLICY_LABEL}=${POSTGRES_OBJECT_KIND}`,
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
		cluster: PostgresDependencyCluster,
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
	 * The deadline is the contract's, delivered as an abort (FR-41), and the injected clock plus the injected
	 * `sleep` are the only timing this provider has — so a unit test's ten-minute deadline costs one loop rather
	 * than ten minutes of wall time (ACC-07-14's "within 10 minutes"). {@link PostgresProviderOptions.readyTimeoutMs}
	 * adds an optional local bound for a caller that wants one.
	 *
	 * `'exhausted'` is the runaway guard, not a deadline: a caller whose signal is never armed would otherwise
	 * spin forever (a no-op `sleep` makes that a tight loop), so after {@link POSTGRES_READY_MAX_POLLS}
	 * observations the provider hands the decision back as `pending` — the honest answer for "still not ready",
	 * and one the job simply retries.
	 */
	private async waitFor(
		ctx: AppDependencyContext,
		check: () => Promise<boolean>
	): Promise<'ready' | 'deadline' | 'aborted' | 'exhausted'> {
		const started = this.now();
		const localDeadline = this.options.readyTimeoutMs;
		const maxPolls = this.options.maxPolls ?? POSTGRES_READY_MAX_POLLS;
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
		return this.options.pollIntervalMs ?? POSTGRES_READY_POLL_MS;
	}

	private teardownTimeoutMs(): number {
		return this.options.teardownTimeoutMs ?? POSTGRES_TEARDOWN_TIMEOUT_MS;
	}

	private maxPolls(): number {
		return this.options.maxPolls ?? POSTGRES_READY_MAX_POLLS;
	}

	private sleep(millis: number): Promise<void> {
		return this.options.sleep ? this.options.sleep(millis) : new Promise((resolve) => setTimeout(resolve, millis));
	}
}

/* ------------------------------------------------------------------------- *
 * Manifests (pure, and every one of them is asserted by a spec)
 * ------------------------------------------------------------------------- */

/** The `dep-postgres` Secret — the plain path's own generated password (plan §4.9:616). */
export function plainSecretManifest(
	ctx: AppDependencyContext,
	cluster: PostgresDependencyCluster,
	password: string
): AppDependencyRenderedObject {
	return {
		apiVersion: 'v1',
		kind: 'Secret',
		type: 'Opaque',
		metadata: {
			name: POSTGRES_OBJECT_NAMES.secret,
			namespace: cluster.namespace,
			labels: dependencyLabels({
				workId: String(ctx?.workId ?? ''),
				workSlug: cluster.workSlug,
				kind: POSTGRES_OBJECT_KIND
			})
		},
		// `data` rather than `stringData`: what the API server stores is what a later read returns, so `getOutputs`
		// reads back exactly the password this call generated instead of re-encoding a guess.
		data: { password: Buffer.from(password, 'utf8').toString('base64') }
	};
}

/**
 * The plain path's two Services: the headless one a StatefulSet needs for stable DNS, and the ClusterIP one an
 * App connects to (plan §4.9:616).
 *
 * `type: ClusterIP` is stated rather than left to the default, because plan §4.9:580 forbids a LoadBalancer or a
 * NodePort for a dependency: nothing outside the cluster may reach Postgres.
 */
export function plainServiceManifests(
	ctx: AppDependencyContext,
	cluster: PostgresDependencyCluster
): AppDependencyRenderedObject[] {
	const labels = dependencyLabels({
		workId: String(ctx?.workId ?? ''),
		workSlug: cluster.workSlug,
		kind: POSTGRES_OBJECT_KIND
	});
	const selector = dependencyPodSelector(POSTGRES_OBJECT_KIND);
	const ports = [{ name: POSTGRES_OBJECT_KIND, port: POSTGRES_PORT, targetPort: POSTGRES_PORT, protocol: 'TCP' }];

	return [
		{
			apiVersion: 'v1',
			kind: 'Service',
			metadata: { name: POSTGRES_OBJECT_NAMES.headlessService, namespace: cluster.namespace, labels },
			spec: { clusterIP: 'None', selector, ports }
		},
		{
			apiVersion: 'v1',
			kind: 'Service',
			metadata: { name: POSTGRES_OBJECT_NAMES.service, namespace: cluster.namespace, labels },
			spec: { type: 'ClusterIP', selector, ports }
		}
	];
}

/**
 * The plain path's StatefulSet (plan §4.9:616), with every value the plan fixes.
 *
 * `volumeClaimTemplates` is what makes the claim, and its `metadata.labels` are what the created PVC carries —
 * including `ever-works.io/retain: "true"`, which is why the claim survives its StatefulSet. In the ephemeral
 * variant (R-10) the same pod runs on an `emptyDir` instead: nothing may outlive the verification namespace,
 * and a claim cannot be honoured there.
 */
export function plainStatefulSetManifest(
	ctx: AppDependencyContext,
	cluster: PostgresDependencyCluster,
	input: PostgresProvisionInput
): AppDependencyRenderedObject {
	const labels = dependencyLabels({
		workId: String(ctx?.workId ?? ''),
		workSlug: cluster.workSlug,
		kind: POSTGRES_OBJECT_KIND
	});
	const podLabels = { ...labels, ...dependencyPodSelector(POSTGRES_OBJECT_KIND) };
	const overrides = dependencyImageOverrides(ctx?.settings);

	const manifest: AppDependencyRenderedObject = {
		apiVersion: 'apps/v1',
		kind: 'StatefulSet',
		metadata: { name: POSTGRES_OBJECT_NAMES.statefulSet, namespace: cluster.namespace, labels },
		spec: {
			serviceName: POSTGRES_OBJECT_NAMES.headlessService,
			replicas: 1,
			selector: { matchLabels: dependencyPodSelector(POSTGRES_OBJECT_KIND) },
			template: {
				metadata: { labels: podLabels },
				spec: {
					securityContext: dependencyPodSecurityContext({
						runAsUser: POSTGRES_UID,
						runAsGroup: POSTGRES_UID,
						fsGroup: POSTGRES_UID
					}),
					containers: [
						{
							name: POSTGRES_OBJECT_KIND,
							image: postgresImage(input.version, overrides.postgres[input.version]),
							imagePullPolicy: 'IfNotPresent',
							ports: [{ name: POSTGRES_OBJECT_KIND, containerPort: POSTGRES_PORT, protocol: 'TCP' }],
							env: [
								{ name: 'POSTGRES_USER', value: POSTGRES_APP_NAME },
								{ name: 'POSTGRES_DB', value: POSTGRES_APP_NAME },
								{ name: 'PGDATA', value: POSTGRES_PGDATA },
								{
									name: 'POSTGRES_PASSWORD',
									valueFrom: {
										secretKeyRef: { name: POSTGRES_OBJECT_NAMES.secret, key: 'password' }
									}
								}
							],
							readinessProbe: {
								exec: { command: ['pg_isready', '-U', POSTGRES_APP_NAME, '-d', POSTGRES_APP_NAME] },
								initialDelaySeconds: 5,
								periodSeconds: 5,
								timeoutSeconds: 3,
								failureThreshold: 12
							},
							resources: {
								requests: { ...POSTGRES_REQUESTS },
								limits: { memory: POSTGRES_MEMORY_LIMIT }
							},
							securityContext: dependencyContainerSecurityContext(),
							volumeMounts: [{ name: 'data', mountPath: POSTGRES_DATA_PATH }]
						}
					]
				}
			}
		}
	};

	const spec = manifest.spec as Record<string, unknown>;
	const template = spec.template as { spec: Record<string, unknown> };

	if (input.ephemeral) {
		template.spec.volumes = [{ name: 'data', emptyDir: {} }];
	} else {
		spec.volumeClaimTemplates = [
			{
				metadata: {
					name: 'data',
					labels: dependencyPvcLabels({
						workId: String(ctx?.workId ?? ''),
						workSlug: cluster.workSlug,
						kind: POSTGRES_OBJECT_KIND
					})
				},
				spec: {
					accessModes: ['ReadWriteOnce'],
					resources: { requests: { storage: gibQuantity(input.sizeGiB) } },
					...(input.storageClass ? { storageClassName: input.storageClass } : {})
				}
			}
		];
	}

	return manifest;
}

/**
 * The operator path's `Cluster` (plan §4.9:615).
 *
 * `instances: 1` — never more: a dependency is a single-replica database for one App Work, and the plan says so
 * twice. `enableSuperuserAccess: false` is the plan's, and the declared extensions ride on
 * `bootstrap.initdb.postInitApplicationSQL`, where the operator runs them as the app owner inside the new
 * database.
 */
export function operatorClusterManifest(
	ctx: AppDependencyContext,
	cluster: PostgresDependencyCluster,
	input: PostgresProvisionInput
): AppDependencyRenderedObject {
	const statements = input.extensions.map(extensionSql);

	return {
		apiVersion: POSTGRES_OPERATOR_API_VERSION,
		kind: 'Cluster',
		metadata: {
			name: dependencyName(POSTGRES_OBJECT_KIND),
			namespace: cluster.namespace,
			labels: dependencyLabels({
				workId: String(ctx?.workId ?? ''),
				workSlug: cluster.workSlug,
				kind: POSTGRES_OBJECT_KIND
			})
		},
		spec: {
			instances: 1,
			storage: {
				size: gibQuantity(input.sizeGiB),
				...(input.storageClass ? { storageClassName: input.storageClass } : {})
			},
			bootstrap: {
				initdb: {
					database: POSTGRES_APP_NAME,
					owner: POSTGRES_APP_NAME,
					...(statements.length > 0 ? { postInitApplicationSQL: statements } : {})
				}
			},
			enableSuperuserAccess: false
		}
	};
}

/** A `CREATE EXTENSION IF NOT EXISTS` statement, with the identifier quoted. */
export function extensionSql(extension: string): string {
	return `CREATE EXTENSION IF NOT EXISTS "${extension}";`;
}

/** The extension Job: `psql`, one `-c` per declared extension (plan §4.9:616 — "a `Job dep-postgres-ext`"). */
export function extensionsJobManifest(
	ctx: AppDependencyContext,
	cluster: PostgresDependencyCluster,
	extensions: readonly string[],
	version: PostgresMajorVersion
): AppDependencyRenderedObject {
	const labels = dependencyLabels({
		workId: String(ctx?.workId ?? ''),
		workSlug: cluster.workSlug,
		kind: POSTGRES_OBJECT_KIND
	});
	const overrides = dependencyImageOverrides(ctx?.settings);

	return {
		apiVersion: 'batch/v1',
		kind: 'Job',
		metadata: { name: POSTGRES_OBJECT_NAMES.extensionsJob, namespace: cluster.namespace, labels },
		spec: {
			backoffLimit: 1,
			ttlSecondsAfterFinished: 3_600,
			template: {
				metadata: { labels: { ...labels, ...dependencyPodSelector(POSTGRES_OBJECT_KIND) } },
				spec: {
					restartPolicy: 'Never',
					securityContext: dependencyPodSecurityContext({}),
					containers: [
						{
							name: 'psql',
							image: postgresClientImage(version, overrides.postgresClient[version]),
							imagePullPolicy: 'IfNotPresent',
							command: [
								'psql',
								'-h',
								POSTGRES_OBJECT_NAMES.service,
								'-U',
								POSTGRES_APP_NAME,
								'-d',
								POSTGRES_APP_NAME,
								'-v',
								'ON_ERROR_STOP=1'
							],
							args: extensions.flatMap((extension) => ['-c', extensionSql(extension)]),
							env: [
								{
									name: 'PGPASSWORD',
									valueFrom: { secretKeyRef: { name: POSTGRES_OBJECT_NAMES.secret, key: 'password' } }
								}
							],
							securityContext: dependencyContainerSecurityContext()
						}
					]
				}
			}
		}
	};
}

/* ------------------------------------------------------------------------- *
 * Pure helpers
 * ------------------------------------------------------------------------- */

/**
 * The plain path's outputs (plan §4.9:616, FR-40).
 *
 * `url` is always emitted and `directUrl` only when the App spec declares it; on the plain path there is no
 * pooler, so the two are the same value — which is exactly what "`url` = `directUrl` with `sslmode=disable`"
 * says. `sslmode=disable` is the plan's own value: this path's Postgres speaks no TLS, and a URL that claimed
 * otherwise would fail to connect.
 */
export function plainOutputs(
	cluster: PostgresDependencyCluster,
	input: { password: string; directUrl: boolean }
): Record<string, string> {
	const host = `${POSTGRES_OBJECT_NAMES.service}.${cluster.namespace}.svc.cluster.local`;
	const url = `postgres://${POSTGRES_APP_NAME}:${encodeURIComponent(input.password)}@${host}:${POSTGRES_PORT}/${POSTGRES_APP_NAME}?sslmode=disable`;

	return {
		host,
		port: String(POSTGRES_PORT),
		database: POSTGRES_APP_NAME,
		user: POSTGRES_APP_NAME,
		password: input.password,
		url,
		...(input.directUrl ? { directUrl: url } : {})
	};
}

/** A 32-hex password from `node:crypto` — never a predictable or derived value. */
export function generatePassword(bytes: number = POSTGRES_PASSWORD_BYTES): string {
	return randomBytes(bytes).toString('hex');
}

/** The declared Postgres major, or the pinned default with a warning when the declaration is unusable. */
function declaredVersion(ctx: AppDependencyContext, warnings: string[]): PostgresMajorVersion {
	const declared = (ctx?.declared ?? {}) as Record<string, unknown>;
	if (isSupportedPostgresVersion(declared.version)) return normalisePostgresVersion(declared.version);

	if (declared.version !== undefined && declared.version !== null && declared.version !== '') {
		warnings.push(`postgresVersionUnsupported=${String(declared.version)}`);
	}
	return POSTGRES_DEFAULT_VERSION;
}

/**
 * The declared extensions, filtered to SQL identifiers.
 *
 * An App-spec field reaches a `psql -c` argument and a `postInitApplicationSQL` statement, so a name that is
 * not an identifier is **dropped**, never escaped into the statement: a declaration cannot become SQL.
 */
function declaredExtensions(ctx: AppDependencyContext): string[] {
	const declared = (ctx?.declared ?? {}) as Record<string, unknown>;
	const raw = declared.extensions;
	if (!Array.isArray(raw)) return [];

	const extensions: string[] = [];
	for (const entry of raw) {
		const name = typeof entry === 'string' ? entry.trim() : '';
		if (SQL_IDENTIFIER.test(name) && !extensions.includes(name)) extensions.push(name);
	}
	return extensions;
}

/** FR-40: is `directUrl` declared for this dependency? */
function declaredDirectUrl(ctx: AppDependencyContext): boolean {
	const declared = (ctx?.declared ?? {}) as Record<string, unknown>;
	return declared.directUrl === true;
}

/** The work slug: APW-06's own `part-of` label when it is there, the context's app name otherwise. */
function workSlugOf(ctx: AppDependencyContext): string {
	const labelled = ctx?.cluster?.appLabels?.['app.kubernetes.io/part-of'];
	const slug = typeof labelled === 'string' && labelled.trim() ? labelled.trim() : String(ctx?.appName ?? '');
	return slug.trim();
}

/** The context's cluster half, or `null` when the caller handed us nothing to write to. */
function requireCluster(ctx: AppDependencyContext): PostgresDependencyCluster | null {
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

/** The plan's `statusDetail.operatorSkipped` value, as the warning the provision outcome can carry. */
export function operatorSkippedWarning(reason: AppDependencyOperatorSkipped): string {
	return `operatorSkipped=${reason}`;
}

/** The code half of a `code=detail` warning. */
export function warningCode(warning: string): string {
	const equals = String(warning ?? '').indexOf('=');
	return equals === -1 ? String(warning ?? '') : String(warning).slice(0, equals);
}

/** A readiness wait that ran past its own observation bound: not ready *yet*, so ask again. */
function exhaustedOutcome(
	pollIntervalMs: number,
	path: 'operator' | 'plain',
	maxPolls: number = POSTGRES_READY_MAX_POLLS
): AppDependencyProvisionOutcome {
	return {
		state: 'pending',
		retryAfterMs: pollIntervalMs,
		detail: { kind: POSTGRES_PROVIDER_KIND, path, waitedPolls: maxPolls }
	};
}

/** The failure a readiness wait ends in — the kind's deadline, or the caller's own abort (FR-41). */ function waitFailure(
	input: PostgresProvisionInput,
	path: 'operator' | 'plain',
	outcome: 'deadline' | 'aborted'
): AppDependencyProvisionOutcome {
	// plan §4.9:616 — "PVC Bound within 10 min else failed noStorage". `noStorage` is not a member of the
	// contract's reason union (`APP_DEPENDENCY_STATUS_REASONS`), whose member for this very card line is
	// `volumeNotReady` ("The volume didn't become ready within {minutes} minutes"); the contract wins and the
	// plan's own word travels in the detail, so nothing is lost.
	return {
		state: 'failed',
		reason: path === 'plain' && !input.ephemeral ? 'volumeNotReady' : 'deadlineExceeded',
		transient: false,
		detail: {
			kind: POSTGRES_PROVIDER_KIND,
			path,
			aborted: outcome === 'aborted' ? 'true' : 'false',
			planReason: path === 'plain' && !input.ephemeral ? 'noStorage' : 'deadlineExceeded'
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
