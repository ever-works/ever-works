/**
 * T12 — the deploy phase machine and rollback (`app-deployer.ts`, plan §5.5; spec FR-26, FR-29,
 * FR-31, FR-32, FR-33, FR-35; ACC-06-09 … ACC-06-24).
 *
 * The renderers of T4–T9 turn an `AppRenderInput` into manifests. **This file applies them, in the
 * order §5.5 fixes, and unwinds that order when something fails:**
 *
 * ```
 * capture = read live Deployments/CronJobs/Ingress (templates, replicas, hosts)   // before any change
 * prepare → [pre-deploy jobs unless skip] → rollout(all components in parallel)
 *   → [first-deploy jobs if isFirstDeploymentOnCluster] → in-cluster smoke (runner, Host: primary)
 *   → isolation probe → publish(Ingress apply) → hooks.verifyPublic(public + hairpin via runner)
 *   → post-deploy jobs → CronJobs → GC env Secrets/old Jobs → done
 * any failure/cancel/deadline in rollout..publish with capture non-empty
 *   → rollback: re-apply captured templates (image, envFrom secret, replicas) and captured Ingress
 *     hosts, wait with the same deadlines → 'rolled-back' | 'rollback-failed'
 * capture empty (first Deployment) → 'failed'; if policy.scaleFailedFirstDeployToZero → scale to 0
 * ```
 *
 * ## What this file is not
 *
 * It renders **nothing**: every object comes from `planAppRender` (§4.2), `planAppJobs` (§4.8/§4.9)
 * and `renderRunnerJob`/`renderRunnerConfigMap` (§4.8/§4.10). It builds no `AppRenderInput` (§5.6 is
 * T14's), resolves no credential (§6.1/§9.9 are T11/T14's) and runs no public check (the platform's
 * `AppPublicSmokeService` arrives through `hooks.verifyPublic`). It reaches for no global: the
 * `KubernetesApiService` — or any object shaped like the five methods below — and the kubeconfig are
 * constructor/argument inputs, which is what lets `__tests__/app-deployer.spec.ts` drive the whole
 * machine against a fake with no network at all.
 *
 * ## The kubeconfig
 *
 * `deployApp`'s second argument is the **guarded** kubeconfig of §6.1: T11's `pinKubeconfigServer`
 * output, whose `server` is the validated public address and whose certificate is still verified
 * against the published name. This module never calls `KubeConfig.loadFromString` itself; it hands
 * the string to the API service, which does. `assertSupportedKubeconfig` runs once, first, before the
 * first write — the same pure refusal step T11 orders before any resolver or client call, so a
 * kubeconfig shape App Works refuse fails here rather than half-way through a rollout.
 *
 * ## Phases are the contract's
 *
 * `AppDeployPhase` (`packages/plugin/src/contracts/capabilities/app-deployment.types.ts:57`) is the
 * only source of phase names, and `AppDeployResult['outcome']` the only source of terminal states.
 * Two steps of §5.5 have no phase of their own and are therefore reported inside the phase they
 * belong to rather than invented:
 *
 * - **the isolation probe** (§4.10) runs inside `in-cluster-smoke`, immediately after the in-cluster
 *   smoke — both are runner Jobs in the app namespace;
 * - **the GC** (§4.7 last line, §4.8) runs after `cron` and is reported in `done`'s detail.
 *
 * Likewise the smoke, hairpin and probe runs are reported through `smoke` (and `isolationEnforced`)
 * rather than through `jobs[]`, which carries the App spec's own jobs — FR-26's rows 2, 4 and 8.
 *
 * ## Deadlines (FR-26's table, FR-29)
 *
 * Every phase of the table has a deadline; §5.3's per-component rollout deadline is
 * `progressDeadlineSeconds` (T6 — the applied Deployment's own `progressDeadlineSeconds`, §3.1's
 * resolved value when the spec carries one, §5.3's formula otherwise) and the whole Deployment is
 * capped at
 * {@link APP_DEPLOY_DEADLINE_MS} — `maxDuration: 7200` in §5.6.10. The cap is evaluated between
 * phases **and on every poll**, and it ends the Deployment wherever it is reached (FR-29: "reaching
 * it after components changed triggers a rollback").
 *
 * ## Where the clock comes from
 *
 * Every instant is either cluster data or `options.now()`; every wait is `options.sleep(ms)`. The
 * spec injects a virtual clock, so a 2400 s rollout deadline or the 2 h cap costs one test loop
 * instead of two hours, and a run is replayable.
 */
import type {
	AppComponentInput,
	AppComponentStatus,
	AppDeployHooks,
	AppDeployPhase,
	AppDeployResult,
	AppFailureCode,
	AppJobResult,
	AppLogRef,
	AppRenderInput,
	AppSmokeResult,
	AppSmokeRun,
	CheckResult
} from '@ever-works/plugin';

import type { KubernetesApiService, PodLogOptions } from '../k8s-api.service.js';
import { scrubError } from '../errors.js';
import { assertSupportedKubeconfig } from './app-kubeconfig.guard.js';
import {
	APP_ENV_SECRET_PREFIX,
	APP_LABEL_COMPONENT,
	APP_LABEL_JOB,
	APP_LABEL_WORK_ID,
	APP_PLATFORM_CONFIGMAP_PREFIX,
	componentObjectName
} from './app-names.js';
import {
	planAppRender,
	primaryWebComponent,
	progressDeadlineSeconds,
	type AppRenderOptions,
	type AppRenderPlan,
	type AppRenderedObject
} from './app-manifest.renderer.js';
import {
	APP_JOB_RUNS_KEPT,
	APP_RUNNER_CONTAINER_NAME,
	APP_RUNNER_DEADLINE_EXTRA_S,
	APP_RUNNER_WINDOW_S,
	planAppJobs,
	renderRunnerConfigMap,
	renderRunnerJob,
	runnerRunName,
	smokeChecksFor,
	type AppJobOptions,
	type AppJobPlanEntry,
	type AppRunnerJobKind
} from './app-jobs.renderer.js';
import {
	classifyPodFailure,
	isComponentRolledOut,
	type AppRolloutComponent,
	type AppRolloutDeployment,
	type AppRolloutPod,
	type AppRolloutReplicaSet,
	type Instant
} from './app-rollout.js';
import type { AppRunnerRecord } from './app-runner.script.js';

/* ------------------------------------------------------------------------- *
 * Constants
 * ------------------------------------------------------------------------- */

/** FR-29 / §5.6.10 (`maxDuration: 7200`): the whole Deployment's hard limit, in milliseconds. */
export const APP_DEPLOY_DEADLINE_MS = 7_200_000;
/** §5.4's `APP_ROLLOUT_POLL_S` — the interval between two observations of a rollout. */
export const APP_DEPLOY_POLL_MS = 5_000;
/** FR-26 #1: the prepare phase's budget. */
export const APP_PREPARE_DEADLINE_MS = 120_000;
/** FR-26 #6: the publish phase's budget (the Ingress apply and the address it earns). */
export const APP_PUBLISH_DEADLINE_MS = 60_000;
/** FR-26 #9: the CronJob phase's budget. */
export const APP_CRON_DEADLINE_MS = 60_000;
/** FR-26 #7: the public smoke window on the first publish … */
export const APP_PUBLIC_SMOKE_WINDOW_S = 600;
/** … and on every later one. */
export const APP_PUBLIC_SMOKE_WINDOW_LATER_S = 180;
/** §4.10: a probe Job that does not report in time is `null` + this warning, **never** `true`. */
export const APP_ISOLATION_PROBE_INCONCLUSIVE = 'isolation_probe_inconclusive';
/** §4.11: the hairpin run's failure is this warning, never a rollback. */
export const APP_HAIRPIN_UNREACHABLE = 'hairpin_unreachable';
/** §4.2 step 3: a 403 on `ew-defaults` on `your-cluster` is skipped with this warning. */
export const APP_LIMITRANGE_FORBIDDEN = 'limitrange_forbidden';

/** The `reason` a `lastState.terminated` carries when the kernel killed the container (§5.4). */
const OOM_KILLED = 'OOMKilled';
/** A Job's own timeout when the rendered object carries none — §4.8's `600` s default. */
const JOB_TIMEOUT_FALLBACK_S = 600;
/** Slack added to a rendered `activeDeadlineSeconds` before the poll gives up on the Job. */
const JOB_TIMEOUT_SLACK_S = 30;

/* ------------------------------------------------------------------------- *
 * The port over the API service
 * ------------------------------------------------------------------------- */

/**
 * The five methods this machine needs, structurally a subset of `KubernetesApiService` (T10) — so
 * the plugin passes its service instance straight in, and the spec passes a fake. The kubeconfig is
 * the first argument of every call, exactly as the service declares it: nothing here is a global.
 */
