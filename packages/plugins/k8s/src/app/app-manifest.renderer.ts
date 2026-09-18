/**
 * T6 — the App manifest renderer (plan §4.1–§4.7, §4.11, §4.12, §5.3; spec FR-10, FR-16, FR-17,
 * FR-19, FR-20, FR-24, FR-44, FR-50; ACC-06-07, ACC-06-15, ACC-06-16, ACC-06-17, ACC-06-18,
 * ACC-06-54, ACC-06-58).
 *
 * Pure functions from `AppRenderInput` (plan §3, §3.1 — the normative contract, imported from
 * `@ever-works/plugin`, never redefined) to Kubernetes objects. **No I/O, no clock, no cluster
 * access, no randomness** — R-5 exists precisely so this code can be a library: the whole plan is
 * computable in an isolated worker, and a golden fixture can pin it. Where a value would otherwise
 * come from outside (the verification expiry instant, the previously applied claim sizes, the
 * observed ingress address) it is a parameter of {@link AppRenderOptions}.
 *
 * This module sits **beside** the site renderer: `manifest.renderer.ts` and its tests are
 * untouched (CONTRACTS R-26, the owner's additive-only rule). The one piece of it this file reuses
 * is `buildImagePullSecret`'s dockerconfigjson encoding — re-stamped with the App label set,
 * because the site path's `COMMON_LABELS` carries `ever-works.io/managed` and
 * `app.kubernetes.io/name`, which the App renderer must never emit (`app-names.ts` §1.2 #6).
 *
 * ## No per-Deployment fact ever reaches a pod template (APW06-G07, ACC-06-58)
 *
 * `ever-works.io/deployment-id` is written on the **Deployment object's** `metadata.annotations`
 * and nowhere else. No `deploymentId`, `deploymentShort`, timestamp or counter is written into a
 * component pod template, the env Secret or the platform ConfigMap — and
 * `EVER_WORKS_DEPLOYMENT_ID` is **not injected at all** (the platform ConfigMap holds only
 * `EVER_WORKS_APP_URL`, `EVER_WORKS_APP_HOST`, `EVER_WORKS_APP_COMMIT` and, under FR-44,
 * `EVER_WORKS_SOURCE_URL`; plan §4.7). The reason is in §4.7: the checksum names **immutable**
 * objects, so two contents under one name would leave a pod that was not restarted reading a stale
 * id. Images are digest-pinned, so a new Build changes the template by itself, and a Deployment of
 * the same Build with the same env renders a byte-identical template — Kubernetes creates no new
 * ReplicaSet and no pod restarts (FR-17).
 *
 * ## The apply order is plan §4.2's, and the two ops order one step differently
 *
 * `deployApp`'s `prepare` (§4.2:410-412) is Namespace → ServiceAccount → LimitRange →
 * ResourceQuota → NetworkPolicies → pull Secret → env Secret → PVCs → Services (workloads and the
 * Ingress after that). The `prepare-namespace` op (§4.2:416-427) is Namespace → ServiceAccount →
 * LimitRange → the three baseline policies → ResourceQuota — quota last, and **never**
 * `ew-allow-ingress` / `ew-allow-deps`. Both are implemented literally:
 * {@link renderPrepareNamespace} for the op, {@link renderPrepare} for the phase.
 *
 * ## Reported gaps (not invented)
 *
 * - **The storage class.** §4.6 says `storageClassName: <target setting or cluster default>`, and
 *   §3's `AppRenderInput` carries no such field (the cluster check reports the classes, §3.1). It is
 *   a parameter: `options.storageClassName`.
 * - **The previously applied claim sizes.** §4.6 refuses a shrink "before apply", which needs the
 *   live claim's size; §3's input has no such field. It is a parameter:
 *   `options.existingVolumes` (claim name → quantity). A claim that is absent from it is not
 *   compared, and an unparseable quantity is **not** refused — a refusal that cannot be proven is
 *   worse than none, so the gap is named here rather than guessed at.
 * - **The platform values.** §4.7 fixes the ConfigMap's keys but §3's input carries no
 *   `EVER_WORKS_*` block: `AppRuntimeEnvSource` (APW-07) resolves them next to `env.values`. They
 *   are derived where §3 *does* determine them (`EVER_WORKS_APP_HOST` from `hosts.primary`,
 *   `EVER_WORKS_APP_COMMIT` from `specCommitSha` — FR-25 makes the image and the spec the same
 *   commit) and supplied through `options.platform` / `options.urlScheme` otherwise. The URL scheme
 *   of §4.11 (`appUrlScheme(tls, hostKind)`) needs the host *kind*, which the render input does not
 *   carry, so `options.urlScheme` wins over this module's TLS-mode default.
 * - **The renderer's `componentDeadlineSeconds` vs the contract's formula.** §5.3's formula lives in
 *   `packages/contracts/src/apps/app-runtime.ts:907` (`appComponentDeadlineSeconds`), and the `k8s`
 *   plugin has no dependency on `@ever-works/contracts` (and adding one is outside this task's
 *   files). {@link componentDeadlineSeconds} applies the **same** formula, with the renderer's
 *   startup default of §4.5 (`10 × 60`) it is the one that owns, and the same clamp. The resolved
 *   `component.deadlineSeconds` of §3.1 wins when it is present, clamped into §5.3's range — that is
 *   the superset of §3.1 and §4.3.
 * - **`components[].runAsUser`.** §4.4's added paragraph (plan.md:489-497) and APW-03 `schema.md`
 *   §10 make it a component field that is "passed through **verbatim**". {@link componentRunAsUser}
 *   reads it structurally and emits nothing when a component does not carry it, so it kept working
 *   while `AppComponentInput` (plan §3.1) lacked the field — and it keeps working now that the field
 *   has landed there (`AppComponentInput.runAsUser?: number`, added with APW06-G26), because the
 *   structural read and the declared field agree. **No change was needed here when the contract
 *   caught up, which is the point of reading it structurally.**
 */
import { createHash } from 'node:crypto';

import type { AppComponentInput, AppLimitRangeInput, AppQuotaInput, AppRenderInput } from '@ever-works/plugin';

import type { IngressStrategy } from '../ingress/strategy.js';
import { defaultIngressStrategyRegistry } from '../ingress/strategy.registry.js';
import { buildImagePullSecret } from '../manifest.renderer.js';
import {
	APP_LIMIT_RANGE_NAME,
	APP_RESOURCE_QUOTA_NAME,
	APP_VERIFICATION_PURPOSE,
	appLabels,
	componentObjectName,
	componentSelector,
	envSecretName,
	namespaceAnnotations,
	namespaceLabels,
	platformConfigMapName,
	pullSecretName,
	pvcLabels,
	pvcName,
	serviceAccountName
} from './app-names.js';
import {
	renderBaselineNetworkPolicies,
	renderDeploymentNetworkPolicies,
	planNetworkPolicies,
	type AppNetworkPolicyOptions,
	type AppNetworkPolicyWarning
} from './app-network-policy.renderer.js';
import {
	appSecurityRefusals,
	containerSecurityContext,
	podSecurityContext,
	tmpVolume,
	tmpVolumeMount,
	type AppSecurityComponent
} from './app-security.js';

/* ------------------------------------------------------------------------- *
 * Constants
 * ------------------------------------------------------------------------- */

