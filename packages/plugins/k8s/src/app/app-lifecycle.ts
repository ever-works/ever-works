/**
 * APW-06 T13 — the App lifecycle: `scaleApp`, `getAppLogs`, `runAppJob`, `prepareAppNamespace`,
 * `publishAppHosts` and `destroyApp`.
 *
 * Sources, in priority order:
 *
 * 1. `plan.md` §3.1 — the six `IDeploymentPlugin` members this class implements are the contract
 *    (`app-deployment.types.ts`), and every signature here matches the optional member exactly.
 * 2. `spec.md` FR-48 (logs: 200 lines, 500 on request, 256 KiB, secret values of 8+ characters
 *    replaced by their name), FR-49 (pause/resume), FR-50 (remove, and "also delete stored data"),
 *    FR-51 (run now), and §4.2 / §4.10 / §4.11 for the namespace, policy and publish rules.
 * 3. `plan.md` §9.10 — the op table these six are the bodies of — and `tasks.md:217-250` (T13).
 *
 * **Everything is read back from the cluster.** `AppTargetRef` carries the Work, the namespace and
 * the context and nothing else, and the App spec is not reachable from a deployment plugin (it lives
 * in the platform's database). Every place a renderer needs an `AppRenderInput`, this module builds
 * a **minimal, honest** one out of live objects: the env checksum from the live pod template's §4.3
 * annotation (so a rendered object names the *same* immutable Secret the running pods mount), the
 * image and `envFrom` from the live Deployment (FR-51's "current live version"), the slug from the
 * namespace name (§4.1's own naming rule inverted) and the primary web component from the one that
 * carries a container port (§4.3 writes ports for web components only).
 *
 * **What is deliberately not re-derived.** No method reads a clock other than the injected one, none
 * of them persists anything (the platform owns every row), none of them calls `deployApp`, and
 * `publishAppHosts` applies exactly one `Ingress` while `scaleApp` applies one `Deployment` per
 * component plus the `CronJob` suspensions (ACC-06-25: "zero other applies").
 */
import { randomUUID } from 'node:crypto';

import type {
	AppComponentStatus,
	AppDestroyResult,
	AppJobResult,
	AppJobRunRequest,
	AppLimitRangeInput,
	AppLogRequest,
	AppLogTail,
	AppRenderInput,
	AppScaleResult,
	AppSmokeInput,
	AppSmokeRun,
	AppTargetRef,
	CheckResult
} from '@ever-works/plugin';

import { K8sPluginError, scrubError } from '../errors.js';
import type { KubernetesApiService } from '../k8s-api.service.js';
import { APP_LIMITRANGE_FORBIDDEN } from './app-deployer.js';
import {
	APP_JOB_TTL_SECONDS,
	APP_JOB_TIMEOUT_DEFAULT_S,
	APP_RUNNER_DEADLINE_EXTRA_S,
	APP_RUNNER_WINDOW_S,
	renderRunnerConfigMap,
	renderRunnerJob
} from './app-jobs.renderer.js';
import {
	APP_DEPLOYMENT_ID_ANNOTATION,
	componentDeadlineSeconds,
	defaultLimitRangeForTarget,
	defaultQuotaForTarget,
	renderIngress,
	renderPrepareNamespace,
	type AppRenderedObject
} from './app-manifest.renderer.js';
import { APP_DEPENDENCY_POLICY_LABEL } from './app-network-policy.renderer.js';
import { assertSupportedKubeconfig } from './app-kubeconfig.guard.js';
import { classifyPodFailure, isComponentRolledOut, type AppRolloutReplicaSet } from './app-rollout.js';
import { podSecurityPolicyForTarget } from './app-security.js';
import type { AppRunnerRecord } from './app-runner.script.js';
import {
	APP_BASELINE_NETWORK_POLICY_NAMES,
	APP_DEPLOYMENT_SHORT_LENGTH,
	APP_LABEL_JOB,
	APP_LABEL_PURPOSE,
	APP_LABEL_WORK_ID,
	APP_VERIFICATION_PURPOSE,
	appLabels,
	componentObjectName,
	hexSuffix,
	manualJobName,
	serviceAccountName
} from './app-names.js';
import {
	APP_LOG_BYTES_MAX,
	APP_LOG_LINES_DEFAULT,
	APP_LOG_LINES_MAX,
	APP_LOG_REDACT_MIN_CHARS,
	checkResultOf,
	componentPodSummary,
	componentSelector,
	ingressAddressOf,
	jobStatusOf,
	liveComponentDeployments,
	liveContainers,
	liveEnvChecksum,
	liveEnvFrom,
	livePrimaryDeployment,
	liveWorkSlug,
	newestJob,
	newestPod,
	parseRunnerRecords,
	workSelector,
	workSlugFromNamespace,
	type AppLiveContainer,
	type AppLiveCronJob,
	type AppLiveDeployment,
	type AppLiveIngress,
	type AppLiveJob,
	type AppLiveNamespace,
	type AppLivePod,
	type AppStatusApi
} from './app-status.reader.js';

/* ------------------------------------------------------------------------- *
 * Constants (plan §5.3)
 * ------------------------------------------------------------------------- */

/** FR-49: **Pause app** scales every component to 0 and suspends scheduled calls within 120 s. */
export const APP_PAUSE_TIMEOUT_S = 120;
/** FR-50: **Remove from cluster** finishes within 300 s — the bound on the namespace wait. */
export const APP_REMOVE_TIMEOUT_S = 300;
/** §5.3: the in-cluster smoke window a resume's phase 5 runs inside. */
export const APP_SMOKE_IN_CLUSTER_WINDOW_S = 120;
/** §5.3 (`APP_ROLLOUT_POLL_S`): the interval between two observations of a rollout. */
export const APP_ROLLOUT_POLL_MS = 5_000;
/** §4.11: `publishAppHosts` observes the published address within its 60 s budget. */
export const APP_PUBLISH_TIMEOUT_S = 60;
/** §5.3: the fallback deadline for a resume of a component with no declared one (the client's 750). */
export const APP_RESUME_DEADLINE_S = 750;
/** FR-11 and APW-03 `schema.md` §10: a component's declared replicas are 0–10. */
export const APP_REPLICA_MIN = 0;
/** The upper bound of the same range — a resume that names more is refused, never clamped. */
export const APP_REPLICA_MAX = 10;

/** The `batch/v1` API version every Job and CronJob here carries. */
const JOB_API_VERSION = 'batch/v1';
/** §4.12's propagation for a namespace delete ("deletes the namespace … propagation `Foreground`"). */
const FOREGROUND = 'Foreground';

/**
 * The `code` values this module raises.
 *
 * `K8sPluginError`'s own union (`errors.ts`) carries no App code and this task may not edit that
 * file, so the code travels as the message's `<code>: <detail>` prefix and is exported here for
 * callers and specs to match on. Every message names the object it is about — a missing pod or
 * container is a specific error, never an empty tail that looks like "no output" (T13).
 */
export const APP_LIFECYCLE_CODES = {
	/** `getAppLogs` was asked for neither a component nor a job. */
	log_target_required: 'log_target_required',
	/** `getAppLogs` was asked for both at once. */
	log_target_ambiguous: 'log_target_ambiguous',
	/** The component, its pod, its container or the job's pod does not exist. */
	log_workload_missing: 'log_workload_missing',
	/** The requested `deploymentId` is not the Deployment the cluster is running. */
	deployment_gone: 'deployment_gone',
	/** `runAppJob` found no live component Deployment to take the image and the env from. */
	no_live_version: 'no_live_version',
	/** `runAppJob` was asked for an image the live Deployment is not running. */
	job_image_moved: 'job_image_moved',
	/** A Job of the same name is already active (FR-51: one run per job at a time). */
	job_active: 'job_active',
	/** The caller explicitly declined the first-deploy confirmation (FR-51). */
	job_confirmation_required: 'job_confirmation_required',
	/** `runAppJob` was asked for a Job with no name. */
	job_name_required: 'job_name_required',
	/** A smoke run was asked for with no check to run. */
	smoke_checks_missing: 'smoke_checks_missing',
	/** `scaleApp` was asked for a mode that is neither `pause` nor `resume`. */
	scale_mode_unknown: 'scale_mode_unknown',
	/** A requested replica count is outside FR-11 / `schema.md` §10's 0–10 range. */
	replicas_out_of_range: 'replicas_out_of_range',
	/** A component that mounts a volume was asked for more than one replica (§4.6, ACC-06-18). */
	volume_replicas: 'volume_replicas',
	/** The namespace exists and is owned by another Work (§4.2's ownership check). */
	namespace_owned: 'namespace_owned',
	/** `publishAppHosts` could not tell which component's `Ingress` to re-apply. */
	ingress_target_unknown: 'ingress_target_unknown',
	/** `publishAppHosts` was handed a TLS mode §4.11 does not define. */
	tls_mode_unknown: 'tls_mode_unknown',
	/** An apply failed for a reason the caller must see (never a silently missing object). */
	apply_failed: 'apply_failed',
	/** A namespace delete was issued and the namespace was still there after the FR-50 budget. */
	namespace_delete_timeout: 'namespace_delete_timeout'
} as const;

export type AppLifecycleCode = (typeof APP_LIFECYCLE_CODES)[keyof typeof APP_LIFECYCLE_CODES];

/* ------------------------------------------------------------------------- *
 * The port over the API service
 * ------------------------------------------------------------------------- */

