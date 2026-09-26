/**
 * APW-06 T13 — `checkAppCluster`: the connection check of plan §6.3 (FR-6, ACC-06-05).
 *
 * Sources, in priority order:
 *
 * 1. `plan.md` §6.3 — the whole shape of the check: `/version` (10 s) → one `SelfSubjectAccessReview`
 *    per required verb → `IngressClass` list → controller-namespace detection → `ClusterIssuer` list
 *    → `StorageClass` list, plus **the ingress controller Service's address**, and the result carries
 *    the cluster `fingerprint` **inside** itself.
 * 2. `spec.md` FR-6 / FR-4 (nothing is dialled before the §6.1 guard accepts the kubeconfig; every
 *    address that becomes a DNS target passes the public-address check) and ACC-06-05 (each missing
 *    required permission is *named*, and a missing **required** permission blocks Save).
 * 3. `plan.md` §9.10's `cluster-check` op — which stores the result as `clusterCheck` and the
 *    observed `ingressAddress` on the runtime state (GAP-09 / APW06-G03), and **never** writes the
 *    `clusterFingerprint` column. This module writes nothing at all: it is a pure read, so "never
 *    writes the runtime-state `clusterFingerprint`" holds by construction.
 *
 * **One additive field beyond §3.1's type.** T13's task line requires the result to carry
 * `ingressAddress` (GAP-09: a custom domain must be verifiable *before* the first Deployment), and
 * §6.3/§9.10 describe it — but the frozen `AppClusterCheck` of §3.1 has no such field and this task
 * may not widen the contract. {@link AppClusterCheckReport} therefore **extends** the contract type
 * with that one property: the contract file is untouched, `checkAppCluster` still returns something
 * assignable to `AppClusterCheck`, and the platform can read the address without a cast. It is
 * reported as a contract gap rather than silently resolved.
 *
 * **Secret-free by construction.** Every field is a name, a version string, a boolean or an address;
 * the kubeconfig itself is never echoed, and a client failure is scrubbed by `errors.ts`'s scrubber
 * before it reaches `error.message`.
 */
import type { AppClusterCheck, AppClusterCheckRequest } from '@ever-works/plugin';

import { K8sPluginError, scrubError } from '../errors.js';
import type { ParsedKubeconfig } from '../kubeconfig.parser.js';
import { parseKubeconfig } from '../kubeconfig.parser.js';
import type {
	KubernetesApiService,
	SelfSubjectAccessReviewInput,
	SelfSubjectAccessReviewStatus
} from '../k8s-api.service.js';
import { assertSupportedKubeconfig, type SupportedKubeconfig } from './app-kubeconfig.guard.js';

/* ------------------------------------------------------------------------- *
 * Constants
 * ------------------------------------------------------------------------- */

/** §5.3 (`APP_CLUSTER_DIAL_TIMEOUT_S`): the single dial `/version` makes. */
export const APP_CLUSTER_DIAL_TIMEOUT_MS = 10_000;

/** §4.11 / §6.3: the labels an ingress controller's pods and Services carry. */
export const APP_INGRESS_CONTROLLER_NAMES: readonly string[] = ['ingress-nginx', 'traefik'];

/** §4.11: `ingressclass.kubernetes.io/is-default-class`. */
export const APP_INGRESS_CLASS_DEFAULT_ANNOTATION = 'ingressclass.kubernetes.io/is-default-class';

/** The two spellings of the default-StorageClass annotation a cluster may carry. */
export const APP_STORAGE_CLASS_DEFAULT_ANNOTATIONS: readonly string[] = [
	'storageclass.kubernetes.io/is-default-class',
	'storageclass.beta.kubernetes.io/is-default-class'
];

/** The label every ingress controller names itself with. */
const CONTROLLER_LABEL = 'app.kubernetes.io/name';