/** The annotation that carries the per-Deployment id — on the Deployment object only (§4.3). */
export const APP_DEPLOYMENT_ID_ANNOTATION = 'ever-works.io/deployment-id';
/** The pod-template annotation that changes the pods' identity when an env value changes (FR-17). */
export const APP_ENV_CHECKSUM_ANNOTATION = 'ever-works.io/env-checksum';
/** The pod-template annotation naming the Build's commit (§4.3). */
export const APP_BUILD_COMMIT_ANNOTATION = 'ever-works.io/build-commit';
/** §4.6: `ever-works.io/backup: "true|false"` on a volume claim. */
export const APP_BACKUP_ANNOTATION = 'ever-works.io/backup';

/** §4.7: the length of the `env.checksum` the two immutable object names are built from. */
export const APP_ENV_CHECKSUM_LENGTH = 16;

/** §4.7: the platform ConfigMap's keys, in the order they are written. */
export const APP_PLATFORM_CONFIGMAP_KEYS = [
	'EVER_WORKS_APP_URL',
	'EVER_WORKS_APP_HOST',
	'EVER_WORKS_APP_COMMIT',
	'EVER_WORKS_SOURCE_URL'
] as const;

/**
 * §4.7 / APW06-G07: keys that must never appear in the platform ConfigMap, whatever a caller
 * passes in. The id is per-Deployment and the object is immutable and checksum-named.
 */
export const APP_PLATFORM_CONFIGMAP_FORBIDDEN_KEYS = ['EVER_WORKS_DEPLOYMENT_ID'] as const;

/** §4.3: `revisionHistoryLimit`. */
export const APP_REVISION_HISTORY_LIMIT = 5;
/** §4.3: `minReadySeconds` for a worker without probes ("30 s stability", §5.4). */
export const APP_WORKER_MIN_READY_SECONDS = 30;
/** §4.5: the web startup default the renderer applies where the spec is silent. */
export const APP_STARTUP_PROBE_PERIOD_S = 10;
export const APP_STARTUP_PROBE_FAILURE_THRESHOLD = 60;
/** APW-03 `schema.md` §10: `readiness: { tcp: true }` is the web default, and its three defaults. */
export const APP_READINESS_PROBE_PERIOD_S = 10;
export const APP_READINESS_PROBE_TIMEOUT_S = 5;
export const APP_READINESS_PROBE_FAILURE_THRESHOLD = 3;
/** The container port name every probe and Service targets (§4.5, §4.3). */
export const APP_CONTAINER_PORT_NAME = 'http';
/** §5.3 — mirrored from `packages/contracts/src/apps/app-runtime.ts:568-578`. */
export const APP_ROLLOUT_EXTRA_S = 120;
export const APP_ROLLOUT_MIN_S = 300;
export const APP_ROLLOUT_MAX_S = 2_400;
/** §5.3: the Service every web component gets (§4.3: "port 80 → targetPort <spec port>"). */
export const APP_SERVICE_PORT = 80;

/* ------------------------------------------------------------------------- *
 * Types
 * ------------------------------------------------------------------------- */

/** The plan §4.2 apply order a caller wants. */
export type AppRenderScope = 'all' | 'prepare-namespace';

/**
 * Everything the pure renderer needs that §3's `AppRenderInput` does not carry. Every entry is
 * *data*: nothing here is fetched, resolved or dialled.
 */
export interface AppRenderOptions {
	/** Which part of §4.2 to render. `'all'` (default) adds the workloads and the Ingress. */
	scope?: AppRenderScope;
	/** A verification namespace's expiry instant — `now + ttlMinutes` (§4.12). Never read from a clock. */
	now?: string | Date | null;
	/** The IngressClass detected as the cluster default, used when `ingress.className` is null (§4.11). */
	defaultIngressClass?: string | null;
	/** `appUrlScheme(tls, hostKind)`'s answer for `EVER_WORKS_APP_URL` (§4.11). */
	urlScheme?: 'http' | 'https' | null;
	/** Values APW-07's `AppRuntimeEnvSource` resolved (§4.7). Only the four allowed keys are written. */
	platform?: Record<string, string | null | undefined> | null;
	/** The live claim sizes, for the `volume_shrink` refusal of §4.6: claim name → quantity. */
	existingVolumes?: Record<string, string | null | undefined> | null;
	/** §4.6: `<target setting or cluster default>`. Omitted when the cluster's default applies. */
	storageClassName?: string | null;
	/** The strategy `IngressStrategyRegistry` selected for the IngressClass's controller (§4.11). */
	ingressStrategy?: IngressStrategy | null;
	/** The controller an `IngressClass` names, for `IngressStrategyRegistry.selectStrategy`. */
	ingressController?: string | null;
	/** The address observed at publish time — the hairpin rule's peer (§4.10, §3.1). */
	ingressAddress?: { ip?: string | null; hostname?: string | null } | null;
	/** §4.10's DNS shape, passed through to the network planner. */
	dns?: AppNetworkPolicyOptions['dns'];
}

/** A warning a caller may show — plan §4.10's and §4.11's codes only. */
export interface AppRenderWarning {
	code: 'no_ingress_controller' | AppNetworkPolicyWarning['code'];
	message: string;
}

/** The three render-time precondition codes of §5.1. */
export type AppRenderRefusalCode = 'volume_replicas' | 'volume_shrink' | 'privileged_port';

/** `AppPrecondition`-shaped, so a caller can hand it straight to `appRender.preconditions`. */
export interface AppRenderRefusal {
	code: AppRenderRefusalCode;
	names?: string[];
	message: string;
}

/** What §5.1's render-time checks found, each code reachable by name. */
export interface AppRenderValidation {
	readonly volume_replicas: readonly AppRenderRefusal[];
	readonly volume_shrink: readonly AppRenderRefusal[];
	readonly privileged_port: readonly AppRenderRefusal[];
	/** The three above, concatenated in that order. */
	readonly refusals: readonly AppRenderRefusal[];
	readonly ok: boolean;
}

/** A rendered object. A `type` alias so a policy object stays assignable to it without a cast. */
export type AppRenderedObject = {
	apiVersion: string;
	kind: string;
	metadata: {
		name: string;
		namespace?: string;
		labels?: Record<string, string>;
		annotations?: Record<string, string>;
	};
	[key: string]: unknown;
};

/** The whole render: what to apply, what to warn about, what to refuse, and the two object names. */
export interface AppRenderPlan {
	objects: AppRenderedObject[];
	warnings: AppRenderWarning[];
	refusals: AppRenderRefusal[];
	validation: AppRenderValidation;
	/** The effective checksum both immutable object names are built from (§4.7). */
	envChecksum: string;
	envSecretName: string;
	platformConfigMapName: string;
}

/** The probe fields §5.3's formula reads — structurally a subset of a resolved component. */
export interface AppDeadlineProbe {
	periodSeconds?: number | null;
	failureThreshold?: number | null;
}

/** The component fields §5.3's formula reads. */
export interface AppDeadlineComponent {
	probes?: {
		startup?: AppDeadlineProbe | null;
		readiness?: AppDeadlineProbe | null;
	} | null;
	/** §3.1's resolved deadline. Wins over the formula when present, clamped into §5.3's range. */
	deadlineSeconds?: number | null;
}

/* ------------------------------------------------------------------------- *
 * The env checksum and the platform values (§4.7)
 * ------------------------------------------------------------------------- */