/**
 * The five methods this module needs: {@link AppStatusApi}'s three reads plus the two writes. The
 * kubeconfig is the first argument of every call, exactly as `KubernetesApiService` (T10) declares
 * it, so the plugin passes its service instance straight in and the spec passes a fake.
 */
export interface AppLifecycleApi extends AppStatusApi {
	applyObject(kubeconfigYaml: string, manifest: Record<string, unknown>, contextOverride?: string): Promise<void>;
	deleteObject(
		kubeconfigYaml: string,
		apiVersion: string,
		kind: string,
		namespace: string,
		name: string,
		propagationPolicy?: string,
		contextOverride?: string
	): Promise<void>;
}

type AssertTrue<T extends true> = T;
/** A compile-time proof that the real service is drivable through {@link AppLifecycleApi}. */
export type KubernetesApiServiceSatisfiesLifecyclePort = AssertTrue<
	KubernetesApiService extends AppLifecycleApi ? true : false
>;

/* ------------------------------------------------------------------------- *
 * What a destroy touches
 * ------------------------------------------------------------------------- */

/**
 * Every kind an APW-07 provider may stamp with `ever-works.io/dependency` (§4.10, APW07-G01). The
 * **label** — never a name prefix — is what FR-50 protects, so the inventory asks every kind for it.
 */