export interface AppDeployerApi {
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
 * A compile-time proof that the real service is drivable through {@link AppDeployerApi}: if
 * `KubernetesApiService` ever stops satisfying the port, `pnpm type-check` fails here rather than at
 * a call site in the worker.
 */
type AssertTrue<T extends true> = T;
export type KubernetesApiServiceSatisfiesPort = AssertTrue<KubernetesApiService extends AppDeployerApi ? true : false>;

/* ------------------------------------------------------------------------- *
 * Inputs
 * ------------------------------------------------------------------------- */

/**
 * Everything about a run that is not already in the `AppRenderInput` §3.1 fixes.
 *
 * Every entry is *data*: the render options §4.11/§4.12 read (`defaultIngressClass`, `urlScheme`,
 * the verification expiry instant), the injected clock, and the two facts the platform knows and
 * this module cannot derive (the interval between polls, and the reason recorded with a cancel —
 * `AppDeployHooks.isCancelled()` answers "yes/no", not "why").
 */
export interface AppDeployerOptions {
	/** Passed to `planAppRender`/`planAppJobs` verbatim (§5.6 builds them; T14). */
	render?: AppRenderOptions;
	/** Epoch milliseconds. Defaults to `Date.now`; the spec injects a virtual clock. */
	now?: () => number;
	/** The only way this module waits. Defaults to `setTimeout`; the spec injects a virtual clock. */
	sleep?: (millis: number) => Promise<void>;
	/** §5.4's poll interval. Defaults to {@link APP_DEPLOY_POLL_MS}. */
	pollIntervalMs?: number;
	/** FR-29. Defaults to {@link APP_DEPLOY_DEADLINE_MS}. */
	overallDeadlineMs?: number;
	/** FR-26 #1. Defaults to {@link APP_PREPARE_DEADLINE_MS}. */
	prepareDeadlineMs?: number;
	/** FR-26 #6. Defaults to {@link APP_PUBLISH_DEADLINE_MS}. */
	publishDeadlineMs?: number;
	/** FR-26 #9. Defaults to {@link APP_CRON_DEADLINE_MS}. */
	cronDeadlineMs?: number;
	/** FR-26 #5's in-cluster window. Defaults to {@link APP_RUNNER_WINDOW_S} (120 s). */
	smokeWindowSeconds?: number;
	/** §5.4's crash-loop threshold, forwarded to the classifier. */
	restartsToFail?: number;
	/** §5.4's stuck-container window, forwarded to the classifier. */
	stuckPodSeconds?: number;
	/** §5.4's worker stability window, forwarded to the classifier. */
	workerStableSeconds?: number;
	/** §3.1: recorded beside a cancel — the hook says *that* it was cancelled, not *why*. */
	cancelReason?: 'user' | 'quarantined' | 'app_work_deleting';
}

/** §5.5's `capture`, taken before any change: what a rollback restores. */
export interface AppDeployCapture {
	/** Every live component Deployment, verbatim (image, `envFrom`, replicas, annotations). */
	deployments: AppRenderedObject[];
	/** The live Ingress, when one is published — its rules are the hosts a rollback restores. */
	ingress: AppRenderedObject | null;
	/** The live CronJobs. Captured for the record; §5.5's rollback restores templates and hosts only. */
	cronJobs: AppRenderedObject[];
	/** `true` when no component Deployment existed: a first Deployment on this cluster. */
	empty: boolean;
}

/** A warning a caller shows beside the outcome — `AppDeployResult['warnings']`. */
export interface AppDeployWarning {
	code: string;
	message: string;
}

/* ------------------------------------------------------------------------- *
 * Internal shapes
 * ------------------------------------------------------------------------- */

/** One component under observation: its resolved input and the object all its workloads share. */
interface ComponentDescriptor {
	objectName: string;
	component: AppComponentInput | null;
}

interface Observation extends ComponentDescriptor {
	deployment: AppRolloutDeployment | null;
	replicaSets: AppRolloutReplicaSet[];
	pods: AppRolloutPod[];
}

/** A phase failure: `AppDeployResult['failure']` minus the outcome-dependent parts. */
type PhaseFailure = NonNullable<AppDeployResult['failure']>;

/** What one walk of §5.5's sequence produced. */
type Walk = { kind: 'ok' } | { kind: 'failure'; failure: PhaseFailure } | { kind: 'cancelled' };

/** Why a wait stopped short of its verdict. */
type WaitStop = 'ok' | 'cancelled' | 'overran';

/** The whole mutable state of one `deployApp` run. */
interface RunState {
	input: AppRenderInput;
	kubeconfig: string;
	context: string | undefined;
	namespace: string;
	workId: string;
	verification: boolean;
	hooks: AppDeployHooks;
	startedAt: number;
	phase: AppDeployPhase;
	/** Whether a component Deployment has been written — FR-31's "before/after components change". */
	changed: boolean;
	warnings: AppDeployWarning[];
	/** `true` once a warning that downgrades the outcome (not a render warning) was recorded. */
	downgraded: boolean;
	jobs: AppJobResult[];
	inCluster: CheckResult[];
	publicChecks: CheckResult[];
	hairpin: CheckResult | null;
	isolationEnforced: boolean | null;
	firstDeployJobsCompleted: boolean;
	ingressAddress: { ip?: string; hostname?: string } | null;
	/** The Ingress this run published, so a rollback with no capture can take it back down. */
	publishedIngress: AppRenderedObject | null;
	/** Every component Deployment this run applied — the objects `scaleFailedFirstDeployToZero` scales. */
	appliedDeployments: AppRenderedObject[];
	/** First observation of each `<pod>/<container>` waiting reason (plan §5.4's 180 s window). */
	podWaitingSince: Record<string, Instant>;
	/** The last observation of every component, for `components[]` in the result. */
	lastObservation: Observation[];
	/** The GC's outcome, reported in `done`'s detail. */
	gc: { secretsDeleted: number; configMapsDeleted: number; jobsDeleted: number; errors: string[] } | null;
}

/* ------------------------------------------------------------------------- *
 * Small pure helpers
 * ------------------------------------------------------------------------- */

/** A scrubbed, one-line message — the plugin never surfaces a raw client error (T10's scrubber). */
function messageOf(err: unknown): string {
	return scrubError(err).message;
}

/**
 * The only code §3.1 offers for "we could not write to the cluster": a prepare, rollout or CronJob
 * apply failure is none of a rollout, a job or a publish, so the codes that name those are wrong and
 * `cluster_unreachable` is the honest one. The scrubbed reason travels in `message`.
 */
function applyFailureCode(): AppFailureCode {
	return 'cluster_unreachable';
}

/**
 * A captured object stripped of everything the API server owns, ready for Server-Side Apply: the
 * `status` (§5.5 restores templates, not observations) and the volatile metadata. Labels and
 * annotations stay — they are part of "the exact workload definition that was running" (FR-33).
 */
function cleanForApply(object: AppRenderedObject): AppRenderedObject {
	const metadata = (object.metadata ?? {}) as Record<string, unknown>;
	const clean: AppRenderedObject = {
		...object,
		metadata: {
			name: String(metadata.name ?? ''),
			...(metadata.namespace !== undefined ? { namespace: String(metadata.namespace) } : {}),
			...(metadata.labels !== undefined ? { labels: metadata.labels as Record<string, string> } : {}),
			...(metadata.annotations !== undefined
				? { annotations: metadata.annotations as Record<string, string> }
				: {})
		}
	};
	delete (clean as Record<string, unknown>).status;
	return clean;
}

/** `ever-works.io/work-id=<id>` — every object this machine touches carries it (§4.1). */
function workSelector(workId: string): string {
	return `${APP_LABEL_WORK_ID}=${workId}`;
}

/** The four prepare-phase kinds, in §4.2's order, versus the two the later phases own. */
function isPrepareObject(object: AppRenderedObject): boolean {
	return object.kind !== 'Deployment' && object.kind !== 'Ingress';
}

/** The objects of one job-plan entry: its runner ConfigMap first, then the Job that mounts it. */
function objectsForEntries(
	plan: { objects: AppRenderedObject[] },
	entries: readonly AppJobPlanEntry[]
): AppRenderedObject[] {
	const byName = new Map(plan.objects.map((object) => [object.metadata.name, object]));
	const objects: AppRenderedObject[] = [];
	for (const entry of entries) {
		if (entry.configMapName) {
			const configMap = byName.get(entry.configMapName);
			if (configMap) {
				objects.push(configMap);
			}
		}
		const object = byName.get(entry.objectName);
		if (object) {
			objects.push(object);
		}
	}
	return objects;
}

/** The hosts a Deployment publishes (§4.11: primary ∪ extra ∪ previous, de-duplicated, in order). */
function publishedHosts(input: AppRenderInput): string[] {
	const declared = [input?.hosts?.primary, ...(input?.hosts?.extra ?? []), ...(input?.hosts?.previous ?? [])];
	const hosts: string[] = [];
	for (const host of declared) {
		const value = typeof host === 'string' ? host.trim() : '';
		if (value && !hosts.includes(value)) {
			hosts.push(value);
		}
	}
	return hosts;
}

/** The Ingress' observed address, or `null` while the controller has not published one yet. */
function ingressAddressOf(ingress: unknown): { ip?: string; hostname?: string } | null {
	const entries = (
		ingress as { status?: { loadBalancer?: { ingress?: Array<{ ip?: string; hostname?: string }> } } } | null
	)?.status?.loadBalancer?.ingress;
	const first = Array.isArray(entries) ? entries[0] : undefined;
	if (!first) {
		return null;
	}
	const address: { ip?: string; hostname?: string } = {};
	if (typeof first.ip === 'string' && first.ip) {
		address.ip = first.ip;
	}
	if (typeof first.hostname === 'string' && first.hostname) {
		address.hostname = first.hostname;
	}
	return Object.keys(address).length > 0 ? address : null;
}

/** §5.4's "for ≥ 180 s" needs a first observation; this is where the deployer records it. */
function recordWaitingSince(observation: Observation, since: Record<string, Instant>, now: number): void {
	for (const pod of observation.pods) {
		const podName = String(pod?.metadata?.name ?? '');
		for (const container of pod?.status?.containerStatuses ?? []) {
			if (!container?.state?.waiting) {
				continue;
			}
			const key = `${podName}/${String(container.name ?? '')}`;
			if (since[key] === undefined) {
				since[key] = now;
			}
		}
	}
}

/** The observed `status` of a Job or CronJob — the two fields §4.8's verdicts read. */
interface JobLike {
	metadata?: { name?: string; creationTimestamp?: Instant | null } | null;
	status?: {
		succeeded?: number;
		failed?: number;
		active?: number;
		startTime?: Instant | null;
		completionTime?: Instant | null;
		conditions?: Array<{ type?: string; status?: string; reason?: string; message?: string }> | null;
	} | null;
}

/** What a Job's observed status proves. `running` means "keep polling". */
function jobVerdict(job: JobLike | null, appliedAt: number, timeoutMs: number, now: number): AppJobResult['status'] {
	const status = job?.status ?? {};
	const conditions = status.conditions ?? [];
	const complete = conditions.some((condition) => condition?.type === 'Complete' && condition?.status === 'True');
	const failedCondition = conditions.find(
		(condition) => condition?.type === 'Failed' && condition?.status === 'True'
	);

	if (complete || (typeof status.succeeded === 'number' && status.succeeded > 0)) {
		return 'succeeded';
	}
	if (failedCondition) {
		return failedCondition.reason === 'DeadlineExceeded' ? 'timeout' : 'failed';
	}
	if (typeof status.failed === 'number' && status.failed > 0) {
		return 'failed';
	}
	return now - appliedAt >= timeoutMs ? 'timeout' : 'running';
}

/** One `AppRunnerRecord` as the `CheckResult` §3.1 declares — never more than 200 found characters. */
function checkResultOf(record: AppRunnerRecord): CheckResult {
	return {
		name: String(record?.name ?? ''),
		status: record?.ok === true ? 'passed' : 'failed',
		...(typeof record?.status === 'number' ? { httpStatus: record.status } : {}),
		...(typeof record?.latencyMs === 'number' ? { latencyMs: record.latencyMs } : {}),
		...(record?.failedExpectation ? { failedExpectation: String(record.failedExpectation) } : {}),
		...(record?.found ? { found: String(record.found).slice(0, 200) } : {})
	};
}

/**
 * The runner's report: one JSON object per line on stdout (§4.8). A line that does not parse is not
 * a record — the runner writes nothing else, so a malformed line is a runner bug, and inventing a
 * result for it would be worse than reporting none.
 */
function parseRunnerRecords(log: string | null | undefined): AppRunnerRecord[] {
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

/** The restart/termination summary of one component's pods, for the `components[]` report. */
function podRestarts(pods: readonly AppRolloutPod[]): {
	restarts: number;
	reason?: string;
	oomKilledAt: string | null;
} {
	let restarts = 0;
	let reason: string | undefined;
	let oomKilledAt: string | null = null;

	for (const pod of pods) {
		for (const container of pod?.status?.containerStatuses ?? []) {
			restarts += typeof container?.restartCount === 'number' ? container.restartCount : 0;
			const terminated = container?.lastState?.terminated ?? container?.state?.terminated;
			if (terminated?.reason) {
				reason = terminated.reason;
			}
			if (terminated?.reason === OOM_KILLED && terminated.finishedAt) {
				const millis = Date.parse(String(terminated.finishedAt));
				oomKilledAt = Number.isFinite(millis) ? new Date(millis).toISOString() : null;
			}
		}
	}

	return { restarts, ...(reason ? { reason } : {}), oomKilledAt };
}

/** Every `envFrom` reference of a rendered pod template — what the GC must not delete (§4.7). */
function envReferencesOf(replicaSet: AppRolloutReplicaSet): string[] {
	const template = replicaSet?.spec?.template as
		| {
				spec?: {
					containers?: Array<{
						envFrom?: Array<{ secretRef?: { name?: string }; configMapRef?: { name?: string } }>;
					}>;
				};
		  }
		| undefined;
	const references: string[] = [];
	for (const container of template?.spec?.containers ?? []) {
		for (const reference of container?.envFrom ?? []) {
			const secret = reference?.secretRef?.name;
			const configMap = reference?.configMapRef?.name;
			if (secret) {
				references.push(secret);
			}
			if (configMap) {
				references.push(configMap);
			}
		}
	}
	return references;
}

/**
 * §4.8's "the last 3 Jobs per job name are kept": everything older than the newest
 * {@link APP_JOB_RUNS_KEPT} of its own name. Jobs are grouped by the `ever-works.io/job` label every
 * rendered Job carries (§4.1), so a manual `run-<name>-<short>` run and the Deployment's own
 * `job-<name>-<deploymentShort>` share one group.
 */
function jobsBeyondKeep(jobs: readonly AppRenderedObject[]): AppRenderedObject[] {
	const groups = new Map<string, AppRenderedObject[]>();

	for (const job of jobs) {
		const labels = (job.metadata.labels ?? {}) as Record<string, string>;
		const name = labels[APP_LABEL_JOB] || String(job.metadata.name ?? '');
		const group = groups.get(name) ?? [];
		group.push(job);
		groups.set(name, group);
	}

	const doomed: AppRenderedObject[] = [];
	for (const group of groups.values()) {
		group
			.slice()
			.sort((left, right) => creationOf(right) - creationOf(left))
			.slice(APP_JOB_RUNS_KEPT)
			.forEach((job) => doomed.push(job));
	}
	return doomed;
}

function creationOf(object: AppRenderedObject): number {
	const created = Date.parse(String((object.metadata as { creationTimestamp?: string }).creationTimestamp ?? ''));
	return Number.isFinite(created) ? created : 0;
}

/* ------------------------------------------------------------------------- *
 * The machine
 * ------------------------------------------------------------------------- */

export class AppDeployer {
	constructor(
		private readonly api: AppDeployerApi,
		private readonly options: AppDeployerOptions = {}
	) {}

	/**
	 * `IDeploymentPlugin.deployApp`'s exact signature (`deployment.interface.ts:285`): the render
	 * input of §3.1, the **credential** (the guarded kubeconfig §6.1 produced) and the platform's
	 * hooks. Resolves to an `AppDeployResult` whose `outcome` is the run's terminal state — a
	 * `rolled-back` Deployment succeeded at rolling back.
	 */
	async deployApp(input: AppRenderInput, credential: string, hooks: AppDeployHooks): Promise<AppDeployResult> {
		// §6.1 first, always: a kubeconfig shape App Works refuse must fail before the first write,
		// exactly as T11's guard refuses it before any resolver call. Pure — no I/O, no client.
		assertSupportedKubeconfig(credential, input?.ref?.kubeContext ?? undefined);

		const state = this.newState(input, credential, hooks);
		const plan = planAppRender(input, this.renderOptions());

		// The very first cancel check: "cancel before anything changed" must not read or write.
		if (await this.cancelled(state)) {
			return this.cancelledResult(state);
		}

		const capture = state.verification ? this.emptyCapture() : await this.capture(state);
		const walk = await this.runPhases(state, plan);

		if (walk.kind === 'cancelled') {
			if (!state.changed) {
				// FR-31: "before components change it ends Cancelled".
				return this.cancelledResult(state);
			}
			// FR-31: "after, the previous version is restored and it ends Rolled back (cancelled)".
			// §5.5 requires a non-empty capture to have anything to restore; with an empty one (a
			// cancelled first Deployment) there is nothing to roll back to, so the run ends
			// `cancelled` and FR-32's handling of an unpublished first Deployment applies.
			if (capture.empty) {
				return this.failedResult(state, null, this.cancelReason());
			}
			return this.rollback(state, capture, null, this.cancelReason());
		}

		if (walk.kind === 'failure') {
			if (!state.changed) {
				// FR-26 #1/#2: "Failed; running app untouched" — no component was written, so there is
				// nothing to unwind and nothing to scale down.
				return this.successResult(state, 'failed', walk.failure);
			}
			if (capture.empty) {
				// §5.5: "capture empty (first Deployment) → 'failed'".
				return this.failedResult(state, walk.failure);
			}
			return this.rollback(state, capture, walk.failure);
		}

		return this.successResult(state, state.downgraded ? 'succeeded-with-warnings' : 'succeeded');
	}

	/* --------------------------------------------------------------------- *
	 * State
	 * --------------------------------------------------------------------- */

	private newState(input: AppRenderInput, kubeconfig: string, hooks: AppDeployHooks): RunState {
		return {
			input,
			kubeconfig,
			context: input?.ref?.kubeContext ?? undefined,
			namespace: String(input?.ref?.namespace ?? ''),
			workId: String(input?.ref?.workId ?? ''),
			verification: input?.purpose === 'verification',
			hooks,
			startedAt: this.now(),
			phase: 'prepare',
			changed: false,
			warnings: [],
			downgraded: false,
			jobs: [],
			inCluster: [],
			publicChecks: [],
			hairpin: null,
			isolationEnforced: null,
			firstDeployJobsCompleted: false,
			ingressAddress: null,
			publishedIngress: null,
			appliedDeployments: [],
			podWaitingSince: {},
			lastObservation: [],
			gc: null
		};
	}

	private cancelReason(): 'user' | 'quarantined' | 'app_work_deleting' {
		return this.options.cancelReason ?? 'user';
	}

	private emptyCapture(): AppDeployCapture {
		return { deployments: [], ingress: null, cronJobs: [], empty: true };
	}

	private now(): number {
		return this.options.now ? this.options.now() : Date.now();
	}

	private async sleep(millis: number): Promise<void> {
		if (this.options.sleep) {
			await this.options.sleep(millis);
			return;
		}
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, millis);
			(timer as { unref?: () => void }).unref?.();
		});
	}

	private renderOptions(): AppRenderOptions {
		return this.options.render ?? {};
	}

	private pollIntervalMs(): number {
		const declared = this.options.pollIntervalMs;
		return typeof declared === 'number' && Number.isFinite(declared) && declared > 0
			? declared
			: APP_DEPLOY_POLL_MS;
	}

	private deadlineOr(declared: number | undefined, fallback: number): number {
		return typeof declared === 'number' && Number.isFinite(declared) && declared > 0 ? declared : fallback;
	}

	private overallDeadlineMs(): number {
		return this.deadlineOr(this.options.overallDeadlineMs, APP_DEPLOY_DEADLINE_MS);
	}

	/** FR-29: has the whole Deployment overrun its cap? */
	private overran(state: RunState): boolean {
		return this.now() - state.startedAt >= this.overallDeadlineMs();
	}

	private overrunFailure(state: RunState): PhaseFailure {
		const minutes = Math.round(this.overallDeadlineMs() / 60_000);
		return {
			phase: state.phase,
			code: 'deadline_exceeded',
			message: `The Deployment reached its ${minutes} minute limit during the '${state.phase}' phase (FR-29).`
		};
	}

	/** §5.6.4: persist the phase (and whatever detail the phase knows) as the Deployment progresses. */
	private async enter(state: RunState, phase: AppDeployPhase, detail?: Record<string, unknown>): Promise<void> {
		state.phase = phase;
		await state.hooks.onPhase(phase, detail);
	}

	/** §5.5: "`hooks.isCancelled()` is checked between phases and every rollout poll". */
	private async cancelled(state: RunState): Promise<boolean> {
		try {
			return (await state.hooks.isCancelled()) === true;
		} catch {
			// A hook that cannot answer is not a cancel: the Deployment continues, and the platform's
			// own lock or quarantine path stops it at the next boundary.
			return false;
		}
	}

	private warn(state: RunState, code: string, message: string, downgrade = true): void {
		state.warnings.push({ code, message });
		if (downgrade) {
			state.downgraded = true;
		}
	}

	/* --------------------------------------------------------------------- *
	 * Capture (§5.5, before any change)
	 * --------------------------------------------------------------------- */

	private async capture(state: RunState): Promise<AppDeployCapture> {
		const deployments: AppRenderedObject[] = [];

		for (const component of state.input?.components ?? []) {
			const name = componentObjectName(component.name);
			const live = await this.api.readObject<AppRenderedObject>(
				state.kubeconfig,
				'apps/v1',
				'Deployment',
				state.namespace,
				name,
				state.context
			);
			if (live) {
				deployments.push(live);
			}
		}

		const primary = primaryWebComponent(state.input);
		const ingress = primary
			? await this.api.readObject<AppRenderedObject>(
					state.kubeconfig,
					'networking.k8s.io/v1',
					'Ingress',
					state.namespace,
					componentObjectName(primary.name),
					state.context
				)
			: null;

		const cronJobs = await this.api.listObjects<AppRenderedObject>(
			state.kubeconfig,
			'batch/v1',
			'CronJob',
			state.namespace,
			workSelector(state.workId),
			state.context
		);

		return { deployments, ingress: ingress ?? null, cronJobs, empty: deployments.length === 0 };
	}

	/* --------------------------------------------------------------------- *
	 * The phase walk (§5.5)
	 * --------------------------------------------------------------------- */

	private async runPhases(state: RunState, plan: AppRenderPlan): Promise<Walk> {
		// ---- 1 · prepare (FR-26 #1, 120 s) ---------------------------------
		await this.enter(state, 'prepare', { objects: plan.objects.length });
		const prepareStartedAt = this.now();
		const prepare = await this.applyAll(state, plan.objects.filter(isPrepareObject));
		if (prepare) {
			return { kind: 'failure', failure: prepare };
		}
		const prepareDeadline = this.deadlineOr(this.options.prepareDeadlineMs, APP_PREPARE_DEADLINE_MS);
		if (this.now() - prepareStartedAt >= prepareDeadline) {
			// FR-26 #1: the phase's own budget. Nothing of the running app was touched — only this
			// Deployment's namespace objects — so the row's "Failed; running app untouched" holds and
			// the walk below ends `failed` (no component was written).
			return {
				kind: 'failure',
				failure: {
					phase: 'prepare',
					code: 'deadline_exceeded',
					message: `Preparing the namespace took longer than the ${Math.round(
						prepareDeadline / 1_000
					)} s of FR-26 #1.`
				}
			};
		}
		if (await this.cancelled(state)) {
			return { kind: 'cancelled' };
		}

		// ---- 2 · pre-deploy jobs, in declared order (FR-26 #2) -------------
		const skipped = state.input?.skipPreDeployJobs === true;
		await this.enter(state, 'pre-deploy-jobs', { skipped });
		if (!skipped) {
			const preDeploy = await this.runJobPhase(state, 'pre-deploy');
			if (preDeploy) {
				return { kind: 'failure', failure: preDeploy };
			}
		}
		if (await this.cancelled(state)) {
			return { kind: 'cancelled' };
		}

		// ---- 3 · components roll out, all in parallel (FR-26 #3) -----------
		await this.enter(state, 'rollout');
		const rollout = await this.rollout(state, plan);
		if (rollout) {
			return { kind: 'failure', failure: rollout };
		}
		if (await this.cancelled(state)) {
			return { kind: 'cancelled' };
		}

		// ---- 4 · first-deploy jobs (FR-26 #4) ------------------------------
		if (state.input?.isFirstDeploymentOnCluster === true) {
			await this.enter(state, 'first-deploy-jobs');
			const firstDeploy = await this.runJobPhase(state, 'first-deploy');
			if (firstDeploy) {
				return { kind: 'failure', failure: firstDeploy };
			}
		}
		// Nothing is outstanding once the phase is behind us: §5.6 stores
		// `firstDeployJobsCompletedAt` from this, and it is never re-derived from a flag.
		state.firstDeployJobsCompleted = true;
		if (await this.cancelled(state)) {
			return { kind: 'cancelled' };
		}

		// ---- 5 · in-cluster smoke, then §4.10's isolation probe -------------
		await this.enter(state, 'in-cluster-smoke');
		const smoke = await this.inClusterSmoke(state);
		if (smoke) {
			return { kind: 'failure', failure: smoke };
		}
		const probe = await this.isolationProbe(state);
		if (probe) {
			return { kind: 'failure', failure: probe };
		}
		if (await this.cancelled(state)) {
			return { kind: 'cancelled' };
		}

		if (!state.verification) {
			// ---- 6 · publish (FR-26 #6, 60 s) ------------------------------
			await this.enter(state, 'publish');
			const publish = await this.publish(state, plan);
			if (publish) {
				return { kind: 'failure', failure: publish };
			}
			if (await this.cancelled(state)) {
				return { kind: 'cancelled' };
			}

			// ---- 7 · public smoke and the hairpin run (FR-26 #7) -----------
			// §4.11: with no Ingress there is nothing published to check — "public smoke skipped",
			// whatever `hosts` the App spec declares, and no self-address check either. The renderer's
			// `no_ingress_controller` warning travels with the plan and is reported beside the outcome.
			const published = this.published(state);
			const urls = published ? this.publicUrls(state) : [];
			if (urls.length > 0 || (published && this.wantsHairpin(state))) {
				await this.enter(state, 'public-smoke', { urls });
				await this.publicSmoke(state, urls);
				await this.hairpin(state);
			}
			if (await this.cancelled(state)) {
				return { kind: 'cancelled' };
			}

			// ---- 8 · post-deploy jobs: "Live with warnings" ----------------
			await this.enter(state, 'post-deploy-jobs');
			await this.runJobPhase(state, 'post-deploy', true);
			if (await this.cancelled(state)) {
				return { kind: 'cancelled' };
			}

			// ---- 9 · scheduled calls (FR-26 #9, 60 s) ----------------------
			await this.enter(state, 'cron');
			await this.runCronPhase(state);
			if (await this.cancelled(state)) {
				return { kind: 'cancelled' };
			}
		}

		// The cap is checked at every phase boundary as well as inside the waits, so a run that
		// spends its budget across phases (FR-29 exists for the sum, not for one phase) still ends.
		if (this.overran(state)) {
			return { kind: 'failure', failure: this.overrunFailure(state) };
		}

		// ---- GC, then done -------------------------------------------------
		await this.gc(state);
		await this.enter(state, 'done', state.gc ? { gc: state.gc } : undefined);
		return { kind: 'ok' };
	}

	/* --------------------------------------------------------------------- *
	 * Applies
	 * --------------------------------------------------------------------- */

	/** One phase's objects, in the renderer's order; a 403 on `ew-defaults` is the one skip. */
	private async applyAll(state: RunState, objects: readonly AppRenderedObject[]): Promise<PhaseFailure | null> {
		for (const object of objects) {
			try {
				await this.api.applyObject(state.kubeconfig, object, state.context);
			} catch (err) {
				const forbidden = scrubError(err).code === 'UNAUTHORIZED';
				if (object.kind === 'LimitRange' && forbidden && state.input?.ref?.target !== 'ever-works-apps') {
					this.warn(
						state,
						APP_LIMITRANGE_FORBIDDEN,
						`Applying LimitRange '${object.metadata.name}' was forbidden; the namespace keeps the cluster's own defaults (plan §4.2 step 3).`
					);
					continue;
				}
				return {
					phase: state.phase,
					code: applyFailureCode(),
					message: `Applying ${object.kind} '${object.metadata.name}' failed: ${messageOf(err)}`
				};
			}
		}
		return null;
	}

	/* --------------------------------------------------------------------- *
	 * Jobs (phases 2, 4, 8)
	 * --------------------------------------------------------------------- */

	/**
	 * One job phase, in declared order. `planAppJobs` also appends the runner runs and the CronJobs;
	 * the former are filtered by `entry.when`, the latter live in `plan.cronJobs`.
	 *
	 * **§5.1 refusals are warnings here, not failures.** A refused `http` job is not rendered at all
	 * by T7 (`requestPayload` returns `null` for an unset `authEnv`), so there is nothing to apply;
	 * FR-24 makes that refusal a *precondition* the platform checks before it calls this machine.
	 * The deployer therefore applies exactly what the renderer drew, reports the refusal with the
	 * renderer's own code, and never invents a failure code for a precondition it does not own.
	 */
	private async runJobPhase(
		state: RunState,
		when: 'pre-deploy' | 'first-deploy' | 'post-deploy',
		warnOnly = false
	): Promise<PhaseFailure | null> {
		const plan = planAppJobs(state.input, { ...this.jobOptions(state), when });
		const entries = plan.jobs.filter((entry) => entry.when === when);

		for (const refusal of plan.refusals.filter((entry) => this.refusalPhase(state, entry) === state.phase)) {
			this.warn(state, refusal.code, refusal.message);
		}

		for (const entry of entries) {
			const failure = await this.applyAll(state, objectsForEntries(plan, [entry]));
			if (failure) {
				if (!warnOnly) {
					return failure;
				}
				this.warn(state, 'job_failed', failure.message);
				return null;
			}

			const waited = await this.waitForJob(state, entry, plan);
			state.jobs.push(waited.result);

			if (waited.stop === 'cancelled') {
				// The walk's own cancel check takes it from here — a cancelled Deployment is not a
				// failed job.
				return null;
			}
			if (waited.stop === 'overran') {
				return null;
			}
			if (waited.result.status !== 'succeeded') {
				const message = jobFailureMessage(entry, waited.result);
				if (!warnOnly) {
					return {
						phase: state.phase,
						code: 'job_failed',
						message,
						...(waited.result.logRef ? { logRef: waited.result.logRef } : {})
					};
				}
				this.warn(state, 'job_failed', message);
				return null;
			}
		}

		return null;
	}

	/** Which §5.5 phase a §5.1 refusal belongs to — its job's `when`, or the CronJob phase. */
	private refusalPhase(state: RunState, refusal: { code: string; names?: string[] }): AppDeployPhase {
		if (refusal.code.startsWith('cron')) {
			return 'cron';
		}
		const name = refusal.names?.[0];
		const job = (state.input?.jobs ?? []).find((entry) => entry.name === name);
		switch (job?.when) {
			case 'pre-deploy':
				return 'pre-deploy-jobs';
			case 'first-deploy':
				return 'first-deploy-jobs';
			default:
				return 'post-deploy-jobs';
		}
	}

	/** Apply every CronJob §4.9 renders; on failure the Deployment stays Live with a warning. */
	private async runCronPhase(state: RunState): Promise<void> {
		const plan = planAppJobs(state.input, this.jobOptions(state));
		const refusals = plan.refusals.filter((refusal) => this.refusalPhase(state, refusal) === 'cron');
		if (refusals.length > 0) {
			// §4.9: a refused entry is never rendered. FR-26 #9: "Live with warnings".
			this.warn(state, refusals[0].code, refusals.map((refusal) => refusal.message).join(' '));
			return;
		}

		const startedAt = this.now();
		for (const entry of plan.cronJobs) {
			const failure = await this.applyAll(state, objectsForEntries(plan, [entry]));
			if (failure) {
				this.warn(state, 'job_failed', failure.message);
			}
		}

		const deadline = this.deadlineOr(this.options.cronDeadlineMs, APP_CRON_DEADLINE_MS);
		if (this.now() - startedAt >= deadline && plan.cronJobs.length > 0) {
			this.warn(
				state,
				'job_failed',
				`Applying ${plan.cronJobs.length} scheduled call(s) took longer than the ${Math.round(
					deadline / 1_000
				)} s of FR-26 #9.`
			);
		}
	}

	/** Apply a Job (and its runner ConfigMap) and wait for its verdict. */
	private async waitForJob(
		state: RunState,
		entry: AppJobPlanEntry,
		plan: { objects: AppRenderedObject[] }
	): Promise<{ result: AppJobResult; stop: WaitStop }> {
		const appliedAt = this.now();
		const name = String(entry.name ?? '');
		const timeoutMs = jobTimeoutMs(plan, entry);
		const startedAt = new Date(appliedAt).toISOString();
		let status: AppJobResult['status'] = 'running';
		let stop: WaitStop = 'ok';

		while (status === 'running') {
			const observed = await this.api.readObject<JobLike>(
				state.kubeconfig,
				'batch/v1',
				'Job',
				state.namespace,
				entry.objectName,
				state.context
			);
			status = jobVerdict(observed, appliedAt, timeoutMs, this.now());
			if (status !== 'running') {
				break;
			}
			if (await this.cancelled(state)) {
				stop = 'cancelled';
				break;
			}
			if (this.overran(state)) {
				stop = 'overran';
				break;
			}
			await this.sleep(this.pollIntervalMs());
		}

		// A runner Job's report is the pod's log (§4.8); a command Job has none.
		const read =
			entry.kind === 'runner' ? await this.readRunnerPod(state, name) : { records: [] as AppRunnerRecord[] };
		const result: AppJobResult = {
			name,
			when: entry.when ?? 'post-deploy',
			runName: entry.objectName,
			status,
			startedAt,
			completedAt: new Date(this.now()).toISOString(),
			...('exitCode' in read && read.exitCode !== undefined ? { exitCode: read.exitCode } : {}),
			...(read.records[0] ? { http: checkResultOf(read.records[0]) } : {}),
			...('logRef' in read && read.logRef ? { logRef: read.logRef } : {})
		};

		return { result, stop };
	}

	/* --------------------------------------------------------------------- *
	 * Rollout (phase 3)
	 * --------------------------------------------------------------------- */

	private async rollout(state: RunState, plan: AppRenderPlan): Promise<PhaseFailure | null> {
		const deployments = plan.objects.filter((object) => object.kind === 'Deployment');

		for (const deployment of deployments) {
			// The first write of a component is what FR-31 calls "components change": from here on a
			// failure or a cancel unwinds instead of ending `failed`.
			state.changed = true;
			try {
				await this.api.applyObject(state.kubeconfig, deployment, state.context);
			} catch (err) {
				return {
					phase: 'rollout',
					code: applyFailureCode(),
					message: `Applying Deployment '${deployment.metadata.name}' failed: ${messageOf(err)}`
				};
			}
			state.appliedDeployments.push(deployment);
		}

		if (deployments.length === 0) {
			return null;
		}

		// §5.5: "rollout(all components in parallel)" — one wait, every component inside it.
		return this.waitForComponents(
			state,
			deployments.map((deployment) => this.descriptorFor(state, deployment.metadata.name))
		);
	}

	/**
	 * §5.4's predicate, polled per component until every one is rolled out. Each component carries
	 * the §5.3 deadline; the run carries FR-29's. A cancel is checked on every poll (§5.5) — except
	 * while a rollback is being waited for, because FR-31's cancel has already been answered by then
	 * and a rollback that stopped half-way would be the one thing worse than a slow one.
	 */
	private async waitForComponents(
		state: RunState,
		descriptors: ComponentDescriptor[],
		options: { cancellable?: boolean } = {}
	): Promise<PhaseFailure | null> {
		const cancellable = options.cancellable !== false;
		const waitStartedAt = this.now();
		const pending = new Map(descriptors.map((descriptor) => [descriptor.objectName, descriptor]));

		while (pending.size > 0) {
			for (const descriptor of [...pending.values()]) {
				const observation = await this.readComponent(state, descriptor);
				recordWaitingSince(observation, state.podWaitingSince, this.now());

				if (
					isComponentRolledOut(
						observation.deployment,
						observation.replicaSets,
						observation.pods,
						this.rolloutOptions(state, descriptor, waitStartedAt)
					)
				) {
					pending.delete(descriptor.objectName);
					continue;
				}

				const failure = classifyPodFailure(
					observation.deployment,
					observation.replicaSets,
					observation.pods,
					this.rolloutOptions(state, descriptor, waitStartedAt)
				);
				if (failure) {
					return {
						phase: state.phase,
						code: failure.code,
						message: rolloutFailureMessage(descriptor.objectName, failure)
					};
				}

				const deadline = progressDeadlineSeconds(descriptor.component ?? {}) * 1_000;
				if (this.now() - waitStartedAt >= deadline) {
					return {
						phase: state.phase,
						code: 'rollout_timeout',
						message: `Component '${descriptor.objectName}' did not become ready within its ${Math.round(
							deadline / 1_000
						)} s deadline (FR-26 #3, plan §5.3).`
					};
				}
			}

			if (pending.size === 0) {
				break;
			}

			// The run's own cap outranks every phase deadline (FR-29).
			if (this.overran(state)) {
				return this.overrunFailure(state);
			}

			// §5.5: on every rollout poll.
			if (cancellable && (await this.cancelled(state))) {
				return null;
			}

			await this.sleep(this.pollIntervalMs());
		}

		return null;
	}

	/** §5.4's options, every entry of them data: the instant to judge, and the three thresholds. */
	private rolloutOptions(state: RunState, descriptor: ComponentDescriptor, startedAt: number) {
		const component = (descriptor.component ?? null) as AppRolloutComponent | null;
		return {
			now: this.now(),
			startedAt,
			component,
			podWaitingSince: state.podWaitingSince,
			...(this.options.restartsToFail !== undefined ? { restartsToFail: this.options.restartsToFail } : {}),
			...(this.options.stuckPodSeconds !== undefined ? { stuckPodSeconds: this.options.stuckPodSeconds } : {}),
			...(this.options.workerStableSeconds !== undefined
				? { workerStableSeconds: this.options.workerStableSeconds }
				: {})
		};
	}

	private descriptorFor(state: RunState, objectName: string): ComponentDescriptor {
		const component = (state.input?.components ?? []).find(
			(candidate) => componentObjectName(candidate.name) === objectName
		);
		return { objectName, component: component ?? null };
	}

	private async readComponent(state: RunState, descriptor: ComponentDescriptor): Promise<Observation> {
		const selector = `${APP_LABEL_COMPONENT}=${descriptor.objectName}`;
		const deployment = await this.api.readObject<AppRolloutDeployment>(
			state.kubeconfig,
			'apps/v1',
			'Deployment',
			state.namespace,
			descriptor.objectName,
			state.context
		);
		const replicaSets = deployment
			? await this.api.listObjects<AppRolloutReplicaSet>(
					state.kubeconfig,
					'apps/v1',
					'ReplicaSet',
					state.namespace,
					selector,
					state.context
				)
			: [];
		const pods = deployment
			? await this.api.listObjects<AppRolloutPod>(
					state.kubeconfig,
					'v1',
					'Pod',
					state.namespace,
					selector,
					state.context
				)
			: [];

		const observation: Observation = { ...descriptor, deployment, replicaSets, pods };
		state.lastObservation = [
			...state.lastObservation.filter((entry) => entry.objectName !== descriptor.objectName),
			observation
		];
		return observation;
	}

	/* --------------------------------------------------------------------- *
	 * In-cluster smoke (phase 5) and the isolation probe (§4.10)
	 * --------------------------------------------------------------------- */

	private async inClusterSmoke(state: RunState): Promise<PhaseFailure | null> {
		const run = await this.runRunner(state, 'smoke');
		if (!run || run.stop !== 'ok') {
			return null;
		}

		state.inCluster = run.records.map(checkResultOf);
		const failed = run.records.filter((record) => record.ok !== true);
		if (run.job.status === 'succeeded' && failed.length === 0 && run.records.length > 0) {
			return null;
		}

		const found = failed
			.map((record) => record.found)
			.find((value) => typeof value === 'string' && value.length > 0);
		const expectation = failed.map((record) => record.failedExpectation).find((value) => Boolean(value));
		const detail = [expectation, found ? `found: ${found}` : null].filter(Boolean).join(' — ');

		return {
			phase: 'in-cluster-smoke',
			code: 'smoke_failed',
			message:
				run.records.length === 0
					? `The in-cluster smoke run reported no result (job ${run.job.status}).`
					: `In-cluster smoke failed: ${detail || `${failed.length} of ${run.records.length} checks did not pass`}`,
			...(run.job.logRef ? { logRef: run.job.logRef } : {})
		};
	}

	/**
	 * §4.10's enforcement probe, run inside the smoke phase (the `AppDeployPhase` union has no phase
	 * of its own for it). `connected` ⇒ not enforced; timeout, refusal or unreachable ⇒ enforced; a
	 * probe that does not report in time ⇒ `null` **and a warning, never `true`**.
	 *
	 * Only the managed tier's `requireIsolationEnforced` turns "not enforced" into a failure, and
	 * §4.12 says a verification reports the value and never fails on it.
	 */
	private async isolationProbe(state: RunState): Promise<PhaseFailure | null> {
		const run = await this.runRunner(state, 'isolation-probe');
		if (!run || run.stop !== 'ok') {
			return null;
		}

		const record = run.records.find((entry) => entry.kind === 'isolation-probe') ?? run.records[0];
		if (!record || run.job.status !== 'succeeded') {
			state.isolationEnforced = null;
			this.warn(
				state,
				APP_ISOLATION_PROBE_INCONCLUSIVE,
				`The isolation probe did not report within its ${
					this.runnerWindowSeconds() + APP_RUNNER_DEADLINE_EXTRA_S
				} s window, so isolation enforcement could not be determined (plan §4.10).`
			);
			return null;
		}

		state.isolationEnforced = record.connected !== true;
		if (state.isolationEnforced || state.verification || state.input?.policy?.requireIsolationEnforced !== true) {
			return null;
		}

		return {
			phase: 'in-cluster-smoke',
			code: 'isolation_not_enforced',
			message:
				'The cluster’s network plugin did not enforce the App namespace policies: the probe reached the API server from a pod only `ew-default-deny` may select (plan §4.10).',
			...(run.job.logRef ? { logRef: run.job.logRef } : {})
		};
	}

	/* --------------------------------------------------------------------- *
	 * Runner runs (§4.8, §4.10, §4.11)
	 * --------------------------------------------------------------------- */

	/**
	 * Render, apply and read one runner run — `smoke`, `hairpin` or `isolation-probe`. `null` when
	 * the renderer refuses to draw one (no checks, `needsHairpin: false`, `isolation: false`), which
	 * is the renderer's own contract: an empty run is never applied.
	 */
	private async runRunner(
		state: RunState,
		kind: AppRunnerJobKind
	): Promise<{ job: AppJobResult; records: AppRunnerRecord[]; stop: WaitStop } | null> {
		const options = this.jobOptions(state);
		const configMap = renderRunnerConfigMap(state.input, kind, options);
		const object = renderRunnerJob(state.input, kind, options);
		if (!configMap || !object) {
			return null;
		}

		const appliedAt = this.now();
		const timeoutMs = (this.runnerWindowSeconds() + APP_RUNNER_DEADLINE_EXTRA_S) * 1_000;
		const name = runnerRunName(kind);

		try {
			await this.api.applyObject(state.kubeconfig, configMap, state.context);
			await this.api.applyObject(state.kubeconfig, object, state.context);
		} catch (err) {
			// A runner run is reported through `smoke` (and `isolationEnforced`), never through
			// `jobs[]`, which carries the App spec's own jobs — FR-26's rows 2, 4 and 8.
			return {
				job: {
					name,
					when: 'post-deploy',
					runName: object.metadata.name,
					status: 'failed',
					startedAt: new Date(appliedAt).toISOString(),
					completedAt: new Date(this.now()).toISOString(),
					http: { name, status: 'failed', found: messageOf(err).slice(0, 200) }
				},
				records: [],
				stop: 'ok'
			};
		}

		let status: AppJobResult['status'] = 'running';
		let stop: WaitStop = 'ok';
		while (status === 'running') {
			const observed = await this.api.readObject<JobLike>(
				state.kubeconfig,
				'batch/v1',
				'Job',
				state.namespace,
				object.metadata.name,
				state.context
			);
			status = jobVerdict(observed, appliedAt, timeoutMs, this.now());
			if (status !== 'running') {
				break;
			}
			if (await this.cancelled(state)) {
				stop = 'cancelled';
				break;
			}
			if (this.overran(state)) {
				stop = 'overran';
				break;
			}
			await this.sleep(this.pollIntervalMs());
		}

		const read = await this.readRunnerPod(state, name);
		const job: AppJobResult = {
			name,
			when: 'post-deploy',
			runName: object.metadata.name,
			status,
			startedAt: new Date(appliedAt).toISOString(),
			completedAt: new Date(this.now()).toISOString(),
			...(read.exitCode !== undefined ? { exitCode: read.exitCode } : {}),
			...(read.records[0] ? { http: checkResultOf(read.records[0]) } : {}),
			...(read.logRef ? { logRef: read.logRef } : {})
		};

		return { job, records: read.records, stop };
	}

	/**
	 * The runner Job's pod and its report. The pod is found by the label every runner Job's pod
	 * template carries (`ever-works.io/job: smoke|hairpin|isolation-probe`, §4.1 — or the App-spec
	 * job's own name for an `http` job).
	 */
	private async readRunnerPod(
		state: RunState,
		label: string
	): Promise<{ records: AppRunnerRecord[]; logRef?: AppLogRef; exitCode?: number }> {
		const pods = await this.api.listObjects<AppRolloutPod>(
			state.kubeconfig,
			'v1',
			'Pod',
			state.namespace,
			`${APP_LABEL_JOB}=${label}`,
			state.context
		);
		const pod = pods[0];
		const podName = String(pod?.metadata?.name ?? '');
		if (!podName) {
			return { records: [] };
		}

		const container = String(pod?.status?.containerStatuses?.[0]?.name ?? APP_RUNNER_CONTAINER_NAME);
		const log = await this.api.readPodLog(
			state.kubeconfig,
			state.namespace,
			podName,
			'',
			{ tailLines: 500, limitBytes: 262_144 },
			state.context
		);
		const terminated = pod?.status?.containerStatuses?.[0]?.state?.terminated;

		return {
			records: parseRunnerRecords(log),
			logRef: { job: label, pod: podName, container, previous: false },
			...(terminated && typeof terminated.exitCode === 'number' ? { exitCode: terminated.exitCode } : {})
		};
	}

	/* --------------------------------------------------------------------- *
	 * Publish, public smoke, hairpin (phases 6 and 7)
	 * --------------------------------------------------------------------- */

	private async publish(state: RunState, plan: AppRenderPlan): Promise<PhaseFailure | null> {
		const ingress = plan.objects.find((object) => object.kind === 'Ingress') ?? null;
		if (!ingress) {
			// §4.11: no class and no default class ⇒ no Ingress, warning `no_ingress_controller`,
			// public smoke skipped. The warning is the renderer's and travels with the plan.
			return null;
		}

		// Recorded before the write: a failed apply may have changed the live Ingress half-way, and a
		// rollback with no capture must take it back down.
		state.publishedIngress = ingress;
		try {
			await this.api.applyObject(state.kubeconfig, ingress, state.context);
		} catch (err) {
			return {
				phase: 'publish',
				code: 'publish_failed',
				message: `Publishing the Ingress '${ingress.metadata.name}' failed: ${messageOf(err)}`
			};
		}

		// FR-26 #6's 60 s: the controller's address, which the hairpin run and the public smoke
		// both want. Reaching the budget without one is not a failure — the public smoke classifies
		// whatever it finds (§5.5), and the result carries `ingressAddress: null`.
		const deadline = this.deadlineOr(this.options.publishDeadlineMs, APP_PUBLISH_DEADLINE_MS);
		const waitStartedAt = this.now();
		while (this.now() - waitStartedAt < deadline) {
			const observed = await this.api.readObject<Record<string, unknown>>(
				state.kubeconfig,
				'networking.k8s.io/v1',
				'Ingress',
				state.namespace,
				ingress.metadata.name,
				state.context
			);
			state.ingressAddress = ingressAddressOf(observed);
			if (state.ingressAddress) {
				break;
			}
			if (await this.cancelled(state)) {
				return null;
			}
			await this.sleep(this.pollIntervalMs());
		}

		return null;
	}

	private urlScheme(state: RunState): 'http' | 'https' {
		const declared = this.renderOptions().urlScheme;
		if (declared) {
			return declared;
		}
		// The documented fallback of §4.11 until T62's `appUrlScheme` lands: `cert-manager`,
		// `external` and `edge` publish TLS, `none` does not. `renderOptions.urlScheme` wins — the
		// platform's one function is the caller's (T62).
		return state.input?.ingress?.tls === 'none' ? 'http' : 'https';
	}

	private publicUrls(state: RunState): string[] {
		const scheme = this.urlScheme(state) ?? 'https';
		return publishedHosts(state.input).map((host) => `${scheme}://${host}`);
	}

	/** §5.5 phase 7: the platform's public smoke. Its failures are warnings (FR-26 #7, FR-37). */
	private async publicSmoke(state: RunState, urls: string[]): Promise<void> {
		const checks = smokeChecksFor(state.input, this.jobOptions(state));
		if (urls.length === 0 || checks.length === 0) {
			return;
		}

		let run: AppSmokeRun;
		try {
			run = await state.hooks.verifyPublic({
				urls,
				checks,
				windowSeconds:
					state.input?.isFirstDeploymentOnCluster === true
						? APP_PUBLIC_SMOKE_WINDOW_S
						: APP_PUBLIC_SMOKE_WINDOW_LATER_S
			});
		} catch (err) {
			this.warn(state, 'unreachable', `The public smoke run could not be completed: ${messageOf(err)}`);
			return;
		}

		state.publicChecks = [...(run?.checks ?? [])];
		for (const check of state.publicChecks) {
			if (check.status === 'passed') {
				continue;
			}
			// §5.5: only in-cluster and publish failures roll back. A public failure is classified by
			// the platform (`dns_not_pointing`, `tls_not_ready`, `unreachable`, `check_failed`) and
			// reported as-is — `check_failed` alone counts toward health (FR-37).
			this.warn(
				state,
				check.classification ?? 'check_failed',
				`Public smoke check '${check.name}' failed${check.failedExpectation ? `: ${check.failedExpectation}` : ''}${
					check.found ? ` — found: ${check.found}` : ''
				}`
			);
		}
	}

	private wantsHairpin(state: RunState): boolean {
		return state.input?.network?.needsHairpin === true && Boolean(state.input?.hosts?.primary);
	}

	/** §4.11: this run (or the version it restored) has an Ingress, so the hosts are reachable. */
	private published(state: RunState): boolean {
		return state.publishedIngress !== null;
	}

	/** §4.11's self-address check: a runner Job inside the namespace, after publish. Never fatal. */
	private async hairpin(state: RunState): Promise<void> {
		if (!this.wantsHairpin(state)) {
			return;
		}

		const run = await this.runRunner(state, 'hairpin');
		if (!run) {
			return;
		}
		state.hairpin = run.records[0] ? checkResultOf(run.records[0]) : null;
		if (state.hairpin?.status === 'passed') {
			return;
		}
		this.warn(
			state,
			APP_HAIRPIN_UNREACHABLE,
			`Your app can't reach its own address from inside the cluster (plan §4.11)${
				state.hairpin?.found ? ` — found: ${state.hairpin.found}` : ''
			}.`
		);
	}

	/* --------------------------------------------------------------------- *
	 * GC (§4.7 last line, §4.8)
	 * --------------------------------------------------------------------- */

	/**
	 * §4.7: "env Secrets and platform ConfigMaps not referenced by the current or 2 previous
	 * ReplicaSets of any component are deleted". §4.8: "the last 3 Jobs per job name are kept".
	 *
	 * The GC never fails a Deployment: a refused delete is counted and reported in `done`'s detail,
	 * and nothing else in the namespace is touched — `dep-<kind>` policies and PVCs belong to APW-07
	 * and to `destroyApp`, never to a Deployment.
	 */
	private async gc(state: RunState): Promise<void> {
		const summary = { secretsDeleted: 0, configMapsDeleted: 0, jobsDeleted: 0, errors: [] as string[] };
		state.gc = summary;

		try {
			const referenced = await this.referencedEnvObjects(state);

			const secrets = await this.api.listObjects<AppRenderedObject>(
				state.kubeconfig,
				'v1',
				'Secret',
				state.namespace,
				workSelector(state.workId),
				state.context
			);
			for (const secret of secrets) {
				if (!secret.metadata.name.startsWith(APP_ENV_SECRET_PREFIX) || referenced.has(secret.metadata.name)) {
					continue;
				}
				summary.secretsDeleted += await this.deleteAndCount(state, 'v1', 'Secret', secret.metadata.name);
			}

			const configMaps = await this.api.listObjects<AppRenderedObject>(
				state.kubeconfig,
				'v1',
				'ConfigMap',
				state.namespace,
				workSelector(state.workId),
				state.context
			);
			for (const configMap of configMaps) {
				if (
					!configMap.metadata.name.startsWith(APP_PLATFORM_CONFIGMAP_PREFIX) ||
					referenced.has(configMap.metadata.name)
				) {
					continue;
				}
				summary.configMapsDeleted += await this.deleteAndCount(
					state,
					'v1',
					'ConfigMap',
					configMap.metadata.name
				);
			}

			const jobs = await this.api.listObjects<AppRenderedObject>(
				state.kubeconfig,
				'batch/v1',
				'Job',
				state.namespace,
				workSelector(state.workId),
				state.context
			);
			for (const doomed of jobsBeyondKeep(jobs)) {
				summary.jobsDeleted += await this.deleteAndCount(state, 'batch/v1', 'Job', doomed.metadata.name);
			}
		} catch (err) {
			summary.errors.push(messageOf(err));
		}
	}

	private async deleteAndCount(state: RunState, apiVersion: string, kind: string, name: string): Promise<number> {
		try {
			await this.api.deleteObject(
				state.kubeconfig,
				apiVersion,
				kind,
				state.namespace,
				name,
				'Background',
				state.context
			);
			return 1;
		} catch (err) {
			state.gc?.errors.push(`${kind} '${name}': ${messageOf(err)}`);
			return 0;
		}
	}

	/** Every env/ConfigMap name the current or two previous ReplicaSets of any component still mount. */
	private async referencedEnvObjects(state: RunState): Promise<Set<string>> {
		const referenced = new Set<string>();

		for (const component of state.input?.components ?? []) {
			const replicaSets = await this.api.listObjects<AppRolloutReplicaSet>(
				state.kubeconfig,
				'apps/v1',
				'ReplicaSet',
				state.namespace,
				`${APP_LABEL_COMPONENT}=${componentObjectName(component.name)}`,
				state.context
			);
			const newestThree = replicaSets
				.slice()
				.sort(
					(left, right) =>
						Date.parse(String(right?.metadata?.creationTimestamp ?? '')) -
						Date.parse(String(left?.metadata?.creationTimestamp ?? ''))
				)
				.slice(0, APP_JOB_RUNS_KEPT);

			for (const replicaSet of newestThree) {
				for (const reference of envReferencesOf(replicaSet)) {
					referenced.add(reference);
				}
			}
		}

		return referenced;
	}

	/* --------------------------------------------------------------------- *
	 * Rollback (FR-33, FR-35) and the first-Deployment path (FR-32)
	 * --------------------------------------------------------------------- */

	/**
	 * §5.5's rollback: re-apply the captured workload definitions and the captured Ingress hosts,
	 * then wait with the same deadlines. `rolled-back` when the previous version is ready again,
	 * `rollback-failed` when it is not (FR-35).
	 *
	 * The wait's descriptors come from the **captured** Deployments, so a workload this Deployment
	 * never rendered is still waited for; one whose component is not in the render input keeps
	 * §5.3's formula (`progressDeadlineSeconds` of an unknown component) and no worker-stability
	 * clause, which is the fail-open reading of "the same deadlines".
	 */
	private async rollback(
		state: RunState,
		capture: AppDeployCapture,
		failure: PhaseFailure | null,
		cancelReason?: 'user' | 'quarantined' | 'app_work_deleting'
	): Promise<AppDeployResult> {
		await this.enter(state, 'rollback', {
			automatic: true,
			...(failure ? { reason: failure.code } : {}),
			...(cancelReason ? { cancelledBy: cancelReason } : {})
		});

		const errors: string[] = [];
		for (const deployment of capture.deployments) {
			try {
				await this.api.applyObject(state.kubeconfig, cleanForApply(deployment), state.context);
			} catch (err) {
				errors.push(`Deployment '${deployment.metadata.name}': ${messageOf(err)}`);
			}
		}

		if (capture.ingress) {
			try {
				await this.api.applyObject(state.kubeconfig, cleanForApply(capture.ingress), state.context);
			} catch (err) {
				errors.push(`Ingress '${capture.ingress.metadata.name}': ${messageOf(err)}`);
			}
		} else if (state.publishedIngress) {
			// Nothing was published before this run, so restoring the previous published hosts means
			// publishing none — and a failed Ingress apply may have left a half-written object behind.
			try {
				await this.api.deleteObject(
					state.kubeconfig,
					'networking.k8s.io/v1',
					'Ingress',
					state.namespace,
					state.publishedIngress.metadata.name,
					'Background',
					state.context
				);
			} catch (err) {
				errors.push(`Ingress '${state.publishedIngress.metadata.name}': ${messageOf(err)}`);
			}
		}

		if (errors.length > 0) {
			return this.successResult(state, 'rollback-failed', {
				phase: 'rollback',
				code: 'rollback_failed',
				message: `The rollback could not restore the previous version: ${errors.join(' ')}`
			});
		}

		// §5.5: "wait with the same deadlines" — and uninterrupted: a cancel is what a rollback is
		// already the answer to, so the wait itself is not cancellable.
		const readiness = await this.waitForComponents(
			state,
			capture.deployments.map((deployment) => this.descriptorFor(state, deployment.metadata.name)),
			{ cancellable: false }
		);

		if (readiness) {
			return this.successResult(state, 'rollback-failed', {
				phase: 'rollback',
				code: 'rollback_failed',
				message: `Rollback did not complete: ${readiness.message}`
			});
		}

		return this.result(state, {
			outcome: 'rolled-back',
			...(failure ? { failure } : {}),
			...(cancelReason ? { cancelReason } : {})
		});
	}

	/**
	 * §5.5's other branch: a Deployment with nothing to roll back to. FR-32 keeps the unpublished
	 * workloads on Your cluster for inspection; Ever Works Apps scales them to 0.
	 */
	private async failedResult(
		state: RunState,
		failure: PhaseFailure | null,
		cancelReason?: 'user' | 'quarantined' | 'app_work_deleting'
	): Promise<AppDeployResult> {
		if (state.input?.policy?.scaleFailedFirstDeployToZero === true) {
			for (const deployment of state.appliedDeployments) {
				try {
					await this.api.applyObject(
						state.kubeconfig,
						{ ...deployment, spec: { ...(deployment.spec as Record<string, unknown>), replicas: 0 } },
						state.context
					);
				} catch (err) {
					state.gc?.errors.push(`scale-to-zero '${deployment.metadata.name}': ${messageOf(err)}`);
				}
			}
		}

		return this.result(state, {
			outcome: cancelReason ? 'cancelled' : 'failed',
			...(failure ? { failure } : {}),
			...(cancelReason ? { cancelReason } : {})
		});
	}

	/* --------------------------------------------------------------------- *
	 * Results
	 * --------------------------------------------------------------------- */

	/** A run that ends without a rollback: `succeeded`, `succeeded-with-warnings`, `failed`, `cancelled`. */
	private async successResult(
		state: RunState,
		outcome: Extract<
			AppDeployResult['outcome'],
			'succeeded' | 'succeeded-with-warnings' | 'failed' | 'cancelled' | 'rollback-failed'
		>,
		failure?: PhaseFailure | null
	): Promise<AppDeployResult> {
		return this.result(state, { outcome, ...(failure ? { failure } : {}) });
	}

	/**
	 * FR-31's "before components change it ends Cancelled" — with the reason §3.1 requires beside a
	 * `cancelled` outcome (`AppDeployHooks.isCancelled()` says *that* it was cancelled, not *why*, so
	 * the orchestrator hands the reason to this object's options).
	 */
	private async cancelledResult(state: RunState): Promise<AppDeployResult> {
		return this.result(state, { outcome: 'cancelled', cancelReason: this.cancelReason() });
	}

	/** The one place an `AppDeployResult` is assembled, so no field can go missing from a branch. */
	private async result(
		state: RunState,
		base: {
			outcome: AppDeployResult['outcome'];
			failure?: PhaseFailure;
			cancelReason?: 'user' | 'quarantined' | 'app_work_deleting';
		}
	): Promise<AppDeployResult> {
		const components = await this.observe(state);
		const smoke: AppSmokeResult = {
			inCluster: state.inCluster,
			public: state.publicChecks,
			...(state.hairpin ? { hairpin: state.hairpin } : {}),
			observedAt: new Date(this.now()).toISOString()
		};

		return {
			outcome: base.outcome,
			...(base.cancelReason ? { cancelReason: base.cancelReason } : {}),
			...(base.failure ? { failure: base.failure } : {}),
			// The renderer's own warnings (§4.10/§4.11) never downgrade an outcome: §5.6 maps a
			// successful Deployment carrying `appRender.warnings` to READY, not to "Live with warnings".
			warnings: [...state.warnings, ...this.renderWarnings(state)],
			components,
			jobs: state.jobs,
			smoke,
			ingressAddress: state.ingressAddress,
			isolationEnforced: state.isolationEnforced,
			firstDeployJobsCompleted: state.firstDeployJobsCompleted
		};
	}

	/** §4.10/§4.11's warnings, which the renderer computed alongside the objects. */
	private renderWarnings(state: RunState): AppDeployWarning[] {
		try {
			return planAppRender(state.input, this.renderOptions()).warnings.map((warning) => ({
				code: warning.code,
				message: warning.message
			}));
		} catch {
			return [];
		}
	}

	/** The observed component statuses of the result — the last observation, refreshed when possible. */
	private async observe(state: RunState): Promise<AppComponentStatus[]> {
		const descriptors = (state.input?.components ?? []).map((component) =>
			this.descriptorFor(state, componentObjectName(component.name))
		);

		try {
			for (const descriptor of descriptors) {
				await this.readComponent(state, descriptor);
			}
		} catch {
			// An unreadable component is reported from the last observation rather than failing the run.
		}

		const observations = state.lastObservation.filter((observation) =>
			descriptors.some((descriptor) => descriptor.objectName === observation.objectName)
		);

		return observations.map((observation) => {
			const restarts = podRestarts(observation.pods);
			const desired = Number(observation.deployment?.spec?.replicas ?? observation.component?.replicas ?? 0);
			return {
				name: String(observation.component?.name ?? observation.objectName),
				role: observation.component?.role ?? 'web',
				desired: Number.isFinite(desired) ? desired : 0,
				ready: Number(observation.deployment?.status?.readyReplicas ?? 0),
				restarts: restarts.restarts,
				...(restarts.reason ? { lastTerminationReason: restarts.reason } : {}),
				oomKilledAt: restarts.oomKilledAt
			};
		});
	}

	/* --------------------------------------------------------------------- *
	 * Options helpers
	 * --------------------------------------------------------------------- */

	private runnerWindowSeconds(): number {
		const declared = this.options.smokeWindowSeconds;
		return typeof declared === 'number' && Number.isFinite(declared) && declared > 0
			? Math.floor(declared)
			: APP_RUNNER_WINDOW_S;
	}

	/**
	 * The §4.8 options every runner render shares — all data, resolved once per run. §4.9's
	 * `suspend: paused` is *not* set here: pausing is `scaleApp`'s (T13), and FR-24 refuses to deploy
	 * a paused App Work in the first place.
	 */
	private jobOptions(state: RunState): AppJobOptions {
		return {
			windowSeconds: this.runnerWindowSeconds(),
			urlScheme: this.urlScheme(state),
			render: this.renderOptions()
		};
	}
}