/**
 * §4.7's checksum: "first 16 hex of sha256 over `name=value` lines of both maps sorted by name".
 *
 * The two maps are the env Secret's values and the platform ConfigMap's, and they are hashed
 * together because the checksum names **both** immutable objects. Sorting is what makes it
 * independent of the order a caller happens to build either map in; a changed value changes the
 * hash, which changes both object names and the pod template's annotation — so a changed value
 * always restarts the pods and an unchanged one never does (FR-17, ACC-06-15).
 */
export function appEnvChecksum(
	secretValues: Record<string, string> = {},
	platformValues: Record<string, string> = {}
): string {
	const lines = [...Object.entries({ ...secretValues, ...platformValues })]
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
		.map(([name, value]) => `${name}=${value}`);

	return createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, APP_ENV_CHECKSUM_LENGTH);
}

/**
 * The checksum a render uses: the render input's own when it carries one, otherwise §4.7's formula
 * over the values in hand. The input's value wins because it is the identity the **already applied**
 * immutable objects carry — re-deriving it here could name a different Secret than the phase-1
 * apply created.
 */
export function effectiveEnvChecksum(input: AppRenderInput, options: AppRenderOptions = {}): string {
	const provided = typeof input?.env?.checksum === 'string' ? input.env.checksum.trim() : '';
	return provided || appEnvChecksum(input?.env?.values ?? {}, platformValues(input, options));
}

/** The four allowed `EVER_WORKS_*` values of §4.7, empty ones omitted, forbidden ones dropped. */
export function platformValues(input: AppRenderInput, options: AppRenderOptions = {}): Record<string, string> {
	const primary = normaliseHost(input?.hosts?.primary);
	const derived: Record<string, string> = {};

	if (primary) {
		derived.EVER_WORKS_APP_URL = `${options.urlScheme ?? schemeForTls(input?.ingress?.tls)}://${primary}`;
		derived.EVER_WORKS_APP_HOST = primary;
	}

	const commit = typeof input?.specCommitSha === 'string' ? input.specCommitSha.trim() : '';
	if (commit) {
		derived.EVER_WORKS_APP_COMMIT = commit;
	}

	const supplied = options?.platform ?? {};
	const values: Record<string, string> = {};

	for (const key of APP_PLATFORM_CONFIGMAP_KEYS) {
		if (isForbiddenPlatformKey(key)) {
			continue;
		}
		const value = supplied[key] ?? derived[key];
		if (typeof value === 'string' && value.trim()) {
			values[key] = value.trim();
		}
	}

	return values;
}

/* ------------------------------------------------------------------------- *
 * Namespace-scoped objects (§4.2)
 * ------------------------------------------------------------------------- */

/**
 * §4.2 step 1: the namespace, with the ownership label, the pod-security labels of §4.4 and — for a
 * verification ref — `ever-works.io/purpose: verification` plus the expiry annotation (§4.12).
 *
 * The expiry instant is `options.now + input.ttlMinutes`; with no `now` the annotation is omitted,
 * because this module never reads a clock (R-5).
 */
export function renderNamespace(input: AppRenderInput, options: AppRenderOptions = {}): AppRenderedObject {
	const verification = input?.purpose === 'verification';
	const expiresAt = verification ? verificationExpiry(input, options) : null;

	const annotations = namespaceAnnotations({ expiresAt });
	const metadata: AppRenderedObject['metadata'] = {
		name: String(input?.ref?.namespace ?? ''),
		labels: namespaceLabels({
			workId: input?.ref?.workId ?? '',
			workSlug: input?.workSlug ?? '',
			podSecurity: input?.policy?.podSecurity ?? 'baseline',
			purpose: verification ? APP_VERIFICATION_PURPOSE : null
		})
	};

	if (Object.keys(annotations).length > 0) {
		metadata.annotations = annotations;
	}

	return { apiVersion: 'v1', kind: 'Namespace', metadata };
}

/** §4.2 step 2 / §4.1: the `app` ServiceAccount, with no automounted token. */
export function renderServiceAccount(input: AppRenderInput): AppRenderedObject {
	return {
		apiVersion: 'v1',
		kind: 'ServiceAccount',
		metadata: {
			name: serviceAccountName(),
			namespace: String(input?.ref?.namespace ?? ''),
			labels: appLabels(labelsInput(input))
		},
		automountServiceAccountToken: false
	};
}

/** §4.2 step 3: `ew-defaults`, from the render input's resolved `policy.limitRange`. */
export function renderLimitRange(input: AppRenderInput): AppRenderedObject {
	const limitRange = input?.policy?.limitRange ?? defaultLimitRangeForTarget(input?.ref?.target);

	return {
		apiVersion: 'v1',
		kind: 'LimitRange',
		metadata: {
			name: APP_LIMIT_RANGE_NAME,
			namespace: String(input?.ref?.namespace ?? ''),
			labels: appLabels(labelsInput(input))
		},
		spec: {
			limits: [
				{
					type: 'Container',
					defaultRequest: {
						cpu: limitRange.defaultRequest.cpu,
						memory: limitRange.defaultRequest.memory
					},
					default: {
						cpu: limitRange.defaultLimit.cpu,
						memory: limitRange.defaultLimit.memory,
						'ephemeral-storage': limitRange.defaultLimit.ephemeralStorage
					},
					max: { cpu: limitRange.max.cpu, memory: limitRange.max.memory }
				}
			]
		}
	};
}

/** §4.2: the LimitRange defaults both targets share, with the managed target's smaller `max`. */
export function defaultLimitRangeForTarget(target?: string | null): AppLimitRangeInput {
	return {
		defaultRequest: { cpu: '100m', memory: '128Mi' },
		defaultLimit: { cpu: '1', memory: '512Mi', ephemeralStorage: '1Gi' },
		max: target === 'ever-works-apps' ? { cpu: '2', memory: '4Gi' } : { cpu: '8', memory: '64Gi' }
	};
}

/** §4.2: `AppsTierPolicy`'s quota defaults — the 13 keys, as the render input's `policy.quota`. */
export function defaultQuotaForTarget(): AppQuotaInput {
	return {
		'requests.cpu': '2',
		'limits.cpu': '4',
		'requests.memory': '4Gi',
		'limits.memory': '6Gi',
		pods: 20,
		persistentvolumeclaims: 5,
		'requests.storage': '20Gi',
		'services.loadbalancers': 0,
		'services.nodeports': 0,
		'count/jobs.batch': 20,
		'count/cronjobs.batch': 20,
		secrets: 30,
		configmaps: 30
	};
}

/** §4.2: `ew-quota` on `ever-works-apps` only (`null` on Your cluster, where a 403 would be fatal). */
export function renderResourceQuota(input: AppRenderInput): AppRenderedObject | null {
	if (input?.ref?.target !== 'ever-works-apps') {
		return null;
	}

	const quota = input?.policy?.quota ?? defaultQuotaForTarget();

	return {
		apiVersion: 'v1',
		kind: 'ResourceQuota',
		metadata: {
			name: APP_RESOURCE_QUOTA_NAME,
			namespace: String(input?.ref?.namespace ?? ''),
			labels: appLabels(labelsInput(input))
		},
		spec: { hard: { ...quota } }
	};
}

/** §4.7: the immutable env Secret — keys are exactly the App spec's runtime env names. */
export function renderEnvSecret(input: AppRenderInput, options: AppRenderOptions = {}): AppRenderedObject {
	return {
		apiVersion: 'v1',
		kind: 'Secret',
		metadata: {
			name: envSecretName(effectiveEnvChecksum(input, options)),
			namespace: String(input?.ref?.namespace ?? ''),
			labels: appLabels(labelsInput(input))
		},
		type: 'Opaque',
		immutable: true,
		stringData: { ...(input?.env?.values ?? {}) }
	};
}

