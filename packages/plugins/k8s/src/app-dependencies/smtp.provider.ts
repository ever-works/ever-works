/**
 * Lane aw-env-smtp (2026-10-18, GAP-22) — `k8s-inline-mailpit`: the `smtp` dependency inside the App
 * Work's own namespace.
 *
 * Until this file the `k8s` plugin served `postgres`, `redis` and `objectStorage` only, and nothing in
 * the platform served `smtp` at all (`smtp-external` / `platform-smtp-relay` are declared ids with no
 * implementation). An App Work whose App spec declares `smtp: { required: true }` — the fixture, Cal —
 * therefore sat at `dependency_not_ready: smtp` forever. This provider closes that, in two modes:
 *
 * ## 1. Bring your own SMTP server — nothing is provisioned
 *
 * When the dependency's stored configuration names a server (`ctx.config.host`, the decrypted
 * `configEncrypted` of the `work_app_dependencies` row), those values ARE the outputs: no cluster call is
 * made, the row reads `ready` at once and `actualVersion` is `external`. The configuration reaches the row
 * two ways — `AppDependenciesService.configure(workId, 'smtp', { config })` (the dependency card's
 * "external SMTP" settings, {@link SMTP_PROVIDER_DESCRIPTOR}'s `promptSchema`), and the App env bridge
 * (`AppEnvSmtpBridgeListener`): an owner who sets the App spec's `deps.smtp.*`-bound names
 * (`SMTP_HOST`, `SMTP_PORT`, …) through `PUT /api/works/:id/app-env` gets those values mirrored here.
 *
 * ## 2. The default — an in-namespace Mailpit mail sink
 *
 * Mailpit is an SMTP server that **keeps** every message and shows it in a web UI; it delivers nothing
 * onwards. It is enough for the fixture's `POST /mail/test` and for previews, and it is never a real mail
 * route — which is why its `preference` (30) sits behind every provider that does deliver mail (the
 * plan's `smtp-external` 10, `platform-smtp-relay` 20), so the day one of those is installed it wins.
 *
 * - **Objects**, in the order the other providers use: the `dep-smtp` policy (same-namespace ingress on
 *   1025 and 8025 only), the `dep-smtp` Secret (the generated SMTP password), the `dep-smtp` Service and a
 *   one-replica `dep-smtp` Deployment. No volume: the store is an `emptyDir` — a sink's mail is
 *   throwaway, and FR-48's card says "No automatic backups" for it like any single-instance provider.
 * - **Pod Security `restricted`**: non-root (uid/gid 1000 — the image itself runs as root, so the ids
 *   are set), `RuntimeDefault` seccomp, no privilege escalation, every capability dropped, and a
 *   read-only root filesystem with `emptyDir`s for the database and `/tmp`.
 * - **No egress of its own**: relaying (`MP_SMTP_RELAY_*`), webhooks (`MP_WEBHOOK_URL`) and the UI's
 *   GitHub version check (`MP_DISABLE_VERSION_CHECK`) are the only outbound paths Mailpit has, and none is
 *   configured. Network-level egress stays the namespace's own `ew-allow-egress` (APW-06 §4.10): a
 *   `NetworkPolicy` can only add allowances, so a `dep-smtp` egress rule could not subtract one.
 * - **Credentials**: Mailpit runs with `MP_SMTP_AUTH_ACCEPT_ANY` (any user/password, including none) and
 *   `MP_SMTP_AUTH_ALLOW_INSECURE` (AUTH without TLS — the sink has no certificate). The outputs still
 *   carry a user and a generated password, stored in `dep-smtp` and reused on every re-provision, so an
 *   app that insists on authenticating has something to send and the values never change underneath it.
 *
 * ## Outputs — exactly `APP_DEPENDENCY_OUTPUTS.smtp`
 *
 * `host`, `port`, `user`, `password`, `from`, `secure` (FR-40), all strings, `port` decimal and `secure`
 * `"true"`/`"false"` (plan §3.3:328-329) — the names `app-env.resolver.ts` reads for `deps.smtp.*`.
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
	APP_DEPENDENCY_TEARDOWN_KINDS,
	dependencyContainerSecurityContext,
	dependencyLabels,
	dependencyName,
	dependencyPodSecurityContext,
	dependencyPodSelector,
	dependencyResourceRefs,
	isForbidden,
	planDependencyNetworkPolicy,
	type AppDependencyApi,
	type AppDependencyObjectRef,
	type AppDependencyRenderedObject
} from './common.js';
import { mailpitImageFor } from './images.js';

/* ------------------------------------------------------------------------- *
 * Constants
 * ------------------------------------------------------------------------- */