/**
 * Every literal credential a kubeconfig carries — the values `errors.ts`'s own patterns cannot know
 * about. A client library that echoes the bearer token it sent would otherwise put it in
 * `error.message`; {@link scrubLiterals} is what makes "secret-free by construction" true rather
 * than hopeful.
 *
 * **Why not `buildSecretPattern`.** `scrubString`'s replacer reads its second callback argument as a
 * capture group (`errors.ts:64`), but `buildSecretPattern` returns a **group-less** pattern — so
 * `scrubString('… 401 for hunter2-secret', [buildSecretPattern('hunter2-secret')])` produces
 * `… 401 for 12[REDACTED]`, the offset glued in front. This module replaces the literals itself
 * rather than depending on that. (`errors.ts` is not this task's file; the pitfall is reported, not
 * fixed here.)
 */
export function credentialLiterals(kubeconfigYaml: string): string[] {
	const literals: string[] = [];
	const pattern =
		/^\s*(?:token|password|client-key-data|client-certificate-data|certificate-authority-data)\s*:\s*(\S+)\s*$/;

	for (const line of String(kubeconfigYaml ?? '').split('\n')) {
		const match = pattern.exec(line.trim());
		if (match && !literals.includes(match[1])) {
			literals.push(match[1]);
		}
	}

	return literals;
}

/** Replace every literal with `[REDACTED]` — a plain split/join, so no regex semantics enter. */
export function scrubLiterals(message: string, literals: readonly string[]): string {
	let out = String(message ?? '');
	for (const literal of literals) {
		if (literal.length > 0 && out.includes(literal)) {
			out = out.split(literal).join('[REDACTED]');
		}
	}
	return out;
}

/* ------------------------------------------------------------------------- *
 * The permission tables (§6.3)
 * ------------------------------------------------------------------------- */

/** One "may I do X" question — what a `SelfSubjectAccessReview` asks and what a refusal names. */
export interface AppPermission {
	verb: string;
	/** The plural lowercase resource, without any subresource. */
	resource: string;
	/** API group; the empty string is the core group. */
	group: string;
	/** `log` for `pods/log`; omitted otherwise. */
	subresource?: string;
}

/** The name a missing permission is reported under: `pods/log` for a subresource question. */
export function permissionName(permission: AppPermission): string {
	return permission.subresource ? `${permission.resource}/${permission.subresource}` : permission.resource;
}

/** §6.3's seven write/read verbs. */
const WRITE_VERBS = ['get', 'list', 'watch', 'create', 'patch', 'update', 'delete'] as const;
/** §6.3's two read-only verbs. */
const READ_VERBS = ['get', 'list'] as const;

/** §6.3's object resources, with the group each lives in. */
const RESOURCES: readonly { resource: string; group: string }[] = [
	{ resource: 'deployments', group: 'apps' },
	{ resource: 'services', group: '' },
	{ resource: 'ingresses', group: 'networking.k8s.io' },
	{ resource: 'secrets', group: '' },
	{ resource: 'configmaps', group: '' },
	{ resource: 'serviceaccounts', group: '' },
	{ resource: 'persistentvolumeclaims', group: '' },
	{ resource: 'jobs', group: 'batch' },
	{ resource: 'cronjobs', group: 'batch' },
	{ resource: 'networkpolicies', group: 'networking.k8s.io' }
];

/** §6.3's observed resources — read-only. */
const OBSERVED_RESOURCES: readonly { resource: string; group: string }[] = [
	{ resource: 'pods', group: '' },
	{ resource: 'replicasets', group: 'apps' },
	{ resource: 'events', group: '' }
];

/**
 * §6.3's required list, verbatim: `get,list,watch,create,patch,update,delete` on the ten object
 * resources, `get,list` on pods / replicasets / events, and `get` on `pods/log`.
 */