/**
 * §4.7: the immutable platform ConfigMap. It holds `EVER_WORKS_APP_URL`, `EVER_WORKS_APP_HOST`,
 * `EVER_WORKS_APP_COMMIT` and — under FR-44 — `EVER_WORKS_SOURCE_URL`, and **no**
 * `EVER_WORKS_DEPLOYMENT_ID` (APW06-G07).
 */
export function renderPlatformConfigMap(input: AppRenderInput, options: AppRenderOptions = {}): AppRenderedObject {
	const data = platformValues(input, options);
	const ordered: Record<string, string> = {};
	for (const key of APP_PLATFORM_CONFIGMAP_KEYS) {
		if (!isForbiddenPlatformKey(key) && typeof data[key] === 'string') {
			ordered[key] = data[key];
		}
	}

	return {
		apiVersion: 'v1',
		kind: 'ConfigMap',
		metadata: {
			name: platformConfigMapName(effectiveEnvChecksum(input, options)),
			namespace: String(input?.ref?.namespace ?? ''),
			labels: appLabels(labelsInput(input))
		},
		immutable: true,
		data: ordered
	};
}

/**
 * §4.1/§4.7: the `app-pull` Secret, mutable because the pull token rotates.
 *
 * The dockerconfigjson encoding is `buildImagePullSecret`'s — reused, not duplicated — but the
 * metadata is re-stamped: the site path's `COMMON_LABELS` carries `ever-works.io/managed` and
 * `app.kubernetes.io/name`, and the App label set carries neither (§1.2 #6).
 */
export function renderPullSecret(input: AppRenderInput): AppRenderedObject | null {
	const pull = input?.image?.pull;
	if (!pull?.server || !pull?.username || !pull?.password) {
		return null;
	}

	const built = buildImagePullSecret({
		name: pullSecretName(),
		namespace: String(input?.ref?.namespace ?? ''),
		server: pull.server,
		username: pull.username,
		password: pull.password,
		workId: input?.ref?.workId ?? '',
		workSlug: input?.workSlug ?? ''
	});

	return {
		apiVersion: 'v1',
		kind: 'Secret',
		type: 'kubernetes.io/dockerconfigjson',
		metadata: {
			name: pullSecretName(),
			namespace: String(input?.ref?.namespace ?? ''),
			labels: appLabels(labelsInput(input))
		},
		data: built.data as Record<string, string>
	};
}

/* ------------------------------------------------------------------------- *
 * Volumes (§4.6, §4.12)
 * ------------------------------------------------------------------------- */

/**
 * §4.6: the claim for one declared volume, labelled `ever-works.io/retain: "true"` so a removal
 * never takes it (§4.12 FR-50 keeps it even without `deleteVolumes`).
 *
 * `null` for a verification ref: §4.12 renders **no** PVC, and every volume becomes an `emptyDir`.
 */
export function renderPvc(
	input: AppRenderInput,
	component: AppComponentInput,
	volume: AppComponentInput['volumes'][number],
	options: AppRenderOptions = {}
): AppRenderedObject | null {
	if (input?.purpose === 'verification') {
		return null;
	}

	const storageClassName = normaliseText(options?.storageClassName);
	const spec: Record<string, unknown> = {
		accessModes: ['ReadWriteOnce'],
		resources: { requests: { storage: volume.size } }
	};
	if (storageClassName) {
		spec.storageClassName = storageClassName;
	}

	return {
		apiVersion: 'v1',
		kind: 'PersistentVolumeClaim',
		metadata: {
			name: pvcName(component.name, volume.name),
			namespace: String(input?.ref?.namespace ?? ''),
			labels: pvcLabels({ ...labelsInput(input), component: component.name }),
			annotations: { [APP_BACKUP_ANNOTATION]: volume.backup === false ? 'false' : 'true' }
		},
		spec
	};
}

/** The pod-spec volume source for one declared volume: a claim, or the verification `emptyDir`. */
export function renderComponentVolume(
	input: AppRenderInput,
	component: AppComponentInput,
	volume: AppComponentInput['volumes'][number]
): Record<string, unknown> {
	if (input?.purpose === 'verification') {
		return { name: volume.name, emptyDir: { sizeLimit: volume.size } };
	}

	return { name: volume.name, persistentVolumeClaim: { claimName: pvcName(component.name, volume.name) } };
}

/* ------------------------------------------------------------------------- *
 * Workloads (§4.3, §4.4, §4.5)
 * ------------------------------------------------------------------------- */

/** §4.3: the Deployment for one component. */
export function renderComponentDeployment(
	input: AppRenderInput,
	component: AppComponentInput,
	options: AppRenderOptions = {}
): AppRenderedObject {
	const selector = componentSelector(component.name);
	const labels = { ...selector, ...appLabels({ ...labelsInput(input), component: component.name }) };
	const annotations: Record<string, string> = {
		[APP_ENV_CHECKSUM_ANNOTATION]: effectiveEnvChecksum(input, options)
	};

	const commit = typeof input?.specCommitSha === 'string' ? input.specCommitSha.trim() : '';
	if (commit) {
		annotations[APP_BUILD_COMMIT_ANNOTATION] = commit;
	}

	const volumes = podVolumes(input, component);
	const declaredVolumes = volumesOf(component);
	const podSpec: Record<string, unknown> = {
		serviceAccountName: serviceAccountName(),
		automountServiceAccountToken: false,
		enableServiceLinks: false,
		securityContext: podSecurityContext(securityInput(input, component), securityComponent(component)),
		containers: [container(input, component, options)],
		// Soft spreading, exactly as the site renderer documents it: a hard constraint can count an
		// untolerated control-plane as an empty domain and strand the next replica.
		topologySpreadConstraints: [
			{
				maxSkew: 1,
				topologyKey: 'kubernetes.io/hostname',
				whenUnsatisfiable: 'ScheduleAnyway',
				labelSelector: { matchLabels: selector }
			}
		]
	};

	if (input?.image?.pull) {
		podSpec.imagePullSecrets = [{ name: pullSecretName() }];
	}

	const runtimeClassName = normaliseText(input?.policy?.runtimeClassName);
	if (runtimeClassName) {
		podSpec.runtimeClassName = runtimeClassName;
	}

	if (volumes.length > 0) {
		podSpec.volumes = volumes;
	}

	const metadata: AppRenderedObject['metadata'] = {
		name: componentObjectName(component.name),
		namespace: String(input?.ref?.namespace ?? ''),
		labels
	};

	// APW06-G07: the per-Deployment id lives HERE and nowhere else — never on the pod template.
	const deploymentId = normaliseText(input?.deploymentId);
	if (deploymentId) {
		metadata.annotations = { [APP_DEPLOYMENT_ID_ANNOTATION]: deploymentId };
	}

	return {
		apiVersion: 'apps/v1',
		kind: 'Deployment',
		metadata,
		spec: {
			replicas: replicasOf(component),
			revisionHistoryLimit: APP_REVISION_HISTORY_LIMIT,
			progressDeadlineSeconds: progressDeadlineSeconds(component),
			selector: { matchLabels: selector },
			// §4.3: `Recreate` when the component **declares** volumes — never because of the §4.4
			// `/tmp` emptyDir, which every read-only container has and which no rollout conflicts with.
			strategy: strategyFor(component, declaredVolumes.length > 0),
			minReadySeconds: component.role !== 'web' && !hasAnyProbe(component) ? APP_WORKER_MIN_READY_SECONDS : 0,
			template: { metadata: { labels, annotations }, spec: podSpec }
		}
	};
}

