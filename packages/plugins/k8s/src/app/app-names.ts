/**
 * T4 — App names and labels (plan §4.1, spec FR-38/FR-40/FR-41).
 *
 * Pure functions: no I/O, no clock, no randomness. Every name is a deterministic function of its
 * inputs, so a namespace computed for dependency provisioning (a `prepare-namespace` op) is the
 * same namespace the Deployment later renders into — which is what lets the epic freeze the
 * namespace at the first `prepare-namespace` (plan §4.1, §4.2, GAP-06) and what lets
 * `verification-deploy` return a name that `verification-destroy` can take back as a handle
 * (plan §4.12, APW06-G09).
 *
 * ## The label set is deliberately disjoint from the site path
 *
 * Plan §1.2 #6 (plan.md:73-76): reusing `app.kubernetes.io/name` or `ever-works.io/managed=true`
 * would make App components appear in the existing `listProjects` / `listManagedDeployments`
 * listings, and selectors are immutable once a Deployment ships. The App label set therefore
 * carries neither key (see {@link APP_FORBIDDEN_LABEL_KEYS}); the site path's `COMMON_LABELS` in
 * `manifest.renderer.ts` is untouched, so those listings return exactly what they return today.
 *
 * ## Caps
 *
 * | Object | Rule | Hard cap |
 * | --- | --- | --- |
 * | Namespace | `ew-<slug ≤ 30>-<first 8 hex of workId>` | 42 by construction, 63 by DNS |
 * | Verification namespace | `<ns>-v<first 6 hex of provisioningId>-<attempt ≤ 9>` | 52 in practice, 63 by DNS |
 * | Job | `job-<name>-<deploymentShort>` / `run-<name>-<8 hex>` | 45 |
 * | CronJob | `cron-<name>` | 37 |
 */
import { createHash } from 'node:crypto';

import { namespacePodSecurityLabels, type AppPodSecurityPolicy } from './app-security.js';

/** The DNS-1123 label cap every Kubernetes object name and namespace obeys. */
export const APP_NAME_MAX_LENGTH = 63;
/** `ew-` + a 30-character slug + `-` + 8 hex. */
export const APP_NAMESPACE_MAX_LENGTH = 42;
/** `<ns>` (≤ 42) + `-v` + 6 hex + `-` + one attempt digit (plan §4.12: "stays within 52 characters"). */
export const APP_VERIFICATION_NAMESPACE_MAX_LENGTH = 52;
export const APP_SLUG_MAX_LENGTH = 30;
/** APW-03 schema §0: a component or job `Name` is 1–32 characters. */
export const APP_COMPONENT_NAME_MAX_LENGTH = 32;
/** `job-` (4) + a 32-character `Name` + `-` + 8 hex = exactly 45. */
export const APP_JOB_NAME_MAX_LENGTH = 45;
/** `cron-` (5) + a 32-character `Name` = exactly 37 (< the 52 the plan allows). */
export const APP_CRONJOB_NAME_MAX_LENGTH = 37;
/** plan §4.12: `-<attempt ≤ 9>`. */
export const APP_VERIFICATION_MAX_ATTEMPT = 9;
export const APP_DEPLOYMENT_SHORT_LENGTH = 8;
export const APP_CHECKSUM_SHORT_LENGTH = 10;
export const APP_VERIFICATION_ID_LENGTH = 6;

export const APP_NAMESPACE_PREFIX = 'ew-';
export const APP_SERVICE_ACCOUNT_NAME = 'app';
export const APP_PULL_SECRET_NAME = 'app-pull';
export const APP_LIMIT_RANGE_NAME = 'ew-defaults';
export const APP_RESOURCE_QUOTA_NAME = 'ew-quota';
export const APP_RUNNER_CONFIGMAP_PREFIX = 'ew-runner-';
export const APP_DEPENDENCY_POLICY_PREFIX = 'dep-';
export const APP_JOB_PREFIX = 'job-';
export const APP_MANUAL_JOB_PREFIX = 'run-';
export const APP_CRONJOB_PREFIX = 'cron-';
export const APP_ENV_SECRET_PREFIX = 'app-env-';
export const APP_PLATFORM_CONFIGMAP_PREFIX = 'app-platform-';

