/**
 * T8 — App jobs, CronJobs and the runner renderer (plan §4.8, §4.9; spec FR-19, FR-20, FR-35,
 * FR-37, FR-51; ACC-06-12, ACC-06-16, ACC-06-35).
 *
 * Pure functions from `AppRenderInput` (plan §3, §3.1 — imported from `@ever-works/plugin`, never
 * redefined) to `batch/v1` objects. **No I/O, no clock, no cluster access, no randomness** — R-5:
 * the whole plan is computable in an isolated worker and a golden fixture can pin it.
 *
 * ## The three families §4.8 and §4.9 describe
 *
 * | App spec | rendered by | runs |
 * | --- | --- | --- |
 * | `jobs[].command` | {@link renderCommandJob} — a `Job` on the component's image | that command, `restartPolicy: Never` |
 * | `jobs[].http`, `cron[].http` | {@link renderRunnerJob} / {@link renderCronJob} — a `Job` on `APP_RUNNER_IMAGE` | `app-runner.script.ts` |
 * | `cron[].command` | {@link renderCronJob} with the component's image | that command |
 *
 * The runner mounts {@link renderRunnerConfigMap}'s `ew-runner-<hash10>` read-only at
 * `/etc/ever-works` and runs `node /etc/ever-works/runner.js`. The request list — paths, methods,
 * bodies, expectations — is the ConfigMap's **other data key**, read by the script with
 * `JSON.parse`, so **no App-spec value ever reaches a `command` or `args`** (Constitution X; T8's
 * `**Done when**` line). A job pod also never carries `ever-works.io/component`: a Service selects
 * on that label, and a job pod must never receive App traffic.
 *
 * ## Credentials
 *
 * An `http` job or cron sends `Authorization` from `authEnv`, mounted as an explicit
 * **`secretKeyRef`** — never a value (ACCEPTANCE E2E-05, ACC-06-16). §4.9: "A cron whose `authEnv`
 * value is unset or empty is a precondition failure (`cron_auth_env_unset`), never a rendered call
 * without a credential"; §5.1's table names the job counterpart `job_auth_env_unset`. An `http`
 * job or cron that declares no `authEnv` is refused the same way — its `authEnv` value is unset
 * too. `{{env.NAME}}` placeholders in a body add a `secretKeyRef` for each name they reference;
 * the runner resolves them at run time and never logs the result.
 *
 * ## Reported gaps (parameters, not inventions)
 *
 * - **The paused flag.** §4.9 renders `suspend: paused`, but §3's `AppRenderInput` has no `paused`
 *   field — the live pause state lives in `work_app_runtime_states` (FR-49). It is
 *   `options.paused`, defaulting to "not paused", so a caller that does not know the state never
 *   silently suspends a schedule.
 * - **The public URL for the hairpin run.** §4.10's hairpin Job targets
 *   `<scheme>://<primary host><path>`; the scheme is derived from `ingress.tls` exactly as §4.7's
 *   `EVER_WORKS_APP_URL` is, and `options.publicUrl` overrides it when the caller already has the
 *   published URL (`app-hosts.service.ts`, FR-41/FR-42).
 * - **The CronJob's `backoffLimit`.** §4.9 fixes every other `jobTemplate` field but not this one,
 *   and APW-03's `cron` block has no `retries`. It is omitted unless the caller supplies
 *   `options.cronBackoffLimit`, so the Kubernetes default stands rather than an invented policy.
 * - **`skipPreDeployJobs`.** §5.5 brackets the pre-deploy jobs with "unless skip", so *that* is the
 *   phase machine's decision (T12), not a render-time one. `options.when` selects the phases to
 *   render; this module never silently drops a job because of an input flag the deployer owns.
 * - **The job timeout range.** spec.md:375 gives jobs "10–3600 s, default 600 s"; a value outside
 *   that range is `spec_invalid` (APW-03 validator rule, §5.1), not something to clamp silently
 *   here. A non-positive or unparseable value falls back to the documented default.
 */
import { createHash } from 'node:crypto';

import type { AppCronInput, AppComponentInput, AppJobInput, AppRenderInput, AppSmokeInput } from '@ever-works/plugin';

import {
	APP_SERVICE_PORT,
	cpuLimitForTarget,
	componentRunAsUser,
	effectiveEnvChecksum,
	type AppRenderOptions,
	type AppRenderedObject
} from './app-manifest.renderer.js';
import {
	APP_DEPLOYMENT_SHORT_LENGTH,
	appLabels,
	componentObjectName,
	cronJobName,
	envSecretName,
	jobName,
	manualJobName,
	platformConfigMapName,
	pullSecretName,
	runnerConfigMapName
} from './app-names.js';
import { APP_ISOLATION_PROBE_LABEL } from './app-network-policy.renderer.js';
import {
	APP_RUNNER_RUN_AS_USER,
	containerSecurityContext,
	podSecurityContext,
	tmpVolume,
	tmpVolumeMount,
	type AppSecurityComponent,
	type AppSecurityInput
} from './app-security.js';
import {
	APP_RUNNER_CONFIGMAP_REQUESTS_KEY,
	APP_RUNNER_CONFIGMAP_SCRIPT_KEY,
	APP_RUNNER_DEFAULT_MAX_LATENCY_MS,
	APP_RUNNER_DEFAULT_STATUS,
	APP_RUNNER_DEFAULT_TIMEOUT_MS,
	APP_RUNNER_IMAGE,
	APP_RUNNER_MOUNT_PATH,
	APP_RUNNER_PROBE_TIMEOUT_MS,
	APP_RUNNER_REQUESTS_ENV,
	APP_RUNNER_REQUESTS_FILE,
	APP_RUNNER_SCRIPT,
	APP_RUNNER_SCRIPT_FILE,
	APP_RUNNER_SCRIPT_VERSION,
	APP_RUNNER_SMOKE_STATUS,
	type AppRunnerPayload,
	type AppRunnerRequestData
} from './app-runner.script.js';

/* ------------------------------------------------------------------------- *
 * Constants
 * ------------------------------------------------------------------------- */

/** The `apiVersion` of every rendered `Job` and `CronJob`. */
export const APP_JOB_API_VERSION = 'batch/v1';