/** §4.3: a `ClusterIP` Service on port 80 for a web component, `null` for a worker. */
export function renderComponentService(input: AppRenderInput, component: AppComponentInput): AppRenderedObject | null {
	if (component?.role !== 'web') {
		return null;
	}

	const port = containerPort(component);
	const servicePort: Record<string, unknown> = {
		name: APP_CONTAINER_PORT_NAME,
		port: APP_SERVICE_PORT,
		protocol: 'TCP'
	};
	if (port !== null) {
		servicePort.targetPort = port;
	}

	return {
		apiVersion: 'v1',
		kind: 'Service',
		metadata: {
			name: componentObjectName(component.name),
			namespace: String(input?.ref?.namespace ?? ''),
			labels: {
				...componentSelector(component.name),
				...appLabels({ ...labelsInput(input), component: component.name })
			}
		},
		spec: {
			type: 'ClusterIP',
			selector: componentSelector(component.name),
			ports: [servicePort]
		}
	};
}

/* ------------------------------------------------------------------------- *
 * Ingress (§4.11)
 * ------------------------------------------------------------------------- */

/**
 * §4.11: the Ingress for the **primary web component** and nobody else, with rules for
 * `hosts.primary ∪ extra ∪ previous` and a TLS block only for `tls: 'cert-manager'`.
 *
 * `null` when: the ref is a verification ref (§4.12 renders none), the App has no primary web
 * component, no host survives the strict RFC-1123 check, or no class exists and no default class
 * was detected (§4.11 — the caller then warns `no_ingress_controller` and skips public smoke).
 */
export function renderIngress(input: AppRenderInput, options: AppRenderOptions = {}): AppRenderedObject | null {
	if (input?.purpose === 'verification') {
		return null;
	}

	const primary = primaryWebComponent(input);
	if (!primary) {
		return null;
	}

	const hosts = ingressHosts(input);
	const className = normaliseText(input?.ingress?.className) ?? normaliseText(options?.defaultIngressClass);
	if (hosts.length === 0 || !className) {
		return null;
	}

	const strategy = ingressStrategy(options);
	const certManager = input?.ingress?.tls === 'cert-manager';
	const tlsIssuer = certManager ? (normaliseText(input?.ingress?.issuer) ?? undefined) : undefined;
	const strategyInputs = { hosts, tlsIssuer, className };

	const tls = certManager ? strategy.tls(strategyInputs) : [];
	const serviceName = componentObjectName(primary.name);
	const path = {
		path: '/',
		pathType: 'Prefix',
		backend: { service: { name: serviceName, port: { number: APP_SERVICE_PORT } } }
	};

	const spec: Record<string, unknown> = {
		ingressClassName: className,
		rules: hosts.map((host) => ({ host, http: { paths: [path] } }))
	};
	if (tls.length > 0) {
		spec.tls = tls;
	}

	return {
		apiVersion: 'networking.k8s.io/v1',
		kind: 'Ingress',
		metadata: {
			name: serviceName,
			namespace: String(input?.ref?.namespace ?? ''),
			labels: {
				...componentSelector(primary.name),
				...appLabels({ ...labelsInput(input), component: primary.name })
			},
			annotations: strategy.annotations(strategyInputs)
		},
		spec
	};
}

/**
 * §4.11: the strict RFC-1123 hostname check `addDomain` uses (`k8s.plugin.ts:1302`,
 * `normaliseIngressHost`), applied here so an App-spec host can never become a catch-all rule.
 * Lower-cased on the way through; `null` for anything that is not one or more DNS labels.
 */
export function normaliseAppHost(host: unknown): string | null {
	const value = typeof host === 'string' ? host.trim().toLowerCase() : '';
	if (!value || value.length > 253) {
		return null;
	}

	const label = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
	return value.split('.').every((part) => label.test(part)) ? value : null;
}

/** §4.3: the one component with an `Ingress` — `primary: true`, or the only `web` component. */
export function primaryWebComponent(input: AppRenderInput): AppComponentInput | null {
	const components = Array.isArray(input?.components) ? input.components : [];
	const marked = components.find((component) => component?.role === 'web' && component?.primary === true);
	if (marked) {
		return marked;
	}

	const webs = components.filter((component) => component?.role === 'web');
	return webs.length === 1 ? webs[0] : null;
}

/* ------------------------------------------------------------------------- *
 * §5.3's deadline formula and §5.1's render-time checks
 * ------------------------------------------------------------------------- */

/**
 * §5.3: `clamp(startup.period × startup.failureThreshold + readiness.period ×
 * readiness.failureThreshold + 120, 300, 2400)` seconds — the same formula as
 * `appComponentDeadlineSeconds` in `packages/contracts/src/apps/app-runtime.ts:907`, with the
 * renderer's web startup default of §4.5 (`10 × 60`, giving the plan's worked example
 * `10 × 60 + 10 × 3 + 120 = 750`) and the schema's readiness default of `10 × 3` where the spec is
 * silent.
 *
 * Fails closed on an unmeasurable field (a missing, negative, `NaN` or infinite period or threshold
 * contributes the default rather than `NaN`): a `NaN` deadline is an unbounded wait, which is the
 * one outcome this formula must not have.
 */
export function componentDeadlineSeconds(component: AppDeadlineComponent): number {
	const startup = tolerance(
		component?.probes?.startup,
		APP_STARTUP_PROBE_PERIOD_S,
		APP_STARTUP_PROBE_FAILURE_THRESHOLD
	);
	const readiness = tolerance(
		component?.probes?.readiness,
		APP_READINESS_PROBE_PERIOD_S,
		APP_READINESS_PROBE_FAILURE_THRESHOLD
	);

	return clampDeadline(startup + readiness + APP_ROLLOUT_EXTRA_S);
}

/**
 * §4.3: `progressDeadlineSeconds` — §3.1's resolved `deadlineSeconds` when the component carries
 * one (clamped into §5.3's range, so a value outside it can never become an illegal deadline),
 * otherwise {@link componentDeadlineSeconds}.
 */
export function progressDeadlineSeconds(component: AppComponentInput | AppDeadlineComponent): number {
	const declared = (component as AppDeadlineComponent)?.deadlineSeconds;
	if (typeof declared === 'number' && Number.isFinite(declared) && declared > 0) {
		return clampDeadline(declared);
	}

	return componentDeadlineSeconds(component as AppDeadlineComponent);
}

/**
 * §5.1's render-time checks: `volume_replicas` (§4.6 — a component with a volume and more than one
 * replica), `volume_shrink` (§4.6 — a lower `storage` than the live claim's) and `privileged_port`
 * (§4.4 — a port below 1024 on `ever-works-apps`, from `app-security.ts`).
 *
 * Every code is reachable by name on the result, and `refusals` concatenates them in §5.1's table
 * order so a caller can persist the list as-is.
 */
export function validateRenderInput(input: AppRenderInput, options: AppRenderOptions = {}): AppRenderValidation {
	const volume_replicas = volumeReplicasRefusal(input);
	const volume_shrink = volumeShrinkRefusal(input, options);
	const privileged_port = privilegedPortRefusal(input);

	const refusals = [
		...(volume_replicas ? [volume_replicas] : []),
		...(volume_shrink ? [volume_shrink] : []),
		...(privileged_port ? [privileged_port] : [])
	];

	return {
		volume_replicas: volume_replicas ? [volume_replicas] : [],
		volume_shrink: volume_shrink ? [volume_shrink] : [],
		privileged_port: privileged_port ? [privileged_port] : [],
		refusals,
		ok: refusals.length === 0
	};
}

