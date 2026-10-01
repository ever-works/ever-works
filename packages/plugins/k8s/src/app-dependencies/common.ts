/**
 * APW-07 T19 — what every in-cluster dependency provider shares: the label set, the security contexts, the
 * reachability policy, and the two cluster probes this epic (not APW-06) owns.
 *
 * Sources, in priority order:
 *
 * 1. `docs/specs/features/app-works/APW-07-app-env-and-dependencies/plan.md` §4.9:575-580 — the common label
 *    set ("APW-06's label set … plus `ever-works.io/dependency: <kind>` — the label APW-06's `destroyApp`
 *    never deletes without `deleteVolumes` — and `ever-works.io/retain: "true"` on PVCs; pod `securityContext`
 *    `runAsNonRoot: true`, `seccompProfile: RuntimeDefault`, container `allowPrivilegeEscalation: false`,
 *    `capabilities.drop: [ALL]`"), and §4.9:582-602 — the reachability rules this epic owns outright.
 * 2. `plan.md` §4.9:604-611 — the cluster permissions the providers need: `statefulsets` required, the CRD
 *    read and the operator resources optional, a denied CRD read choosing the plain path with
 *    `statusDetail.operatorSkipped = 'noPermission'`, and a 403 on StatefulSet create failing the card with
 *    `clusterPermissionMissing`.
 * 3. `spec.md` FR-36 (the operator path is chosen only when its resources exist **and** the platform's access
 *    may create them in the app's namespace) and FR-38 ("reachable only from the App Work's own pods … exposes
 *    no dependency outside the cluster").
 *
 * ## One owner per closed set
 *
 * Every name, label and annotation here is **imported** from the module that already owns it — `app-names.ts`
 * for `dep-<kind>` and `ever-works.io/retain`, `app-network-policy.renderer.ts` for
 * `ever-works.io/dependency` and the `kubernetes.io/metadata.name` label, `app-cluster-check.ts` for the two
 * default-StorageClass annotations, `@ever-works/contracts` for the ports and default sizes. Nothing is
 * restated, because a second literal is a second thing to change.
 *
 * ## Why the reachability policy is drawn here and not by APW-06
 *
 * `plan.md` §4.9:582-602 (rewritten 2026-09-17, APW07-G01): the provider applies its own `dep-<kind>` policy
 * **before** its workload and **whatever the App Work's isolation setting is**. `ew-allow-deps` allows egress
 * *out* of the namespace, so it never kept anyone *out*, and with `isolation: false` APW-06 draws no `ew-*`
 * policy at all — which is why FR-38 lives here. {@link planDependencyNetworkPolicy} therefore takes no
 * isolation flag: there is no input that could switch the policy off.
 */
import type { AppDependencyBackupStatus, AppDependencyKind, AppDependencyResourceRefs } from '@ever-works/plugin';

import type {
	KubernetesApiService,
	SelfSubjectAccessReviewInput,
	SelfSubjectAccessReviewStatus
} from '../k8s-api.service.js';
import {
	APP_DEPENDENCY_POLICY_LABEL,
	APP_NAMESPACE_NAME_LABEL,
	APP_NETWORK_POLICY_API_VERSION
} from '../app/app-network-policy.renderer.js';
import { APP_LABEL_RETAIN, appLabels, dependencyNetworkPolicyName } from '../app/app-names.js';

/* ------------------------------------------------------------------------- *
 * The port over the API service
 * ------------------------------------------------------------------------- */

/**
 * The seven methods a dependency provider needs, structurally a subset of `KubernetesApiService` — the same
 * idiom `AppLifecycleApi` and `AppClusterCheckApi` use, so the plugin passes its service instance straight in
 * and each spec passes a fake. Every method takes the kubeconfig first, exactly as the service declares it.
 *
 * `crdServed` and `defaultStorageClass` are APW-07 **T18's** members (`k8s-api.service.ts:871` / `:899`), and
 * they are called, never re-derived: T18 owns the 404-versus-denial distinction (a non-404 failure throws so
 * "the operator is not installed" stays distinguishable from "we may not look", APW07-G10) and the default-class
 * annotation rule. Re-implementing either in a provider is the duplication this port exists to avoid.
 */
