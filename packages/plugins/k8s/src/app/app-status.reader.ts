/**
 * APW-06 T13 — `getAppStatus`, and the live-cluster reads the other two T13 modules share.
 *
 * Sources, in priority order:
 *
 * 1. `plan.md` §3.1 — `AppStatusSpec` / `AppStatusSnapshot` / `AppComponentStatus` / `AppJobResult`
 *    are the contract (`packages/plugin/src/contracts/capabilities/app-deployment.types.ts`), and this
 *    module's `getAppStatus` matches `IDeploymentPlugin.getAppStatus`'s signature exactly.
 * 2. `spec.md` FR-46 (every field one observation carries), FR-47 (the three states that read the
 *    numbers it produces) and FR-48's caps, which the runner-report reads here already honour.
 * 3. `plan.md` §6.3 ("Connection check") and §9.10 (`status-refresh`), and `tasks.md:217-250` (T13).
 *
 * **What this module reads, and what it deliberately does not.** Every field of the snapshot comes
 * from objects and pod logs in the Work's own namespace: the component Deployments but also the
 * ReplicaSets and Pods behind them (`restarts`, `lastTerminationReason`, `oomKilledAt`), the Jobs of
 * the App spec's job names (`jobs[]`), the CronJobs and the Jobs they created (`cron[]`), the newest
 * `smoke` runner Job's report (`smoke`), the newest `isolation-probe` runner Job's answer
 * (`isolationEnforced`) and the published `Ingress`'s load-balancer address (`ingressAddress`).
 * It never dials anything else and it persists nothing: FR-46's *target*, *URL*, *Source*, *app
 * state* and *outcomes of any action still in flight* are the platform's (`work_app_runtime_states`),
 * which is why §9.10's `status-refresh` op is the only caller — a status read is a cluster read.
 *
 * **`AppTargetRef` has no `purpose`.** §4.12 makes a verification ref's namespace carry
 * `ever-works.io/purpose: verification`, so a verification read is recognised from the namespace
 * label — never from the namespace name, which §4.12 also says APW-04 never derives. For such a ref
 * only `components`, `jobs`, `smoke` and `isolationEnforced` are reported: no `cron[]` (a
 * verification render has no CronJob) and no `ingressAddress` (it has no Ingress).
 *
 * **Additive-only.** This is a new file; nothing here changes a file another task shipped. The three
 * FR-48/§5.3 constants below (`APP_LOG_*`) live here rather than in `app-lifecycle.ts` because
 * `app-lifecycle.ts` imports this module (one direction only), and both need them: a runner report
 * *is* a log read, so the same 200-line / 256 KiB caps apply to it (FR-48).
 */
import type {
	AppComponentStatus,
	AppJobResult,
	AppLogRef,
	AppSmokeResult,
	AppStatusSnapshot,
	AppStatusSpec,
	AppTargetRef,
	CheckResult
} from '@ever-works/plugin';

import type { AppRolloutPod } from './app-rollout.js';
import type { AppRunnerRecord } from './app-runner.script.js';
import type { KubernetesApiService, PodLogOptions } from '../k8s-api.service.js';
import { assertSupportedKubeconfig } from './app-kubeconfig.guard.js';
import { APP_ENV_CHECKSUM_ANNOTATION } from './app-manifest.renderer.js';
import {
	APP_LABEL_COMPONENT,
	APP_LABEL_CRON,
	APP_LABEL_JOB,
	APP_LABEL_PURPOSE,
	APP_LABEL_WORK_ID,
	APP_VERIFICATION_PURPOSE,
	componentObjectName,
	cronJobName
} from './app-names.js';

/* ------------------------------------------------------------------------- *
 * Constants (plan §5.3, FR-48)
 * ------------------------------------------------------------------------- */

/** FR-46: "last out-of-memory kill in the last 24 hours" — older ones are not reported. */
export const APP_OOM_WINDOW_HOURS = 24;

/** FR-48: logs show the last 200 lines by default. */
export const APP_LOG_LINES_DEFAULT = 200;
/** FR-48: up to 500 lines on request. */
export const APP_LOG_LINES_MAX = 500;
/** FR-48: at most 256 KiB per container. */
export const APP_LOG_BYTES_MAX = 262_144;
/** FR-48: every secret env value of this many characters or more is replaced by its name. */
export const APP_LOG_REDACT_MIN_CHARS = 8;