/* ------------------------------------------------------------------------- *
 * The two entry points: the prepare-namespace op and the whole render
 * ------------------------------------------------------------------------- */

/**
 * §4.2: the `prepare-namespace` subset, in the op's own order — Namespace, ServiceAccount,
 * LimitRange, then (when `isolation` is true) `ew-default-deny`, `ew-allow-same-namespace` and
 * `ew-allow-egress`, then the ResourceQuota on `ever-works-apps`.
 *
 * It **never** draws `ew-allow-ingress` or `ew-allow-deps`: a Deployment draws those, and until one
 * runs there is nothing to publish and nothing to depend on (`AppDeployResult` §3, plan §4.2 step
 * 4). That is what breaks the GAP-06 / APW07-G01 cycle without dropping a requirement — the
 * namespace and its baseline policies exist before either a dependency is provisioned or a
 * Deployment starts (ACC-06-54).
 */
export function renderPrepareNamespace(input: AppRenderInput, options: AppRenderOptions = {}): AppRenderedObject[] {
	const objects: AppRenderedObject[] = [
		renderNamespace(input, options),
		renderServiceAccount(input),
		renderLimitRange(input)
	];

	objects.push(...renderBaselineNetworkPolicies(input, networkOptions(options)));

	const quota = renderResourceQuota(input);
	if (quota) {
		objects.push(quota);
	}

	return objects;
}

/**
 * §4.2's prepare phase (`plan.md:410-412`), which orders the quota **before** the policies:
 * Namespace → ServiceAccount → LimitRange → ResourceQuota → NetworkPolicies → pull Secret →
 * env Secret → PVCs → Services. Workloads and the Ingress come after it (see
 * {@link planAppRender}).
 */
export function renderPrepare(input: AppRenderInput, options: AppRenderOptions = {}): AppRenderedObject[] {
	const objects: AppRenderedObject[] = [
		renderNamespace(input, options),
		renderServiceAccount(input),
		renderLimitRange(input)
	];

	const quota = renderResourceQuota(input);
	if (quota) {
		objects.push(quota);
	}

	objects.push(...renderNetworkPoliciesForDeploy(input, options));

	const pullSecret = renderPullSecret(input);
	if (pullSecret) {
		objects.push(pullSecret);
	}

	objects.push(renderEnvSecret(input, options), renderPlatformConfigMap(input, options));

	for (const component of componentsOf(input)) {
		for (const volume of volumesOf(component)) {
			const claim = renderPvc(input, component, volume, options);
			if (claim) {
				objects.push(claim);
			}
		}
	}

	for (const component of componentsOf(input)) {
		const service = renderComponentService(input, component);
		if (service) {
			objects.push(service);
		}
	}

	return objects;
}

/** The whole render: §4.2's prepare set, then the Deployments and the Ingress. */
export function planAppRender(input: AppRenderInput, options: AppRenderOptions = {}): AppRenderPlan {
	const envChecksum = effectiveEnvChecksum(input, options);
	const validation = validateRenderInput(input, options);

	if (options?.scope === 'prepare-namespace') {
		return {
			objects: renderPrepareNamespace(input, options),
			// The prepare-namespace scope draws the baseline three only, so §4.10's ingress-controller
			// warning — which belongs to `ew-allow-ingress`, a Deployment-only policy — cannot apply.
			warnings: [],
			refusals: [...validation.refusals],
			validation,
			envChecksum,
			envSecretName: envSecretName(envChecksum),
			platformConfigMapName: platformConfigMapName(envChecksum)
		};
	}

	const objects = renderPrepare(input, options);

	for (const component of componentsOf(input)) {
		objects.push(renderComponentDeployment(input, component, options));
	}

	const ingress = renderIngress(input, options);
	if (ingress) {
		objects.push(ingress);
	}

	return {
		objects,
		warnings: [...noIngressControllerWarning(input, options), ...renderNetworkWarnings(input, options)],
		refusals: [...validation.refusals],
		validation,
		envChecksum,
		envSecretName: envSecretName(envChecksum),
		platformConfigMapName: platformConfigMapName(envChecksum)
	};
}

/** Just the objects of {@link planAppRender}, for a caller that has already validated the input. */
export function renderAppObjects(input: AppRenderInput, options: AppRenderOptions = {}): AppRenderedObject[] {
	return planAppRender(input, options).objects;
}

/* ------------------------------------------------------------------------- *
 * Container and pod construction
 * ------------------------------------------------------------------------- */

function container(
	input: AppRenderInput,
	component: AppComponentInput,
	options: AppRenderOptions
): Record<string, unknown> {
	const containerSpec: Record<string, unknown> = {
		name: componentObjectName(component.name),
		image: String(input?.image?.reference ?? ''),
		// §4.3: a digest-pinned reference makes `Always` pointless.
		imagePullPolicy: 'IfNotPresent'
	};

	if (Array.isArray(component?.command) && component.command.length > 0) {
		containerSpec.command = [...component.command];
	}
	if (Array.isArray(component?.args) && component.args.length > 0) {
		containerSpec.args = [...component.args];
	}

	const port = containerPort(component);
	// §4.3: ports for web components only.
	if (component?.role === 'web' && port !== null) {
		containerSpec.ports = [{ name: APP_CONTAINER_PORT_NAME, containerPort: port, protocol: 'TCP' }];
	}

	// §4.3: `envFrom` is never optional — a missing Secret must fail loudly as
	// `CreateContainerConfigError`, unlike the site path.
	const checksum = effectiveEnvChecksum(input, options);
	containerSpec.envFrom = [
		{ secretRef: { name: envSecretName(checksum), optional: false } },
		{ configMapRef: { name: platformConfigMapName(checksum), optional: false } }
	];

	containerSpec.resources = containerResources(input, component);

	const probes = probeSpecs(component);
	if (Object.keys(probes).length > 0) {
		Object.assign(containerSpec, probes);
	}

	containerSpec.securityContext = containerSecurityContext(
		securityInput(input, component),
		securityComponent(component)
	);

	const mounts = volumeMounts(input, component);
	if (mounts.length > 0) {
		containerSpec.volumeMounts = mounts;
	}

	return containerSpec;
}

/** §4.5: requests from the spec, the memory limit from it, and the managed CPU limit when absent. */
function containerResources(input: AppRenderInput, component: AppComponentInput): Record<string, unknown> {
	const resources = component?.resources ?? ({} as AppComponentInput['resources']);
	const limits: Record<string, string> = { memory: resources.memoryLimit };
	const cpuLimit = cpuLimitForTarget(input?.ref?.target, resources.cpuLimit, resources.cpu);
	if (cpuLimit) {
		limits.cpu = cpuLimit;
	}

	return {
		requests: { cpu: resources.cpu, memory: resources.memory },
		limits
	};
}

/**
 * §4.5: on `ever-works-apps` an absent `cpuLimit` becomes `max(1, 4 × cpu)` so the namespace quota
 * admits the pod; on Your cluster it stays absent (no limit) and a declared one is used verbatim on
 * both targets.
 */