/** §4.8: `ttlSecondsAfterFinished` for every Job (plan §5.3 `APP_JOB_TTL_S`). */
export const APP_JOB_TTL_SECONDS = 86_400;
/** §4.8: "The last 3 Jobs per job name are kept" (plan §5.3 `APP_JOB_RUNS_KEPT`). */
export const APP_JOB_RUNS_KEPT = 3;
/** APW-03 schema §13 / plan §5.3: a job's `timeoutSeconds` default. */
export const APP_JOB_TIMEOUT_DEFAULT_S = 600;
/** spec.md:375 — the job timeout range the App-spec validator enforces. */
export const APP_JOB_TIMEOUT_MIN_S = 10;
export const APP_JOB_TIMEOUT_MAX_S = 3_600;
/** APW-03 schema §14: a cron entry's `timeoutSeconds` default. */
export const APP_CRON_TIMEOUT_DEFAULT_S = 300;
/** §4.9: `timeZone` is always UTC. */
export const APP_CRON_TIME_ZONE = 'Etc/UTC';
/** §4.9: `startingDeadlineSeconds: 300`. */
export const APP_CRON_STARTING_DEADLINE_S = 300;
/** §4.9: `successfulJobsHistoryLimit: 1`. */
export const APP_CRON_SUCCESSFUL_HISTORY_LIMIT = 1;
/** §4.9: `failedJobsHistoryLimit: 3`. */
export const APP_CRON_FAILED_HISTORY_LIMIT = 3;
/** §4.9: on `ever-works-apps` a schedule may not fire more often than every 5 minutes. */
export const APP_MANAGED_CRON_MIN_INTERVAL_MIN = 5;
/** §4.8: the runner's `activeDeadlineSeconds` is its window + 30. */
export const APP_RUNNER_DEADLINE_EXTRA_S = 30;
/** The runner's default window: §5.3's in-cluster smoke window. */
export const APP_RUNNER_WINDOW_S = 120;
/** §4.8: the runner container's and volume's name. */
export const APP_RUNNER_CONTAINER_NAME = 'runner';
export const APP_RUNNER_VOLUME_NAME = 'runner';
/** §4.8: the runner's requests and limits. */
export const APP_RUNNER_REQUESTS = { cpu: '50m', memory: '64Mi' } as const;
export const APP_RUNNER_LIMITS = { cpu: '500m', memory: '128Mi' } as const;
/** A failed runner check is reported, not retried — §4.8 leaves the value open. */
export const APP_RUNNER_BACKOFF_LIMIT = 0;
/** The Job names of the three runner runs that are not App-spec jobs. */
export const APP_SMOKE_JOB_NAME = 'smoke';
export const APP_HAIRPIN_JOB_NAME = 'hairpin';
export const APP_ISOLATION_PROBE_JOB_NAME = 'isolation-probe';
/** APW-03 schema §13: an `http` job's method when the spec is silent. */
export const APP_JOB_HTTP_METHOD_DEFAULT = 'POST';
/** APW-03 schema §16: a smoke check's method when the spec is silent. */
export const APP_SMOKE_HTTP_METHOD_DEFAULT = 'GET';
/** APW-03 schema §13/§14: `authScheme` default (APW-13's addition is `raw`). */
export const APP_AUTH_SCHEME_DEFAULT = 'bearer';
/** The ConfigMap volume's file mode: the script is read, never written. */
export const APP_RUNNER_CONFIGMAP_MODE = 0o444;
/** `expect.status` for an `http` job or cron, and for a smoke check. */
export const APP_JOB_EXPECT_STATUS: number[] = [...APP_RUNNER_DEFAULT_STATUS];
export const APP_SMOKE_EXPECT_STATUS: number[] = [...APP_RUNNER_SMOKE_STATUS];

/** The four runner jobs of T8's union. */
export type AppRunnerJobKind = 'http-job' | 'smoke' | 'hairpin' | 'isolation-probe';
/** Every payload kind the runner ConfigMap can carry — the four above plus a cron entry. */
export type AppRunnerKind = AppRunnerJobKind | 'cron';

/** §4.9's and §5.1's job/cron refusals. */
export type AppJobRefusalCode = 'job_auth_env_unset' | 'cron_auth_env_unset' | 'cron_too_frequent';

/** `AppPrecondition`-shaped, so a caller can hand it straight to `appRender.preconditions`. */
export interface AppJobRefusal {
	code: AppJobRefusalCode;
	names?: string[];
	message: string;
}

/** A rendered Job or CronJob the plan created — what a caller reports and garbage-collects. */
export interface AppJobPlanEntry {
	/** The App spec's `Name`, or a runner run's own name (`smoke`, `hairpin`, `isolation-probe`). */
	name: string;
	/** The object's Kubernetes name. */
	objectName: string;
	/** `command` (the component's image) or `runner` (the runner image). */
	kind: 'command' | 'runner';
	/** The job's App-spec phase; `null` for a smoke, hairpin or probe run. */
	when: AppJobInput['when'] | null;
	/** The runner ConfigMap this object mounts, when it has one. */
	configMapName?: string;
}

/** Everything §4.8/§4.9 render, the refusals that stopped the rest, and the object names. */
export interface AppJobRenderPlan {
	objects: AppRenderedObject[];
	/** The `ew-runner-<hash10>` ConfigMaps, in apply order — for garbage collection (§4.8). */
	runnerConfigMaps: AppRenderedObject[];
	jobs: AppJobPlanEntry[];
	cronJobs: AppJobPlanEntry[];
	refusals: AppJobRefusal[];
	ok: boolean;
}

/**
 * Caller-supplied values §4.8/§4.9 need but §3's render input does not carry. Every entry is
 * *data*: nothing here is fetched, resolved or dialled.
 */
export interface AppJobOptions {
	/** Which job phases to render; default all three. */
	when?: AppJobInput['when'] | readonly AppJobInput['when'][];
	/** The `http` job {@link renderRunnerJob} runs (kind `http-job`). */
	job?: AppJobInput | null;
	/** The cron entry {@link renderRunnerConfigMap} belongs to (kind `cron`). */
	cron?: AppCronInput | null;
	/** The smoke checks to run instead of the render input's own (a manual `runner: 'smoke'` run). */
	checks?: readonly AppSmokeInput[] | null;
	/** A manual run's short id → `run-<name>-<8 hex>` instead of `job-<name>-<deploymentShort>`. */
	manualRunShort?: string | null;
	/** The published URL for a hairpin run; derived from `hosts.primary` + `ingress.tls` otherwise. */
	publicUrl?: string | null;
	/** The scheme `appUrlScheme(tls, hostKind)` answered (§4.11) — wins over the TLS-mode default. */
	urlScheme?: 'http' | 'https' | null;
	/** The runner's own window: `activeDeadlineSeconds` is this + 30 (§4.8). */
	windowSeconds?: number | null;
	/** The isolation probe's destination, when the caller already knows it. */
	isolationProbe?: { host?: string | null; port?: number | null } | null;
	/** The runner Job's `backoffLimit`; §4.8 leaves it open, the default is 0. */
	backoffLimit?: number | null;
	/** A CronJob `jobTemplate`'s `backoffLimit`; omitted unless the caller supplies one. */
	cronBackoffLimit?: number | null;
	/** The live pause state of the App Work (§4.9's `suspend: paused`). */
	paused?: boolean;
	/** The checksum `planAppRender` resolved — reusing it keeps every object name identical. */
	envChecksum?: string | null;
	/** The render options the checksum was resolved with (the platform values, §4.7). */
	render?: AppRenderOptions | null;
	/** Extra env names to mount as `secretKeyRef` (a caller-known placeholder). */
	extraEnvNames?: readonly string[] | null;
}

/** What one runner mode runs, and the env names its credentials come from. */

/* ------------------------------------------------------------------------- *
 * Shared helpers
 * ------------------------------------------------------------------------- */

function normaliseText(value: unknown): string | null {
	const text = typeof value === 'string' ? value.trim() : '';
	return text ? text : null;
}

function labelsInput(input: AppRenderInput, extra: { job?: string; cron?: string }) {
	return { workId: input?.ref?.workId ?? '', workSlug: input?.workSlug ?? '', ...extra };
}