export const APP_DEPENDENCY_KINDS: readonly { apiVersion: string; kind: string }[] = [
	{ apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy' },
	{ apiVersion: 'v1', kind: 'Secret' },
	{ apiVersion: 'v1', kind: 'ConfigMap' },
	{ apiVersion: 'v1', kind: 'Service' },
	{ apiVersion: 'v1', kind: 'PersistentVolumeClaim' },
	{ apiVersion: 'apps/v1', kind: 'Deployment' },
	{ apiVersion: 'apps/v1', kind: 'StatefulSet' },
	{ apiVersion: JOB_API_VERSION, kind: 'Job' },
	{ apiVersion: JOB_API_VERSION, kind: 'CronJob' }
];

/** FR-50's deletable set: "workloads, jobs, scheduled calls, services, published hosts, secrets". */
const APP_OWNED_KINDS: readonly { apiVersion: string; kind: string }[] = [
	{ apiVersion: 'apps/v1', kind: 'Deployment' },
	{ apiVersion: JOB_API_VERSION, kind: 'Job' },
	{ apiVersion: JOB_API_VERSION, kind: 'CronJob' },
	{ apiVersion: 'v1', kind: 'Service' },
	{ apiVersion: 'networking.k8s.io/v1', kind: 'Ingress' },
	{ apiVersion: 'v1', kind: 'Secret' },
	{ apiVersion: 'v1', kind: 'ConfigMap' }
];

/** The deny-all policy FR-50 keeps while kept data remains — §4.10's first baseline policy. */
const DEFAULT_DENY_POLICY = APP_BASELINE_NETWORK_POLICY_NAMES[0];
/** The four policies a destroy takes down with the workloads; `ew-default-deny` is conditional. */
const DELETABLE_POLICY_NAMES = APP_BASELINE_NETWORK_POLICY_NAMES.filter((name) => name !== DEFAULT_DENY_POLICY);

/** One `{ kind, name }` of an `AppDestroyResult`. */
export interface AppObjectRef {
	kind: string;
	name: string;
}

/* ------------------------------------------------------------------------- *
 * Options
 * ------------------------------------------------------------------------- */

/** Everything a lifecycle call needs that is not already in the contract §3.1 fixes. */
export interface AppLifecycleOptions {
	/** Epoch milliseconds. Defaults to `Date.now`; the spec injects a virtual clock. */
	now?: () => number;
	/** The only way this module waits. Defaults to `setTimeout`; the spec injects a virtual clock. */
	sleep?: (millis: number) => Promise<void>;
	/** §5.4's poll interval. Defaults to {@link APP_ROLLOUT_POLL_MS}. */
	pollIntervalMs?: number;
	/** FR-49's pause budget. Defaults to {@link APP_PAUSE_TIMEOUT_S} s. */
	pauseTimeoutMs?: number;
	/** FR-50's remove budget. Defaults to {@link APP_REMOVE_TIMEOUT_S} s. */
	removeTimeoutMs?: number;
	/** §4.11's publish budget. Defaults to {@link APP_PUBLISH_TIMEOUT_S} s. */
	publishTimeoutMs?: number;
	/** How long `runAppJob` waits for its Job before reporting `running`. Defaults to 600 s. */
	jobWaitMs?: number;
	/** §4.8's runner window. Defaults to {@link APP_RUNNER_WINDOW_S} (120 s). */
	smokeWindowSeconds?: number;
	/** The resume fallback when `resumeChecks.deadlines` names no entry. Defaults to 750 s (§5.3). */
	resumeDeadlineSeconds?: number;
	/** A manual Job run's short id. Defaults to the first 8 hex of a fresh uuid. */
	runShort?: () => string;
}

/* ------------------------------------------------------------------------- *
 * Pure helpers — logs (FR-48)
 * ------------------------------------------------------------------------- */

/** FR-48's line budget: 1–500, default 200. A missing, zero or unparseable value is the default. */
export function logLineBudget(requested: unknown): number {
	const value = typeof requested === 'number' && Number.isFinite(requested) ? Math.floor(requested) : 0;
	if (value < 1) {
		return APP_LOG_LINES_DEFAULT;
	}
	return Math.min(APP_LOG_LINES_MAX, value);
}

/** The lines of a log text: a single trailing newline is a terminator, not an empty last line. */
export function logLinesOf(text: string | null | undefined): string[] {
	const lines = String(text ?? '').split('\n');
	if (lines.length > 0 && lines[lines.length - 1] === '') {
		lines.pop();
	}
	return lines;
}

/** The longest prefix of `text` that fits `maxBytes` UTF-8 bytes (never splitting a code point). */
function truncateToBytes(text: string, maxBytes: number): string {
	const buffer = Buffer.from(text, 'utf8').subarray(0, Math.max(0, maxBytes));
	// `toString` replaces a partial multi-byte sequence with U+FFFD rather than throwing, and the byte
	// length of the result is then ≤ maxBytes.
	return buffer.toString('utf8');
}

/**
 * FR-48's two caps, applied to the **newest** end of the list: at most `maxLines` lines and at most
 * `maxBytes` bytes, both counted **after** redaction (see {@link redactSecretValues}) — redacting
 * first is what stops a byte cut from splitting a secret value in half and leaking the half.
 */
export function boundLogLines(
	lines: readonly string[],
	maxLines: number,
	maxBytes: number
): { lines: string[]; truncated: boolean } {
	let truncated = false;
	let kept = [...lines];

	if (kept.length > maxLines) {
		kept = kept.slice(kept.length - maxLines);
		truncated = true;
	}

	let bytes = 0;
	let start = kept.length;
	for (let index = kept.length - 1; index >= 0; index -= 1) {
		const size = Buffer.byteLength(kept[index], 'utf8') + 1;
		if (bytes + size > maxBytes && start < kept.length) {
			truncated = true;
			break;
		}
		bytes += size;
		start = index;
	}

	const bounded = kept.slice(start);
	// One line can exceed the byte cap on its own; cutting it is the only way to keep the cap. The cut
	// is mid-line, so it happens **after** redaction and the result is still bounded.
	if (bounded.length === 1 && Buffer.byteLength(bounded[0], 'utf8') > maxBytes) {
		return { lines: [truncateToBytes(bounded[0], maxBytes)], truncated: true };
	}

	return { lines: bounded, truncated };
}

/**
 * FR-48's redaction set: every secret **name** whose value is at least
 * {@link APP_LOG_REDACT_MIN_CHARS} characters, plus the lines with those values replaced.
 *
 * - The value is replaced by its **name** — the only substitution that keeps a log usable
 *   (`ADMIN_PASSWORD` in place of the password tells a reader what was there).
 * - Longest value first, so a value that contains another is replaced whole; ties break on the name,
 *   so the same input always produces the same output.
 * - Values shorter than 8 characters are **not** replaced: a 3-character value would match inside
 *   ordinary words and turn a log into noise.
 * - `AppLogRequest.secretValues` is in-memory only (FR-48, §3.1): nothing here is logged or stored.
 */
export function redactSecretValues(
	secretValues: Record<string, string> | null | undefined,
	lines: readonly string[]
): { lines: string[]; redactedNames: string[] } {
	const entries = Object.entries(secretValues ?? {})
		.filter(([, value]) => typeof value === 'string' && value.length >= APP_LOG_REDACT_MIN_CHARS)
		.sort(([leftName, leftValue], [rightName, rightValue]) =>
			rightValue.length !== leftValue.length
				? rightValue.length - leftValue.length
				: leftName.localeCompare(rightName)
		);

	const redactedNames = entries.map(([name]) => name).sort();
	if (entries.length === 0) {
		return { lines: [...lines], redactedNames };
	}

	return {
		lines: lines.map((line) => {
			let out = line;
			for (const [name, value] of entries) {
				if (out.includes(value)) {
					out = out.split(value).join(name);
				}
			}
			return out;
		}),
		redactedNames
	};
}

/* ------------------------------------------------------------------------- *
 * Pure helpers — the minimal render input
 * ------------------------------------------------------------------------- */

/** The optional facts a live read contributes to the minimal {@link AppRenderInput}. */
export interface MinimalRenderInputExtras {
	workSlug?: string | null;
	components?: AppRenderInput['components'];
	envChecksum?: string | null;
	smoke?: readonly AppSmokeInput[];
	isFirstDeploymentOnCluster?: boolean;
	hosts?: { primary: string | null; extra: string[]; previous: string[] };
	ingress?: {
		className: string | null;
		controllerNamespace: string | null;
		tls: AppRenderInput['ingress']['tls'];
		issuer: string | null;
	};
	network?: { isolation: boolean; needsHairpin: boolean };
	podSecurity?: 'restricted' | 'baseline';
	limitRange?: AppLimitRangeInput;
}

/**
 * The least an `AppRenderInput` can be while still rendering §4.2's subset, §4.8's runner Job and
 * §4.11's `Ingress` faithfully.
 *
 * Every field is either taken from the caller or read from a live object; nothing is invented that a
 * renderer would write into an object this module then applies, except the values with no possible
 * source (`deploymentId`, `specCommitSha`, the job and cron lists) — those are read only by render
 * paths this module does not call.
 */
export function minimalRenderInput(ref: AppTargetRef, extras: MinimalRenderInputExtras = {}): AppRenderInput {
	const target = ref?.target ?? 'your-cluster';
	return {
		ref,
		purpose: 'deploy',
		workSlug: extras.workSlug ?? workSlugFromNamespace(ref?.namespace ?? ''),
		deploymentId: '',
		deploymentShort: '',
		specCommitSha: '',
		isFirstDeploymentOnCluster: extras.isFirstDeploymentOnCluster === true,
		skipPreDeployJobs: true,
		image: { reference: '' },
		components: extras.components ?? [],
		jobs: [],
		cron: [],
		smoke: extras.smoke ? [...extras.smoke] : [],
		env: { values: {}, checksum: extras.envChecksum ?? '', secretNames: [] },
		hosts: extras.hosts ?? { primary: null, extra: [], previous: [] },
		ingress: extras.ingress ?? { className: null, controllerNamespace: null, tls: 'none', issuer: null },
		network: {
			isolation: extras.network?.isolation === true,
			extraEgress: [],
			needsHairpin: extras.network?.needsHairpin === true
		},
		policy: {
			podSecurity: extras.podSecurity ?? podSecurityPolicyForTarget(target),
			allowRoot: false,
			runtimeClassName: null,
			quota: target === 'ever-works-apps' ? defaultQuotaForTarget() : null,
			limitRange: extras.limitRange ?? defaultLimitRangeForTarget(target),
			cronMinIntervalMinutes: 5,
			scaleFailedFirstDeployToZero: true,
			requireIsolationEnforced: false
		}
	};
}

/** The primary web component a live Deployment describes — §4.3's "the one with a container port". */
export function primaryComponentFromDeployment(deployment: AppLiveDeployment): AppRenderInput['components'][number] {
	const container = liveContainers(deployment)[0];
	const port = container?.ports?.[0]?.containerPort;
	return {
		name: String(deployment?.metadata?.name ?? ''),
		role: 'web',
		...(typeof port === 'number' ? { port } : {}),
		replicas: Math.max(1, Number(deployment?.spec?.replicas ?? 1)),
		writableRootFilesystem: false,
		probes: {},
		resources: { cpu: '100m', memory: '128Mi', memoryLimit: '512Mi' },
		volumes: [],
		primary: true,
		deadlineSeconds: componentDeadlineSeconds({}),
		internalUrl: ''
	};
}

/* ------------------------------------------------------------------------- *
 * The lifecycle
 * ------------------------------------------------------------------------- */

/** One component as §5.4 reads it: the Deployment, its ReplicaSets, its pods, and its container. */
interface ComponentObservation {
	deployment: AppLiveDeployment | null;
	replicaSets: AppRolloutReplicaSet[];
	pods: AppLivePod[];
	container: AppLiveContainer | null;
	role: 'web' | 'worker';
}

/** What one poll of a Job proved. */
interface JobObservation {
	status: AppJobResult['status'];
	records: AppRunnerRecord[];
	pod: string;
	container: string;
	exitCode?: number;
	completedAt?: string;
}

/**
 * The six lifecycle capabilities of T13. One instance per plugin, stateless between calls: every
 * fact a call needs is read from the cluster or passed in.
 */
export class AppLifecycle {
	constructor(
		private readonly api: AppLifecycleApi,
		private readonly options: AppLifecycleOptions = {}
	) {}

	/* --------------------------------------------------------------------- *
	 * Logs (FR-48)
	 * --------------------------------------------------------------------- */

	/**
	 * `IDeploymentPlugin.getAppLogs` — the last 200 lines (up to 500 on request, 256 KiB) of one
	 * component's pods or of one job's pod, with every secret value of 8 or more characters replaced
	 * by its name.
	 *
	 * A component, its pod, its container or the job's pod that does not exist is a **specific
	 * error**, never an empty tail: "no logs" and "no output" must not look the same (FR-48).
	 */
	async getAppLogs(ref: AppTargetRef, credential: string, req: AppLogRequest): Promise<AppLogTail> {
		assertSupportedKubeconfig(credential, ref?.kubeContext ?? undefined);

		const context = ref?.kubeContext ?? undefined;
		const namespace = String(ref?.namespace ?? '');
		const lines = logLineBudget(req?.lines);
		const component = normalise(req?.component);
		const job = normalise(req?.job);

		if (component && job) {
			throw lifecycleError(
				APP_LIFECYCLE_CODES.log_target_ambiguous,
				`Logs were requested for component '${component}' and job '${job}' at once; ask for one of them.`
			);
		}
		if (!component && !job) {
			throw lifecycleError(
				APP_LIFECYCLE_CODES.log_target_required,
				`Logs need a component or a job; neither was given for namespace '${namespace}'.`
			);
		}

		const targets = component
			? await this.componentLogTargets(credential, ref, component, req, context)
			: await this.jobLogTargets(credential, namespace, job ?? '', context);

		const secrets = req?.secretValues ?? {};
		const containers: Array<{ pod: string; container: string; lines: string[]; truncated: boolean }> = [];
		let redactedNames: string[] = [];

		for (const target of targets) {
			const raw = await this.api.readPodLog(
				credential,
				namespace,
				target.pod,
				target.container,
				{ tailLines: lines, limitBytes: APP_LOG_BYTES_MAX, previous: req?.previous === true },
				context
			);
			if (raw === null) {
				throw lifecycleError(
					APP_LIFECYCLE_CODES.log_workload_missing,
					`Pod '${target.pod}' has no logs for container '${target.container}' in namespace '${namespace}'` +
						(req?.previous === true ? ' (previous instance)' : '') +
						'.'
				);
			}

			const redacted = redactSecretValues(secrets, logLinesOf(raw));
			const bounded = boundLogLines(redacted.lines, lines, APP_LOG_BYTES_MAX);
			redactedNames = redacted.redactedNames;
			containers.push({
				pod: target.pod,
				container: target.container,
				lines: bounded.lines,
				truncated: bounded.truncated
			});
		}

		return { containers, redactedNames, fetchedAt: new Date(this.now()).toISOString() };
	}

	/** The pods of one component, in pod-name order — one read per pod. */
	private async componentLogTargets(
		credential: string,
		ref: AppTargetRef,
		component: string,
		req: AppLogRequest,
		context?: string
	): Promise<Array<{ pod: string; container: string }>> {
		const namespace = String(ref?.namespace ?? '');
		const objectName = componentObjectName(component);
		const deployment = await this.api.readObject<AppLiveDeployment>(
			credential,
			'apps/v1',
			'Deployment',
			namespace,
			objectName,
			context
		);
		if (!deployment) {
			throw lifecycleError(
				APP_LIFECYCLE_CODES.log_workload_missing,
				`Component '${component}' has no Deployment '${objectName}' in namespace '${namespace}'.`
			);
		}

		const requested = normalise(req?.deploymentId);
		const live = normalise(deployment?.metadata?.annotations?.[APP_DEPLOYMENT_ID_ANNOTATION]);
		if (requested && live !== requested) {
			throw lifecycleError(
				APP_LIFECYCLE_CODES.deployment_gone,
				`Deployment '${objectName}' in namespace '${namespace}' is running deployment '${live ?? 'unknown'}', ` +
					`not the requested '${requested}'; its pods are gone (§4.3 keeps the id off the pod template).`
			);
		}

		const pods = await this.api.listObjects<AppLivePod>(
			credential,
			'v1',
			'Pod',
			namespace,
			componentSelector(objectName),
			context
		);
		if (pods.length === 0) {
			throw lifecycleError(
				APP_LIFECYCLE_CODES.log_workload_missing,
				`Component '${component}' has no pod in namespace '${namespace}'.`
			);
		}

		return [...pods]
			.sort((left, right) =>
				String(left?.metadata?.name ?? '').localeCompare(String(right?.metadata?.name ?? ''))
			)
			.map((pod) => {
				const podName = String(pod?.metadata?.name ?? '');
				const container = String(pod?.spec?.containers?.[0]?.name ?? '');
				if (!container) {
					throw lifecycleError(
						APP_LIFECYCLE_CODES.log_workload_missing,
						`Pod '${podName}' in namespace '${namespace}' reports no container to read logs from.`
					);
				}
				return { pod: podName, container };
			});
	}

	/** The newest pod of the newest Job carrying `ever-works.io/job=<name>`. */
	private async jobLogTargets(
		credential: string,
		namespace: string,
		job: string,
		context?: string
	): Promise<Array<{ pod: string; container: string }>> {
		const jobs = await this.api.listObjects<AppLiveJob>(
			credential,
			JOB_API_VERSION,
			'Job',
			namespace,
			`${APP_LABEL_JOB}=${job}`,
			context
		);
		const newest = newestJob(jobs);
		if (!newest) {
			throw lifecycleError(
				APP_LIFECYCLE_CODES.log_workload_missing,
				`Job '${job}' has never run in namespace '${namespace}'.`
			);
		}

		const pods = await this.api.listObjects<AppLivePod>(
			credential,
			'v1',
			'Pod',
			namespace,
			`${APP_LABEL_JOB}=${job}`,
			context
		);
		const pod = newestPod(pods);
		const podName = String(pod?.metadata?.name ?? '');
		const container = String(pod?.spec?.containers?.[0]?.name ?? '');
		if (!podName || !container) {
			throw lifecycleError(
				APP_LIFECYCLE_CODES.log_workload_missing,
				`Job '${String(newest?.metadata?.name ?? job)}' in namespace '${namespace}' has no pod to read logs from.`
			);
		}

		return [{ pod: podName, container }];
	}

	/* --------------------------------------------------------------------- *
	 * Run now (FR-51)
	 * --------------------------------------------------------------------- */

	/**
	 * `IDeploymentPlugin.runAppJob` — FR-51: "runs it with the current live version's image and env;
	 * one run per job at a time".
	 *
	 * The Job's image, `envFrom`, `securityContext` and `resources` come from the **live** component
	 * Deployment, which is what makes the run use the version that is actually running; a request
	 * naming a different image is refused rather than silently running one of the two. An active run
	 * of the same job is refused before anything is applied.
	 *
	 * `runner: 'smoke'` renders §4.8's runner Job with the checks the request carries, so a manual
	 * smoke run and a resume's phase-5 smoke are the same object.
	 */
	async runAppJob(ref: AppTargetRef, credential: string, job: AppJobRunRequest): Promise<AppJobResult> {
		assertSupportedKubeconfig(credential, ref?.kubeContext ?? undefined);

		const context = ref?.kubeContext ?? undefined;
		const namespace = String(ref?.namespace ?? '');
		const name = normalise(job?.name);
		if (!name) {
			throw lifecycleError(APP_LIFECYCLE_CODES.job_name_required, 'A job run needs the App spec job name.');
		}
		if (job?.confirmFirstDeploy === false) {
			throw lifecycleError(
				APP_LIFECYCLE_CODES.job_confirmation_required,
				`Job '${name}' was not confirmed; a first-deploy job runs only after confirmation (FR-51).`
			);
		}

		const deployments = await liveComponentDeployments(this.api, credential, ref, context);
		const live = deployments[0] ?? null;
		if (!live) {
			throw lifecycleError(
				APP_LIFECYCLE_CODES.no_live_version,
				`Namespace '${namespace}' has no live component Deployment for this Work, so job '${name}' has no ` +
					'version to run (FR-51).'
			);
		}

		const liveImage = String(liveContainers(live)[0]?.image ?? '');
		const requestedImage = normalise(job?.image);
		if (requestedImage && requestedImage !== liveImage) {
			throw lifecycleError(
				APP_LIFECYCLE_CODES.job_image_moved,
				`Job '${name}' was requested with image '${requestedImage}' while '${String(
					live?.metadata?.name ?? ''
				)}' is running '${liveImage}'; a run always uses the live version (FR-51).`
			);
		}

		const active = await this.activeRun(credential, namespace, name, context);
		if (active) {
			throw lifecycleError(
				APP_LIFECYCLE_CODES.job_active,
				`Job '${name}' is already running as '${String(active?.metadata?.name ?? '')}' in namespace ` +
					`'${namespace}'; one run per job at a time (FR-51).`
			);
		}

		const runShort = this.runShort();
		const smoke = job?.runner === 'smoke';
		const envChecksum = liveEnvChecksum(live);
		let object: AppRenderedObject;
		let configMap: AppRenderedObject | null = null;

		if (smoke) {
			const input = minimalRenderInput(ref, {
				workSlug: liveWorkSlug(live),
				envChecksum,
				smoke: job?.checks ?? [],
				isFirstDeploymentOnCluster: false
			});
			const renderOptions = {
				checks: job?.checks ?? [],
				envChecksum,
				manualRunShort: runShort,
				windowSeconds: this.smokeWindowSeconds()
			};
			configMap = renderRunnerConfigMap(input, 'smoke', renderOptions);
			const rendered = renderRunnerJob(input, 'smoke', renderOptions);
			if (!configMap || !rendered) {
				throw lifecycleError(
					APP_LIFECYCLE_CODES.smoke_checks_missing,
					`A smoke run of job '${name}' has no check to run in namespace '${namespace}'.`
				);
			}
			object = rendered;
		} else {
			object = this.commandJob(ref, live, name, runShort);
		}

		try {
			if (configMap) {
				await this.api.applyObject(credential, configMap, context);
			}
			await this.api.applyObject(credential, object, context);
		} catch (err) {
			throw lifecycleError(
				APP_LIFECYCLE_CODES.apply_failed,
				`Applying Job '${String(object.metadata.name)}' failed: ${scrubError(err).message}`
			);
		}

		const startedAt = new Date(this.now()).toISOString();
		const budget = smoke
			? Math.min(this.jobWaitMs(), (this.smokeWindowSeconds() + APP_RUNNER_DEADLINE_EXTRA_S) * 1_000)
			: this.jobWaitMs();
		const observed = await this.pollJob(credential, namespace, String(object.metadata.name), name, budget, context);

		return {
			name,
			// A manual run's phase is not in `AppJobRunRequest` (§3.1) and §4.8 stamps no phase label on a
			// Job, so the neutral `post-deploy` is reported rather than an invented phase.
			when: 'post-deploy',
			runName: String(object.metadata.name),
			status: observed.status,
			startedAt,
			completedAt: observed.completedAt ?? new Date(this.now()).toISOString(),
			...(observed.exitCode !== undefined ? { exitCode: observed.exitCode } : {}),
			...(observed.records[0] ? { http: checkResultOf(observed.records[0]) } : {}),
			...(observed.pod
				? { logRef: { job: name, pod: observed.pod, container: observed.container, previous: false } }
				: {})
		};
	}

	/**
	 * §4.8's `command` job, with the live version's image, `envFrom`, security context and resources.
	 *
	 * The job's **own** command is not in `AppJobRunRequest` (§3.1) and this module cannot reach the
	 * App spec, so the container runs the image's own entrypoint. That is the one field of a manual
	 * command run this task cannot fill; it is reported rather than guessed (see the T13 report).
	 */
	private commandJob(ref: AppTargetRef, live: AppLiveDeployment, name: string, runShort: string): AppRenderedObject {
		const container = liveContainers(live)[0] ?? {};
		const labels = appLabels({
			workId: ref.workId,
			workSlug: liveWorkSlug(live) ?? workSlugFromNamespace(ref.namespace),
			job: name
		});

		const jobContainer: Record<string, unknown> = {
			name: String(container.name ?? componentObjectName(name)),
			image: String(container.image ?? ''),
			imagePullPolicy: 'IfNotPresent',
			// The live `envFrom` verbatim, never a re-derived checksum: the objects it names are the
			// immutable ones the running pods mount (§4.7).
			envFrom: liveEnvFrom(live)
		};
		if (container.resources) {
			jobContainer.resources = container.resources;
		}
		if (container.securityContext) {
			jobContainer.securityContext = container.securityContext;
		}

		const podSpec = live?.spec?.template?.spec ?? {};
		const templateSpec: Record<string, unknown> = {
			restartPolicy: 'Never',
			serviceAccountName: serviceAccountName(),
			automountServiceAccountToken: false,
			enableServiceLinks: false,
			containers: [jobContainer]
		};
		if (podSpec.securityContext) {
			templateSpec.securityContext = podSpec.securityContext;
		}
		if (Array.isArray(podSpec.imagePullSecrets) && podSpec.imagePullSecrets.length > 0) {
			templateSpec.imagePullSecrets = podSpec.imagePullSecrets;
		}

		return {
			apiVersion: JOB_API_VERSION,
			kind: 'Job',
			metadata: {
				name: manualJobName(name, runShort),
				namespace: String(ref.namespace),
				labels
			},
			spec: {
				backoffLimit: 0,
				activeDeadlineSeconds: APP_JOB_TIMEOUT_DEFAULT_S,
				ttlSecondsAfterFinished: APP_JOB_TTL_SECONDS,
				template: { metadata: { labels }, spec: templateSpec }
			}
		};
	}

	/** FR-51's "one run per job at a time": a Job of this name that is still active. */
	private async activeRun(
		credential: string,
		namespace: string,
		name: string,
		context?: string
	): Promise<AppLiveJob | null> {
		const jobs = await this.api.listObjects<AppLiveJob>(
			credential,
			JOB_API_VERSION,
			'Job',
			namespace,
			`${APP_LABEL_JOB}=${name}`,
			context
		);
		return jobs.find((job) => Number(job?.status?.active ?? 0) > 0 && jobStatusOf(job) === 'running') ?? null;
	}

	/* --------------------------------------------------------------------- *
	 * Pause and resume (FR-49)
	 * --------------------------------------------------------------------- */

	/**
	 * `IDeploymentPlugin.scaleApp`.
	 *
	 * - `pause` sets every component Deployment the Work owns to `replicas: 0` and suspends every
	 *   `CronJob` (§4.9's `suspend: paused`), then confirms the scale-down inside FR-49's 120 s.
	 * - `resume` restores the declared replicas, un-suspends the schedules, waits for the phase-3
	 *   rollout with §5.4's predicate and each component's §5.3 deadline, and then runs the phase-5
	 *   in-cluster smoke (`resumeChecks.smoke`). A failure is **reported, never rolled back** — FR-49:
	 *   "the app stays resumed … there is no earlier version to restore".
	 */
	async scaleApp(
		ref: AppTargetRef,
		credential: string,
		mode: 'pause' | 'resume',
		replicas: Record<string, number>,
		resumeChecks?: { smoke: AppSmokeInput[]; deadlines: Record<string, number> }
	): Promise<AppScaleResult> {
		assertSupportedKubeconfig(credential, ref?.kubeContext ?? undefined);

		const context = ref?.kubeContext ?? undefined;
		const namespace = String(ref?.namespace ?? '');
		if (mode !== 'pause' && mode !== 'resume') {
			throw lifecycleError(
				APP_LIFECYCLE_CODES.scale_mode_unknown,
				`scaleApp was asked for mode '${String(mode)}'; the two modes are 'pause' and 'resume'.`
			);
		}

		const pause = mode === 'pause';
		const declared = replicas ?? {};
		const live = await liveComponentDeployments(this.api, credential, ref, context);
		const names = new Set<string>(live.map((deployment) => String(deployment?.metadata?.name ?? '')));
		if (!pause) {
			for (const name of Object.keys(declared)) {
				names.add(componentObjectName(name));
			}
		}
		names.delete('');

		/** What this call will write: the components it scales, and to what. */
		const targets: Array<{ objectName: string; replicas: number }> = [];
		for (const objectName of names) {
			const count = pause ? 0 : declaredReplicas(declared, objectName);
			if (count === null) {
				// A component the caller did not declare is left at whatever it is running: the resume
				// payload is "the declared replicas from the spec" (§9.10), and nothing here invents one.
				continue;
			}
			targets.push({ objectName, replicas: count });
		}
		this.assertScalable(targets, live);

		for (const target of targets) {
			await this.applyReplicas(credential, namespace, target.objectName, target.replicas, context);
		}

		for (const cronJob of await this.workCronJobs(credential, ref, context)) {
			await this.api.applyObject(
				credential,
				{
					apiVersion: JOB_API_VERSION,
					kind: 'CronJob',
					metadata: { name: String(cronJob?.metadata?.name ?? ''), namespace },
					spec: { suspend: pause }
				},
				context
			);
		}

		// The result reports the components **this call scaled**, which is what the op changed; a
		// component left untouched is not claimed as resumed or paused.
		const scaled = targets.map((target) => target.objectName);

		if (pause) {
			const failure = await this.waitForScaledDown(credential, ref, scaled, context);
			const components = await this.observeComponents(credential, ref, scaled, context);
			return { components, smoke: null, ...(failure ? { failure } : {}) };
		}

		const failure = await this.waitForRollout(credential, ref, scaled, resumeChecks?.deadlines ?? {}, context);
		const components = await this.observeComponents(credential, ref, scaled, context);
		if (failure) {
			return { components, smoke: null, failure };
		}

		const checks = resumeChecks?.smoke ?? [];
		if (checks.length === 0) {
			return { components, smoke: null };
		}

		const run = await this.smokeRun(ref, credential, live, checks, context);
		if (run.failure) {
			return { components, smoke: run.smoke, failure: run.failure };
		}
		return { components, smoke: run.smoke };
	}

	/**
	 * What `scaleApp` refuses, with the plan's own codes — a refusal is thrown (a request the plugin
	 * will not act on), while a failure of an accepted operation is `AppScaleResult.failure`.
	 *
	 * 1. **Out of range.** FR-11 and APW-03 `schema.md` §10 fix a component's replicas at 0–10, so a
	 *    resume that names 11 (or a negative or fractional count) is refused rather than clamped: a
	 *    silently clamped resume would report success for a replica count the App never declared.
	 * 2. **A volume with more than one replica** — §4.6's `volume_replicas` (ACC-06-18). A claim
	 *    attaches to one pod, and the App spec's own validator refuses the same combination, so the
	 *    resume path must not be the way around it.
	 */
	private assertScalable(
		targets: readonly { objectName: string; replicas: number }[],
		live: readonly AppLiveDeployment[]
	): void {
		for (const target of targets) {
			const replicas = target.replicas;
			if (
				typeof replicas !== 'number' ||
				!Number.isInteger(replicas) ||
				replicas < APP_REPLICA_MIN ||
				replicas > APP_REPLICA_MAX
			) {
				throw lifecycleError(
					APP_LIFECYCLE_CODES.replicas_out_of_range,
					`Component '${target.objectName}' was asked for ${String(replicas)} replicas; FR-11 and the App ` +
						`spec allow ${APP_REPLICA_MIN}–${APP_REPLICA_MAX} whole replicas.`
				);
			}

			const deployment = live.find((entry) => String(entry?.metadata?.name ?? '') === target.objectName);
			const claims = claimsOf(deployment);
			if (claims.length > 0 && replicas > 1) {
				throw lifecycleError(
					APP_LIFECYCLE_CODES.volume_replicas,
					`Component '${target.objectName}' mounts volume claim(s) ${claims.join(', ')} and cannot run ` +
						`${replicas} replicas; a volume attaches to one pod (plan §4.6, ACC-06-18).`
				);
			}
		}
	}

	/** One component's replica count, with §4.12's "never a negative or fractional count" applied. */
	private async applyReplicas(
		credential: string,
		namespace: string,
		objectName: string,
		replicas: number,
		context?: string
	): Promise<void> {
		await this.api.applyObject(
			credential,
			{
				apiVersion: 'apps/v1',
				kind: 'Deployment',
				metadata: { name: objectName, namespace },
				spec: { replicas: asReplicaCount(replicas) }
			},
			context
		);
	}

	/** The Work's CronJobs, sorted by object name. */
	private async workCronJobs(credential: string, ref: AppTargetRef, context?: string): Promise<AppLiveCronJob[]> {
		const cronJobs = await this.api.listObjects<AppLiveCronJob>(
			credential,
			JOB_API_VERSION,
			'CronJob',
			ref.namespace,
			workSelector(ref.workId),
			context
		);
		return [...cronJobs].sort((left, right) =>
			String(left?.metadata?.name ?? '').localeCompare(String(right?.metadata?.name ?? ''))
		);
	}

	/** FR-49: the scale-down is confirmed inside the pause budget, or reported as not taken. */
	private async waitForScaledDown(
		credential: string,
		ref: AppTargetRef,
		names: readonly string[],
		context?: string
	): Promise<AppScaleResult['failure'] | undefined> {
		const startedAt = this.now();
		const deadline = this.deadlineOr(this.options.pauseTimeoutMs, APP_PAUSE_TIMEOUT_S * 1_000);

		for (;;) {
			const deployments = await liveComponentDeployments(this.api, credential, ref, context);
			const scaled = names.every((name) =>
				deployments.some(
					(deployment) =>
						String(deployment?.metadata?.name ?? '') === name &&
						Number(deployment?.spec?.replicas ?? 1) === 0
				)
			);
			if (scaled) {
				return undefined;
			}
			if (this.now() - startedAt >= deadline) {
				return {
					code: 'deadline_exceeded',
					message: `Scaling every component to 0 did not take within FR-49's ${Math.round(
						deadline / 1_000
					)} s pause budget.`
				};
			}
			await this.sleep(this.pollIntervalMs());
		}
	}

	/**
	 * §5.4's predicate per component, with §5.3's deadline for each: `resumeChecks.deadlines[name]`
	 * when the caller declared one (the resolved deadline from the spec at the current Deployment's
	 * commit), {@link APP_RESUME_DEADLINE_S} otherwise.
	 */
	private async waitForRollout(
		credential: string,
		ref: AppTargetRef,
		names: readonly string[],
		deadlines: Record<string, number>,
		context?: string
	): Promise<AppScaleResult['failure'] | undefined> {
		const startedAt = this.now();
		const pending = new Set(names);

		while (pending.size > 0) {
			for (const name of [...pending]) {
				const observation = await this.observe(credential, ref, name, context);
				const options = {
					now: this.now(),
					startedAt,
					component: {
						name,
						role: observation.role,
						probes: {
							startup: observation.container?.startupProbe,
							readiness: observation.container?.readinessProbe,
							liveness: observation.container?.livenessProbe
						}
					}
				};

				if (isComponentRolledOut(observation.deployment, observation.replicaSets, observation.pods, options)) {
					pending.delete(name);
					continue;
				}

				const podFailure = classifyPodFailure(
					observation.deployment,
					observation.replicaSets,
					observation.pods,
					options
				);
				if (podFailure) {
					return {
						code: podFailure.code,
						message: `Component '${name}' did not become ready: ${podFailure.reason ?? podFailure.signal}${
							podFailure.message ? ` (${podFailure.message})` : ''
						} (plan §5.4).`
					};
				}

				const budget =
					declaredDeadline(deadlines, name) ?? this.options.resumeDeadlineSeconds ?? APP_RESUME_DEADLINE_S;
				if (this.now() - startedAt >= budget * 1_000) {
					return {
						code: 'rollout_timeout',
						message: `Component '${name}' did not reach its declared replicas within its ${budget} s deadline (FR-49, plan §5.3).`
					};
				}
			}

			if (pending.size === 0) {
				return undefined;
			}
			await this.sleep(this.pollIntervalMs());
		}

		return undefined;
	}

	/** One component as §5.4 reads it: the Deployment, its ReplicaSets and its pods. */
	private async observe(
		credential: string,
		ref: AppTargetRef,
		objectName: string,
		context?: string
	): Promise<ComponentObservation> {
		const deployment = await this.api.readObject<AppLiveDeployment>(
			credential,
			'apps/v1',
			'Deployment',
			ref.namespace,
			objectName,
			context
		);
		const replicaSets = deployment
			? await this.api.listObjects<AppRolloutReplicaSet>(
					credential,
					'apps/v1',
					'ReplicaSet',
					ref.namespace,
					componentSelector(objectName),
					context
				)
			: [];
		const pods = deployment
			? await this.api.listObjects<AppLivePod>(
					credential,
					'v1',
					'Pod',
					ref.namespace,
					componentSelector(objectName),
					context
				)
			: [];
		const container = liveContainers(deployment)[0] ?? null;

		return {
			deployment,
			replicaSets,
			pods,
			container,
			// §4.3 writes a container port for web components only, so the live object says which it is.
			role: (container?.ports ?? []).length > 0 ? 'web' : 'worker'
		};
	}

	/** The observed component statuses of the named components — T12's `observe()` assembly. */
	private async observeComponents(
		credential: string,
		ref: AppTargetRef,
		names: readonly string[],
		context?: string
	): Promise<AppComponentStatus[]> {
		const components: AppComponentStatus[] = [];
		const now = this.now();

		for (const name of [...names].sort()) {
			const observation = await this.observe(credential, ref, name, context);
			const summary = componentPodSummary(observation.pods, now);
			components.push({
				name,
				role: observation.role,
				desired: Number(observation.deployment?.spec?.replicas ?? 0),
				ready: Number(observation.deployment?.status?.readyReplicas ?? 0),
				restarts: summary.restarts,
				...(summary.reason ? { lastTerminationReason: summary.reason } : {}),
				oomKilledAt: summary.oomKilledAt
			});
		}

		return components;
	}

	/** §9.10's phase-5 smoke for a resume: §4.8's runner Job, in the app namespace. */
	private async smokeRun(
		ref: AppTargetRef,
		credential: string,
		live: readonly AppLiveDeployment[],
		checks: readonly AppSmokeInput[],
		context?: string
	): Promise<{ smoke: AppSmokeRun | null; failure?: AppScaleResult['failure'] }> {
		const namespace = String(ref?.namespace ?? '');
		const primary = livePrimaryDeployment(live);
		const envChecksum = liveEnvChecksum(primary ?? live[0]);
		const input = minimalRenderInput(ref, {
			workSlug: liveWorkSlug(primary ?? live[0]),
			envChecksum,
			components: primary ? [primaryComponentFromDeployment(primary)] : [],
			smoke: checks,
			// A resume follows a Deployment, so the App is not on its first Deployment: §5.5's
			// `first-deploy` checks are filtered out exactly as the deployer filters them.
			isFirstDeploymentOnCluster: false
		});
		const renderOptions = { checks, envChecksum, windowSeconds: this.smokeWindowSeconds() };
		const configMap = renderRunnerConfigMap(input, 'smoke', renderOptions);
		const object = renderRunnerJob(input, 'smoke', renderOptions);
		if (!configMap || !object) {
			return { smoke: null };
		}

		await this.api.applyObject(credential, configMap, context);
		await this.api.applyObject(credential, object, context);

		const observed = await this.pollJob(
			credential,
			namespace,
			String(object.metadata.name),
			'smoke',
			(this.smokeWindowSeconds() + APP_RUNNER_DEADLINE_EXTRA_S) * 1_000,
			context
		);
		const results: CheckResult[] = observed.records.map(checkResultOf);
		if (results.length === 0) {
			// A runner that wrote no report at all did not fail a check — it did not answer. Reporting
			// `smoke_failed` here would blame the App for a Job that never ran (FR-49's "the app stays
			// resumed" still holds; the code names what actually happened).
			return {
				smoke: null,
				failure: {
					code: 'deadline_exceeded',
					message:
						`The in-cluster smoke run '${String(object.metadata.name)}' reported nothing within its ` +
						`${this.smokeWindowSeconds() + APP_RUNNER_DEADLINE_EXTRA_S} s window (plan §4.8); the app stays ` +
						'resumed and health notifications follow FR-47 (FR-49).'
				}
			};
		}

		const smoke: AppSmokeRun = { checks: results, passed: results.every((check) => check.status === 'passed') };

		if (!smoke.passed) {
			return {
				smoke,
				failure: {
					code: 'smoke_failed',
					message:
						`The in-cluster smoke run reported ${results.filter((check) => check.status !== 'passed').length} ` +
						'failing check(s); the app stays resumed and health notifications follow FR-47 (FR-49).'
				}
			};
		}

		return { smoke };
	}

	/* --------------------------------------------------------------------- *
	 * Namespace preparation (§4.2, GAP-06)
	 * --------------------------------------------------------------------- */

	/**
	 * `IDeploymentPlugin.prepareAppNamespace` — §4.2's subset, in the op's own order: Namespace
	 * (ownership check, `ever-works.io/work-id`, the pod-security labels), ServiceAccount `app`,
	 * LimitRange `ew-defaults` (403 on Your cluster is the warning `limitrange_forbidden`) and, when
	 * `isolation` is true, the three baseline policies.
	 *
	 * It **never** draws `ew-allow-ingress`, `ew-allow-deps` or a `dep-*` policy — a Deployment draws
	 * the first two and APW-07 owns the third (GAP-06), which is what breaks the `prepare-namespace` /
	 * dependency-provisioning cycle. It persists nothing: the `namespace` and `clusterFingerprint`
	 * columns belong to §9.10's op.
	 */
	async prepareAppNamespace(
		ref: AppTargetRef,
		credential: string,
		opts: { isolation: boolean; limitRange: AppLimitRangeInput }
	): Promise<{ warnings: Array<{ code: string; message: string }> }> {
		assertSupportedKubeconfig(credential, ref?.kubeContext ?? undefined);

		const context = ref?.kubeContext ?? undefined;
		const namespace = String(ref?.namespace ?? '');
		await this.assertNamespaceOwnership(credential, ref, context);

		const input = minimalRenderInput(ref, {
			network: { isolation: opts?.isolation === true, needsHairpin: false },
			limitRange: opts?.limitRange ?? defaultLimitRangeForTarget(ref?.target)
		});
		const warnings: Array<{ code: string; message: string }> = [];

		for (const object of renderPrepareNamespace(input)) {
			try {
				await this.api.applyObject(credential, object, context);
			} catch (err) {
				const forbidden = scrubError(err).code === 'UNAUTHORIZED';
				if (object.kind === 'LimitRange' && forbidden && ref?.target !== 'ever-works-apps') {
					warnings.push({
						code: APP_LIMITRANGE_FORBIDDEN,
						message: `Applying LimitRange '${object.metadata.name}' to namespace '${namespace}' was forbidden; the namespace keeps the cluster's own defaults (plan §4.2 step 3).`
					});
					continue;
				}
				throw err instanceof K8sPluginError
					? err
					: lifecycleError(
							APP_LIFECYCLE_CODES.apply_failed,
							`Applying ${object.kind} '${object.metadata.name}' failed: ${scrubError(err).message}`
						);
			}
		}

		return { warnings };
	}

	/**
	 * §4.2's namespace ownership check: an existing namespace must carry `ever-works.io/work-id`
	 * equal to this Work, or be the owner-selected pre-created namespace with no object labelled for
	 * another Work. A namespace labelled for a different Work is refused — applying into it would
	 * rewrite another App's namespace objects.
	 */
	private async assertNamespaceOwnership(credential: string, ref: AppTargetRef, context?: string): Promise<void> {
		const namespace = String(ref?.namespace ?? '');
		const existing = await this.api.readObject<AppLiveNamespace>(
			credential,
			'v1',
			'Namespace',
			'',
			namespace,
			context
		);
		if (!existing) {
			return;
		}

		const owner = normalise(existing?.metadata?.labels?.[APP_LABEL_WORK_ID]);
		if (owner && owner !== ref.workId) {
			throw lifecycleError(
				APP_LIFECYCLE_CODES.namespace_owned,
				`Namespace '${namespace}' belongs to Work '${owner}', not to '${ref.workId}' (plan §4.2).`
			);
		}
		if (owner === ref.workId) {
			return;
		}

		// The owner-selected pre-created namespace: it may hold no object labelled for another Work.
		const deployments = await this.api.listObjects<AppLiveDeployment>(
			credential,
			'apps/v1',
			'Deployment',
			namespace,
			APP_LABEL_WORK_ID,
			context
		);
		const foreign = deployments.find(
			(deployment) => normalise(deployment?.metadata?.labels?.[APP_LABEL_WORK_ID]) !== ref.workId
		);
		if (foreign) {
			throw lifecycleError(
				APP_LIFECYCLE_CODES.namespace_owned,
				`Namespace '${namespace}' holds Deployment '${String(foreign?.metadata?.name ?? '')}' of another Work (plan §4.2).`
			);
		}
	}

	/* --------------------------------------------------------------------- *
	 * Publish hosts (§4.11, APW06-G03)
	 * --------------------------------------------------------------------- */

	/**
	 * `IDeploymentPlugin.publishAppHosts` — re-applies **only** the `Ingress` for the given hosts and
	 * returns the address it observed. Used by §9.10's `ingress-reconcile` op, which must never call
	 * `deployApp`: this method applies exactly one object (ACC-06-25).
	 *
	 * The IngressClass is the live Ingress's own when one is published (a reconcile must not move a
	 * published host to another controller) and the cluster's default class otherwise; with neither,
	 * §4.11 renders no Ingress at all and the result is `{ ingressAddress: null }`.
	 */
	async publishAppHosts(
		ref: AppTargetRef,
		credential: string,
		hosts: { primary: string | null; extra: string[]; previous: string[]; tls: string; issuer: string | null }
	): Promise<{ ingressAddress: { ip?: string; hostname?: string } | null }> {
		assertSupportedKubeconfig(credential, ref?.kubeContext ?? undefined);

		const context = ref?.kubeContext ?? undefined;
		const namespace = String(ref?.namespace ?? '');
		const tls = tlsMode(hosts?.tls);
		if (!tls) {
			throw lifecycleError(
				APP_LIFECYCLE_CODES.tls_mode_unknown,
				`'${String(hosts?.tls)}' is not one of §4.11's TLS modes (cert-manager, external, none, edge).`
			);
		}

		const namespaceObject = await this.api.readObject<AppLiveNamespace>(
			credential,
			'v1',
			'Namespace',
			'',
			namespace,
			context
		);
		if (namespaceObject?.metadata?.labels?.[APP_LABEL_PURPOSE] === APP_VERIFICATION_PURPOSE) {
			// §4.12: a verification namespace renders no Ingress and publishes no host.
			return { ingressAddress: null };
		}

		const deployments = await liveComponentDeployments(this.api, credential, ref, context);
		const published = await this.readPublishedIngress(credential, ref, deployments, context);
		if (!published.deployment) {
			throw lifecycleError(
				APP_LIFECYCLE_CODES.ingress_target_unknown,
				`Namespace '${namespace}' has no web component to publish an Ingress for.`
			);
		}

		const input = minimalRenderInput(ref, {
			workSlug: liveWorkSlug(published.deployment),
			components: [primaryComponentFromDeployment(published.deployment)],
			hosts: {
				primary: hosts?.primary ?? null,
				extra: [...(hosts?.extra ?? [])],
				previous: [...(hosts?.previous ?? [])]
			},
			ingress: {
				className: published.className ?? (await this.defaultIngressClass(credential, context)),
				controllerNamespace: null,
				tls,
				issuer: hosts?.issuer ?? null
			}
		});

		const ingress = renderIngress(input);
		if (!ingress) {
			// §4.11: no host passed the RFC-1123 check, or no class exists and none was detected.
			return { ingressAddress: null };
		}

		await this.api.applyObject(credential, ingress, context);

		const startedAt = this.now();
		const deadline = this.deadlineOr(this.options.publishTimeoutMs, APP_PUBLISH_TIMEOUT_S * 1_000);
		for (;;) {
			const live = await this.api.readObject<AppLiveIngress>(
				credential,
				'networking.k8s.io/v1',
				'Ingress',
				namespace,
				String(ingress.metadata.name),
				context
			);
			const address = ingressAddressOf(live);
			if (address) {
				return { ingressAddress: address };
			}
			if (this.now() - startedAt >= deadline) {
				// §9.10: the op's 60 s budget. A controller that has not answered yet is reported as "no
				// address", never as a failure — the Deployment's publish phase owns that verdict.
				return { ingressAddress: null };
			}
			await this.sleep(this.pollIntervalMs());
		}
	}

	/** The published Ingress' class and the component behind it, or the sole web component. */
	private async readPublishedIngress(
		credential: string,
		ref: AppTargetRef,
		deployments: readonly AppLiveDeployment[],
		context?: string
	): Promise<{ deployment: AppLiveDeployment | null; className: string | null }> {
		const ingresses = await this.api.listObjects<AppLiveIngress>(
			credential,
			'networking.k8s.io/v1',
			'Ingress',
			ref.namespace,
			workSelector(ref.workId),
			context
		);
		const ingress = ingresses[0] ?? null;
		const backend =
			normalise(ingress?.spec?.rules?.[0]?.http?.paths?.[0]?.backend?.service?.name) ??
			normalise(ingress?.metadata?.name);

		if (backend) {
			const match = deployments.find((deployment) => String(deployment?.metadata?.name ?? '') === backend);
			if (match) {
				return { deployment: match, className: normalise(ingress?.spec?.ingressClassName) };
			}
		}

		return {
			deployment: livePrimaryDeployment(deployments),
			className: normalise(ingress?.spec?.ingressClassName)
		};
	}

	/** The cluster's default IngressClass (§4.11), or `null` when none is marked default. */
	private async defaultIngressClass(credential: string, context?: string): Promise<string | null> {
		const classes = await this.api.listObjects<{
			metadata?: { name?: string; annotations?: Record<string, string> };
		}>(credential, 'networking.k8s.io/v1', 'IngressClass', '', undefined, context);
		const marked = classes.find(
			(entry) => entry?.metadata?.annotations?.['ingressclass.kubernetes.io/is-default-class'] === 'true'
		);
		return normalise(marked?.metadata?.name);
	}

	/* --------------------------------------------------------------------- *
	 * Remove (FR-50)
	 * --------------------------------------------------------------------- */

	/**
	 * `IDeploymentPlugin.destroyApp` — FR-50's **Remove from cluster**, and its **Also delete stored
	 * data** variant.
	 *
	 * Deleted: workloads, jobs, scheduled calls, services, published hosts (`Ingress`), secrets,
	 * ConfigMaps and the app's network policies. Never deleted unless `deleteVolumes`: any
	 * `PersistentVolumeClaim`, anything labelled `ever-works.io/dependency` (APW-07's objects,
	 * §4.10 / APW07-G01) and the namespace itself — and while a kept claim or dependency object
	 * remains, `ew-default-deny` stays too, so kept data is never opened to other pods.
	 *
	 * A **verification** namespace (label `ever-works.io/purpose: verification`, §4.12) is deleted
	 * whole regardless of `deleteVolumes`, with propagation `Foreground`.
	 *
	 * `deleteVolumes` defaults to `false` when the option is absent: "keeps volumes, dependencies and
	 * the namespace holding them" is the safe reading of a missing flag.
	 */
	async destroyApp(
		ref: AppTargetRef,
		credential: string,
		opts: { deleteVolumes: boolean }
	): Promise<AppDestroyResult> {
		assertSupportedKubeconfig(credential, ref?.kubeContext ?? undefined);

		const context = ref?.kubeContext ?? undefined;
		const namespace = String(ref?.namespace ?? '');
		const deleteVolumes = opts?.deleteVolumes === true;

		const namespaceObject = await this.api.readObject<AppLiveNamespace>(
			credential,
			'v1',
			'Namespace',
			'',
			namespace,
			context
		);
		if (!namespaceObject) {
			return { deleted: [], kept: [], namespaceDeleted: false };
		}

		if (namespaceObject?.metadata?.labels?.[APP_LABEL_PURPOSE] === APP_VERIFICATION_PURPOSE) {
			// §4.12: "Destroy deletes the namespace (propagation Foreground) and waits ≤ 300 s".
			return this.deleteNamespaceWhole(credential, namespace, context);
		}

		const deleted: AppObjectRef[] = [];
		const kept: AppObjectRef[] = [];

		for (const { apiVersion, kind } of APP_OWNED_KINDS) {
			for (const name of await this.appObjects(credential, ref, apiVersion, kind, context)) {
				await this.api.deleteObject(credential, apiVersion, kind, namespace, name, undefined, context);
				deleted.push({ kind, name });
			}
		}

		const held = new Set(
			await this.namespacedObjects(
				credential,
				'networking.k8s.io/v1',
				'NetworkPolicy',
				namespace,
				workSelector(ref.workId),
				context
			)
		);
		for (const name of DELETABLE_POLICY_NAMES.filter((policy) => held.has(policy))) {
			await this.api.deleteObject(
				credential,
				'networking.k8s.io/v1',
				'NetworkPolicy',
				namespace,
				name,
				undefined,
				context
			);
			deleted.push({ kind: 'NetworkPolicy', name });
		}
		const defaultDeny = held.has(DEFAULT_DENY_POLICY) ? DEFAULT_DENY_POLICY : null;

		const claims = await this.namespacedObjects(
			credential,
			'v1',
			'PersistentVolumeClaim',
			namespace,
			workSelector(ref.workId),
			context
		);
		const dependencies = await this.dependencyObjects(credential, namespace, context);

		// FR-50: "the namespace's deny-all policy stays while any kept dependency or volume remains, so
		// kept data is never opened to other pods". With nothing left to protect — and on the
		// delete-everything path — it is one of "the app's network policies" and goes with them.
		const nothingRemains = claims.length === 0 && dependencies.length === 0;
		if (defaultDeny && (deleteVolumes || nothingRemains)) {
			await this.api.deleteObject(
				credential,
				'networking.k8s.io/v1',
				'NetworkPolicy',
				namespace,
				defaultDeny,
				undefined,
				context
			);
			deleted.push({ kind: 'NetworkPolicy', name: defaultDeny });
		}

		if (deleteVolumes) {
			for (const name of claims) {
				await this.api.deleteObject(
					credential,
					'v1',
					'PersistentVolumeClaim',
					namespace,
					name,
					undefined,
					context
				);
				deleted.push({ kind: 'PersistentVolumeClaim', name });
			}
			for (const dependency of dependencies) {
				await this.api.deleteObject(
					credential,
					dependency.apiVersion,
					dependency.kind,
					namespace,
					dependency.name,
					undefined,
					context
				);
				deleted.push({ kind: dependency.kind, name: dependency.name });
			}

			const whole = await this.deleteNamespaceWhole(credential, namespace, context);
			return { deleted: [...deleted, ...whole.deleted], kept, namespaceDeleted: whole.namespaceDeleted };
		}

		for (const name of claims) {
			kept.push({ kind: 'PersistentVolumeClaim', name });
		}
		for (const dependency of dependencies) {
			kept.push({ kind: dependency.kind, name: dependency.name });
		}
		if (defaultDeny && !nothingRemains) {
			kept.push({ kind: 'NetworkPolicy', name: defaultDeny });
		}
		kept.push({ kind: 'Namespace', name: namespace });

		return { deleted, kept, namespaceDeleted: false };
	}

	/** The object names of one kind that carry this Work's label, sorted. */
	private async appObjects(
		credential: string,
		ref: AppTargetRef,
		apiVersion: string,
		kind: string,
		context?: string
	): Promise<string[]> {
		return this.namespacedObjects(credential, apiVersion, kind, ref.namespace, workSelector(ref.workId), context);
	}

	private async namespacedObjects(
		credential: string,
		apiVersion: string,
		kind: string,
		namespace: string,
		labelSelector: string | undefined,
		context?: string
	): Promise<string[]> {
		const objects = await this.api.listObjects<{ metadata?: { name?: string } }>(
			credential,
			apiVersion,
			kind,
			namespace,
			labelSelector,
			context
		);
		return objects
			.map((object) => String(object?.metadata?.name ?? ''))
			.filter((name) => name.length > 0)
			.sort();
	}

	/** Every object in the namespace labelled `ever-works.io/dependency` — APW-07's (§4.10). */
	private async dependencyObjects(
		credential: string,
		namespace: string,
		context?: string
	): Promise<Array<AppObjectRef & { apiVersion: string }>> {
		const found: Array<AppObjectRef & { apiVersion: string }> = [];
		for (const { apiVersion, kind } of APP_DEPENDENCY_KINDS) {
			const names = await this.namespacedObjects(
				credential,
				apiVersion,
				kind,
				namespace,
				APP_DEPENDENCY_POLICY_LABEL,
				context
			);
			for (const name of names) {
				found.push({ apiVersion, kind, name });
			}
		}
		return found;
	}

	/** Delete a namespace whole (`Foreground`) and wait ≤ FR-50's 300 s for it to be gone. */
	private async deleteNamespaceWhole(
		credential: string,
		namespace: string,
		context?: string
	): Promise<AppDestroyResult> {
		await this.api.deleteObject(credential, 'v1', 'Namespace', '', namespace, FOREGROUND, context);

		const startedAt = this.now();
		const deadline = this.deadlineOr(this.options.removeTimeoutMs, APP_REMOVE_TIMEOUT_S * 1_000);
		for (;;) {
			const live = await this.api.readObject<AppLiveNamespace>(
				credential,
				'v1',
				'Namespace',
				'',
				namespace,
				context
			);
			if (!live) {
				return { deleted: [{ kind: 'Namespace', name: namespace }], kept: [], namespaceDeleted: true };
			}
			if (this.now() - startedAt >= deadline) {
				throw lifecycleError(
					APP_LIFECYCLE_CODES.namespace_delete_timeout,
					`Namespace '${namespace}' was deleted with propagation ${FOREGROUND} but still exists after FR-50's ${Math.round(
						deadline / 1_000
					)} s budget.`
				);
			}
			await this.sleep(this.pollIntervalMs());
		}
	}

	/* --------------------------------------------------------------------- *
	 * Shared machine
	 * --------------------------------------------------------------------- */

	/** Poll one Job until it is terminal or the caller's budget is spent, then read its report. */
	private async pollJob(
		credential: string,
		namespace: string,
		objectName: string,
		label: string,
		budgetMs: number,
		context?: string
	): Promise<JobObservation> {
		const startedAt = this.now();
		let status: AppJobResult['status'] = 'running';

		for (;;) {
			const job = await this.api.readObject<AppLiveJob>(
				credential,
				JOB_API_VERSION,
				'Job',
				namespace,
				objectName,
				context
			);
			status = jobStatusOf(job);
			if (status !== 'running' || this.now() - startedAt >= budgetMs) {
				break;
			}
			await this.sleep(this.pollIntervalMs());
		}

		const job = await this.api.readObject<AppLiveJob>(
			credential,
			JOB_API_VERSION,
			'Job',
			namespace,
			objectName,
			context
		);
		const pods = await this.api.listObjects<AppLivePod>(
			credential,
			'v1',
			'Pod',
			namespace,
			`${APP_LABEL_JOB}=${label}`,
			context
		);
		const pod = newestPod(pods);
		const podName = String(pod?.metadata?.name ?? '');
		const container = String(pod?.spec?.containers?.[0]?.name ?? '');
		const log = podName
			? await this.api.readPodLog(
					credential,
					namespace,
					podName,
					container,
					{ tailLines: APP_LOG_LINES_DEFAULT, limitBytes: APP_LOG_BYTES_MAX, previous: false },
					context
				)
			: null;
		const exitCode = terminatedExitCode(pod);
		const completedAt = normalise(job?.status?.completionTime);

		return {
			status,
			records: parseRunnerRecords(log),
			pod: podName,
			container,
			...(exitCode !== undefined ? { exitCode } : {}),
			...(completedAt ? { completedAt } : {})
		};
	}

	private now(): number {
		return this.options.now ? this.options.now() : Date.now();
	}

	private async sleep(millis: number): Promise<void> {
		if (this.options.sleep) {
			await this.options.sleep(millis);
			return;
		}
		await new Promise<void>((resolve) => setTimeout(resolve, millis));
	}

	private pollIntervalMs(): number {
		const declared = this.options.pollIntervalMs;
		return typeof declared === 'number' && Number.isFinite(declared) && declared > 0
			? Math.floor(declared)
			: APP_ROLLOUT_POLL_MS;
	}

	private deadlineOr(declared: number | undefined, fallback: number): number {
		return typeof declared === 'number' && Number.isFinite(declared) && declared >= 0 ? declared : fallback;
	}

	private jobWaitMs(): number {
		const declared = this.options.jobWaitMs;
		return typeof declared === 'number' && Number.isFinite(declared) && declared >= 0
			? declared
			: APP_JOB_TIMEOUT_DEFAULT_S * 1_000;
	}

	private smokeWindowSeconds(): number {
		const declared = this.options.smokeWindowSeconds;
		return typeof declared === 'number' && Number.isFinite(declared) && declared > 0
			? Math.floor(declared)
			: APP_RUNNER_WINDOW_S;
	}

	private runShort(): string {
		if (this.options.runShort) {
			return this.options.runShort();
		}
		return hexSuffix(randomUUID(), APP_DEPLOYMENT_SHORT_LENGTH);
	}
}

/* ------------------------------------------------------------------------- *
 * Module-level helpers
 * ------------------------------------------------------------------------- */

/** A `<code>: <detail>` refusal — `errors.ts`'s union has no App code (see {@link APP_LIFECYCLE_CODES}). */
function lifecycleError(code: string, message: string): K8sPluginError {
	return new K8sPluginError('UNKNOWN', `${code}: ${message}`);
}

function normalise(value: unknown): string | null {
	const text = typeof value === 'string' ? value.trim() : '';
	return text ? text : null;
}

/** §4.11's four TLS modes, or `null` for anything else. */
function tlsMode(value: unknown): AppRenderInput['ingress']['tls'] | null {
	return value === 'cert-manager' || value === 'external' || value === 'none' || value === 'edge' ? value : null;
}

/** A replica count that is always a non-negative integer — a cluster never accepts anything else. */
function asReplicaCount(value: unknown): number {
	const count = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 0;
	return Math.max(0, count);
}

/**
 * The declared replicas of one component, looked up by object name and by the App spec's own
 * spelling of it (they differ only for a name the sanitiser rewrites). `null` means "not declared".
 */
function declaredReplicas(declared: Record<string, number>, objectName: string): number | null {
	if (typeof declared?.[objectName] === 'number' && Number.isFinite(declared[objectName])) {
		return declared[objectName];
	}
	const specName = Object.keys(declared ?? {}).find((name) => componentObjectName(name) === objectName);
	if (specName && typeof declared[specName] === 'number' && Number.isFinite(declared[specName])) {
		return declared[specName];
	}
	return null;
}

/** `resumeChecks.deadlines` is keyed by the App spec's component name; both spellings are looked up. */
function declaredDeadline(deadlines: Record<string, number>, name: string): number | null {
	const candidates = [deadlines?.[name], deadlines?.[componentObjectName(name)]];
	const declared = candidates.find((value) => typeof value === 'number' && Number.isFinite(value) && value > 0);
	return typeof declared === 'number' ? Math.floor(declared) : null;
}

/** The terminated container's exit code, when the pod reports one. */
function terminatedExitCode(pod: AppLivePod | null | undefined): number | undefined {
	for (const container of pod?.status?.containerStatuses ?? []) {
		const terminated = container?.state?.terminated ?? container?.lastState?.terminated ?? null;
		if (typeof terminated?.exitCode === 'number') {
			return terminated.exitCode;
		}
	}
	return undefined;
}

/** The volume claims a live component Deployment mounts — §4.6's reason a second replica is refused. */
function claimsOf(deployment: AppLiveDeployment | null | undefined): string[] {
	const volumes = deployment?.spec?.template?.spec?.volumes ?? [];
	return volumes
		.map((volume) => volume?.persistentVolumeClaim?.claimName)
		.filter((name): name is string => typeof name === 'string' && name.length > 0);
}