export const APP_REQUIRED_PERMISSIONS: readonly AppPermission[] = [
	...RESOURCES.flatMap(({ resource, group }) => WRITE_VERBS.map((verb) => ({ verb, resource, group }))),
	...OBSERVED_RESOURCES.flatMap(({ resource, group }) => READ_VERBS.map((verb) => ({ verb, resource, group }))),
	{ verb: 'get', resource: 'pods', group: '', subresource: 'log' }
];

/**
 * §6.3's optional list: `create namespaces` (which becomes **required** when the namespace does not
 * exist yet — that is what `AppClusterCheckRequest.needsCreateNamespace` means) and
 * `create,patch limitranges` (the §4.2 step 3 object, whose 403 is the `limitrange_forbidden`
 * warning rather than a failure).
 */
export const APP_OPTIONAL_PERMISSIONS: readonly AppPermission[] = [
	{ verb: 'create', resource: 'namespaces', group: '' },
	{ verb: 'create', resource: 'limitranges', group: '' },
	{ verb: 'patch', resource: 'limitranges', group: '' }
];

/** The one optional permission that turns required when the namespace still has to be created. */
export const APP_CREATE_NAMESPACE_PERMISSION: AppPermission = { verb: 'create', resource: 'namespaces', group: '' };

/** §6.3's cluster-scoped questions: a `namespace` attribute must never be sent with one. */
const CLUSTER_SCOPED_RESOURCES = new Set(['namespaces']);

/* ------------------------------------------------------------------------- *
 * The port over the API service
 * ------------------------------------------------------------------------- */

/**
 * The three methods a connection check needs, structurally a subset of `KubernetesApiService` (T10)
 * — so the plugin passes its service instance straight in and the spec passes a fake.
 */
export interface AppClusterCheckApi {
	getServerVersion(parsed: ParsedKubeconfig, kubeconfigYaml: string): Promise<string>;
	listObjects<T = Record<string, unknown>>(
		kubeconfigYaml: string,
		apiVersion: string,
		kind: string,
		namespace: string,
		labelSelector?: string,
		contextOverride?: string
	): Promise<T[]>;
	createSelfSubjectAccessReview(
		kubeconfigYaml: string,
		attributes: SelfSubjectAccessReviewInput,
		contextOverride?: string
	): Promise<SelfSubjectAccessReviewStatus>;
}

type AssertTrue<T extends true> = T;
/** A compile-time proof that the real service is drivable through {@link AppClusterCheckApi}. */
export type KubernetesApiServiceSatisfiesClusterCheckPort = AssertTrue<
	KubernetesApiService extends AppClusterCheckApi ? true : false
>;

/* ------------------------------------------------------------------------- *
 * The result
 * ------------------------------------------------------------------------- */

/**
 * §3.1's `AppClusterCheck` plus the one field §6.3 / §9.10 need and the frozen type does not carry:
 * the ingress controller Service's address (GAP-09 — a custom domain is verifiable before the first
 * Deployment). Assignable to `AppClusterCheck`, so `IDeploymentPlugin.checkAppCluster` type-checks.
 */
export interface AppClusterCheckReport extends AppClusterCheck {
	/** The observed address of the ingress controller's Service, or `null` when none is published. */
	readonly ingressAddress: { readonly ip?: string; readonly hostname?: string } | null;
}

/** Everything a check needs that is not already in the contract §3.1 fixes. */
export interface AppClusterCheckerOptions {
	/** §6.3's `/version` dial timeout. Defaults to {@link APP_CLUSTER_DIAL_TIMEOUT_MS}. */
	versionTimeoutMs?: number;
	/** The controller names the namespace detection looks for. Defaults to `ingress-nginx`, `traefik`. */
	controllerNames?: readonly string[];
}

/* ------------------------------------------------------------------------- *
 * The checker
 * ------------------------------------------------------------------------- */

/** The house shape of a missing-permission entry (§3.1). */
type MissingPermission = { verb: string; resource: string };