export const APP_LABEL_PART_OF = 'app.kubernetes.io/part-of';
export const APP_LABEL_MANAGED_BY = 'app.kubernetes.io/managed-by';
export const APP_LABEL_WORK_ID = 'ever-works.io/work-id';
export const APP_LABEL_KIND = 'ever-works.io/kind';
export const APP_LABEL_COMPONENT = 'ever-works.io/component';
export const APP_LABEL_JOB = 'ever-works.io/job';
export const APP_LABEL_CRON = 'ever-works.io/cron';
export const APP_LABEL_PURPOSE = 'ever-works.io/purpose';
export const APP_LABEL_RETAIN = 'ever-works.io/retain';
export const APP_ANNOTATION_EXPIRES_AT = 'ever-works.io/expires-at';

/** The value of `app.kubernetes.io/managed-by` for every App object. */
export const APP_MANAGED_BY = 'ever-works-k8s-plugin';
/** The value of `ever-works.io/kind` for every App object. */
export const APP_LABEL_KIND_APP = 'app';
/** The `ever-works.io/purpose` value of a verification namespace (plan §4.12). */
export const APP_VERIFICATION_PURPOSE = 'verification';

/**
 * Labels the App renderer must **never** emit (plan §1.2 #6). They belong to the website path and
 * are what its `listProjects` / `listManagedDeployments` listings select on.
 */
export const APP_FORBIDDEN_LABEL_KEYS = ['ever-works.io/managed', 'app.kubernetes.io/name'] as const;

/** The three baseline policies a `prepare-namespace` op draws (plan §4.2 step 4). */
export const APP_BASELINE_NETWORK_POLICY_NAMES = [
	'ew-default-deny',
	'ew-allow-same-namespace',
	'ew-allow-egress'
] as const;

/** The two policies only a Deployment draws (plan §4.2 step 4). */
export const APP_DEPLOYMENT_NETWORK_POLICY_NAMES = ['ew-allow-ingress', 'ew-allow-deps'] as const;

export interface AppLabelsInput {
	/** The Work uuid, verbatim. */
	workId: string;
	/** The App Work slug — `app.kubernetes.io/part-of`. */
	workSlug: string;
	component?: string | null;
	job?: string | null;
	cron?: string | null;
}

export interface AppNamespaceLabelsInput extends AppLabelsInput {
	podSecurity: AppPodSecurityPolicy;
	/** `ever-works.io/purpose` — set to `verification` for a verification namespace (plan §4.12). */
	purpose?: string | null;
}

/**
 * The deterministic hex suffix rule shared by every short id in §4.1: the first `length` hex
 * characters of the identifier (`first 8 hex of workId`, `first 6 hex of provisioningId`, the
 * first 10 hex of an env checksum). Case and separators are normalised away, so a uuid gives the
 * same suffix whether it is written upper- or lower-case.
 *
 * An identifier that carries fewer than `length` hex characters (a non-uuid Work id, an id with
 * letters outside the hex alphabet) falls back to the first `length` hex of its SHA-256 digest —
 * still a pure, deterministic function of the input, so a namespace is never re-derived into a
 * different name, and two such ids still differ.
 */
export function hexSuffix(value: string, length: number = APP_DEPLOYMENT_SHORT_LENGTH): string {
	const size = Math.max(1, Number.isFinite(length) ? Math.floor(length) : APP_DEPLOYMENT_SHORT_LENGTH);
	const raw = String(value ?? '');
	const hex = raw.toLowerCase().replace(/[^0-9a-f]/g, '');

	if (hex.length >= size) {
		return hex.slice(0, size);
	}

	return createHash('sha256').update(raw).digest('hex').slice(0, size);
}

/**
 * `ew-<slug ≤ 30>-<first 8 hex of workId>` (plan §4.1). The result never exceeds
 * {@link APP_NAMESPACE_MAX_LENGTH}, which is what keeps a verification namespace inside the 52
 * characters plan §4.12 promises.
 */
export function appNamespaceName(workSlug: string, workId: string): string {
	const slug = sanitiseName(workSlug, APP_SLUG_MAX_LENGTH) || APP_LABEL_KIND_APP;
	return fitLabel(`${APP_NAMESPACE_PREFIX}${slug}`, `-${hexSuffix(workId)}`, APP_NAMESPACE_MAX_LENGTH);
}

/** `<ns>-pr<number>` (plan §4.1). The pull request number is normalised to a positive integer. */
export function previewNamespaceName(namespace: string, prNumber: number): string {
	const pr = Number.isFinite(prNumber) ? Math.max(1, Math.floor(prNumber)) : 1;
	return fitLabel(namespace, `-pr${pr}`, APP_NAME_MAX_LENGTH);
}