/** The effective env checksum: the caller's, else §4.7's formula over the values in hand. */
function checksumOf(input: AppRenderInput, options: AppJobOptions): string {
	const provided = normaliseText(options?.envChecksum);
	return provided || effectiveEnvChecksum(input, options?.render ?? {});
}

/** The env Secret and platform ConfigMap a Job's `envFrom` references (§4.3). */
function envReferences(input: AppRenderInput, options: AppJobOptions): Record<string, unknown>[] {
	const checksum = checksumOf(input, options);
	return [
		{ secretRef: { name: envSecretName(checksum), optional: false } },
		{ configMapRef: { name: platformConfigMapName(checksum), optional: false } }
	];
}

function componentOf(input: AppRenderInput, name: string | null | undefined): AppComponentInput | null {
	return (input?.components ?? []).find((component) => component.name === name) ?? null;
}

function primaryComponentName(input: AppRenderInput): string {
	const primary = (input?.components ?? []).find((component) => component.primary === true);
	return primary?.name ?? (input?.components ?? [])[0]?.name ?? '';
}

/** §4.4's security input for a component's own container — `allowRoot` and the `runAsUser` seam. */
function appSecurityInput(input: AppRenderInput, component: AppComponentInput | null): AppSecurityInput {
	return {
		ref: { target: input?.ref?.target },
		policy: { allowRoot: input?.policy?.allowRoot === true },
		runAsUser: component ? componentRunAsUser(component) : undefined
	};
}

/** §4.8 runner hardening: uid 10001, never root, whatever `allowRoot` says for the App. */
function runnerSecurityInput(input: AppRenderInput): AppSecurityInput {
	return {
		ref: { target: input?.ref?.target },
		policy: { allowRoot: false },
		runAsUser: APP_RUNNER_RUN_AS_USER
	};
}

function securityComponentOf(component: AppComponentInput | null, name?: string): AppSecurityComponent {
	return {
		name: component?.name ?? name ?? APP_RUNNER_CONTAINER_NAME,
		role: component?.role === 'web' ? 'web' : 'worker',
		port: component?.port ?? null,
		volumes: component?.volumes ?? [],
		writableRootFilesystem: component?.writableRootFilesystem === true
	};
}

/** `job-<name>-<deploymentShort>` or, for a manual run, `run-<name>-<8 hex>` (plan §4.1). */
function objectNameFor(input: AppRenderInput, name: string, options: AppJobOptions): string {
	const manual = normaliseText(options?.manualRunShort);
	if (manual) {
		return manualJobName(name, manual);
	}
	return jobName(name, String(input?.deploymentShort ?? '').slice(0, APP_DEPLOYMENT_SHORT_LENGTH));
}

function timeoutSecondsOf(declared: unknown, fallback: number): number {
	return typeof declared === 'number' && Number.isFinite(declared) && declared > 0 ? Math.floor(declared) : fallback;
}

function backoffLimitOf(declared: unknown, fallback: number | null): number | null {
	if (typeof declared === 'number' && Number.isFinite(declared) && declared >= 0) {
		return Math.floor(declared);
	}
	return fallback;
}

function httpBlockOf(entry: { http?: unknown } | null | undefined): AppJobInput['http'] | null {
	return (entry?.http as AppJobInput['http']) ?? null;
}

/** §4.5's resources, with the managed CPU limit of `cpuLimitForTarget`. */
function componentResources(input: AppRenderInput, component: AppComponentInput): Record<string, unknown> {
	const resources = component.resources;
	const limits: Record<string, string> = { memory: resources.memoryLimit };
	const cpuLimit = cpuLimitForTarget(input?.ref?.target, resources.cpuLimit, resources.cpu);
	if (cpuLimit) {
		limits.cpu = cpuLimit;
	}

	return { requests: { cpu: resources.cpu, memory: resources.memory }, limits };
}

/**
 * The pod spec a Job or a CronJob `jobTemplate` uses.
 *
 * The §4.4 `/tmp` `emptyDir` travels with a read-only root filesystem, exactly as it does for a
 * Deployment (`app-security.ts`), and the service-account token is never mounted (FR-13).
 */
function jobPodSpec(
	input: AppRenderInput,
	component: AppComponentInput | null,
	container: Record<string, unknown>,
	options: { volumes?: Record<string, unknown>[]; appImage?: boolean } = {}
): Record<string, unknown> {
	const podSpec: Record<string, unknown> = {
		restartPolicy: 'Never',
		serviceAccountName: 'app',
		automountServiceAccountToken: false,
		enableServiceLinks: false,
		securityContext: component
			? podSecurityContext(appSecurityInput(input, component), securityComponentOf(component))
			: podSecurityContext(runnerSecurityInput(input), securityComponentOf(null)),
		containers: [container]
	};

	if (options.appImage !== false && input?.image?.pull) {
		podSpec.imagePullSecrets = [{ name: pullSecretName() }];
	}

	const runtimeClassName = normaliseText(input?.policy?.runtimeClassName);
	if (runtimeClassName) {
		podSpec.runtimeClassName = runtimeClassName;
	}

	if (options.volumes && options.volumes.length > 0) {
		podSpec.volumes = options.volumes;
	}

	return podSpec;
}

/* ------------------------------------------------------------------------- *
 * Command jobs (plan §4.8 bullet 1)
 * ------------------------------------------------------------------------- */

/**
 * §4.8: a `command` job is a `Job` on the component's image, with the component's env, security
 * context and resources.
 *
 * `null` when the job names a component the render input does not carry: a Job on no image is not
 * renderable, and inventing one would apply a broken object. §5.1's `spec_invalid` covers that
 * case before a render is attempted.
 */
export function renderCommandJob(
	input: AppRenderInput,
	job: AppJobInput,
	options: AppJobOptions = {}
): AppRenderedObject | null {
	const component = componentOf(input, job?.component);
	if (!component) {
		return null;
	}

	const name = String(job?.name ?? '');
	const labels = appLabels(labelsInput(input, { job: name }));

	return {
		apiVersion: APP_JOB_API_VERSION,
		kind: 'Job',
		metadata: { name: objectNameFor(input, name, options), namespace: String(input?.ref?.namespace ?? ''), labels },
		spec: {
			backoffLimit: backoffLimitOf(job?.retries, 0),
			activeDeadlineSeconds: timeoutSecondsOf(job?.timeoutSeconds, APP_JOB_TIMEOUT_DEFAULT_S),
			ttlSecondsAfterFinished: APP_JOB_TTL_SECONDS,
			template: {
				metadata: { labels },
				spec: jobPodSpec(input, component, commandContainer(input, component, job?.command, options))
			}
		}
	};
}