/** The provider id — appended to `APP_DEPENDENCY_PROVIDER_IDS` by the same lane. */
export const SMTP_PROVIDER_ID = 'k8s-inline-mailpit';

/** The kind this provider serves. */
export const SMTP_PROVIDER_KIND: AppDependencyKind = 'smtp';

/** The local part of every `dep-smtp…` object name. */
export const SMTP_OBJECT_KIND = 'smtp';

/** The SMTP port the sink listens on (Mailpit's default; unprivileged, so a non-root pod can bind it). */
export const SMTP_PORT = 1025;

/** The web UI / API port — where a lane or an owner reads what the app sent. */
export const SMTP_UI_PORT = 8025;

/** `actualVersion` of a bring-your-own row: nothing was provisioned, so there is no image version. */
export const SMTP_EXTERNAL_VERSION = 'external';

/** `actualVersion` of a Mailpit row — the pinned tag (`images.ts`). */
export const SMTP_MAILPIT_VERSION = 'mailpit-1.31';

/** The user name the sink's outputs carry (Mailpit accepts any). */
export const SMTP_MAILPIT_USER = 'mailpit';

/** The generated password's length — 16 random bytes, hex (the same shape the Redis provider uses). */
export const SMTP_PASSWORD_BYTES = 16;

/** The `dep-smtp` Secret key the password is stored under. */
export const SMTP_PASSWORD_KEY = 'password';

/** How many messages the sink keeps before it drops the oldest. */
export const SMTP_MAILPIT_MAX_MESSAGES = 500;

/** Where Mailpit keeps its database — an `emptyDir`. */
export const SMTP_MAILPIT_DATA_PATH = '/data';

/** Small, fixed resources: a sink for a handful of test messages, inside the managed quota. */
export const SMTP_MAILPIT_RESOURCES = {
	requests: { cpu: '10m', memory: '32Mi' },
	limits: { cpu: '200m', memory: '128Mi' }
} as const;

/** The uid/gid the sink runs as — the image's own user is root, which `restricted` refuses. */
export const SMTP_MAILPIT_UID = 1000;

/** The object names, all `dep-smtp`. */
export const SMTP_OBJECT_NAMES = {
	secret: dependencyName(SMTP_OBJECT_KIND),
	service: dependencyName(SMTP_OBJECT_KIND),
	deployment: dependencyName(SMTP_OBJECT_KIND)
} as const;

/** How often a readiness wait re-reads the cluster. */
export const SMTP_READY_POLL_MS = 2_000;

/**
 * The most observations one readiness wait makes before answering `pending` — the runaway guard the
 * other providers carry; FR-41's 30-second `smtp` deadline reaches the provider as `ctx.signal`'s abort.
 */
export const SMTP_READY_MAX_POLLS = 120;

/** How long a `deleteData` teardown keeps re-listing. */
export const SMTP_TEARDOWN_TIMEOUT_MS = 120_000;

/** The ports a bring-your-own server may name: 25, 465, 587, 2525 and anything else in range. */
const PORT_MIN = 1;
const PORT_MAX = 65_535;

/**
 * The descriptor the plugin publishes.
 *
 * `promptSchema` is the "external SMTP" configuration a dependency card can render (FR-5: `password`
 * is `x-secret`, write-only). Nothing in it is required — an empty configuration is the Mailpit default —
 * which is also why `awaitingConfig` is absent: the row never waits for the owner.
 */