/**
 * `<ns>-v<first 6 hex of provisioningId>-<attempt ≤ 9>` (plan §4.1, §4.12).
 *
 * The provisioning part is what stops a re-provision's attempt 1 from colliding with a leftover —
 * or a still-`Terminating` — namespace from an earlier run (APW06-G09). The epic derives and owns
 * this name: APW-04 never derives one of its own.
 */
export function verificationNamespaceName(namespace: string, provisioningId: string, attempt: number): string {
	const bounded = Number.isFinite(attempt)
		? Math.min(APP_VERIFICATION_MAX_ATTEMPT, Math.max(1, Math.floor(attempt)))
		: 1;
	const suffix = `-v${hexSuffix(provisioningId, APP_VERIFICATION_ID_LENGTH)}-${bounded}`;
	return fitLabel(namespace, suffix, APP_NAME_MAX_LENGTH);
}

/** A component's Deployment / Service / Ingress all share the App spec's `Name` (plan §4.1). */
export function componentObjectName(component: string): string {
	return normaliseComponentName(component);
}

/** `<component>-<volume>` — the PVC name (plan §4.1). */
export function pvcName(component: string, volume: string): string {
	return fitLabel(`${normaliseComponentName(component)}-${volume}`, '', APP_NAME_MAX_LENGTH);
}

/** `app-env-<checksum first 10 hex>` — immutable, keys are the App spec's runtime env names. */
export function envSecretName(checksum: string): string {
	return `${APP_ENV_SECRET_PREFIX}${hexSuffix(checksum, APP_CHECKSUM_SHORT_LENGTH)}`;
}

/** `app-platform-<checksum first 10 hex>` — immutable, the non-secret `EVER_WORKS_*` variables. */
export function platformConfigMapName(checksum: string): string {
	return `${APP_PLATFORM_CONFIGMAP_PREFIX}${hexSuffix(checksum, APP_CHECKSUM_SHORT_LENGTH)}`;
}

/** `app-pull` — mutable, because the pull token rotates. */
export function pullSecretName(): string {
	return APP_PULL_SECRET_NAME;
}

/** `app` — `automountServiceAccountToken: false` (plan §4.1). */
export function serviceAccountName(): string {
	return APP_SERVICE_ACCOUNT_NAME;
}

/** `job-<name>-<deploymentShort>` — a per-Deployment Job, ≤ 45 characters. */
export function jobName(name: string, deploymentShort: string): string {
	return fitLabel(`${APP_JOB_PREFIX}${name}`, `-${hexSuffix(deploymentShort)}`, APP_JOB_NAME_MAX_LENGTH);
}

/** `run-<name>-<8 hex>` — a manually requested Job run, ≤ 45 characters. */
export function manualJobName(name: string, runShort: string): string {
	return fitLabel(`${APP_MANUAL_JOB_PREFIX}${name}`, `-${hexSuffix(runShort)}`, APP_JOB_NAME_MAX_LENGTH);
}

/** `cron-<name>` — ≤ 37 characters. */
export function cronJobName(name: string): string {
	return fitLabel(`${APP_CRONJOB_PREFIX}${name}`, '', APP_CRONJOB_NAME_MAX_LENGTH);
}

/** `ew-runner-<hash10>` — the runner script + check list ConfigMap (plan §4.8). */
export function runnerConfigMapName(hash: string): string {
	return `${APP_RUNNER_CONFIGMAP_PREFIX}${hexSuffix(hash, APP_CHECKSUM_SHORT_LENGTH)}`;
}

/**
 * `dep-<kind>` — drawn by APW-07's provider before its own workload, never by this renderer
 * (plan §4.1). Named here so the renderer can recognise and never delete one (R-15, ACC-06-54).
 */
export function dependencyNetworkPolicyName(kind: string): string {
	return fitLabel(`${APP_DEPENDENCY_POLICY_PREFIX}${kind}`, '', APP_NAME_MAX_LENGTH);
}

/**
 * `{ ever-works.io/component: <name> }` (plan §4.1) — the selector every App workload, Service
 * and policy uses. It is deliberately **not** keyed on the slug, so renaming an App Work never
 * rewrites an immutable selector.
 */
export function componentSelector(name: string): Record<string, string> {
	return { [APP_LABEL_COMPONENT]: normaliseComponentName(name) };
}