/** The component's own container, re-stamped for a Job: no ports and no probes — it is not a server. */
function commandContainer(
	input: AppRenderInput,
	component: AppComponentInput,
	command: readonly string[] | undefined,
	options: AppJobOptions
): Record<string, unknown> {
	const containerSpec: Record<string, unknown> = {
		name: componentObjectName(component.name),
		image: String(input?.image?.reference ?? ''),
		imagePullPolicy: 'IfNotPresent',
		envFrom: envReferences(input, options)
	};

	const effectiveCommand = Array.isArray(command) && command.length > 0 ? command : component.command;
	if (Array.isArray(effectiveCommand) && effectiveCommand.length > 0) {
		containerSpec.command = [...effectiveCommand];
	}
	if (Array.isArray(component.args) && component.args.length > 0) {
		containerSpec.args = [...component.args];
	}

	containerSpec.resources = componentResources(input, component);
	containerSpec.securityContext = containerSecurityContext(
		appSecurityInput(input, component),
		securityComponentOf(component)
	);

	const mount = tmpVolumeMount(appSecurityInput(input, component), securityComponentOf(component));
	if (mount) {
		containerSpec.volumeMounts = [mount];
	}

	return containerSpec;
}

/** The §4.4 `/tmp` volume a read-only container needs, or an empty list. */
function tmpVolumes(input: AppRenderInput, component: AppComponentInput | null): Record<string, unknown>[] {
	const securityInput = component ? appSecurityInput(input, component) : runnerSecurityInput(input);
	const volume = tmpVolume(securityInput, securityComponentOf(component));
	return volume ? [volume as unknown as Record<string, unknown>] : [];
}

/* ------------------------------------------------------------------------- *
 * The runner (plan §4.8 bullets 2-4)
 * ------------------------------------------------------------------------- */

/**
 * `sha256` over the script and the payload — the `ew-runner-<hash10>` name's input (§4.1).
 *
 * The script and the contract version are part of the hash, so bumping either renames every
 * ConfigMap instead of leaving a pod with a stale script under an unchanged name.
 */
export function runnerConfigHash(payload: AppRunnerPayload): string {
	return createHash('sha256')
		.update(`${APP_RUNNER_SCRIPT_VERSION}\n${APP_RUNNER_SCRIPT}\n${JSON.stringify(payload)}`)
		.digest('hex');
}

/**
 * §4.8: the `ew-runner-<hash10>` ConfigMap — the script plus the request list, both **data**.
 *
 * A path carrying `$(`, a backtick or a quote stays verbatim inside the JSON, because nothing here
 * is escaped into a shell or a command line. `null` when the mode has nothing to run (an
 * `http-job` with no job, a hairpin run with no public host, an isolation probe with isolation
 * off).
 */
export function renderRunnerConfigMap(
	input: AppRenderInput,
	kind: AppRunnerKind,
	options: AppJobOptions = {}
): AppRenderedObject | null {
	const payload = runnerPayload(input, kind, options);
	if (!payload) {
		return null;
	}

	return {
		apiVersion: 'v1',
		kind: 'ConfigMap',
		metadata: {
			name: runnerConfigMapName(runnerConfigHash(payload)),
			namespace: String(input?.ref?.namespace ?? ''),
			labels: appLabels(labelsInput(input, { job: String(payload.name ?? kind) }))
		},
		data: {
			[APP_RUNNER_CONFIGMAP_SCRIPT_KEY]: APP_RUNNER_SCRIPT,
			[APP_RUNNER_CONFIGMAP_REQUESTS_KEY]: JSON.stringify(payload)
		}
	};
}

/**
 * §4.8/§4.9/§4.10: the runner `Job` for one of T8's four kinds.
 *
 * - `http-job` — the `http` job named by `options.job`; `null` without one, and `null` when its
 *   `authEnv` has no value (the `job_auth_env_unset` refusal of §5.1).
 * - `smoke` — the App spec's smoke checks (`options.checks` replaces them for a manual
 *   `runner: 'smoke'` run), targeting `http://<component>.<namespace>.svc:80<path>`, so the
 *   request's `Host` is the component's Service name (plan §4.12).
 * - `hairpin` — §4.10's self-address check against `<scheme>://<primary host><path>`; `null` when
 *   `network.needsHairpin` is false, there is no primary host, the ref is a verification ref, or no
 *   smoke check exists.
 * - `isolation-probe` — the §4.10 enforcement probe, whose pod carries
 *   `ever-works.io/isolation-probe`; `null` when `network.isolation` is false ("no probe runs").
 */
export function renderRunnerJob(
	input: AppRenderInput,
	kind: AppRunnerJobKind,
	options: AppJobOptions = {}
): AppRenderedObject | null {
	const payload = runnerPayload(input, kind, options);
	if (!payload) {
		return null;
	}

	const labels = appLabels(labelsInput(input, { job: String(payload.name ?? kind) }));
	const podLabels: Record<string, string> = { ...labels };
	if (kind === 'isolation-probe') {
		// §4.10: the policies' `podSelector` excludes a pod carrying this label, so the probe pod is
		// selected by `ew-default-deny` alone and has no egress at all — not even DNS. It only ever
		// removes allowances, so the probe gains nothing.
		podLabels[APP_ISOLATION_PROBE_LABEL] = 'true';
	}

	const configMapName = runnerConfigMapName(runnerConfigHash(payload));

	return {
		apiVersion: APP_JOB_API_VERSION,
		kind: 'Job',
		metadata: {
			name: runnerJobName(input, kind, options),
			namespace: String(input?.ref?.namespace ?? ''),
			labels
		},
		spec: {
			backoffLimit: backoffLimitOf(options?.backoffLimit, APP_RUNNER_BACKOFF_LIMIT),
			activeDeadlineSeconds: windowSeconds(options) + APP_RUNNER_DEADLINE_EXTRA_S,
			ttlSecondsAfterFinished: APP_JOB_TTL_SECONDS,
			template: {
				metadata: { labels: podLabels },
				spec: jobPodSpec(input, null, runnerContainer(input, payload, options), {
					volumes: runnerVolumes(configMapName, input),
					appImage: false
				})
			}
		}
	};
}

function runnerJobName(input: AppRenderInput, kind: AppRunnerJobKind, options: AppJobOptions): string {
	if (kind === 'http-job') {
		return objectNameFor(input, String(options?.job?.name ?? ''), options);
	}
	const name =
		kind === 'smoke'
			? APP_SMOKE_JOB_NAME
			: kind === 'hairpin'
				? APP_HAIRPIN_JOB_NAME
				: APP_ISOLATION_PROBE_JOB_NAME;
	return objectNameFor(input, name, options);
}

function windowSeconds(options: AppJobOptions): number {
	const declared = options?.windowSeconds;
	return typeof declared === 'number' && Number.isFinite(declared) && declared > 0
		? Math.floor(declared)
		: APP_RUNNER_WINDOW_S;
}

/** The runner container: the mounted script, the request-file path, and `secretKeyRef` env only. */
function runnerContainer(
	input: AppRenderInput,
	payload: AppRunnerPayload,
	options: AppJobOptions
): Record<string, unknown> {
	const securityInput = runnerSecurityInput(input);
	const mount = tmpVolumeMount(securityInput, securityComponentOf(null));

	return {
		name: APP_RUNNER_CONTAINER_NAME,
		image: APP_RUNNER_IMAGE,
		imagePullPolicy: 'IfNotPresent',
		// The script path and the request-file path are this module's own constants, never App data.
		command: ['node', APP_RUNNER_SCRIPT_FILE],
		env: [
			{ name: APP_RUNNER_REQUESTS_ENV, value: APP_RUNNER_REQUESTS_FILE },
			...secretEnvRefs(input, payload, options)
		],
		resources: {
			requests: { ...APP_RUNNER_REQUESTS },
			limits: { ...APP_RUNNER_LIMITS }
		},
		securityContext: containerSecurityContext(securityInput, securityComponentOf(null)),
		volumeMounts: [
			{ name: APP_RUNNER_VOLUME_NAME, mountPath: APP_RUNNER_MOUNT_PATH, readOnly: true },
			...(mount ? [mount as unknown as Record<string, unknown>] : [])
		]
	};
}