/** A Job in a terminal state, or one still running — the four values `AppJobResult['status']` has. */
type JobStatus = AppJobResult['status'];

/* ------------------------------------------------------------------------- *
 * The port over the API service
 * ------------------------------------------------------------------------- */

/**
 * The three methods a status read needs, structurally a subset of `KubernetesApiService` (T10) — so
 * the plugin passes its service instance straight in and the spec passes a fake. The kubeconfig is
 * the first argument of every call, exactly as the service declares it: nothing here is a global.
 */
export interface AppStatusApi {
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
	readPodLog(
		kubeconfigYaml: string,
		namespace: string,
		pod: string,
		container: string,
		options?: PodLogOptions,
		contextOverride?: string
	): Promise<string | null>;
}

/**
 * A compile-time proof that the real service is drivable through {@link AppStatusApi}: if
 * `KubernetesApiService` ever stops satisfying the port, `pnpm type-check` fails here rather than at
 * a call site in the worker.
 */
type AssertTrue<T extends true> = T;
export type KubernetesApiServiceSatisfiesStatusPort = AssertTrue<
	KubernetesApiService extends AppStatusApi ? true : false
>;

/* ------------------------------------------------------------------------- *
 * Structural shapes of the objects read
 * ------------------------------------------------------------------------- */

/** One container of a live pod template — the fields a log read, a job run or a scale needs. */
export interface AppLiveContainer {
	name?: string;
	image?: string;
	command?: readonly string[];
	args?: readonly string[];
	envFrom?: readonly {
		secretRef?: { name?: string } | null;
		configMapRef?: { name?: string } | null;
	}[];
	ports?: readonly { name?: string; containerPort?: number }[] | null;
	/** §4.4's hardening, copied verbatim into a manual run (§4.8: "security context and resources"). */
	securityContext?: Record<string, unknown> | null;
	resources?: Record<string, unknown> | null;
	/** §4.5's probes — what tells a worker without probes apart from a web component (§5.4). */
	startupProbe?: unknown;
	readinessProbe?: unknown;
	livenessProbe?: unknown;
}

/** The pod spec a live Deployment carries — the source of the image, the `envFrom` and the ports. */
export interface AppLivePodSpec {
	serviceAccountName?: string;
	containers?: readonly AppLiveContainer[] | null;
	imagePullSecrets?: readonly { name?: string }[] | null;
	securityContext?: Record<string, unknown> | null;
	/** §4.6's claims — what refuses a second replica of a component that mounts one (`volume_replicas`). */
	volumes?: readonly { name?: string; persistentVolumeClaim?: { claimName?: string } | null }[] | null;
}

/** A live component Deployment, as `apps/v1` reports it. */
export interface AppLiveDeployment {
	apiVersion?: string;
	kind?: string;
	metadata?: {
		name?: string;
		namespace?: string;
		labels?: Record<string, string>;
		annotations?: Record<string, string>;
		creationTimestamp?: string;
		generation?: number;
	} | null;
	spec?: {
		replicas?: number;
		selector?: { matchLabels?: Record<string, string> } | null;
		template?: {
			metadata?: { labels?: Record<string, string>; annotations?: Record<string, string> };
			spec?: AppLivePodSpec;
		} | null;
	} | null;
	status?: {
		observedGeneration?: number;
		replicas?: number;
		updatedReplicas?: number;
		readyReplicas?: number;
		availableReplicas?: number;
		unavailableReplicas?: number;
		conditions?: readonly { type?: string; status?: string; reason?: string; message?: string }[] | null;
	} | null;
}

/** A live Pod: {@link AppRolloutPod} (the §5.4 predicate's view) plus the containers, which name
 * the container a log read addresses. */
export interface AppLivePod extends AppRolloutPod {
	spec?: { containers?: readonly AppLiveContainer[] | null } | null;
}

/** A live `batch/v1` Job. */
export interface AppLiveJob {
	apiVersion?: string;
	kind?: string;
	metadata?: {
		name?: string;
		namespace?: string;
		labels?: Record<string, string>;
		creationTimestamp?: string;
	} | null;
	status?: {
		active?: number;
		succeeded?: number;
		failed?: number;
		startTime?: string;
		completionTime?: string;
		conditions?: readonly { type?: string; status?: string; reason?: string; message?: string }[] | null;
	} | null;
}