/**
 * `checkAppCluster` — T13's connection check.
 *
 * It **never throws for a cluster-side refusal**: an unsupported kubeconfig is the §6.1 guard's
 * refusal and stays one (the guard runs first and throws, exactly as it does before `deployApp`),
 * while an unreachable cluster is reported as `{ ok: false, error: { code: 'cluster_unreachable' } }`
 * — which is what the UI has to show. A list the credentials may not read (a missing cert-manager
 * CRD, a 403 on pods) is *not* an error: the permission table is the one place a capability is
 * judged, and it answers "no" for every verb that could not be exercised.
 */
export class AppClusterChecker {
	constructor(
		private readonly api: AppClusterCheckApi,
		private readonly options: AppClusterCheckerOptions = {}
	) {}

	/**
	 * `IDeploymentPlugin.checkAppCluster`'s signature (no ref — §3.1 gives the request the namespace
	 * and whether it still has to be created).
	 */
	async checkAppCluster(credential: string, req: AppClusterCheckRequest): Promise<AppClusterCheckReport> {
		// §6.1 first: a kubeconfig shape App Works refuse fails before any client is constructed, and
		// the fingerprint a check reports comes from that same parse.
		const supported: SupportedKubeconfig = assertSupportedKubeconfig(credential);
		const namespace = normalise(req?.namespace);
		const needsCreateNamespace = req?.needsCreateNamespace === true || !namespace;

		let serverVersion: string;
		try {
			serverVersion = await this.withDeadline(
				this.api.getServerVersion(parseKubeconfig(credential), credential),
				this.versionTimeoutMs(),
				`The cluster did not answer /version within ${Math.round(this.versionTimeoutMs() / 1_000)} s (plan §6.3).`
			);
		} catch (err) {
			return {
				ok: false,
				fingerprint: supported.fingerprint,
				missingPermissions: [],
				optionalMissing: [],
				ingressClasses: [],
				controllerNamespace: null,
				clusterIssuers: [],
				storageClasses: [],
				ingressAddress: null,
				error: {
					code: 'cluster_unreachable',
					message: scrubLiterals(scrubError(err).message, credentialLiterals(credential))
				}
			};
		}

		const required = [...APP_REQUIRED_PERMISSIONS];
		const optional = APP_OPTIONAL_PERMISSIONS.filter(
			(permission) =>
				!needsCreateNamespace ||
				permission.verb !== APP_CREATE_NAMESPACE_PERMISSION.verb ||
				permission.resource !== APP_CREATE_NAMESPACE_PERMISSION.resource
		);
		if (needsCreateNamespace) {
			// §6.3: "or, when it does not exist, `create namespaces` cluster-wide" — with no namespace to
			// ask about, the cluster-scoped create is the permission the App cannot proceed without.
			required.push(APP_CREATE_NAMESPACE_PERMISSION);
		}

		const missingPermissions = await this.missing(credential, required, namespace);
		const optionalMissing = await this.missing(credential, optional, namespace);
		const ingressClasses = await this.ingressClasses(credential);
		const controllerNamespace = await this.controllerNamespace(credential);
		const clusterIssuers = await this.clusterIssuers(credential);
		const storageClasses = await this.storageClasses(credential);
		const ingressAddress = await this.ingressAddress(credential, controllerNamespace);

		return {
			// ACC-06-05: a missing **required** permission blocks Save. A missing optional one is
			// reported beside it and blocks nothing.
			ok: missingPermissions.length === 0,
			serverVersion,
			fingerprint: supported.fingerprint,
			missingPermissions,
			optionalMissing,
			ingressClasses,
			controllerNamespace,
			clusterIssuers,
			storageClasses,
			ingressAddress
		};
	}

	/** Every question of `permissions` the credentials may not answer "yes" to, in table order. */
	private async missing(
		credential: string,
		permissions: readonly AppPermission[],
		namespace: string | null
	): Promise<MissingPermission[]> {
		const missing: MissingPermission[] = [];

		for (const permission of permissions) {
			const allowed = await this.allowed(credential, permission, namespace);
			if (!allowed) {
				missing.push({ verb: permission.verb, resource: permissionName(permission) });
			}
		}

		return missing;
	}