function runnerVolumes(configMapName: string, input: AppRenderInput): Record<string, unknown>[] {
	return [
		{ name: APP_RUNNER_VOLUME_NAME, configMap: { name: configMapName, defaultMode: APP_RUNNER_CONFIGMAP_MODE } },
		...tmpVolumes(input, null)
	];
}

/**
 * Every `secretKeyRef` the runner needs: the `authEnv` of each request, plus every env name a body
 * placeholder references. Mounted by key from the §4.7 env Secret — never a value, and never the
 * whole Secret: a health check has no business reading the App's database password.
 *
 * The reference is deliberately **not** `optional`: a name the env Secret does not carry fails the
 * pod loudly (`CreateContainerConfigError`) instead of sending a request with an empty credential.
 */
function secretEnvRefs(
	input: AppRenderInput,
	payload: AppRunnerPayload,
	options: AppJobOptions
): Record<string, unknown>[] {
	const secretName = envSecretName(checksumOf(input, options));
	const names = new Set<string>();

	for (const request of payload.requests) {
		const authEnv = normaliseText(request.authEnv);
		if (authEnv) {
			names.add(authEnv);
		}
		for (const name of placeholderNames(request.body)) {
			names.add(name);
		}
	}
	for (const name of options?.extraEnvNames ?? []) {
		const trimmed = normaliseText(name);
		if (trimmed) {
			names.add(trimmed);
		}
	}

	return [...names]
		.sort()
		.map((name) => ({ name, valueFrom: { secretKeyRef: { name: secretName, key: name, optional: false } } }));
}

/** Every `{{env.NAME}}` of a body, in first-appearance order. */
export function placeholderNames(body: unknown): string[] {
	const names: string[] = [];
	const walk = (value: unknown): void => {
		if (typeof value === 'string') {
			for (const match of value.matchAll(/{{env\.([A-Za-z_][A-Za-z0-9_]*)}}/g)) {
				if (!names.includes(match[1])) {
					names.push(match[1]);
				}
			}
			return;
		}
		if (Array.isArray(value)) {
			value.forEach(walk);
			return;
		}
		if (value && typeof value === 'object') {
			Object.values(value as Record<string, unknown>).forEach(walk);
		}
	};
	walk(body);
	return names;
}

/* ------------------------------------------------------------------------- *
 * CronJobs (plan §4.9)
 * ------------------------------------------------------------------------- */

/**
 * §4.9: the `CronJob` for one `cron` entry.
 *
 * `suspend: paused` (ACC-06-35) is the **caller's** live pause state — §3's render input carries
 * none; `concurrencyPolicy` maps `concurrency: forbid|allow` (default `Forbid`); an `http` entry
 * runs the runner (mounting its own `ew-runner-<hash10>`) and a `command` entry runs the
 * component's image. A managed (`ever-works-apps`) schedule that can fire more often than every
 * `policy.cronMinIntervalMinutes` is refused with `cron_too_frequent`, and an `http` entry whose
 * credential is unset with `cron_auth_env_unset` — both return `null` here; `planAppJobs` reports
 * them.
 *
 * **No per-Deployment value reaches the `jobTemplate`** (APW06-G07, ACC-06-58): no
 * `ever-works.io/env-checksum`, no `deploymentShort` in a name, no `ever-works.io/deployment-id` —
 * so two Deployments of the same Build render byte-identical CronJobs. The runner ConfigMap's name
 * is a function of the script and the request data alone, which is why it may appear there.
 */
export function renderCronJob(
	input: AppRenderInput,
	cron: AppCronInput,
	options: AppJobOptions = {}
): AppRenderedObject | null {
	if (input?.purpose === 'verification') {
		// §4.12: a verification ref renders no CronJob.
		return null;
	}
	if (cronTooFrequent(input, cron)) {
		return null;
	}

	const name = String(cron?.name ?? '');
	const labels = appLabels(labelsInput(input, { cron: name }));
	const scoped: AppJobOptions = { ...options, cron };
	const payload = httpBlockOf(cron) ? runnerPayload(input, 'cron', scoped) : null;
	if (httpBlockOf(cron) && !payload) {
		return null;
	}

	const configMapName = payload ? runnerConfigMapName(runnerConfigHash(payload)) : '';
	const component = componentOf(input, cron?.component ?? primaryComponentName(input));
	const container = payload
		? runnerContainer(input, payload, scoped)
		: component
			? commandContainer(input, component, cron?.command, scoped)
			: null;
	if (!container) {
		return null;
	}

	const jobSpec: Record<string, unknown> = {
		activeDeadlineSeconds: timeoutSecondsOf(cron?.timeoutSeconds, APP_CRON_TIMEOUT_DEFAULT_S),
		ttlSecondsAfterFinished: APP_JOB_TTL_SECONDS,
		template: {
			metadata: { labels },
			spec: jobPodSpec(input, payload ? null : component, container, {
				volumes: payload ? runnerVolumes(configMapName, input) : tmpVolumes(input, component),
				appImage: !payload
			})
		}
	};
	const cronBackoff = backoffLimitOf(options?.cronBackoffLimit, null);
	if (cronBackoff !== null) {
		jobSpec.backoffLimit = cronBackoff;
	}

	return {
		apiVersion: APP_JOB_API_VERSION,
		kind: 'CronJob',
		metadata: {
			name: cronJobName(name),
			namespace: String(input?.ref?.namespace ?? ''),
			labels
		},
		spec: {
			schedule: String(cron?.schedule ?? ''),
			timeZone: APP_CRON_TIME_ZONE,
			concurrencyPolicy: cron?.concurrency === 'allow' ? 'Allow' : 'Forbid',
			startingDeadlineSeconds: APP_CRON_STARTING_DEADLINE_S,
			successfulJobsHistoryLimit: APP_CRON_SUCCESSFUL_HISTORY_LIMIT,
			failedJobsHistoryLimit: APP_CRON_FAILED_HISTORY_LIMIT,
			suspend: options?.paused === true,
			jobTemplate: { metadata: { labels }, spec: jobSpec }
		}
	};
}

/* ------------------------------------------------------------------------- *
 * The request list (§4.8, §4.9, §4.10)
 * ------------------------------------------------------------------------- */

/** `http://<component>.<namespace>.svc:80` — §4.9's literal target for a job or cron request. */
export function componentRequestUrl(input: AppRenderInput, component: string | null | undefined): string | null {
	const namespace = normaliseText(input?.ref?.namespace);
	if (!namespace) {
		return null;
	}
	return `http://${componentObjectName(component ?? '')}.${namespace}.svc:${APP_SERVICE_PORT}`;
}