/** A live `batch/v1` CronJob. */
export interface AppLiveCronJob {
	metadata?: { name?: string; namespace?: string; labels?: Record<string, string> } | null;
	spec?: { suspend?: boolean; schedule?: string } | null;
	status?: { lastScheduleTime?: string; lastSuccessfulTime?: string; active?: readonly unknown[] | null } | null;
}

/** A live `networking.k8s.io/v1` Ingress — its class, its backend and its assigned address. */
export interface AppLiveIngress {
	metadata?: { name?: string; namespace?: string; labels?: Record<string, string> } | null;
	spec?: {
		ingressClassName?: string;
		rules?: readonly {
			host?: string;
			http?: { paths?: readonly { backend?: { service?: { name?: string; port?: { number?: number } } } }[] };
		}[];
	} | null;
	status?: { loadBalancer?: { ingress?: readonly { ip?: string; hostname?: string }[] } } | null;
}

/** A live `v1` Namespace — the labels that say whether this is a verification namespace. */
export interface AppLiveNamespace {
	metadata?: { name?: string; labels?: Record<string, string>; annotations?: Record<string, string> } | null;
}

/* ------------------------------------------------------------------------- *
 * Live-cluster helpers shared with `app-lifecycle.ts`
 * ------------------------------------------------------------------------- */

/** `ever-works.io/work-id=<id>` — every object §4.1 stamps for a Work. */
export function workSelector(workId: string): string {
	return `${APP_LABEL_WORK_ID}=${workId}`;
}

/** `ever-works.io/component=<objectName>` — the §4.1 selector, stable across slug renames. */
export function componentSelector(objectName: string): string {
	return `${APP_LABEL_COMPONENT}=${objectName}`;
}

/**
 * §4.1's inverse of `appNamespaceName` for a **live** namespace: `ew-<slug ≤ 30>-<8 hex>` carries the
 * slug, and nothing else in the plugin does. The namespace is the one value every T13 capability is
 * given (via `AppTargetRef`), while `AppRenderInput` — which the renderer needs — also wants the
 * slug for `app.kubernetes.io/part-of`. Deriving it is exact: the suffix is a `-` plus exactly
 * {@link APP_DEPLOYMENT_SHORT_LENGTH} hex characters appended by `fitLabel`, which never truncates
 * the suffix.
 *
 * Returns `''` for a name that is not an App namespace (a verification or preview namespace, or an
 * owner-chosen one); `appLabels` then falls back to `app`, exactly as it does for a slug that
 * sanitises to nothing, so the object is still labelled rather than rejected.
 */
export function workSlugFromNamespace(namespace: string): string {
	const name = String(namespace ?? '');
	const match = /^ew-(.+)-[0-9a-f]{8}$/.exec(name);
	return match ? match[1] : '';
}

/** The containers of a live Deployment's pod template, in declaration order. */
export function liveContainers(deployment: AppLiveDeployment | null | undefined): AppLiveContainer[] {
	return [...(deployment?.spec?.template?.spec?.containers ?? [])];
}

/**
 * The `envFrom` of the live Deployment's first container, verbatim — what a `runAppJob` Job must
 * carry so it runs with the App's own environment (FR-51: "the current live version's image and
 * env"), rather than with a re-rendered guess at the checksum.
 */
export function liveEnvFrom(deployment: AppLiveDeployment | null | undefined): Record<string, unknown>[] {
	const container = liveContainers(deployment)[0];
	return (container?.envFrom ?? []).map((reference) => ({ ...reference }));
}

/**
 * The env checksum the live pods were rolled with — the pod-template annotation §4.3 writes
 * (`ever-works.io/env-checksum`), falling back to the `app-env-<first 10 hex>` Secret name.
 *
 * The fallback is exact: `envSecretName(checksum)` takes the first 10 hex of the checksum, and
 * `hexSuffix` of an already-10-hex string is that same string, so passing the recovered prefix back
 * through the renderer reproduces **both** immutable object names.
 */
export function liveEnvChecksum(deployment: AppLiveDeployment | null | undefined): string | null {
	const annotated = deployment?.spec?.template?.metadata?.annotations?.[APP_ENV_CHECKSUM_ANNOTATION];
	if (typeof annotated === 'string' && annotated.trim()) {
		return annotated.trim();
	}
	for (const reference of liveContainers(deployment)[0]?.envFrom ?? []) {
		const name = reference?.secretRef?.name;
		const match = /^app-env-([0-9a-f]{10})$/.exec(String(name ?? ''));
		if (match) {
			return match[1];
		}
	}
	return null;
}