export const SMTP_PROVIDER_DESCRIPTOR: AppDependencyProviderDescriptor = {
	id: SMTP_PROVIDER_ID,
	kind: SMTP_PROVIDER_KIND,
	targets: ['your-cluster'],
	label: 'In your cluster · mail sink (Mailpit)',
	preference: 30,
	backupPolicy: 'none',
	promptSchema: {
		type: 'object',
		properties: {
			host: {
				type: 'string',
				title: 'SMTP host',
				description: 'Your own SMTP server. Leave blank to use the in-namespace mail sink.'
			},
			port: { type: 'string', title: 'Port', description: '587 (STARTTLS), 465 (TLS) or 25.' },
			user: { type: 'string', title: 'User name' },
			password: { type: 'string', title: 'Password', 'x-secret': true },
			from: { type: 'string', title: 'From address' },
			secure: { type: 'string', title: 'Implicit TLS', enum: ['true', 'false'] }
		}
	}
};

/* ------------------------------------------------------------------------- *
 * Shapes
 * ------------------------------------------------------------------------- */

/** Everything a provider call needs beyond the contract's context. */
export interface SmtpProviderOptions {
	/** Epoch milliseconds. Defaults to `Date.now`; the specs inject a virtual clock. */
	now?: () => number;
	/** The only way this provider waits. Defaults to `setTimeout`; the specs inject a virtual clock. */
	sleep?: (millis: number) => Promise<void>;
	/** The readiness poll interval. Defaults to {@link SMTP_READY_POLL_MS}. */
	pollIntervalMs?: number;
	/** How many observations a readiness wait makes before answering `pending`. */
	maxPolls?: number;
	/** The `deleteData` teardown budget. Defaults to {@link SMTP_TEARDOWN_TIMEOUT_MS}. */
	teardownTimeoutMs?: number;
}

/** The cluster half of a context, once it is known to be present. */
export interface SmtpDependencyCluster {
	kubeconfig: string;
	context?: string;
	namespace: string;
	workSlug: string;
}

/** A bring-your-own server, normalised. */
export interface SmtpExternalServer {
	host: string;
	port: number;
	user: string;
	password: string;
	from: string;
	secure: boolean;
}

/* ------------------------------------------------------------------------- *
 * The provider
 * ------------------------------------------------------------------------- */

/**
 * `k8s-inline-mailpit` — one instance per plugin, stateless between calls: every fact a call needs is
 * read from the cluster or passed in.
 */
export class SmtpDependencyProvider {
	constructor(
		private readonly api: AppDependencyApi,
		private readonly options: SmtpProviderOptions = {}
	) {}

	/** The descriptor the plugin publishes. */
	descriptor(): AppDependencyProviderDescriptor {
		return SMTP_PROVIDER_DESCRIPTOR;
	}

	/** `(smtp, your-cluster)` and nothing else — the managed plugin maps its target onto this one. */
	async supports(kind: AppDependencyKind, target: AppDependencyTarget): Promise<AppDependencySupport> {
		if (kind === SMTP_PROVIDER_KIND && target === 'your-cluster') {
			return { supported: true, providerId: SMTP_PROVIDER_ID };
		}
		return { supported: false, reason: 'providerNotSupported' };
	}