/** `http://<component>.<namespace>.svc.cluster.local` (plan §4.3). */
export function internalUrl(component: string, namespace: string): string {
	return `http://${normaliseComponentName(component)}.${sanitiseName(namespace, APP_NAME_MAX_LENGTH)}.svc.cluster.local`;
}

/**
 * The labels on every App object (plan §4.1): `app.kubernetes.io/managed-by`,
 * `app.kubernetes.io/part-of`, `ever-works.io/work-id`, `ever-works.io/kind: app`, plus
 * `ever-works.io/component` / `ever-works.io/job` / `ever-works.io/cron` where relevant.
 *
 * Never `ever-works.io/managed` and never `app.kubernetes.io/name`, and there is no generic
 * "extra labels" escape hatch that could smuggle one in.
 */
export function appLabels(input: AppLabelsInput): Record<string, string> {
	const labels: Record<string, string> = {
		[APP_LABEL_MANAGED_BY]: APP_MANAGED_BY,
		[APP_LABEL_PART_OF]: sanitiseName(input?.workSlug, APP_SLUG_MAX_LENGTH) || APP_LABEL_KIND_APP,
		[APP_LABEL_WORK_ID]: String(input?.workId ?? ''),
		[APP_LABEL_KIND]: APP_LABEL_KIND_APP
	};

	const component = optionalName(input?.component);
	if (component) {
		labels[APP_LABEL_COMPONENT] = component;
	}

	const job = optionalName(input?.job);
	if (job) {
		labels[APP_LABEL_JOB] = job;
	}

	const cron = optionalName(input?.cron);
	if (cron) {
		labels[APP_LABEL_CRON] = cron;
	}

	return labels;
}

/** {@link appLabels} plus `ever-works.io/retain: "true"` — a volume claim is never auto-deleted. */
export function pvcLabels(input: AppLabelsInput): Record<string, string> {
	return { ...appLabels(input), [APP_LABEL_RETAIN]: 'true' };
}

/**
 * The App labels plus the namespace PodSecurity labels of §4.4, and — for a verification
 * namespace — `ever-works.io/purpose: verification` (plan §4.1, §4.12).
 */
export function namespaceLabels(input: AppNamespaceLabelsInput): Record<string, string> {
	const labels: Record<string, string> = {
		...appLabels(input),
		...namespacePodSecurityLabels(input.podSecurity)
	};

	const purpose = optionalName(input?.purpose);
	if (purpose) {
		labels[APP_LABEL_PURPOSE] = purpose;
	}

	return labels;
}

/**
 * The annotations of a namespace. A verification namespace carries
 * `ever-works.io/expires-at: <RFC 3339 UTC>` (plan §4.1, §4.12) — the instant is the **caller's**,
 * never read from a clock here, so the helper stays pure and testable.
 */
export function namespaceAnnotations(input?: { expiresAt?: string | null }): Record<string, string> {
	const expiresAt = typeof input?.expiresAt === 'string' ? input.expiresAt.trim() : '';
	return expiresAt ? { [APP_ANNOTATION_EXPIRES_AT]: expiresAt } : {};
}

// Internal helpers -----------------------------------------------------------

/**
 * Reduce a value to the DNS-1123 label charset and cap its length. Truncation never leaves a
 * trailing hyphen (which would make the label invalid), so the result is always a legal label
 * segment.
 */
function sanitiseName(value: unknown, maxLength: number): string {
	const limit = Math.max(1, Math.floor(maxLength));
	const sanitised = String(value ?? '')
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-+|-+$/g, '');

	return trimHyphens(sanitised.slice(0, limit));
}

/**
 * Assemble `<base><suffix>` inside `maxLength`, truncating only the base — so the suffix that
 * carries the identity (work id, provisioning id, attempt) is never the part that is cut.
 */
function fitLabel(base: string, suffix: string, maxLength: number): string {
	const room = Math.max(1, maxLength - suffix.length);
	const head = sanitiseName(base, room) || APP_SERVICE_ACCOUNT_NAME;
	return `${head}${suffix}`;
}

function trimHyphens(value: string): string {
	return value.replace(/^-+/, '').replace(/-+$/, '');
}

function normaliseComponentName(component: unknown): string {
	return sanitiseName(component, APP_NAME_MAX_LENGTH) || APP_SERVICE_ACCOUNT_NAME;
}

function optionalName(value: unknown): string | null {
	if (typeof value !== 'string') {
		return null;
	}
	const trimmed = value.trim();
	return trimmed ? trimmed : null;
}