export function cpuLimitForTarget(
	target: string | null | undefined,
	declared: string | null | undefined,
	request: string | null | undefined
): string | undefined {
	const declaredLimit = normaliseText(declared);
	if (declaredLimit) {
		return declaredLimit;
	}

	if (target !== 'ever-works-apps') {
		return undefined;
	}

	const cores = parseCpuCores(request);
	if (cores === null) {
		return '1';
	}

	return formatCpuQuantity(Math.max(1, 4 * cores));
}

/** §4.5: the declared probes, plus the renderer's web defaults where the spec is silent. */
function probeSpecs(component: AppComponentInput): Record<string, unknown> {
	const probes: Record<string, unknown> = {};
	const declared = component?.probes ?? {};
	const web = component?.role === 'web';

	const liveness = probeSpec(declared.liveness);
	if (liveness) {
		probes.livenessProbe = liveness;
	}

	const readiness =
		probeSpec(declared.readiness) ??
		(web
			? tcpProbeSpec(
					APP_READINESS_PROBE_PERIOD_S,
					APP_READINESS_PROBE_TIMEOUT_S,
					APP_READINESS_PROBE_FAILURE_THRESHOLD
				)
			: null);
	if (readiness) {
		probes.readinessProbe = readiness;
	}

	const startup =
		probeSpec(declared.startup) ??
		(web
			? tcpProbeSpec(
					APP_STARTUP_PROBE_PERIOD_S,
					APP_READINESS_PROBE_TIMEOUT_S,
					APP_STARTUP_PROBE_FAILURE_THRESHOLD
				)
			: null);
	if (startup) {
		probes.startupProbe = startup;
	}

	return probes;
}

function probeSpec(probe: AppComponentInput['probes']['startup'] | undefined): Record<string, unknown> | null {
	if (!probe) {
		return null;
	}

	const handler = probe.http
		? { httpGet: { path: probe.http, port: APP_CONTAINER_PORT_NAME } }
		: probe.tcp
			? { tcpSocket: { port: APP_CONTAINER_PORT_NAME } }
			: null;
	if (!handler) {
		return null;
	}

	return {
		...handler,
		periodSeconds: probe.periodSeconds,
		timeoutSeconds: probe.timeoutSeconds,
		initialDelaySeconds: probe.initialDelaySeconds,
		failureThreshold: probe.failureThreshold
	};
}

function tcpProbeSpec(
	periodSeconds: number,
	timeoutSeconds: number,
	failureThreshold: number
): Record<string, unknown> {
	return {
		tcpSocket: { port: APP_CONTAINER_PORT_NAME },
		periodSeconds,
		timeoutSeconds,
		initialDelaySeconds: 0,
		failureThreshold
	};
}

/** The pod's volumes: every declared volume's source, plus the §4.4 `/tmp` `emptyDir`. */
function podVolumes(input: AppRenderInput, component: AppComponentInput): Record<string, unknown>[] {
	const volumes = volumesOf(component).map((volume) => renderComponentVolume(input, component, volume));
	const tmp = tmpVolume(securityInput(input, component), securityComponent(component));
	if (tmp) {
		volumes.push(tmp as unknown as Record<string, unknown>);
	}

	return volumes;
}

function volumeMounts(input: AppRenderInput, component: AppComponentInput): Record<string, unknown>[] {
	const mounts: Record<string, unknown>[] = volumesOf(component).map((volume) => ({
		name: volume.name,
		mountPath: volume.path
	}));

	const tmp = tmpVolumeMount(securityInput(input, component), securityComponent(component));
	if (tmp) {
		mounts.push(tmp as unknown as Record<string, unknown>);
	}

	return mounts;
}

/** §4.3: `Recreate` when the component has volumes, else the site renderer's RollingUpdate pair. */
function strategyFor(component: AppComponentInput, hasVolumes: boolean): Record<string, unknown> {
	if (hasVolumes) {
		return { type: 'Recreate' };
	}

	return {
		type: 'RollingUpdate',
		rollingUpdate:
			replicasOf(component) === 1 ? { maxSurge: 0, maxUnavailable: 1 } : { maxSurge: 1, maxUnavailable: 0 }
	};
}

/* ------------------------------------------------------------------------- *
 * Security-context bridging (app-security.ts stays the single source of §4.4)
 * ------------------------------------------------------------------------- */

/**
 * `AppSecurityInput` for §4.4, including the optional numeric `runAsUser` seam. `AppSecurityTarget`
 * is `AppDeployTarget` in `app-security.ts`, so the render input's target passes straight through.
 */
function securityInput(input: AppRenderInput, component: AppComponentInput) {
	return {
		ref: { target: input?.ref?.target },
		policy: { allowRoot: input?.policy?.allowRoot === true },
		runAsUser: componentRunAsUser(component)
	};
}

/**
 * APW-03 `schema.md` §10's optional `components[].runAsUser`, read structurally until plan §3.1's
 * `AppComponentInput` declares it. Passed through **verbatim** — never derived — and `undefined`
 * when absent, so the rendered pod spec is byte-identical for every spec that omits it.
 */