/** The Work slug the live objects were labelled with, when one was — `app.kubernetes.io/part-of`. */
export function liveWorkSlug(deployment: AppLiveDeployment | null | undefined): string | null {
	const slug = deployment?.metadata?.labels?.['app.kubernetes.io/part-of'];
	return typeof slug === 'string' && slug.trim() ? slug.trim() : null;
}

/**
 * The component Deployment that serves HTTP — the one §4.3 gives a Service and, for
 * `domains.primaryComponent`, an Ingress. §4.3 writes `ports` for web components only, so the
 * container port named `http` is the structural mark of the primary web component.
 *
 * Sorted by object name so two calls on the same namespace pick the same one.
 */
export function livePrimaryDeployment(deployments: readonly AppLiveDeployment[]): AppLiveDeployment | null {
	const withPort = [...deployments]
		.sort((left, right) => String(left?.metadata?.name ?? '').localeCompare(String(right?.metadata?.name ?? '')))
		.find((deployment) => liveContainers(deployment).some((container) => (container.ports ?? []).length > 0));
	return withPort ?? null;
}

/** Every component Deployment of a Work, sorted by object name. */
export async function liveComponentDeployments(
	api: AppStatusApi,
	credential: string,
	ref: AppTargetRef,
	context?: string
): Promise<AppLiveDeployment[]> {
	const deployments = await api.listObjects<AppLiveDeployment>(
		credential,
		'apps/v1',
		'Deployment',
		ref.namespace,
		workSelector(ref.workId),
		context
	);
	return [...deployments].sort((left, right) =>
		String(left?.metadata?.name ?? '').localeCompare(String(right?.metadata?.name ?? ''))
	);
}

/* ------------------------------------------------------------------------- *
 * The runner report (plan §4.8: one JSON line per request)
 * ------------------------------------------------------------------------- */

/**
 * The runner's report: one JSON object per line on stdout (§4.8). A line that does not parse is not
 * a record — the runner writes nothing else, so a malformed line is a runner bug, and inventing a
 * result for it would be worse than reporting none.
 */
export function parseRunnerRecords(log: string | null | undefined): AppRunnerRecord[] {
	const records: AppRunnerRecord[] = [];
	for (const line of String(log ?? '').split('\n')) {
		const trimmed = line.trim();
		if (!trimmed.startsWith('{')) {
			continue;
		}
		try {
			const parsed = JSON.parse(trimmed) as AppRunnerRecord;
			if (parsed && typeof parsed === 'object' && typeof parsed.name === 'string') {
				records.push(parsed);
			}
		} catch {
			// A partial line (a truncated log tail) is not a record.
		}
	}
	return records;
}

/** One runner record as the `CheckResult` §3.1 declares — never more than 200 found characters. */
export function checkResultOf(record: AppRunnerRecord): CheckResult {
	return {
		name: String(record?.name ?? ''),
		status: record?.ok === true ? 'passed' : 'failed',
		...(typeof record?.status === 'number' ? { httpStatus: record.status } : {}),
		...(typeof record?.latencyMs === 'number' ? { latencyMs: record.latencyMs } : {}),
		...(record?.failedExpectation ? { failedExpectation: String(record.failedExpectation) } : {}),
		...(record?.found ? { found: String(record.found).slice(0, 200) } : {})
	};
}

/** A runner report plus where it was read from — what a status read and a job run both need. */
export interface AppRunnerReport {
	records: AppRunnerRecord[];
	job: AppLiveJob | null;
	pod: string;
	container: string;
	logRef: AppLogRef | null;
}

/**
 * Read one runner run's report: the newest Job carrying `ever-works.io/job=<label>`, its pod, and
 * that pod's log — bounded by FR-48's caps, because a runner report is a log read and a chatty
 * script must not be pulled into memory whole.
 *
 * Returns `null` when no such Job exists (nothing has run yet), which is different from a Job whose
 * pod is gone: that one is reported with an empty `records` and a `null` `logRef`, so a caller can
 * tell "never ran" from "ran, report expired".
 */