/* ------------------------------------------------------------------------- *
 * Module-level helpers the class uses
 * ------------------------------------------------------------------------- */

/** A Job's own timeout: `activeDeadlineSeconds` + slack for the API server's own lag. */
function jobTimeoutMs(plan: { objects: AppRenderedObject[] }, entry: AppJobPlanEntry): number {
	const object = plan.objects.find((candidate) => candidate.metadata.name === entry.objectName);
	const spec = (object?.spec ?? {}) as { activeDeadlineSeconds?: number };
	const declared = spec.activeDeadlineSeconds;
	const seconds =
		typeof declared === 'number' && Number.isFinite(declared) && declared > 0 ? declared : JOB_TIMEOUT_FALLBACK_S;
	return (seconds + JOB_TIMEOUT_SLACK_S) * 1_000;
}

function jobFailureMessage(entry: AppJobPlanEntry, result: AppJobResult): string {
	const expectation = result.http?.failedExpectation ? ` (${result.http.failedExpectation})` : '';
	const found = result.http?.found ? ` — found: ${result.http.found}` : '';
	return `Job '${entry.name}' ended ${result.status}${expectation}${found}.`;
}

function rolloutFailureMessage(
	objectName: string,
	failure: { code: AppFailureCode; reason?: string; message?: string }
): string {
	const detail = failure.message ?? failure.reason ?? failure.code;
	return `Component '${objectName}' failed to roll out: ${detail} (${failure.code}).`;
}