export interface AppDependencyApi {
	applyObject(kubeconfigYaml: string, manifest: Record<string, unknown>, contextOverride?: string): Promise<void>;
	readObject<T = Record<string, unknown>>(
		kubeconfigYaml: string,
		apiVersion: string,
		kind: string,
		namespace: string,
		name: string,
		contextOverride?: string
	): Promise<T | null>;
	listObjects<T = Record<string, unknown>>(
		kubeconfigYaml: string,
		apiVersion: string,
		kind: string,
		namespace: string,
		labelSelector?: string,
		contextOverride?: string
	): Promise<T[]>;
	deleteObject(
		kubeconfigYaml: string,
		apiVersion: string,
		kind: string,
		namespace: string,
		name: string,
		propagationPolicy?: string,
		contextOverride?: string
	): Promise<void>;
	createSelfSubjectAccessReview(
		kubeconfigYaml: string,
		attributes: SelfSubjectAccessReviewInput,
		contextOverride?: string
	): Promise<SelfSubjectAccessReviewStatus>;
	/** T18 (`k8s-api.service.ts:871`): CRD installed **and** serving `version`; 404 ⇒ `false`, a denial throws. */
	crdServed(kubeconfigYaml: string, name: string, version: string, contextOverride?: string): Promise<boolean>;
	/** T18 (`k8s-api.service.ts:899`): the cluster's default `StorageClass`, or `null`; a denial throws. */
	defaultStorageClass(kubeconfigYaml: string, contextOverride?: string): Promise<string | null>;
}

type AssertTrue<T extends true> = T;
/** A compile-time proof that the real service is drivable through {@link AppDependencyApi}. */
export type KubernetesApiServiceSatisfiesDependencyPort = AssertTrue<
	KubernetesApiService extends AppDependencyApi ? true : false
>;

/* ------------------------------------------------------------------------- *
 * Names, ports and API versions
 * ------------------------------------------------------------------------- */

/** The three kinds this plugin serves; `smtp` is `app-dependencies-external`'s (plan §4.9:570). */
export const APP_DEPENDENCY_K8S_KINDS = ['postgres', 'redis', 'objectStorage'] as const;

/** The dependency kind of one of this plugin's providers. */
export type AppDependencyK8sKind = (typeof APP_DEPENDENCY_K8S_KINDS)[number];

/** The container port each kind's Service publishes (plan §4.9:588 — "on the service ports (5432, 6379, 9000)"). */
export const APP_DEPENDENCY_PORTS: Readonly<Record<AppDependencyK8sKind, number>> = {
	postgres: 5432,
	redis: 6379,
	objectStorage: 9000
};

/**
 * The CloudNativePG instance manager's status port (plan §4.9:592 — "the operator status port and 5432").
 *
 * It is the port the operator's own tooling (`cnpg status`, the instance-manager probes) talks to when it
 * cannot reach Postgres itself, which is why the operator-namespace admission carries it beside 5432.
 */
export const APP_DEPENDENCY_OPERATOR_STATUS_PORT = 8000;

/** The `apiVersion` of the CloudNativePG `Cluster`/`Backup`/`ScheduledBackup` resources. */
export const POSTGRES_OPERATOR_API_VERSION = 'postgresql.cnpg.io/v1';

/** The `Cluster` CRD the operator path needs served — the name T18's `crdServed` is asked about. */
export const POSTGRES_CLUSTER_CRD = 'clusters.postgresql.cnpg.io';

/** `dep-<kind>` — the name the plan gives the policy, the Secret, the workload and the Service alike. */
export function dependencyName(kind: AppDependencyK8sKind | string): string {
	return dependencyNetworkPolicyName(String(kind));
}

/** The `cnpg.io/cluster` label the operator puts on a cluster's `Backup` and `ScheduledBackup` objects. */
export const POSTGRES_OPERATOR_CLUSTER_LABEL = 'cnpg.io/cluster';

/** The label selector those objects are listed with (plan §4.9:615). */
export function postgresOperatorLabelSelector(clusterName: string): string {
	return `${POSTGRES_OPERATOR_CLUSTER_LABEL}=${clusterName}`;
}

/* ------------------------------------------------------------------------- *
 * Labels
 * ------------------------------------------------------------------------- */

/** The App-label fields every dependency object carries. */
export interface DependencyLabelInput {
	workId: string;
	workSlug: string;
	kind: AppDependencyK8sKind | string;
}