export function componentRunAsUser(component: AppComponentInput): number | undefined {
	const value = (component as { runAsUser?: unknown })?.runAsUser;
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function securityComponent(component: AppComponentInput): AppSecurityComponent {
	return {
		name: component?.name,
		role: component?.role,
		port: component?.port ?? null,
		volumes: component?.volumes ?? [],
		writableRootFilesystem: component?.writableRootFilesystem === true
	};
}

/* ------------------------------------------------------------------------- *
 * Refusals (§5.1)
 * ------------------------------------------------------------------------- */

function volumeReplicasRefusal(input: AppRenderInput): AppRenderRefusal | null {
	const names = componentsOf(input)
		.filter((component) => volumesOf(component).length > 0 && replicasOf(component) > 1)
		.map((component) => component.name);

	if (names.length === 0) {
		return null;
	}

	return {
		code: 'volume_replicas',
		names,
		message:
			'A component with a volume can run only one replica, because its volume is read-write-once. Remove the volume or set replicas to 1.'
	};
}

function volumeShrinkRefusal(input: AppRenderInput, options: AppRenderOptions): AppRenderRefusal | null {
	const existing = options?.existingVolumes ?? {};
	const names: string[] = [];

	for (const component of componentsOf(input)) {
		for (const volume of volumesOf(component)) {
			const claim = pvcName(component.name, volume.name);
			const requested = parseStorageBytes(volume.size);
			const live = parseStorageBytes(existing[claim]);

			if (requested === null || live === null) {
				continue;
			}
			if (requested < live) {
				names.push(claim);
			}
		}
	}

	if (names.length === 0) {
		return null;
	}

	return {
		code: 'volume_shrink',
		names,
		message: 'A volume can grow but never shrink. Raise the requested size to at least the current one.'
	};
}

function privilegedPortRefusal(input: AppRenderInput): AppRenderRefusal | null {
	const names: string[] = [];
	let message = '';

	for (const component of componentsOf(input)) {
		const refusals = appSecurityRefusals(securityInput(input, component), securityComponent(component));
		for (const refusal of refusals) {
			names.push(component.name);
			message = message || refusal.message;
		}
	}

	return names.length > 0 ? { code: 'privileged_port', names, message } : null;
}

/* ------------------------------------------------------------------------- *
 * Network policies (§4.2, §4.10)
 * ------------------------------------------------------------------------- */

function networkOptions(options: AppRenderOptions): AppNetworkPolicyOptions {
	return { ingressAddress: options?.ingressAddress ?? null, dns: options?.dns };
}

/** Every policy when isolation is on, nothing when it is off — both sets, in table order. */
function renderNetworkPoliciesForDeploy(input: AppRenderInput, options: AppRenderOptions): AppRenderedObject[] {
	if (input?.network?.isolation !== true) {
		return [];
	}

	const baseline = renderBaselineNetworkPolicies(input, networkOptions(options));
	const deployment = renderDeploymentNetworkPolicies(input, networkOptions(options));
	return [...baseline, ...deployment] as AppRenderedObject[];
}

function renderNetworkWarnings(input: AppRenderInput, options: AppRenderOptions): AppRenderWarning[] {
	const plan = planNetworkPolicies(input, networkOptions(options));
	return (plan.warnings as AppNetworkPolicyWarning[]).map((warning) => ({
		code: warning.code,
		message: warning.message
	}));
}

/** §4.11: no class and no detected default → no Ingress, and the caller skips public smoke. */
function noIngressControllerWarning(input: AppRenderInput, options: AppRenderOptions): AppRenderWarning[] {
	if (input?.purpose === 'verification' || !primaryWebComponent(input)) {
		return [];
	}

	const className = normaliseText(input?.ingress?.className) ?? normaliseText(options?.defaultIngressClass);
	if (className || ingressHosts(input).length === 0) {
		return [];
	}

	return [
		{
			code: 'no_ingress_controller',
			message:
				'No ingress controller was found on your cluster, so the app is reachable only inside the cluster. Install an ingress controller and run Check connection.'
		}
	];
}

/* ------------------------------------------------------------------------- *
 * Small pure helpers
 * ------------------------------------------------------------------------- */

function labelsInput(input: AppRenderInput): { workId: string; workSlug: string } {
	return { workId: input?.ref?.workId ?? '', workSlug: input?.workSlug ?? '' };
}

function componentsOf(input: AppRenderInput): AppComponentInput[] {
	return Array.isArray(input?.components) ? [...input.components] : [];
}

function volumesOf(component: AppComponentInput): AppComponentInput['volumes'][number][] {
	return Array.isArray(component?.volumes) ? [...component.volumes] : [];
}

function replicasOf(component: AppComponentInput): number {
	const replicas = component?.replicas;
	if (typeof replicas !== 'number' || !Number.isFinite(replicas)) {
		return 1;
	}

	return Math.max(0, Math.floor(replicas));
}

function containerPort(component: AppComponentInput): number | null {
	const port = component?.port;
	return typeof port === 'number' && Number.isFinite(port) && port > 0 ? Math.floor(port) : null;
}

function hasAnyProbe(component: AppComponentInput): boolean {
	const probes = component?.probes ?? {};
	return Boolean(probes.startup || probes.readiness || probes.liveness);
}

function ingressHosts(input: AppRenderInput): string[] {
	const candidates = [input?.hosts?.primary, ...(input?.hosts?.extra ?? []), ...(input?.hosts?.previous ?? [])];
	const hosts: string[] = [];

	for (const candidate of candidates) {
		const host = normaliseAppHost(candidate);
		if (host && !hosts.includes(host)) {
			hosts.push(host);
		}
	}

	return hosts;
}

function ingressStrategy(options: AppRenderOptions): IngressStrategy {
	if (options?.ingressStrategy) {
		return options.ingressStrategy;
	}

	return defaultIngressStrategyRegistry.selectStrategy(normaliseText(options?.ingressController) ?? undefined);
}

/** §4.11's `appUrlScheme(tls, hostKind)` default where the caller does not supply the scheme. */
function schemeForTls(tls: unknown): 'http' | 'https' {
	return tls === 'none' ? 'http' : 'https';
}

function verificationExpiry(input: AppRenderInput, options: AppRenderOptions): string | null {
	const ttl = input?.ttlMinutes;
	if (typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl <= 0) {
		return null;
	}

	const now = options?.now;
	const instant = now instanceof Date ? now : typeof now === 'string' ? new Date(now) : null;
	if (!instant || Number.isNaN(instant.getTime())) {
		return null;
	}

	return new Date(instant.getTime() + Math.floor(ttl) * 60_000).toISOString();
}

function tolerance(
	probe: AppDeadlineProbe | null | undefined,
	defaultPeriod: number,
	defaultThreshold: number
): number {
	const period =
		typeof probe?.periodSeconds === 'number' && Number.isFinite(probe.periodSeconds) && probe.periodSeconds >= 0
			? probe.periodSeconds
			: defaultPeriod;
	const threshold =
		typeof probe?.failureThreshold === 'number' &&
		Number.isFinite(probe.failureThreshold) &&
		probe.failureThreshold >= 0
			? probe.failureThreshold
			: defaultThreshold;

	const product = period * threshold;
	return Number.isFinite(product) ? product : defaultPeriod * defaultThreshold;
}

function clampDeadline(seconds: number): number {
	if (!Number.isFinite(seconds)) {
		return APP_ROLLOUT_MIN_S;
	}

	return Math.min(APP_ROLLOUT_MAX_S, Math.max(APP_ROLLOUT_MIN_S, Math.floor(seconds)));
}

function isForbiddenPlatformKey(key: string): boolean {
	return (APP_PLATFORM_CONFIGMAP_FORBIDDEN_KEYS as readonly string[]).includes(key);
}

function normaliseHost(value: unknown): string | null {
	return normaliseAppHost(value);
}

function normaliseText(value: unknown): string | null {
	const text = typeof value === 'string' ? value.trim() : '';
	return text ? text : null;
}

/** `m`/`u`/`n` suffixes and plain decimal cores — anything else cannot be derived from. */
function parseCpuCores(value: unknown): number | null {
	const text = normaliseText(value);
	if (!text) {
		return null;
	}

	const match = /^(\d+(?:\.\d+)?)([mun]?)$/.exec(text);
	if (!match) {
		return null;
	}

	const amount = Number(match[1]);
	const suffix = match[2];
	const factor = suffix === 'm' ? 1 / 1_000 : suffix === 'u' ? 1 / 1_000_000 : suffix === 'n' ? 1 / 1_000_000_000 : 1;
	const cores = amount * factor;

	return Number.isFinite(cores) ? cores : null;
}

/** A legal Kubernetes quantity: at most three decimal places, and no `1.0000000000000002`. */
function formatCpuQuantity(cores: number): string {
	const rounded = Number(cores.toFixed(3));
	return String(rounded);
}

/**
 * Bytes for a storage quantity, decimal (`k`, `M`, `G`, `T`, `P`, `E`) or binary (`Ki`, `Mi`, `Gi`,
 * `Ti`, `Pi`, `Ei`). `null` when the value cannot be one — a comparison that cannot be made is not
 * a refusal.
 */
export function parseStorageBytes(value: unknown): number | null {
	const text = normaliseText(value);
	if (!text) {
		return null;
	}

	const match = /^(\d+(?:\.\d+)?)([kMGTPE]i?)?$/.exec(text);
	if (!match) {
		return null;
	}

	const amount = Number(match[1]);
	const suffix = match[2] ?? '';
	const binary = suffix.endsWith('i');
	const unit = binary ? suffix.slice(0, 1) : suffix;
	const power = ['', 'k', 'M', 'G', 'T', 'P', 'E'].indexOf(unit);
	if (power < 0) {
		return null;
	}

	const bytes = amount * Math.pow(binary ? 1024 : 1000, power);
	return Number.isFinite(bytes) ? bytes : null;
}