/** `<scheme>://<primary host>` for the hairpin run, or `null` when there is nothing to reach. */
function publicUrl(input: AppRenderInput, options: AppJobOptions): string | null {
	const declared = normaliseText(options?.publicUrl);
	if (declared) {
		return declared.replace(/\/+$/, '');
	}
	const host = normaliseText(input?.hosts?.primary);
	if (!host) {
		return null;
	}
	return `${options?.urlScheme ?? (input?.ingress?.tls === 'none' ? 'http' : 'https')}://${host}`;
}

/** §4.10: the hairpin run needs the flag and a public URL, and never runs for a verification ref. */
function hairpinUrl(input: AppRenderInput, options: AppJobOptions): string | null {
	if (input?.purpose === 'verification' || input?.network?.needsHairpin !== true) {
		return null;
	}
	return publicUrl(input, options);
}

/** The smoke checks a run covers: `first-deploy` ones only on the first Deployment (§5.5). */
export function smokeChecksFor(input: AppRenderInput, options: AppJobOptions = {}): readonly AppSmokeInput[] {
	const checks = options?.checks ?? input?.smoke ?? [];
	return checks.filter((check) => check?.when !== 'first-deploy' || input?.isFirstDeploymentOnCluster === true);
}

/**
 * The payload a runner mode carries, or `null` when the mode has nothing it can run — which is
 * what keeps a renderer from applying an empty check.
 */
function runnerPayload(input: AppRenderInput, kind: AppRunnerKind, options: AppJobOptions): AppRunnerPayload | null {
	switch (kind) {
		case 'http-job': {
			const job = options?.job;
			const http = httpBlockOf(job);
			if (!job || !http) {
				return null;
			}
			return requestPayload(input, 'http-job', String(job.name ?? ''), job.component, http);
		}
		case 'cron': {
			const cron = options?.cron;
			const http = httpBlockOf(cron);
			if (!cron || !http) {
				return null;
			}
			return requestPayload(
				input,
				'cron',
				String(cron.name ?? ''),
				cron.component ?? primaryComponentName(input),
				http
			);
		}
		case 'smoke': {
			const requests = smokeChecksFor(input, options)
				.map((check) => smokeRequest(input, check, componentRequestUrl(input, check.component)))
				.filter((request): request is AppRunnerRequestData => request !== null);
			if (requests.length === 0) {
				return null;
			}
			return payloadOf('smoke', null, requests);
		}
		case 'hairpin': {
			const base = hairpinUrl(input, options);
			const check = smokeChecksFor(input, options)[0];
			if (!base || !check) {
				return null;
			}
			const request = smokeRequest(input, check, base);
			return request ? payloadOf('hairpin', null, [request]) : null;
		}
		case 'isolation-probe':
			if (input?.network?.isolation === false) {
				// §4.10: with isolation off no probe runs, and the value is `null`.
				return null;
			}
			return {
				...emptyPayload('isolation-probe', null),
				isolationProbe: {
					host: normaliseText(options?.isolationProbe?.host),
					port:
						typeof options?.isolationProbe?.port === 'number' &&
						Number.isFinite(options.isolationProbe.port)
							? options.isolationProbe.port
							: null,
					timeoutMs: APP_RUNNER_PROBE_TIMEOUT_MS
				}
			};
		default:
			return null;
	}
}

function emptyPayload(kind: AppRunnerKind, name: string | null): AppRunnerPayload {
	return { version: APP_RUNNER_SCRIPT_VERSION, kind, name, requests: [], secrets: [] };
}

/** One smoke check as a request against `base` — the component Service, or the public URL. */
function smokeRequest(input: AppRenderInput, check: AppSmokeInput, base: string | null): AppRunnerRequestData | null {
	if (!base) {
		return null;
	}
	return requestData(
		String(check?.name ?? ''),
		`${base}${pathOf(check?.http?.path)}`,
		check?.http?.method ?? APP_SMOKE_HTTP_METHOD_DEFAULT,
		null,
		check?.http?.body,
		{
			status: check?.expect?.status ?? APP_SMOKE_EXPECT_STATUS,
			bodyContains: check?.expect?.bodyContains ?? [],
			bodyNotContains: check?.expect?.bodyNotContains ?? [],
			maxLatencyMs: check?.expect?.maxLatencyMs ?? APP_RUNNER_DEFAULT_MAX_LATENCY_MS
		}
	);
}

/** One `http` job or cron entry as a request against its component's Service. */
function requestPayload(
	input: AppRenderInput,
	kind: 'http-job' | 'cron',
	name: string,
	component: string | null | undefined,
	http: NonNullable<AppJobInput['http']>
): AppRunnerPayload | null {
	const authEnv = normaliseText(http.authEnv);
	if (!authEnv || !hasEnvValue(input, authEnv)) {
		// `cron_auth_env_unset` / `job_auth_env_unset` (§4.9, §5.1): never a call without a credential.
		return null;
	}

	const base = componentRequestUrl(input, component ?? primaryComponentName(input));
	if (!base) {
		return null;
	}

	const request = requestData(
		name,
		`${base}${pathOf(http.path)}`,
		http.method ?? APP_JOB_HTTP_METHOD_DEFAULT,
		http,
		http.body,
		{
			status: http.expect?.status ?? APP_JOB_EXPECT_STATUS,
			bodyContains: [],
			bodyNotContains: [],
			maxLatencyMs: APP_RUNNER_DEFAULT_MAX_LATENCY_MS
		}
	);
	return payloadOf(kind, name, [request]);
}

function hasEnvValue(input: AppRenderInput, name: string): boolean {
	const value = (input?.env?.values ?? {})[name];
	return typeof value === 'string' && value.trim().length > 0;
}

function requestData(
	name: string,
	url: string,
	method: string,
	http: { authEnv?: string | null; authScheme?: 'bearer' | 'raw' | null } | null,
	body: unknown,
	expect: {
		status: readonly number[];
		bodyContains: readonly string[];
		bodyNotContains: readonly string[];
		maxLatencyMs: number;
	}
): AppRunnerRequestData {
	const request: AppRunnerRequestData = {
		name: String(name ?? ''),
		url,
		method: String(method ?? APP_JOB_HTTP_METHOD_DEFAULT),
		expect: {
			status: [...expect.status],
			bodyContains: [...expect.bodyContains],
			bodyNotContains: [...expect.bodyNotContains],
			maxLatencyMs: expect.maxLatencyMs
		},
		timeoutMs: APP_RUNNER_DEFAULT_TIMEOUT_MS
	};

	if (body !== undefined && body !== null) {
		request.body = body;
	}

	const authEnv = normaliseText(http?.authEnv);
	if (authEnv) {
		request.authEnv = authEnv;
		request.authScheme = http?.authScheme === 'raw' ? 'raw' : APP_AUTH_SCHEME_DEFAULT;
	}

	return request;
}

function payloadOf(kind: AppRunnerKind, name: string | null, requests: AppRunnerRequestData[]): AppRunnerPayload {
	const secrets = new Set<string>();
	for (const request of requests) {
		const authEnv = normaliseText(request.authEnv);
		if (authEnv) {
			secrets.add(authEnv);
		}
		for (const placeholder of placeholderNames(request.body)) {
			secrets.add(placeholder);
		}
	}
	return { version: APP_RUNNER_SCRIPT_VERSION, kind, name, requests, secrets: [...secrets].sort() };
}