	/**
	 * One `SelfSubjectAccessReview`. A refusal, a response without a `status` and a thrown client
	 * error all read as "not allowed": this check fails closed, so an unanswerable question can never
	 * be mistaken for a granted permission.
	 */
	private async allowed(credential: string, permission: AppPermission, namespace: string | null): Promise<boolean> {
		try {
			const status = await this.api.createSelfSubjectAccessReview(credential, {
				verb: permission.verb,
				group: permission.group,
				resource: permission.resource,
				...(permission.subresource ? { subresource: permission.subresource } : {}),
				// §6.3's one cluster-scoped question (`create namespaces`) must not carry a namespace:
				// the API server rejects a namespaced attribute for a cluster-scoped resource.
				...(namespace && !CLUSTER_SCOPED_RESOURCES.has(permission.resource) ? { namespace } : {})
			});
			return status?.allowed === true;
		} catch {
			return false;
		}
	}

	/** §6.3: the `IngressClass` list, with the default marked. A 403 or an absent API is an empty list. */
	private async ingressClasses(credential: string): Promise<AppClusterCheck['ingressClasses']> {
		const classes = await this.safeList<{ metadata?: { name?: string; annotations?: Record<string, string> } }>(
			credential,
			'networking.k8s.io/v1',
			'IngressClass'
		);

		return classes
			.map((entry) => ({
				name: String(entry?.metadata?.name ?? ''),
				isDefault: entry?.metadata?.annotations?.[APP_INGRESS_CLASS_DEFAULT_ANNOTATION] === 'true'
			}))
			.filter((entry) => entry.name.length > 0)
			.sort((left, right) => left.name.localeCompare(right.name));
	}

	/**
	 * §6.3: the controller namespace, from the pods carrying
	 * `app.kubernetes.io/name ∈ {ingress-nginx, traefik}` across all namespaces. Skipped on a 403 —
	 * a credential that may not list pods cluster-wide still gets a usable check, with `null` here.
	 */
	private async controllerNamespace(credential: string): Promise<string | null> {
		const selector = `${CONTROLLER_LABEL} in (${this.controllerNames().join(',')})`;
		const pods = await this.safeList<{ metadata?: { name?: string; namespace?: string } }>(
			credential,
			'v1',
			'Pod',
			'',
			selector
		);

		const namespaces = [
			...new Set(
				pods
					.map((pod) => normalise(pod?.metadata?.namespace))
					.filter((entry): entry is string => entry !== null)
			)
		].sort();

		return namespaces[0] ?? null;
	}

	/** §6.3: `cert-manager.io/v1` `ClusterIssuer` names; absent CRD or 403 is an empty list. */
	private async clusterIssuers(credential: string): Promise<string[]> {
		const issuers = await this.safeList<{ metadata?: { name?: string } }>(
			credential,
			'cert-manager.io/v1',
			'ClusterIssuer'
		);
		return issuers
			.map((issuer) => String(issuer?.metadata?.name ?? ''))
			.filter((name) => name.length > 0)
			.sort();
	}

	/** §6.3: the `StorageClass` list, with the default marked. */
	private async storageClasses(credential: string): Promise<AppClusterCheck['storageClasses']> {
		const classes = await this.safeList<{ metadata?: { name?: string; annotations?: Record<string, string> } }>(
			credential,
			'storage.k8s.io/v1',
			'StorageClass'
		);

		return classes
			.map((entry) => ({
				name: String(entry?.metadata?.name ?? ''),
				isDefault: APP_STORAGE_CLASS_DEFAULT_ANNOTATIONS.some(
					(annotation) => entry?.metadata?.annotations?.[annotation] === 'true'
				)
			}))
			.filter((entry) => entry.name.length > 0)
			.sort((left, right) => left.name.localeCompare(right.name));
	}