	/**
	 * Satisfy the App Work's `smtp`: the owner's own server when the configuration names one, else the
	 * in-namespace sink.
	 */
	async provision(providerId: string, ctx: AppDependencyContext): Promise<AppDependencyProvisionOutcome> {
		if (providerId !== SMTP_PROVIDER_ID) {
			return { state: 'failed', reason: 'providerNotSupported', transient: false, detail: { providerId } };
		}

		const external = externalSmtpServer(ctx);
		if (external === 'invalid') {
			// A host with an unusable port is the owner's typo, not a transient fault: fail at once with the
			// card's "couldn't connect" reason rather than silently falling back to the sink.
			return {
				state: 'failed',
				reason: 'smtpConnectFailed',
				transient: false,
				detail: { mode: 'external', field: 'port' }
			};
		}
		if (external) {
			// Bring your own: nothing is created and nothing is dialled — the owner's values are the outputs.
			// A sink this row ran before is stopped (scaled to 0, nothing deleted), so it neither answers on
			// the old host nor spends the namespace's quota.
			const cluster = requireCluster(ctx);
			if (cluster) await this.stopWorkloads(cluster).catch(() => []);
			return {
				state: 'ready',
				outputs: externalOutputs(external),
				actualVersion: SMTP_EXTERNAL_VERSION,
				resourceRefs: { objects: [] },
				warnings: ['externalSmtp']
			};
		}

		const cluster = requireCluster(ctx);
		if (!cluster) {
			return {
				state: 'failed',
				reason: 'clusterUnreachable',
				transient: true,
				detail: { target: String(ctx?.target ?? '') }
			};
		}

		const warnings: string[] = [];
		const ephemeral = ctx?.ephemeral === true;
		if (ephemeral) warnings.push('ephemeralNoPersistence');

		try {
			await this.api.applyObject(cluster.kubeconfig, networkPolicyManifest(ctx, cluster), cluster.context);
		} catch (error) {
			return applyFailure(error, 'NetworkPolicy');
		}

		// Reuse the stored password: re-provisioning must never change a credential the app holds (FR-47).
		const existing = await this.readStoredPassword(cluster).catch(() => null);
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

		try {
			await this.api.applyObject(cluster.kubeconfig, deploymentManifest(ctx, cluster), cluster.context);
		} catch (error) {
			if (isForbidden(error)) {
				return {
					state: 'failed',
					reason: 'clusterPermissionMissing',
					transient: false,
					detail: { resource: 'deployments', verb: 'create', namespace: cluster.namespace }
				};
			}
			return transientClusterFailure(error);
		}

		const outcome = await this.waitFor(ctx, async () => {
			const live = await this.api.readObject<{ status?: { readyReplicas?: number } }>(
				cluster.kubeconfig,
				'apps/v1',
				'Deployment',
				cluster.namespace,
				SMTP_OBJECT_NAMES.deployment,
				cluster.context
			);
			return (live?.status?.readyReplicas ?? 0) >= 1;
		});
		if (outcome === 'exhausted') {
			return {
				state: 'pending',
				retryAfterMs: this.pollIntervalMs(),
				detail: { kind: SMTP_PROVIDER_KIND, waitedPolls: this.maxPolls() }
			};
		}
		if (outcome !== 'ready') {
			return {
				state: 'failed',
				reason: 'deadlineExceeded',
				transient: false,
				detail: { kind: SMTP_PROVIDER_KIND, aborted: outcome === 'aborted' ? 'true' : 'false' }
			};
		}

		const objects: AppDependencyObjectRef[] = [
			{ kind: 'NetworkPolicy', name: dependencyName(SMTP_OBJECT_KIND) },
			{ kind: 'Secret', name: SMTP_OBJECT_NAMES.secret },
			{ kind: 'Service', name: SMTP_OBJECT_NAMES.service },
			{ kind: 'Deployment', name: SMTP_OBJECT_NAMES.deployment }
		];

		return {
			state: 'ready',
			outputs: mailpitOutputs(ctx, cluster, password),
			actualVersion: SMTP_MAILPIT_VERSION,
			resourceRefs: dependencyResourceRefs(cluster.namespace, objects),
			...(warnings.length > 0 ? { warnings } : {})
		};
	}

	/**
	 * Re-read what the dependency publishes (the `refresh` mode): the configuration for a bring-your-own
	 * row, the `dep-smtp` Secret for the sink. A missing Secret throws (`degraded outputsUnavailable`).
	 */
	async getOutputs(providerId: string, ctx: AppDependencyContext): Promise<Record<string, string>> {
		if (providerId !== SMTP_PROVIDER_ID) {
			throw dependencyError('providerNotSupported', `'${providerId}' is not served by this provider.`);
		}

		const external = externalSmtpServer(ctx);
		if (external === 'invalid') throw dependencyError('smtpConnectFailed', 'The SMTP port is not usable.');
		if (external) return externalOutputs(external);

		const cluster = requireCluster(ctx);
		if (!cluster) throw dependencyError('clusterUnreachable', 'The dependency has no cluster to read from.');

		const password = await this.readStoredPassword(cluster);
		if (!password) {
			throw dependencyError(
				'clusterUnreachable',
				`'${SMTP_OBJECT_NAMES.secret}' has no '${SMTP_PASSWORD_KEY}' in namespace '${cluster.namespace}'.`
			);
		}
		return mailpitOutputs(ctx, cluster, password);
	}