export async function readRunnerReport(
	api: AppStatusApi,
	credential: string,
	namespace: string,
	label: string,
	context?: string
): Promise<AppRunnerReport | null> {
	const jobs = await api.listObjects<AppLiveJob>(
		credential,
		'batch/v1',
		'Job',
		namespace,
		`${APP_LABEL_JOB}=${label}`,
		context
	);
	const job = newestJob(jobs);
	if (!job) {
		return null;
	}

	const pods = await api.listObjects<AppLivePod>(
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
	if (!podName) {
		return { records: [], job, pod: '', container: '', logRef: null };
	}

	const log = await api.readPodLog(
		credential,
		namespace,
		podName,
		container,
		{ tailLines: APP_LOG_LINES_DEFAULT, limitBytes: APP_LOG_BYTES_MAX, previous: false },
		context
	);

	return {
		records: parseRunnerRecords(log),
		job,
		pod: podName,
		container,
		logRef: { job: label, pod: podName, container, previous: false }
	};
}

/* ------------------------------------------------------------------------- *
 * Small helpers
 * ------------------------------------------------------------------------- */

function asNumber(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function instantOf(instant: unknown): string | null {
	if (typeof instant !== 'string' || !instant.trim()) {
		return null;
	}
	const millis = Date.parse(instant);
	return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

function createdMillis(job: AppLiveJob | null | undefined): number {
	const millis = Date.parse(String(job?.metadata?.creationTimestamp ?? ''));
	return Number.isFinite(millis) ? millis : 0;
}

/** The newest Job of a list: by `creationTimestamp`, ties broken by name so a read is replayable. */
export function newestJob(jobs: readonly AppLiveJob[]): AppLiveJob | null {
	if (jobs.length === 0) {
		return null;
	}
	return [...jobs].sort((left, right) => {
		const byTime = createdMillis(right) - createdMillis(left);
		return byTime !== 0
			? byTime
			: String(right?.metadata?.name ?? '').localeCompare(String(left?.metadata?.name ?? ''));
	})[0];
}

function podCreatedMillis(pod: AppLivePod | null | undefined): number {
	const millis = Date.parse(String(pod?.metadata?.creationTimestamp ?? ''));
	return Number.isFinite(millis) ? millis : 0;
}

/** The newest pod of a list, ties broken by name — a Job's pod is the one that reports. */
export function newestPod(pods: readonly AppLivePod[]): AppLivePod | null {
	if (pods.length === 0) {
		return null;
	}
	return [...pods].sort((left, right) => {
		const byTime = podCreatedMillis(right) - podCreatedMillis(left);
		return byTime !== 0
			? byTime
			: String(right?.metadata?.name ?? '').localeCompare(String(left?.metadata?.name ?? ''));
	})[0];
}

/**
 * §4.8's verdict from a Job's observed status. `running` means "not finished yet" — the same
 * reading T12's private `jobVerdict` takes, which is why a status read and a deploy agree on what a
 * half-done Job looks like.
 */
export function jobStatusOf(job: AppLiveJob | null | undefined): JobStatus {
	const status = job?.status ?? {};
	const conditions = status.conditions ?? [];
	if (
		conditions.some((condition) => condition?.type === 'Complete' && condition?.status === 'True') ||
		asNumber(status.succeeded) > 0
	) {
		return 'succeeded';
	}
	const failed = conditions.find((condition) => condition?.type === 'Failed' && condition?.status === 'True');
	if (failed) {
		return failed.reason === 'DeadlineExceeded' ? 'timeout' : 'failed';
	}
	if (asNumber(status.failed) > 0) {
		return 'failed';
	}
	return 'running';
}

/** The terminated container's exit code, when a pod reports one. */
function exitCodeOf(pod: AppLivePod | null | undefined, containerName: string): number | undefined {
	for (const container of pod?.status?.containerStatuses ?? []) {
		if (containerName && container?.name !== containerName) {
			continue;
		}
		const terminated = container?.state?.terminated ?? container?.lastState?.terminated ?? null;
		if (typeof terminated?.exitCode === 'number') {
			return terminated.exitCode;
		}
	}
	return undefined;
}

/**
 * The restart/termination summary of one component's pods — FR-46's *restarts of current pods* and
 * *last out-of-memory kill in the last 24 hours*.
 *
 * `oomKilledAt` is the **newest** `OOMKilled` termination that happened inside
 * {@link APP_OOM_WINDOW_HOURS}; an older one is reported as `null`, which is what FR-46 asks for
 * ("last out-of-memory kill in the last 24 hours"). The window is measured against the caller's
 * clock, never a second one.
 */
export function componentPodSummary(
	pods: readonly AppLivePod[],
	now: number
): { restarts: number; reason?: string; oomKilledAt: string | null } {
	let restarts = 0;
	let reason: string | undefined;
	let newestOom: number | null = null;

	for (const pod of pods) {
		for (const container of pod?.status?.containerStatuses ?? []) {
			restarts += asNumber(container?.restartCount);
			const terminated = container?.lastState?.terminated ?? container?.state?.terminated ?? null;
			if (terminated?.reason) {
				reason = terminated.reason;
			}
			if (terminated?.reason !== 'OOMKilled') {
				continue;
			}
			const finished = Date.parse(String(terminated?.finishedAt ?? ''));
			if (Number.isFinite(finished) && (newestOom === null || finished > newestOom)) {
				newestOom = finished;
			}
		}
	}

	const windowMs = APP_OOM_WINDOW_HOURS * 60 * 60 * 1_000;
	const withinWindow = newestOom !== null && now - newestOom <= windowMs;

	return {
		restarts,
		...(reason ? { reason } : {}),
		oomKilledAt: withinWindow && newestOom !== null ? new Date(newestOom).toISOString() : null
	};
}

/** The Ingress' observed address, or `null` while the controller has not published one yet. */
export function ingressAddressOf(
	ingress: AppLiveIngress | null | undefined
): { ip?: string; hostname?: string } | null {
	const first = ingress?.status?.loadBalancer?.ingress?.[0];
	const address: { ip?: string; hostname?: string } = {};
	if (typeof first?.ip === 'string' && first.ip) {
		address.ip = first.ip;
	}
	if (typeof first?.hostname === 'string' && first.hostname) {
		address.hostname = first.hostname;
	}
	return Object.keys(address).length > 0 ? address : null;
}

/* ------------------------------------------------------------------------- *
 * The reader
 * ------------------------------------------------------------------------- */

/** Everything a status read needs that is not already in the contract §3.1 fixes. */
export interface AppStatusReaderOptions {
	/** Epoch milliseconds. Defaults to `Date.now`; the spec injects a virtual clock. */
	now?: () => number;
}

/**
 * `getAppStatus` (FR-46, ACC-06-31) — one observation of a live App Work, assembled from the Work's
 * own namespace.
 *
 * The reader holds no state between calls: two reads of an unchanged cluster resolve to the same
 * snapshot, which is what makes `status-refresh` replayable and what FR-46's "Refresh is allowed
 * once per 15 seconds" rate-limits rather than de-duplicates.
 */
export class AppStatusReader {
	constructor(
		private readonly api: AppStatusApi,
		private readonly options: AppStatusReaderOptions = {}
	) {}

	/**
	 * `IDeploymentPlugin.getAppStatus`'s exact signature: the ref, the **credential** (the guarded
	 * kubeconfig §6.1 produced) and the spec of what to observe.
	 */
	async getAppStatus(ref: AppTargetRef, credential: string, spec: AppStatusSpec): Promise<AppStatusSnapshot> {
		// §6.1 first, always: a kubeconfig shape App Works refuse must fail before the first read.
		assertSupportedKubeconfig(credential, ref?.kubeContext ?? undefined);

		const context = ref?.kubeContext ?? undefined;
		const namespace = String(ref?.namespace ?? '');
		const observedAt = new Date(this.now()).toISOString();

		const namespaceObject = await this.api.readObject<AppLiveNamespace>(
			credential,
			'v1',
			'Namespace',
			'',
			namespace,
			context
		);
		const verification = namespaceObject?.metadata?.labels?.[APP_LABEL_PURPOSE] === APP_VERIFICATION_PURPOSE;

		const components = await this.readComponents(credential, ref, spec, context);
		const jobs = await this.readJobs(credential, namespace, spec, context);
		const smoke = await this.readSmoke(credential, namespace, context);
		const isolationEnforced = await this.readIsolationEnforced(credential, namespace, context);

		if (verification) {
			// §4.12: "getAppStatus for a verification ref returns components, jobs and smoke only".
			return {
				observedAt,
				components,
				jobs,
				cron: [],
				...(smoke ? { smoke } : {}),
				isolationEnforced
			};
		}

		const cron = await this.readCron(credential, namespace, spec, context);
		const ingressAddress = await this.readIngressAddress(credential, ref, spec, context);

		return {
			observedAt,
			components,
			jobs,
			cron,
			...(smoke ? { smoke } : {}),
			isolationEnforced,
			ingressAddress
		};
	}

	/** FR-46: per component, ready/desired replicas, restarts, the last termination and the last OOM. */
	private async readComponents(
		credential: string,
		ref: AppTargetRef,
		spec: AppStatusSpec,
		context?: string
	): Promise<AppComponentStatus[]> {
		const statuses: AppComponentStatus[] = [];
		const now = this.now();

		for (const entry of spec?.components ?? []) {
			const objectName = componentObjectName(entry?.name ?? '');
			const deployment = await this.api.readObject<AppLiveDeployment>(
				credential,
				'apps/v1',
				'Deployment',
				ref.namespace,
				objectName,
				context
			);
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

			const summary = componentPodSummary(pods, now);
			// The live Deployment's own `spec.replicas` is the desired count when there is one — the
			// same reading T12's `observe()` takes, so a status read and a Deployment's result agree —
			// and the declared count from the spec is the fallback for a component with no Deployment
			// (never deployed, or scaled away).
			const desired = deployment?.spec?.replicas ?? entry?.replicas ?? 0;

			statuses.push({
				name: String(entry?.name ?? objectName),
				role: entry?.role === 'worker' ? 'worker' : 'web',
				desired: asNumber(desired),
				ready: asNumber(deployment?.status?.readyReplicas),
				restarts: summary.restarts,
				...(summary.reason ? { lastTerminationReason: summary.reason } : {}),
				oomKilledAt: summary.oomKilledAt
			});
		}

		return statuses;
	}

	/** FR-46: each job's last result, from the newest Job carrying that job's §4.1 label. */
	private async readJobs(
		credential: string,
		namespace: string,
		spec: AppStatusSpec,
		context?: string
	): Promise<Array<{ name: string; last?: AppJobResult }>> {
		const results: Array<{ name: string; last?: AppJobResult }> = [];

		for (const name of spec?.jobs ?? []) {
			const label = String(name ?? '');
			const jobs = await this.api.listObjects<AppLiveJob>(
				credential,
				'batch/v1',
				'Job',
				namespace,
				`${APP_LABEL_JOB}=${label}`,
				context
			);
			const job = newestJob(jobs);
			results.push(
				job
					? { name: label, last: await this.jobResult(credential, namespace, label, job, context) }
					: { name: label }
			);
		}

		return results;
	}

	/**
	 * One Job as `AppJobResult`.
	 *
	 * The phase (`when`) is **not** recoverable from the object: §4.8's renderer stamps a Job with
	 * `ever-works.io/job=<name>` and no phase label, and `AppStatusSpec.jobs` — the contract §3.1 —
	 * carries names only. A status read therefore reports the neutral `post-deploy` rather than
	 * inventing a phase; the phase of a historical run is the Deployment row's (`appRender.jobResults`),
	 * which is where the platform keeps it.
	 */
	private async jobResult(
		credential: string,
		namespace: string,
		name: string,
		job: AppLiveJob,
		context?: string
	): Promise<AppJobResult> {
		const runName = String(job?.metadata?.name ?? '');
		const pods = await this.api.listObjects<AppLivePod>(
			credential,
			'v1',
			'Pod',
			namespace,
			`${APP_LABEL_JOB}=${name}`,
			context
		);
		const pod = newestPod(pods);
		const podName = String(pod?.metadata?.name ?? '');
		const container = String(pod?.spec?.containers?.[0]?.name ?? '');
		const exitCode = exitCodeOf(pod, container);
		const startedAt =
			instantOf(job?.status?.startTime) ??
			instantOf(job?.metadata?.creationTimestamp) ??
			new Date(this.now()).toISOString();
		const completedAt = instantOf(job?.status?.completionTime);

		return {
			name,
			when: 'post-deploy',
			runName,
			status: jobStatusOf(job),
			startedAt,
			...(completedAt ? { completedAt } : {}),
			...(exitCode !== undefined ? { exitCode } : {}),
			...(podName ? { logRef: { job: name, pod: podName, container, previous: false } } : {})
		};
	}

	/**
	 * FR-46: each scheduled call's last run and result.
	 *
	 * `lastScheduleAt` is the CronJob's own `status.lastScheduleTime` (what the controller scheduled),
	 * `lastSuccessAt` the newest Job of that schedule that succeeded, and `lastResult` a short outcome
	 * label for the newest one — §3.1 names the field without giving it a type, and a label is what a
	 * status table shows.
	 */
	private async readCron(
		credential: string,
		namespace: string,
		spec: AppStatusSpec,
		context?: string
	): Promise<AppStatusSnapshot['cron']> {
		const entries: Array<{
			name: string;
			lastScheduleAt?: string;
			lastSuccessAt?: string;
			lastResult?: string;
		}> = [];

		for (const name of spec?.cron ?? []) {
			const label = String(name ?? '');
			const cronJob = await this.api.readObject<AppLiveCronJob>(
				credential,
				'batch/v1',
				'CronJob',
				namespace,
				cronJobName(label),
				context
			);
			const runs = await this.api.listObjects<AppLiveJob>(
				credential,
				'batch/v1',
				'Job',
				namespace,
				`${APP_LABEL_CRON}=${label}`,
				context
			);
			const newest = newestJob(runs);
			const succeeded = [...runs]
				.filter((run) => jobStatusOf(run) === 'succeeded')
				.map((run) => instantOf(run?.status?.completionTime) ?? instantOf(run?.status?.startTime))
				.filter((instant): instant is string => instant !== null)
				.sort()
				.pop();

			const lastScheduleAt =
				instantOf(cronJob?.status?.lastScheduleTime) ??
				instantOf(cronJob?.status?.lastSuccessfulTime) ??
				undefined;

			entries.push({
				name: label,
				...(lastScheduleAt ? { lastScheduleAt } : {}),
				...(succeeded ? { lastSuccessAt: succeeded } : {}),
				...(newest ? { lastResult: jobStatusOf(newest) } : {})
			});
		}

		return entries;
	}

	/**
	 * FR-46: the latest smoke results. The newest `smoke` runner Job's report is the only place an
	 * in-cluster smoke result exists (§4.8 writes it to stdout, and nothing stores it), so it is read
	 * from that Job's pod. The public half is the platform's (`AppPublicSmokeService`) and is not
	 * re-run here — a status read never dials the app.
	 */
	private async readSmoke(
		credential: string,
		namespace: string,
		context?: string
	): Promise<AppSmokeResult | undefined> {
		const report = await readRunnerReport(this.api, credential, namespace, 'smoke', context);
		if (!report || report.records.length === 0) {
			return undefined;
		}

		return {
			inCluster: report.records.filter((record) => record?.kind !== 'isolation-probe').map(checkResultOf),
			public: [],
			observedAt: new Date(this.now()).toISOString()
		};
	}

	/**
	 * §4.10's enforcement verdict, from the newest `isolation-probe` runner Job: the probe reports
	 * `connected`, and *connected* means the network plugin did **not** enforce the policies. No probe
	 * Job, or a probe that did not report, is `null` — never `true` ("a probe Job that does not report
	 * within its `activeDeadlineSeconds` ⇒ `null` … **never** `true`").
	 */
	private async readIsolationEnforced(
		credential: string,
		namespace: string,
		context?: string
	): Promise<boolean | null> {
		const report = await readRunnerReport(this.api, credential, namespace, 'isolation-probe', context);
		const record = report?.records.find((entry) => entry?.kind === 'isolation-probe');
		if (!record) {
			return null;
		}
		return record.connected !== true;
	}

	/** FR-46's URL: the address the published Ingress earned, from the primary web component's own. */
	private async readIngressAddress(
		credential: string,
		ref: AppTargetRef,
		spec: AppStatusSpec,
		context?: string
	): Promise<{ ip?: string; hostname?: string } | null> {
		const primary = (spec?.components ?? []).find((entry) => entry?.primary === true);
		if (!primary) {
			return null;
		}

		const ingress = await this.api.readObject<AppLiveIngress>(
			credential,
			'networking.k8s.io/v1',
			'Ingress',
			ref.namespace,
			componentObjectName(primary.name),
			context
		);
		return ingressAddressOf(ingress);
	}

	private now(): number {
		return this.options.now ? this.options.now() : Date.now();
	}
}