/**
 * APW-06's label set plus `ever-works.io/dependency: <kind>` — the label that marks every object this epic
 * owns, and the one APW-06's `destroyApp` refuses to delete without `deleteVolumes` (ACC-06-54, R-15).
 */
export function dependencyLabels(input: DependencyLabelInput): Record<string, string> {
	return {
		...appLabels({ workId: String(input?.workId ?? ''), workSlug: String(input?.workSlug ?? '') }),
		[APP_DEPENDENCY_POLICY_LABEL]: String(input?.kind ?? '')
	};
}

/**
 * {@link dependencyLabels} plus `ever-works.io/retain: "true"` — the PVC label (plan §4.9:578).
 *
 * A claim is never garbage-collected with its StatefulSet, so the label is what tells a later reader (and the
 * delete-data dialog) that the volume is deliberate.
 */
export function dependencyPvcLabels(input: DependencyLabelInput): Record<string, string> {
	return { ...dependencyLabels(input), [APP_LABEL_RETAIN]: 'true' };
}

/** The `podSelector` of a dependency's policy and the `matchLabels` of its workload's pod template. */
export function dependencyPodSelector(kind: AppDependencyK8sKind | string): Record<string, string> {
	return { [APP_DEPENDENCY_POLICY_LABEL]: String(kind) };
}

/* ------------------------------------------------------------------------- *
 * Security contexts (plan §4.9:578-579)
 * ------------------------------------------------------------------------- */

/** A pod-security context as the plan fixes it: never root, always a `RuntimeDefault` seccomp profile. */
export interface DependencyPodSecurityContext {
	runAsNonRoot: true;
	seccompProfile: { type: 'RuntimeDefault' };
	runAsUser?: number;
	runAsGroup?: number;
	fsGroup?: number;
}

/** A container-security context as the plan fixes it: no escalation, every capability dropped. */
export interface DependencyContainerSecurityContext {
	allowPrivilegeEscalation: false;
	capabilities: { drop: ['ALL'] };
}

/** The uid/gid/fsGroup the official Postgres image runs as (plan §4.9:616 — "uid/gid/fsGroup 999"). */
export const DEPENDENCY_POSTGRES_UID = 999;
/** The matching gid. */
export const DEPENDENCY_POSTGRES_GID = 999;

/**
 * The pod-level security context.
 *
 * `runAsNonRoot: true` and `seccompProfile: RuntimeDefault` are **not** parameters: the plan fixes them for
 * every dependency, and a caller that could turn `runAsNonRoot` off would be a caller that can render a root
 * pod. Only the numeric ids are optional, and only an integer is accepted — a name or a fraction is dropped
 * rather than rounded into a uid the image may not have.
 */
export function dependencyPodSecurityContext(
	ids: {
		runAsUser?: number | null;
		runAsGroup?: number | null;
		fsGroup?: number | null;
	} = {}
): DependencyPodSecurityContext {
	const context: DependencyPodSecurityContext = {
		runAsNonRoot: true,
		seccompProfile: { type: 'RuntimeDefault' }
	};

	const runAsUser = integerId(ids?.runAsUser);
	if (runAsUser !== null) context.runAsUser = runAsUser;
	const runAsGroup = integerId(ids?.runAsGroup);
	if (runAsGroup !== null) context.runAsGroup = runAsGroup;
	const fsGroup = integerId(ids?.fsGroup);
	if (fsGroup !== null) context.fsGroup = fsGroup;

	return context;
}

/** The container-level security context — the same for every dependency container (plan §4.9:579). */
export function dependencyContainerSecurityContext(): DependencyContainerSecurityContext {
	return { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } };
}