	/**
	 * Release, or destroy (plan §4.9:624-628, §4.12): `deleteData: false` makes no cluster call (or, with
	 * `stopWorkloads`, scales the sink to 0 and touches nothing else); `deleteData: true` deletes every
	 * `ever-works.io/dependency=smtp` object and re-lists. A bring-your-own server is the owner's and is
	 * never touched — there is nothing of ours to delete for it.
	 */
	async deprovision(
		providerId: string,
		ctx: AppDependencyContext,
		opts: AppDependencyDeprovisionOptions
	): Promise<AppDependencyDeprovisionOutcome> {
		if (providerId !== SMTP_PROVIDER_ID) return { state: 'released' };

		const cluster = requireCluster(ctx);
		if (!cluster) return { state: 'released' };

		if (opts?.deleteData !== true) {
			if (opts?.stopWorkloads === true) await this.stopWorkloads(cluster);
			return { state: 'released' };
		}

		return this.deleteAll(cluster);
	}

	/** FR-48: `none` — a sink's messages are throwaway, and an external server's backups are its owner's. */
	async backupStatus(_providerId: string, ctx: AppDependencyContext): Promise<AppDependencyBackupStatus> {
		const external = externalSmtpServer(ctx);
		return { state: external && external !== 'invalid' ? 'external' : 'none' };
	}

	/* --------------------------------------------------------------------- *
	 * Cluster reads and writes
	 * --------------------------------------------------------------------- */

	private async readStoredPassword(cluster: SmtpDependencyCluster): Promise<string | null> {
		const secret = await this.api.readObject<{ data?: Record<string, string> }>(
			cluster.kubeconfig,
			'v1',
			'Secret',
			cluster.namespace,
			SMTP_OBJECT_NAMES.secret,
			cluster.context
		);
		return decodeSecretValue(secret?.data?.[SMTP_PASSWORD_KEY]);
	}

	/** Scale the sink to zero and touch nothing else. */
	private async stopWorkloads(cluster: SmtpDependencyCluster): Promise<string[]> {
		const deployment = await this.api.readObject(
			cluster.kubeconfig,
			'apps/v1',
			'Deployment',
			cluster.namespace,
			SMTP_OBJECT_NAMES.deployment,
			cluster.context
		);
		if (!deployment) return [];
		await this.api.applyObject(
			cluster.kubeconfig,
			{
				apiVersion: 'apps/v1',
				kind: 'Deployment',
				metadata: { name: SMTP_OBJECT_NAMES.deployment, namespace: cluster.namespace },
				spec: { replicas: 0 }
			},
			cluster.context
		);
		return ['Deployment'];
	}