function pathOf(path: unknown): string {
	const text = typeof path === 'string' ? path : '';
	if (!text) {
		return '/';
	}
	return text.startsWith('/') ? text : `/${text}`;
}

/* ------------------------------------------------------------------------- *
 * Cron frequency (§4.9)
 * ------------------------------------------------------------------------- */

/**
 * §4.9: "schedules that can fire more often than every 5 minutes are refused (`cron_too_frequent`)"
 * — on `ever-works-apps` only.
 *
 * The check is a real scan, not "the smallest step in the minute field": a minute field of `*` with
 * a step of 7 fires at `:00, :07, … :56` and then at `:00` of the next hour — a 4-minute gap that a
 * step-size reading would call 7. The scan starts at a **fixed** anchor (2024-01-01T00:00Z, a
 * Monday) and looks a year ahead, so it reads no clock and answers the same way every time.
 */
export function cronTooFrequent(input: AppRenderInput, cron: AppCronInput): boolean {
	if (input?.ref?.target !== 'ever-works-apps') {
		return false;
	}
	const actual = cronMinIntervalMinutes(cron?.schedule);
	return actual !== null && actual < intervalMinutesOf(input);
}

function intervalMinutesOf(input: AppRenderInput): number {
	const declared = input?.policy?.cronMinIntervalMinutes;
	return typeof declared === 'number' && Number.isFinite(declared) && declared > 0
		? Math.floor(declared)
		: APP_MANAGED_CRON_MIN_INTERVAL_MIN;
}

/** The fixed anchor of {@link cronMinIntervalMinutes}: a Monday, so day-of-week is well defined. */
const CRON_ANCHOR_MS = Date.parse('2024-01-01T00:00:00.000Z');
/** One day, in milliseconds. */
const CRON_DAY_MS = 86_400_000;
/** How far the scan looks ahead: a full leap year for a five-field schedule. */
const CRON_SCAN_DAYS = 366;
/** The same, in days, for a six-field schedule — its times-of-day set is 86 400 entries wide. */
const CRON_SCAN_DAYS_WITH_SECONDS = 40;
/** The smallest interval a schedule can have, in seconds: two consecutive seconds. */
const CRON_MIN_GAP_SECONDS = 1;

/**
 * The shortest gap, in **whole minutes**, between two consecutive firings of a standard cron
 * schedule — or `null` when the schedule cannot be parsed, or when a year of scanning finds fewer
 * than two firings (a yearly schedule can never be "too frequent"; an unparseable one is
 * `spec_invalid` of §5.1, not this code).
 *
 * The scan is over a real calendar, not over the field steps: a minute field of `*` with a step of
 * 7 fires at `:00, :07, … :56` and then at `:00` of the next hour, so its shortest gap is **4**
 * minutes, not 7 — which is exactly the difference between refusing a schedule on the managed tier
 * and letting it hammer the App every hour.
 *
 * Five fields are `minute hour day-of-month month day-of-week`; a sixth leading field (seconds) is
 * accepted defensively, because refusing such a schedule as "too frequent" is never worse than
 * letting a per-second schedule onto the managed tier. Day-of-month and day-of-week combine the way
 * Kubernetes' parser (`robfig/cron`) combines them: when **both** are restricted, a time matches if
 * **either** does.
 */
export function cronMinIntervalMinutes(schedule: unknown): number | null {
	const parsed = parseCron(schedule);
	if (!parsed) {
		return null;
	}

	const days = parsed.seconds ? CRON_SCAN_DAYS_WITH_SECONDS : CRON_SCAN_DAYS;
	let previous: number | null = null;
	let minimum: number | null = null;

	for (let day = 0; day < days; day += 1) {
		if (!parsed.dayMatches(new Date(CRON_ANCHOR_MS + day * CRON_DAY_MS))) {
			continue;
		}
		for (const secondOfDay of parsed.timesOfDay) {
			const absolute = day * 86_400 + secondOfDay;
			if (previous !== null) {
				const gap = Math.max(1, Math.ceil((absolute - previous) / 60));
				if (minimum === null || gap < minimum) {
					minimum = gap;
					if (minimum === 1) {
						return minimum;
					}
				}
			}
			previous = absolute;
		}
	}

	return minimum;
}

interface ParsedCron {
	/** Whether the schedule carried a seconds field. */
	seconds: boolean;
	/** The times of day the schedule fires at, in seconds since UTC midnight, ascending. */
	timesOfDay: number[];
	/** Whether a calendar day matches the `month` / day-of-month / day-of-week fields. */
	dayMatches(instant: Date): boolean;
}

const CRON_DESCRIPTORS: Record<string, string> = {
	'@yearly': '0 0 1 1 *',
	'@annually': '0 0 1 1 *',
	'@monthly': '0 0 1 * *',
	'@weekly': '0 0 * * 0',
	'@daily': '0 0 * * *',
	'@midnight': '0 0 * * *',
	'@hourly': '0 * * * *'
};

function parseCron(schedule: unknown): ParsedCron | null {
	let text = typeof schedule === 'string' ? schedule.trim() : '';
	if (!text) {
		return null;
	}
	const descriptor = CRON_DESCRIPTORS[text.toLowerCase()];
	if (descriptor) {
		text = descriptor;
	} else if (text.startsWith('@')) {
		return null;
	}

	const parts = text.split(/\s+/);
	if (parts.length !== 5 && parts.length !== 6) {
		return null;
	}

	const withSeconds = parts.length === 6;
	const [secondField, minuteField, hourField, dayField, monthField, weekField] = withSeconds
		? parts
		: ['0', ...parts];

	const second = parseCronField(secondField, 0, 59, null);
	const minute = parseCronField(minuteField, 0, 59, null);
	const hour = parseCronField(hourField, 0, 23, null);
	const day = parseCronField(dayField, 1, 31, null);
	const month = parseCronField(monthField, 1, 12, null);
	const week = parseCronField(weekField, 0, 7, 7);
	if (!second || !minute || !hour || !day || !month || !week) {
		return null;
	}

	const dayRestricted = dayField.trim() !== '*';
	const weekRestricted = weekField.trim() !== '*';
	const timesOfDay: number[] = [];
	for (const h of [...hour].sort((left, right) => left - right)) {
		for (const m of [...minute].sort((left, right) => left - right)) {
			for (const s of [...second].sort((left, right) => left - right)) {
				timesOfDay.push(h * 3_600 + m * 60 + s);
			}
		}
	}

	return {
		seconds: withSeconds,
		timesOfDay,
		dayMatches: (instant: Date): boolean => {
			if (!month.has(instant.getUTCMonth() + 1)) return false;
			const dayMatch = day.has(instant.getUTCDate());
			const weekMatch = week.has(instant.getUTCDay());
			if (dayRestricted && weekRestricted) {
				return dayMatch || weekMatch;
			}
			return dayMatch && weekMatch;
		}
	};
}