function integerId(value: unknown): number | null {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/* ------------------------------------------------------------------------- *
 * Reachability (plan §4.9:582-602, FR-38)
 * ------------------------------------------------------------------------- */

/** A rendered dependency object. A `type` alias so it stays assignable to the app renderer's object shape. */
export type AppDependencyRenderedObject = {
	apiVersion: string;
	kind: string;
	metadata: {
		name: string;
		namespace: string;
		labels: Record<string, string>;
		[key: string]: unknown;
	};
	[key: string]: unknown;
};

/** What {@link planDependencyNetworkPolicy} needs to draw `dep-<kind>`. */
export interface DependencyNetworkPolicyInput extends DependencyLabelInput {
	namespace: string;
	/** The service port the kind is reached on — same-namespace pods get exactly this one. */
	port: number;
	/**
	 * The operator's namespace, when the operator path detected it. `null`/absent means either "not the
	 * operator path" or "detection failed" — {@link DependencyNetworkPolicyInput.operatorFallback} tells the
	 * two apart.
	 */
	operatorNamespace?: string | null;
	/**
	 * True when the operator path is in use but its namespace could not be detected: the plan's fallback then
	 * admits **any** namespace on the two operator ports only (plan §4.9:591-592), and the caller reports the
	 * warning `operatorNamespaceUnknown`.
	 */
	operatorFallback?: boolean;
}

/** The policy plus the warnings drawing it produced. */
export interface AppDependencyNetworkPolicyPlan {
	policy: AppDependencyRenderedObject;
	/** `['operatorNamespaceUnknown']` when the operator path could not name its namespace. */
	warnings: string[];
}

/**
 * `dep-<kind>` — the plan's reachability policy, as a plan object so the warning travels with it.
 *
 * Three rules, and nothing outside them is admitted:
 *
 * 1. **Same namespace only.** `from: [{ podSelector: {} }]` with no `namespaceSelector` means "pods in this
 *    policy's own namespace" — that is the whole of FR-38 for a pod outside the App Work.
 * 2. **On the kind's own service port** — never "every port", so an admitted neighbour cannot reach an
 *    instance manager, an admin endpoint or a metrics port.
 * 3. **On the operator path only**, the operator's namespace, on 5432 and the status port; when the operator's
 *    namespace is unknown, the documented fallback admits every namespace on those two ports **only**, and the
 *    caller reports `operatorNamespaceUnknown`.
 *
 * `policyTypes: [Ingress]` and no egress rules: a dependency's own outgoing traffic is not this policy's
 * business, and an empty `egress` list would have denied it.
 */
export function planDependencyNetworkPolicy(input: DependencyNetworkPolicyInput): AppDependencyNetworkPolicyPlan {
	const kind = String(input?.kind ?? '');
	const port = normalisePort(input?.port);
	const warnings: string[] = [];
	const ingress: Record<string, unknown>[] = [{ from: [{ podSelector: {} }], ports: [{ protocol: 'TCP', port }] }];

	const operatorNamespace = normaliseName(input?.operatorNamespace);
	if (operatorNamespace) {
		ingress.push({
			from: [{ namespaceSelector: { matchLabels: { [APP_NAMESPACE_NAME_LABEL]: operatorNamespace } } }],
			ports: operatorPorts()
		});
	} else if (input?.operatorFallback === true) {
		warnings.push('operatorNamespaceUnknown');
		ingress.push({ from: [{ namespaceSelector: {} }], ports: operatorPorts() });
	}

	return {
		policy: {
			apiVersion: APP_NETWORK_POLICY_API_VERSION,
			kind: 'NetworkPolicy',
			metadata: {
				name: dependencyName(kind),
				namespace: String(input?.namespace ?? ''),
				labels: dependencyLabels({ workId: input?.workId, workSlug: input?.workSlug, kind })
			},
			spec: {
				podSelector: { matchLabels: dependencyPodSelector(kind) },
				policyTypes: ['Ingress'],
				ingress
			}
		},
		warnings
	};
}

/** {@link planDependencyNetworkPolicy}'s policy alone — the object a provider applies. */
export function renderDependencyNetworkPolicy(input: DependencyNetworkPolicyInput): AppDependencyRenderedObject {
	return planDependencyNetworkPolicy(input).policy;
}

/** 5432 and the operator status port — the two ports the operator-namespace rules admit. */
function operatorPorts(): { protocol: string; port: number }[] {
	return [
		{ protocol: 'TCP', port: APP_DEPENDENCY_PORTS.postgres },
		{ protocol: 'TCP', port: APP_DEPENDENCY_OPERATOR_STATUS_PORT }
	];
}

function normalisePort(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function normaliseName(value: unknown): string | null {
	const text = typeof value === 'string' ? value.trim() : '';
	return text || null;
}

/* ------------------------------------------------------------------------- *
 * The two probes T18 owns, called through the port
 * ------------------------------------------------------------------------- */

/**
 * Is the operator's CRD installed **and** serving `v1`?
 *
 * A thin, named delegation to APW-07 **T18**'s `KubernetesApiService.crdServed` (`k8s-api.service.ts:871`) —
 * the member exists now, and this epic calls it rather than re-deriving it. T18 owns both halves of the rule
 * that make APW07-G10 work:
 *
 * - a 404, a version the CRD does not serve, or `served: false` ⇒ **`false`** ("the operator is not
 *   installed" ⇒ the plain path);
 * - **any non-404 failure throws** a scrubbed `K8sPluginError` (403 ⇒ code `UNAUTHORIZED`) instead of
 *   answering `false`, so "we may not look" stays distinguishable from "it is not there". {@link
 *   probePostgresOperator} catches exactly that refusal and reports `operatorSkipped: 'noPermission'`.
 *
 * The wrapper stays because `AppDependencyApi.crdServed`'s kubeconfig-first arity is the port's, and naming
 * the CRD once here is what keeps `probePostgresOperator` readable.
 */
export async function crdServed(
	api: AppDependencyApi,
	kubeconfig: string,
	name: string,
	version: string,
	context?: string
): Promise<boolean> {
	return api.crdServed(kubeconfig, name, version, context);
}

/**
 * The cluster's default `StorageClass`, or `null` when it has none — T18's
 * `KubernetesApiService.defaultStorageClass` (`k8s-api.service.ts:899`), called, never re-derived.
 *
 * `null` therefore always means "this cluster really has no default" (both the GA and the beta annotation were
 * checked, and a class merely *listed first* is not the default), which is exactly the precondition S18 /
 * ACC-07-20 fails on with the definite reason `noDefaultStorageClass`. A refusal throws rather than answering
 * `null`, so an unreadable class list can never be mistaken for a missing default.
 */
export async function defaultStorageClass(
	api: AppDependencyApi,
	kubeconfig: string,
	context?: string
): Promise<string | null> {
	return api.defaultStorageClass(kubeconfig, context);
}

/**
 * The namespace the CloudNativePG operator runs in, read from its own Deployment, or `null`.
 *
 * A cluster-scoped list by label is the detection: the operator's Deployment is the only object that names
 * the namespace the operator's pods live in, and the plan says to detect it "from its Deployment"
 * (§4.9:591). The list failing (no permission, no such API) is `null`, which the caller turns into the
 * documented `operatorNamespaceUnknown` fallback rather than a failure.
 */
export async function detectOperatorNamespace(
	api: AppDependencyApi,
	kubeconfig: string,
	context?: string
): Promise<string | null> {
	try {
		const deployments = await api.listObjects<{
			metadata?: { namespace?: string; labels?: Record<string, string> };
		}>(kubeconfig, 'apps/v1', 'Deployment', '', 'app.kubernetes.io/name=cloudnative-pg', context);

		const namespace = deployments[0]?.metadata?.namespace;
		return normaliseName(namespace);
	} catch {
		return null;
	}
}

/** Why the operator path was not taken — the values of `statusDetail.operatorSkipped` (plan §4.9:610). */
export type AppDependencyOperatorSkipped = 'noPermission' | 'crdNotServed';

/** The operator probe's answer. */
export type PostgresOperatorProbe =
	| { usable: true; operatorNamespace: string | null }
	| { usable: false; operatorSkipped: AppDependencyOperatorSkipped };

/**
 * May this provider use the CloudNativePG operator for `namespace`?
 *
 * FR-36's two conditions, in order: the cluster's operator **resources exist** (`crdServed`) **and** the
 * platform's access **may create them in the app's namespace** (one `SelfSubjectAccessReview` for
 * `create postgresql.cnpg.io clusters`, the same fail-closed shape `AppClusterChecker` uses). A denied CRD
 * read and a denied create are both `noPermission`; an absent CRD is `crdNotServed` — the plan records the
 * first explicitly (`statusDetail.operatorSkipped = 'noPermission'`) and the second is the plain path's whole
 * reason for existing.
 *
 * The probe never throws for a refusal; a genuinely unreachable cluster still throws (`readObject` wraps it),
 * so the caller can report the transient `clusterUnreachable` rather than silently downgrading to the plain
 * path — which would create a second, unmanaged database beside the operator's.
 */
export async function probePostgresOperator(
	api: AppDependencyApi,
	kubeconfig: string,
	namespace: string,
	context?: string
): Promise<PostgresOperatorProbe> {
	let served: boolean;
	try {
		served = await crdServed(api, kubeconfig, POSTGRES_CLUSTER_CRD, 'v1', context);
	} catch (error) {
		if (isForbidden(error)) return { usable: false, operatorSkipped: 'noPermission' };
		throw error;
	}

	if (!served) return { usable: false, operatorSkipped: 'crdNotServed' };

	let allowed: boolean;
	try {
		const status = await api.createSelfSubjectAccessReview(
			kubeconfig,
			{
				verb: 'create',
				group: 'postgresql.cnpg.io',
				resource: 'clusters',
				...(namespace ? { namespace } : {})
			},
			context
		);
		allowed = status?.allowed === true;
	} catch (error) {
		if (isForbidden(error)) return { usable: false, operatorSkipped: 'noPermission' };
		throw error;
	}

	if (!allowed) return { usable: false, operatorSkipped: 'noPermission' };

	return { usable: true, operatorNamespace: await detectOperatorNamespace(api, kubeconfig, context) };
}

/**
 * Is this error a refusal?
 *
 * `scrubError` classifies 401/403/forbidden text as `UNAUTHORIZED` (`errors.ts`), and the wrapped
 * `K8sPluginError` keeps the original on `cause`, so the check reads the scrubbed code first and the status
 * code second — the same test `app-lifecycle.ts` uses for its `limitrange_forbidden` skip.
 */
export function isForbidden(error: unknown): boolean {
	const candidate = error as { code?: unknown; cause?: unknown } | undefined;
	if (candidate?.code === 'UNAUTHORIZED') return true;
	const cause = candidate?.cause as
		| { statusCode?: number; code?: number; response?: { statusCode?: number } }
		| undefined;
	return cause?.statusCode === 403 || cause?.code === 403 || cause?.response?.statusCode === 403;
}

/* ------------------------------------------------------------------------- *
 * Provider settings (plan §4.9:630-633)
 * ------------------------------------------------------------------------- */

/** The `appDependencySizes` setting, per sized kind — a default for the configure dialog, never a floor. */
export interface AppDependencySizes {
	readonly postgres: number;
	readonly objectStorage: number;
	readonly redis: number;
}

/**
 * FR-37's default volumes, in GiB.
 *
 * **These three numbers have an owner elsewhere and are restated here deliberately, not by accident.**
 * `APP_DEPENDENCY_DEFAULT_SIZE_GIB` in `packages/contracts/src/apps/app-dependencies.ts` is the normative
 * declaration (10 / 20 / 1), and the k8s plugin **cannot** import it: the plugin has no dependency on
 * `@ever-works/contracts` — `app-manifest.renderer.ts:58-61` records that decision for this plugin, and
 * `@ever-works/plugin` re-exports the contract's app-dependency **types** but not its values. Adding the
 * dependency is a `package.json` change T19 does not own, so the values are mirrored here with their owner
 * named. A drift is caught by APW-07's schema/contract parity work rather than silently: the configure
 * dialog renders the setting from the plugin's own schema, and this table only ever *seeds* it.
 */
export const APP_DEPENDENCY_SIZE_DEFAULTS: AppDependencySizes = { postgres: 10, objectStorage: 20, redis: 1 };

/**
 * FR-48's **Overdue** line: 26 hours, restated for the same reason {@link APP_DEPENDENCY_SIZE_DEFAULTS} is.
 *
 * `APP_DEPENDENCY_BACKUP_OVERDUE_MS` (`packages/contracts/src/apps/app-dependencies.ts`) owns the number and
 * `isAppDependencyBackupOverdue` is its comparison; this module needs the same window to answer a backup state
 * from a cluster it reads itself.
 */
export const APP_DEPENDENCY_BACKUP_OVERDUE_MS = 26 * 3_600_000;

/** What a provider reads out of `ctx.settings`. */
export interface AppDependencyProviderSettings {
	/** `appDependencyStorageClass`, or `null` to use the cluster's own default class. */
	readonly storageClass: string | null;
	readonly sizes: AppDependencySizes;
}

/** The settings as the plugin declares them, read defensively out of a stored blob. */
export function dependencyProviderSettings(
	settings: Record<string, unknown> | undefined
): AppDependencyProviderSettings {
	return {
		storageClass: normaliseName(settings?.appDependencyStorageClass),
		sizes: {
			postgres: sizeSetting(settings, 'postgres'),
			objectStorage: sizeSetting(settings, 'objectStorage'),
			redis: sizeSetting(settings, 'redis')
		}
	};
}

function sizeSetting(settings: Record<string, unknown> | undefined, kind: keyof AppDependencySizes): number {
	const raw = settings?.appDependencySizes;
	const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>)[kind] : undefined;
	return positiveInteger(value) ?? APP_DEPENDENCY_SIZE_DEFAULTS[kind];
}

/**
 * The volume size a provisioning run uses, in GiB.
 *
 * `ctx.sizeGiB` (the owner's own choice, FR-37) wins; then the plugin's `appDependencySizes` default; then the
 * contract's {@link APP_DEPENDENCY_SIZE_DEFAULTS}. The plan is explicit that the setting is "a **default**
 * seeding the configure dialog, not a floor" (§4.9:631), so a smaller-but-positive owner choice is honoured
 * rather than raised — refusing a shrink is `PUT …/:kind`'s job (FR-63), not the renderer's.
 */
export function dependencySizeGiB(
	kind: keyof AppDependencySizes,
	settings: Record<string, unknown> | undefined,
	requested: unknown
): number {
	return positiveInteger(requested) ?? sizeSetting(settings, kind);
}

function positiveInteger(value: unknown): number | null {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** `10Gi`-style quantity for a GiB size — the only place a size becomes a Kubernetes quantity. */
export function gibQuantity(gib: number): string {
	const bounded = positiveInteger(gib) ?? APP_DEPENDENCY_SIZE_DEFAULTS.postgres;
	return `${bounded}Gi`;
}

/* ------------------------------------------------------------------------- *
 * Backup state (FR-48/FR-49, plan §4.9:615)
 * ------------------------------------------------------------------------- */

/** A CNPG `Backup` object, as much of it as FR-49 reads. */
export interface PostgresBackupObject {
	metadata?: { name?: string; creationTimestamp?: string; labels?: Record<string, string> };
	status?: { phase?: string; stoppedAt?: string; startedAt?: string };
	/** Present on a `Cluster` — read by nothing here, and deliberately so (see {@link postgresBackupStatus}). */
	lastSuccessfulBackup?: string;
}

/** A CNPG `ScheduledBackup` object, as much as "has a schedule existed for 26 hours" needs. */
export interface PostgresScheduledBackupObject {
	metadata?: { name?: string; creationTimestamp?: string };
}

/**
 * FR-48/FR-49's one backup state, from the operator's **individual** records.
 *
 * The algorithm is the plan's, exactly (`plan.md` §4.9:615):
 *
 * - the newest `Backup` **by `status.stoppedAt`** decides: `completed` within
 *   {@link APP_DEPENDENCY_BACKUP_OVERDUE_MS} → `healthy`, older → `overdue`, `failed` → `failing`;
 * - no `Backup` at all → `not_configured` when no `ScheduledBackup` exists, `overdue` when one has existed
 *   longer than the same window, and otherwise `unknown` ("first backup pending");
 * - **never** `Cluster.status.lastSuccessfulBackup`. That field is exactly the "summary field that can report
 *   success while backups fail" FR-49 forbids reading, and a spec pins it: a cluster whose summary claims a
 *   fresh success while its newest `Backup` failed must read `failing`. {@link PostgresBackupObject} does not
 *   even carry the cluster's `status`, so the forbidden read is not merely avoided but unavailable here.
 */
export function postgresBackupStatus(input: {
	backups: readonly PostgresBackupObject[];
	scheduledBackups: readonly PostgresScheduledBackupObject[];
	now: number;
}): AppDependencyBackupStatus {
	const newest = newestBackup(input?.backups ?? []);
	if (newest) {
		const stoppedAt =
			normaliseTimestamp(newest.status?.stoppedAt) ?? normaliseTimestamp(newest.metadata?.creationTimestamp);
		const phase = String(newest.status?.phase ?? '').toLowerCase();
		const lastBackupAt = stoppedAt ?? undefined;

		if (phase === 'failed') return withTimestamp({ state: 'failing' }, lastBackupAt);
		if (phase === 'completed') {
			if (stoppedAt === null) return withTimestamp({ state: 'healthy' }, lastBackupAt);
			const overdue = input.now - Date.parse(stoppedAt) > APP_DEPENDENCY_BACKUP_OVERDUE_MS;
			return withTimestamp({ state: overdue ? 'overdue' : 'healthy' }, lastBackupAt);
		}

		// A `Backup` the operator has not finished (or a phase this contract does not know): the honest answer
		// is that the last attempt has no verdict yet, and its start is not a completion.
		return { state: 'unknown' };
	}

	const schedule = oldestTimestamp(input?.scheduledBackups ?? []);
	if (schedule === null) return { state: 'not_configured' };
	const overdue = input.now - Date.parse(schedule) > APP_DEPENDENCY_BACKUP_OVERDUE_MS;
	return { state: overdue ? 'overdue' : 'unknown' };
}

/** The newest `Backup` of a list, by `status.stoppedAt` and then by creation time. */
export function newestBackup(backups: readonly PostgresBackupObject[]): PostgresBackupObject | null {
	let best: PostgresBackupObject | null = null;
	let bestAt = Number.NEGATIVE_INFINITY;

	for (const backup of backups) {
		const at =
			normaliseTimestamp(backup?.status?.stoppedAt) ?? normaliseTimestamp(backup?.metadata?.creationTimestamp);
		const millis = at === null ? Number.NEGATIVE_INFINITY : Date.parse(at);
		if (best === null || millis > bestAt) {
			best = backup;
			bestAt = millis;
		}
	}

	return best;
}

function withTimestamp(
	status: { state: AppDependencyBackupStatus['state'] },
	lastBackupAt: string | undefined
): AppDependencyBackupStatus {
	return lastBackupAt ? { state: status.state, lastBackupAt } : { state: status.state };
}

function oldestTimestamp(scheduled: readonly PostgresScheduledBackupObject[]): string | null {
	let oldest: string | null = null;
	for (const entry of scheduled) {
		const at = normaliseTimestamp(entry?.metadata?.creationTimestamp);
		if (at === null) continue;
		if (oldest === null || Date.parse(at) < Date.parse(oldest)) oldest = at;
	}
	return oldest;
}

function normaliseTimestamp(value: unknown): string | null {
	const text = typeof value === 'string' ? value.trim() : '';
	if (!text) return null;
	return Number.isNaN(Date.parse(text)) ? null : text;
}

/* ------------------------------------------------------------------------- *
 * Resource refs
 * ------------------------------------------------------------------------- */

/** One entry of {@link AppDependencyResourceRefs.objects}. */
export interface AppDependencyObjectRef {
	kind: string;
	name: string;
}

/** Everything a provider created, as the non-secret record the row stores (plan §3.2:218). */
export function dependencyResourceRefs(
	namespace: string,
	objects: readonly AppDependencyObjectRef[],
	extra: { databases?: readonly string[]; buckets?: readonly string[] } = {}
): AppDependencyResourceRefs {
	return {
		namespace,
		objects: objects.map((object) => ({ kind: String(object.kind), name: String(object.name) })),
		...(extra.databases && extra.databases.length > 0 ? { databases: [...extra.databases] } : {}),
		...(extra.buckets && extra.buckets.length > 0 ? { buckets: [...extra.buckets] } : {})
	};
}

/** The kinds every dependency kind owns, in the order teardown deletes them (plan §4.9:626-628). */
export const APP_DEPENDENCY_TEARDOWN_KINDS: readonly { apiVersion: string; kind: string }[] = [
	{ apiVersion: POSTGRES_OPERATOR_API_VERSION, kind: 'Cluster' },
	{ apiVersion: 'apps/v1', kind: 'StatefulSet' },
	{ apiVersion: 'apps/v1', kind: 'Deployment' },
	{ apiVersion: 'v1', kind: 'Service' },
	{ apiVersion: 'v1', kind: 'Secret' },
	{ apiVersion: 'batch/v1', kind: 'Job' },
	{ apiVersion: APP_NETWORK_POLICY_API_VERSION, kind: 'NetworkPolicy' },
	{ apiVersion: 'v1', kind: 'PersistentVolumeClaim' }
];

/** The kinds a `stopWorkloads` release is allowed to touch — never a PVC, Secret or policy (R-15). */
export const APP_DEPENDENCY_STOPPABLE_KINDS: readonly string[] = ['StatefulSet', 'Deployment', 'Cluster'];

/** The kind of an {@link AppDependencyKind} — the four kinds `APP_DEPENDENCY_KINDS` closes over. */
export type { AppDependencyKind };