	private async deleteAll(cluster: SmtpDependencyCluster): Promise<AppDependencyDeprovisionOutcome> {
		const started = this.now();

		for (const kind of APP_DEPENDENCY_TEARDOWN_KINDS) {
			for (const object of await this.listOwned(cluster, kind)) {
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

		let remaining = await this.remaining(cluster);
		if (remaining.length > 0 && this.now() - started < this.teardownTimeoutMs()) {
			remaining = await this.remaining(cluster);
		}

		return remaining.length === 0
			? { state: 'deleted' }
			: { state: 'pending', remaining: dependencyResourceRefs(cluster.namespace, remaining) };
	}

	private async listOwned(
		cluster: SmtpDependencyCluster,
		kind: { apiVersion: string; kind: string }
	): Promise<AppDependencyObjectRef[]> {
		const objects = await this.api
			.listObjects<{
				metadata?: { name?: string };
			}>(cluster.kubeconfig, kind.apiVersion, kind.kind, cluster.namespace, `${APP_DEPENDENCY_POLICY_LABEL}=${SMTP_OBJECT_KIND}`, cluster.context)
			.catch(() => []);
		return objects
			.filter((object) => typeof object?.metadata?.name === 'string' && object.metadata.name)
			.map((object) => ({ kind: kind.kind, name: String(object.metadata?.name) }));
	}

	private async remaining(cluster: SmtpDependencyCluster): Promise<AppDependencyObjectRef[]> {
		const found: AppDependencyObjectRef[] = [];
		for (const kind of APP_DEPENDENCY_TEARDOWN_KINDS) found.push(...(await this.listOwned(cluster, kind)));
		return found;
	}

	/* --------------------------------------------------------------------- *
	 * Waiting
	 * --------------------------------------------------------------------- */

	private async waitFor(
		ctx: AppDependencyContext,
		check: () => Promise<boolean>
	): Promise<'ready' | 'aborted' | 'exhausted'> {
		const aborted = (): boolean => ctx?.signal?.aborted === true;
		for (let polls = 1; ; polls += 1) {
			if (aborted()) return 'aborted';
			if (await check()) return 'ready';
			if (aborted()) return 'aborted';
			if (polls >= this.maxPolls()) return 'exhausted';
			await this.sleep(this.pollIntervalMs());
		}
	}

	private now(): number {
		return this.options.now ? this.options.now() : Date.now();
	}

	private pollIntervalMs(): number {
		return this.options.pollIntervalMs ?? SMTP_READY_POLL_MS;
	}

	private maxPolls(): number {
		return this.options.maxPolls ?? SMTP_READY_MAX_POLLS;
	}

	private teardownTimeoutMs(): number {
		return this.options.teardownTimeoutMs ?? SMTP_TEARDOWN_TIMEOUT_MS;
	}

	private sleep(millis: number): Promise<void> {
		return this.options.sleep ? this.options.sleep(millis) : new Promise((resolve) => setTimeout(resolve, millis));
	}
}

/* ------------------------------------------------------------------------- *
 * Bring your own
 * ------------------------------------------------------------------------- */

/**
 * The owner's own server, from the dependency's configuration — or `null` when it names none (the sink),
 * or `'invalid'` when it names a host with an unusable port.
 *
 * `secure` defaults to `true` exactly for 465 (implicit TLS); `from` defaults to the user name when that
 * is an address, and is otherwise left empty for the app's own default.
 */
export function externalSmtpServer(ctx: AppDependencyContext): SmtpExternalServer | 'invalid' | null {
	const config = (ctx?.config ?? {}) as Record<string, unknown>;
	const host = text(config.host);
	if (!host) return null;

	const portText = text(config.port);
	const port = portText ? Number(portText) : 587;
	if (!Number.isInteger(port) || port < PORT_MIN || port > PORT_MAX) return 'invalid';

	const user = text(config.user);
	const secureText = text(config.secure).toLowerCase();
	const secure =
		secureText === 'true' || secureText === '1'
			? true
			: secureText === 'false' || secureText === '0'
				? false
				: port === 465;
	const from = text(config.from) || (user.includes('@') ? user : '');

	return { host, port, user, password: typeof config.password === 'string' ? config.password : '', from, secure };
}

/** The six outputs of a bring-your-own server. */
export function externalOutputs(server: SmtpExternalServer): Record<string, string> {
	return {
		host: server.host,
		port: String(server.port),
		user: server.user,
		password: server.password,
		from: server.from,
		secure: server.secure ? 'true' : 'false'
	};
}

/* ------------------------------------------------------------------------- *
 * Manifests (pure)
 * ------------------------------------------------------------------------- */

/** `dep-smtp` — same-namespace pods on the SMTP port and the UI port, nothing else (FR-38). */
export function networkPolicyManifest(
	ctx: AppDependencyContext,
	cluster: SmtpDependencyCluster
): AppDependencyRenderedObject {
	const policy = planDependencyNetworkPolicy({
		kind: SMTP_OBJECT_KIND,
		namespace: cluster.namespace,
		workId: String(ctx?.workId ?? ''),
		workSlug: cluster.workSlug,
		port: SMTP_PORT
	}).policy;
	const spec = policy.spec as { ingress: Array<{ ports: Array<{ protocol: string; port: number }> }> };
	spec.ingress[0].ports.push({ protocol: 'TCP', port: SMTP_UI_PORT });
	return policy;
}

/** The `dep-smtp` Secret — the generated SMTP password the outputs carry. */
export function secretManifest(
	ctx: AppDependencyContext,
	cluster: SmtpDependencyCluster,
	password: string
): AppDependencyRenderedObject {
	return {
		apiVersion: 'v1',
		kind: 'Secret',
		type: 'Opaque',
		metadata: {
			name: SMTP_OBJECT_NAMES.secret,
			namespace: cluster.namespace,
			labels: dependencyLabels({
				workId: String(ctx?.workId ?? ''),
				workSlug: cluster.workSlug,
				kind: SMTP_OBJECT_KIND
			})
		},
		data: { [SMTP_PASSWORD_KEY]: Buffer.from(password, 'utf8').toString('base64') }
	};
}

/** `dep-smtp:1025` (SMTP) and `:8025` (UI), `ClusterIP` — never a LoadBalancer or a NodePort. */
export function serviceManifest(
	ctx: AppDependencyContext,
	cluster: SmtpDependencyCluster
): AppDependencyRenderedObject {
	return {
		apiVersion: 'v1',
		kind: 'Service',
		metadata: {
			name: SMTP_OBJECT_NAMES.service,
			namespace: cluster.namespace,
			labels: dependencyLabels({
				workId: String(ctx?.workId ?? ''),
				workSlug: cluster.workSlug,
				kind: SMTP_OBJECT_KIND
			})
		},
		spec: {
			type: 'ClusterIP',
			selector: dependencyPodSelector(SMTP_OBJECT_KIND),
			ports: [
				{ name: 'smtp', port: SMTP_PORT, targetPort: SMTP_PORT, protocol: 'TCP' },
				{ name: 'http', port: SMTP_UI_PORT, targetPort: SMTP_UI_PORT, protocol: 'TCP' }
			]
		}
	};
}

/** Mailpit's settings — every one an env var, none of them a credential. */
export function mailpitContainerEnv(): Array<{ name: string; value: string }> {
	return [
		{ name: 'MP_SMTP_BIND_ADDR', value: `0.0.0.0:${SMTP_PORT}` },
		{ name: 'MP_UI_BIND_ADDR', value: `0.0.0.0:${SMTP_UI_PORT}` },
		{ name: 'MP_DATABASE', value: `${SMTP_MAILPIT_DATA_PATH}/mailpit.db` },
		{ name: 'MP_MAX_MESSAGES', value: String(SMTP_MAILPIT_MAX_MESSAGES) },
		{ name: 'MP_SMTP_AUTH_ACCEPT_ANY', value: 'true' },
		{ name: 'MP_SMTP_AUTH_ALLOW_INSECURE', value: 'true' },
		{ name: 'MP_DISABLE_VERSION_CHECK', value: 'true' }
	];
}

/**
 * The one-replica sink. `Recreate`: two sinks would split the mail between them. Restricted-PSS
 * compatible: non-root ids, `RuntimeDefault` seccomp, no escalation, `drop: [ALL]`, read-only root.
 */
export function deploymentManifest(
	ctx: AppDependencyContext,
	cluster: SmtpDependencyCluster
): AppDependencyRenderedObject {
	const labels = dependencyLabels({
		workId: String(ctx?.workId ?? ''),
		workSlug: cluster.workSlug,
		kind: SMTP_OBJECT_KIND
	});

	return {
		apiVersion: 'apps/v1',
		kind: 'Deployment',
		metadata: { name: SMTP_OBJECT_NAMES.deployment, namespace: cluster.namespace, labels },
		spec: {
			replicas: 1,
			strategy: { type: 'Recreate' },
			selector: { matchLabels: dependencyPodSelector(SMTP_OBJECT_KIND) },
			template: {
				metadata: { labels: { ...labels, ...dependencyPodSelector(SMTP_OBJECT_KIND) } },
				spec: {
					automountServiceAccountToken: false,
					securityContext: dependencyPodSecurityContext({
						runAsUser: SMTP_MAILPIT_UID,
						runAsGroup: SMTP_MAILPIT_UID,
						fsGroup: SMTP_MAILPIT_UID
					}),
					containers: [
						{
							name: SMTP_OBJECT_KIND,
							image: mailpitImageFor(ctx?.settings),
							imagePullPolicy: 'IfNotPresent',
							ports: [
								{ name: 'smtp', containerPort: SMTP_PORT, protocol: 'TCP' },
								{ name: 'http', containerPort: SMTP_UI_PORT, protocol: 'TCP' }
							],
							env: mailpitContainerEnv(),
							readinessProbe: {
								httpGet: { path: '/readyz', port: SMTP_UI_PORT },
								initialDelaySeconds: 1,
								periodSeconds: 2,
								timeoutSeconds: 2,
								failureThreshold: 10
							},
							livenessProbe: {
								httpGet: { path: '/livez', port: SMTP_UI_PORT },
								periodSeconds: 20,
								timeoutSeconds: 3,
								failureThreshold: 3
							},
							resources: {
								requests: { ...SMTP_MAILPIT_RESOURCES.requests },
								limits: { ...SMTP_MAILPIT_RESOURCES.limits }
							},
							securityContext: { ...dependencyContainerSecurityContext(), readOnlyRootFilesystem: true },
							volumeMounts: [
								{ name: 'data', mountPath: SMTP_MAILPIT_DATA_PATH },
								{ name: 'tmp', mountPath: '/tmp' }
							]
						}
					],
					volumes: [
						{ name: 'data', emptyDir: { sizeLimit: '256Mi' } },
						{ name: 'tmp', emptyDir: { sizeLimit: '64Mi' } }
					]
				}
			}
		}
	};
}

/* ------------------------------------------------------------------------- *
 * Pure helpers
 * ------------------------------------------------------------------------- */

/** The sink's six outputs — `APP_DEPENDENCY_OUTPUTS.smtp`, exactly. */
export function mailpitOutputs(
	ctx: AppDependencyContext,
	cluster: SmtpDependencyCluster,
	password: string
): Record<string, string> {
	return {
		host: `${SMTP_OBJECT_NAMES.service}.${cluster.namespace}.svc.cluster.local`,
		port: String(SMTP_PORT),
		user: SMTP_MAILPIT_USER,
		password,
		from: declaredFrom(ctx, cluster),
		secure: 'false'
	};
}

/**
 * The sink's from-address: the App spec's own `smtp.from` when it declares one, else
 * `no-reply@<slug>.invalid` — an RFC 2606 name that can never be a real mailbox, which is the honest
 * address for mail that goes nowhere.
 */
export function declaredFrom(ctx: AppDependencyContext, cluster: SmtpDependencyCluster): string {
	const declared = (ctx?.declared ?? {}) as Record<string, unknown>;
	const from = text(declared.from);
	if (from) return from;
	const slug =
		cluster.workSlug
			.toLowerCase()
			.replace(/[^a-z0-9-]+/g, '-')
			.replace(/^-+|-+$/g, '') || 'app';
	return `no-reply@${slug}.invalid`;
}

/** A 32-hex password from `node:crypto`. */
export function generatePassword(bytes: number = SMTP_PASSWORD_BYTES): string {
	return randomBytes(bytes).toString('hex');
}

function text(value: unknown): string {
	if (typeof value === 'number' && Number.isFinite(value)) return String(value);
	return typeof value === 'string' ? value.trim() : '';
}

function workSlugOf(ctx: AppDependencyContext): string {
	const labelled = ctx?.cluster?.appLabels?.['app.kubernetes.io/part-of'];
	const slug = typeof labelled === 'string' && labelled.trim() ? labelled.trim() : String(ctx?.appName ?? '');
	return slug.trim();
}

function requireCluster(ctx: AppDependencyContext): SmtpDependencyCluster | null {
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

function decodeSecretValue(value: unknown): string | null {
	if (typeof value !== 'string' || !value) return null;
	const decoded = Buffer.from(value, 'base64').toString('utf8');
	return decoded ? decoded : null;
}

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

function dependencyError(code: string, message: string): Error & { code: string } {
	const error = new Error(`${code}: ${message}`) as Error & { code: string };
	error.code = code;
	return error;
}