	/**
	 * §6.3 / GAP-09: the ingress controller **Service**'s load-balancer address, read during the
	 * check so a custom domain can be verified before the first Deployment. The Service is looked for
	 * in the detected controller namespace, by the controller label first and by `type: LoadBalancer`
	 * second (a chart that labels its Service differently still gets an address reported).
	 */
	private async ingressAddress(
		credential: string,
		controllerNamespace: string | null
	): Promise<AppClusterCheckReport['ingressAddress']> {
		if (!controllerNamespace) {
			return null;
		}

		const labelled = await this.safeList<AppControllerService>(
			credential,
			'v1',
			'Service',
			controllerNamespace,
			`${CONTROLLER_LABEL} in (${this.controllerNames().join(',')})`
		);
		const all =
			labelled.length > 0
				? labelled
				: await this.safeList<AppControllerService>(credential, 'v1', 'Service', controllerNamespace);

		const candidates = [...all].sort((left, right) =>
			String(left?.metadata?.name ?? '').localeCompare(String(right?.metadata?.name ?? ''))
		);
		const loadBalancers = candidates.filter((service) => service?.spec?.type === 'LoadBalancer');
		const withAddress = (loadBalancers.length > 0 ? loadBalancers : candidates).find(
			(service) => addressOf(service) !== null
		);

		return withAddress ? addressOf(withAddress) : null;
	}

	/** A list the check may not be allowed to make is an empty list — never a thrown check. */
	private async safeList<T>(
		credential: string,
		apiVersion: string,
		kind: string,
		namespace = '',
		labelSelector?: string
	): Promise<T[]> {
		try {
			return await this.api.listObjects<T>(credential, apiVersion, kind, namespace, labelSelector);
		} catch {
			return [];
		}
	}

	private versionTimeoutMs(): number {
		const declared = this.options.versionTimeoutMs;
		return typeof declared === 'number' && Number.isFinite(declared) && declared > 0
			? declared
			: APP_CLUSTER_DIAL_TIMEOUT_MS;
	}

	private controllerNames(): string[] {
		const declared = this.options.controllerNames;
		return Array.isArray(declared) && declared.length > 0 ? [...declared] : [...APP_INGRESS_CONTROLLER_NAMES];
	}

	/**
	 * §6.3's `/version` budget. The client call itself is not cancellable — the timer only stops the
	 * **check** from hanging on a half-open connection, which is the failure this budget exists for;
	 * the abandoned promise resolves into nothing.
	 */
	private async withDeadline<T>(work: Promise<T>, millis: number, message: string): Promise<T> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => reject(new K8sPluginError('CLUSTER_UNREACHABLE', message)), millis);
		});

		try {
			return await Promise.race([work, timeout]);
		} finally {
			if (timer) {
				clearTimeout(timer);
			}
		}
	}
}

/* ------------------------------------------------------------------------- *
 * Module-level helpers
 * ------------------------------------------------------------------------- */

/** The `v1` Service fields the controller-address read touches. */
interface AppControllerService {
	metadata?: { name?: string; namespace?: string } | null;
	spec?: { type?: string } | null;
	status?: { loadBalancer?: { ingress?: readonly { ip?: string; hostname?: string }[] } } | null;
}

/** The Service's published address, or `null` while the controller has none. */
function addressOf(service: AppControllerService | null | undefined): { ip?: string; hostname?: string } | null {
	const first = service?.status?.loadBalancer?.ingress?.[0];
	const address: { ip?: string; hostname?: string } = {};
	if (typeof first?.ip === 'string' && first.ip) {
		address.ip = first.ip;
	}
	if (typeof first?.hostname === 'string' && first.hostname) {
		address.hostname = first.hostname;
	}
	return Object.keys(address).length > 0 ? address : null;
}

function normalise(value: unknown): string | null {
	const text = typeof value === 'string' ? value.trim() : '';
	return text ? text : null;
}