/** One field as a set of allowed values, or `null` when it is unparseable or out of range. */
function parseCronField(field: string, min: number, max: number, sundayAlias: number | null): Set<number> | null {
	const values = new Set<number>();
	for (const part of field.split(',')) {
		const [range, stepText] = part.split('/');
		const step = stepText === undefined ? 1 : Number(stepText);
		if (!Number.isInteger(step) || step < 1) {
			return null;
		}

		let from: number;
		let to: number;
		if (range === '*') {
			from = min;
			to = max;
		} else if (range.includes('-')) {
			const [startText, endText] = range.split('-');
			from = Number(startText);
			to = Number(endText);
		} else {
			from = Number(range);
			to = stepText === undefined ? from : max;
		}

		if (!Number.isInteger(from) || !Number.isInteger(to) || from < min || to > max || from > to) {
			return null;
		}
		for (let value = from; value <= to; value += step) {
			values.add(sundayAlias !== null && value === sundayAlias ? 0 : value);
		}
	}

	return values.size > 0 ? values : null;
}

/* ------------------------------------------------------------------------- *
 * The whole plan
 * ------------------------------------------------------------------------- */

/** §5.1's job and cron refusals on their own — the `validateRenderInput` shape T6 uses. */
export function appJobRefusals(input: AppRenderInput, options: AppJobOptions = {}): AppJobRefusal[] {
	const refusals: AppJobRefusal[] = [];

	for (const job of input?.jobs ?? []) {
		const http = httpBlockOf(job);
		if (!http) {
			continue;
		}
		const authEnv = normaliseText(http.authEnv);
		if (!authEnv || !hasEnvValue(input, authEnv)) {
			refusals.push(credentialRefusal('job', String(job?.name ?? ''), authEnv));
		}
	}

	for (const cron of input?.cron ?? []) {
		const http = httpBlockOf(cron);
		if (http) {
			const authEnv = normaliseText(http.authEnv);
			if (!authEnv || !hasEnvValue(input, authEnv)) {
				refusals.push(credentialRefusal('cron', String(cron?.name ?? ''), authEnv));
			}
		}
		if (cronTooFrequent(input, cron)) {
			refusals.push({
				code: 'cron_too_frequent',
				names: [String(cron?.name ?? '')],
				message: `Cron entry "${String(cron?.name ?? '')}" can fire every ${String(cronMinIntervalMinutes(cron?.schedule))} minute(s); Ever Works Apps requires at least ${intervalMinutesOf(input)}. Plan §4.9.`
			});
		}
	}

	return refusals;
}

function credentialRefusal(kind: 'job' | 'cron', name: string, authEnv: string | null): AppJobRefusal {
	const subject = kind === 'cron' ? 'Cron entry' : 'Job';
	const detail = authEnv
		? `its authEnv "${authEnv}" has no value in the App's runtime env`
		: 'it declares no authEnv';
	return {
		code: kind === 'cron' ? 'cron_auth_env_unset' : 'job_auth_env_unset',
		names: [name],
		message: `${subject} "${name}" cannot run an authenticated request: ${detail}. Plan §4.9 never renders a call without a credential.`
	};
}

/**
 * Everything §4.8/§4.9 render, in apply order: for each job or cron entry, its runner ConfigMap
 * first and then the object that mounts it.
 *
 * `options.when` selects the job phases (§5.5 renders them in phases 2, 4 and 9), `options.paused`
 * reaches the CronJobs (ACC-06-35), and a verification ref gets its pre-deploy/first-deploy jobs
 * with no CronJob (plan §4.12).
 */
export function planAppJobs(input: AppRenderInput, options: AppJobOptions = {}): AppJobRenderPlan {
	const objects: AppRenderedObject[] = [];
	const runnerConfigMaps: AppRenderedObject[] = [];
	const jobs: AppJobPlanEntry[] = [];
	const cronJobs: AppJobPlanEntry[] = [];
	const phases = phasesOf(options);
	const verification = input?.purpose === 'verification';

	for (const job of input?.jobs ?? []) {
		if (!phases.includes(job?.when)) {
			continue;
		}
		if (verification && job?.when === 'post-deploy') {
			continue;
		}

		if (httpBlockOf(job)) {
			const scoped: AppJobOptions = { ...options, job, manualRunShort: null };
			const configMap = renderRunnerConfigMap(input, 'http-job', scoped);
			const object = renderRunnerJob(input, 'http-job', scoped);
			if (!configMap || !object) {
				continue;
			}
			objects.push(configMap, object);
			runnerConfigMaps.push(configMap);
			jobs.push({
				name: String(job.name ?? ''),
				objectName: object.metadata.name,
				kind: 'runner',
				when: job.when,
				configMapName: configMap.metadata.name
			});
			continue;
		}

		const object = renderCommandJob(input, job, options);
		if (!object) {
			continue;
		}
		objects.push(object);
		jobs.push({
			name: String(job?.name ?? ''),
			objectName: object.metadata.name,
			kind: 'command',
			when: job?.when ?? null
		});
	}

	for (const kind of ['smoke', 'hairpin', 'isolation-probe'] as const) {
		// A Deployment's own smoke, hairpin and probe runs are never "manual runs": the manual short
		// id belongs to §9.10's `runAppJob`, which renders the one job it is asked for directly.
		const scoped: AppJobOptions = { ...options, job: null, cron: null, manualRunShort: null };
		const configMap = renderRunnerConfigMap(input, kind, scoped);
		const object = renderRunnerJob(input, kind, scoped);
		if (!configMap || !object) {
			continue;
		}
		objects.push(configMap, object);
		runnerConfigMaps.push(configMap);
		jobs.push({
			name: runnerRunName(kind),
			objectName: object.metadata.name,
			kind: 'runner',
			when: null,
			configMapName: configMap.metadata.name
		});
	}

	if (!verification) {
		for (const cron of input?.cron ?? []) {
			const scoped: AppJobOptions = { ...options, cron };
			const object = renderCronJob(input, cron, scoped);
			if (!object) {
				continue;
			}
			const configMap = httpBlockOf(cron) ? renderRunnerConfigMap(input, 'cron', scoped) : null;
			if (configMap) {
				objects.push(configMap, object);
				runnerConfigMaps.push(configMap);
			} else {
				objects.push(object);
			}
			cronJobs.push({
				name: String(cron?.name ?? ''),
				objectName: object.metadata.name,
				kind: configMap ? 'runner' : 'command',
				when: null,
				...(configMap ? { configMapName: configMap.metadata.name } : {})
			});
		}
	}

	const refusals = appJobRefusals(input, options);
	return { objects, runnerConfigMaps, jobs, cronJobs, refusals, ok: refusals.length === 0 };
}

/** The name a runner run reports under — the same name its Job carries (plan §4.1). */
export function runnerRunName(kind: AppRunnerKind): string {
	if (kind === 'smoke') return APP_SMOKE_JOB_NAME;
	if (kind === 'hairpin') return APP_HAIRPIN_JOB_NAME;
	if (kind === 'isolation-probe') return APP_ISOLATION_PROBE_JOB_NAME;
	return kind;
}

function phasesOf(options: AppJobOptions): AppJobInput['when'][] {
	const declared = options?.when;
	if (!declared) {
		return ['pre-deploy', 'first-deploy', 'post-deploy'];
	}
	return Array.isArray(declared) ? [...declared] : [declared as AppJobInput['when']];
}
