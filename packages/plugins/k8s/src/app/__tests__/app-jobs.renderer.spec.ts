/**
 * T8 — `app-jobs.renderer.ts` (plan §4.8, §4.9; spec FR-19/FR-20/FR-35/FR-37/FR-51; ACC-06-12,
 * ACC-06-35).
 *
 * Every clause of T8's `**Test**` line (tasks.md:157-159) has an `it` below whose title names the
 * clause, plus the T8 prose clauses and the `**Done when**` line (tasks.md:163-164):
 *
 * - "backoff/deadline/TTL/Never"
 * - "the ConfigMap contains paths with `$(`, backticks and quotes verbatim as JSON data and no
 *   command string contains them"
 * - "cron auth via `secretKeyRef`"
 * - "`concurrencyPolicy` mapping"
 * - "`suspend: true` when paused (ACC-06-35)"
 * - "no rendered `command`/`args` contains a value read from the App spec's `http` block"
 *
 * The golden render input is the T6 fixture `render-input.web-worker-volume.json` (APW-03
 * `schema.md` §24.3), mutated per case — so this suite renders against the same input T6 pins.
 *
 * Pure functions only: no clock, no I/O, no cluster access. Fixtures carry no real host, digest or
 * secret (RFC 2606 hosts, RFC 5737 addresses, synthetic digests).
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import type { AppRenderInput } from '@ever-works/plugin';

import { planAppRender } from '../app-manifest.renderer';
import { runnerConfigMapName } from '../app-names';
import { APP_ISOLATION_PROBE_LABEL } from '../app-network-policy.renderer';
import { APP_RUNNER_RUN_AS_USER } from '../app-security';
import {
	APP_AUTH_SCHEME_DEFAULT,
	APP_CRON_FAILED_HISTORY_LIMIT,
	APP_CRON_STARTING_DEADLINE_S,
	APP_CRON_SUCCESSFUL_HISTORY_LIMIT,
	APP_CRON_TIME_ZONE,
	APP_JOB_HTTP_METHOD_DEFAULT,
	APP_JOB_RUNS_KEPT,
	APP_JOB_TIMEOUT_DEFAULT_S,
	APP_JOB_TTL_SECONDS,
	APP_MANAGED_CRON_MIN_INTERVAL_MIN,
	APP_SMOKE_EXPECT_STATUS,
	APP_SMOKE_HTTP_METHOD_DEFAULT,
	appJobRefusals,
	cronMinIntervalMinutes,
	planAppJobs,
	renderCommandJob,
	renderRunnerConfigMap,
	renderRunnerJob,
	runnerConfigHash,
	type AppJobOptions,
	type AppJobRenderPlan,
	type AppRunnerJobKind
} from '../app-jobs.renderer';
import {
	APP_RUNNER_CONFIGMAP_REQUESTS_KEY,
	APP_RUNNER_CONFIGMAP_SCRIPT_KEY,
	APP_RUNNER_FOUND_CHARS,
	APP_RUNNER_IMAGE,
	APP_RUNNER_MAX_BODY_BYTES,
	APP_RUNNER_MOUNT_PATH,
	APP_RUNNER_REQUESTS_ENV,
	APP_RUNNER_REQUESTS_FILE,
	APP_RUNNER_SCRIPT,
	APP_RUNNER_SCRIPT_FILE,
	type AppRunnerPayload,
	type AppRunnerRequestData
} from '../app-runner.script';

// --- fixture plumbing -------------------------------------------------------

type Json = Record<string, any>;

const asJson = (object: unknown): Json => object as unknown as Json;

function fixtureInput(): Json {
	return JSON.parse(
		readFileSync(new URL('./fixtures/render-input.web-worker-volume.json', import.meta.url), 'utf8')
	) as Json;
}

/** The fixture with `change` applied to a deep copy — never mutating the shared fixture. */
function inputWith(
	change: (draft: Json) => void,
	options?: AppJobOptions
): { input: AppRenderInput; plan: AppJobRenderPlan } {
	const draft = fixtureInput();
	change(draft);
	const input = draft as unknown as AppRenderInput;
	return { input, plan: planAppJobs(input, options) };
}

function httpJob(over: Json = {}): Json {
	return {
		name: 'seed',
		when: 'first-deploy',
		component: 'web',
		...over,
		http: { path: '/api/seed', authEnv: 'SESSION_SECRET', ...(over.http ?? {}) }
	};
}

function httpCron(over: Json = {}): Json {
	return {
		name: 'ping',
		schedule: '*/10 * * * *',
		component: 'web',
		...over,
		http: { path: '/api/ping', authEnv: 'SESSION_SECRET', ...(over.http ?? {}) }
	};
}

/** A rendered ConfigMap, reached by its payload kind and — for jobs and cron — its own name. */
function configMapFor(plan: AppJobRenderPlan, kind: string, name?: string): Json {
	const found = plan.runnerConfigMaps.find((configMap) => {
		const payload = payloadOf(asJson(configMap));
		return payload.kind === kind && (name === undefined || payload.name === name);
	});
	expect(found, `a runner ConfigMap for ${kind}${name ? ` ${name}` : ''}`).toBeDefined();
	return asJson(found);
}

function objectNamed(plan: AppJobRenderPlan, kind: string, name: string): Json | undefined {
	const found = plan.objects.find((object) => object.kind === kind && object.metadata.name === name);
	return found ? asJson(found) : undefined;
}

/** Every `configMap` volume source referenced by a rendered Job/CronJob. */
function configMapSources(object: Json): string[] {
	const names: string[] = [];
	const walk = (value: unknown): void => {
		if (!value || typeof value !== 'object') return;
		if (Array.isArray(value)) {
			value.forEach(walk);
			return;
		}
		const record = value as Json;
		if (record.configMap?.name) names.push(String(record.configMap.name));
		Object.values(record).forEach(walk);
	};
	walk(object);
	return names;
}

/** Every `command` / `args` array in a rendered object, wherever it sits. */
function commandLines(object: Json): string[] {
	const lines: string[] = [];
	const walk = (value: unknown): void => {
		if (!value || typeof value !== 'object') return;
		if (Array.isArray(value)) {
			value.forEach(walk);
			return;
		}
		const record = value as Json;
		for (const key of ['command', 'args']) {
			if (Array.isArray(record[key])) lines.push(...record[key].map((entry: unknown) => String(entry)));
		}
		Object.values(record).forEach(walk);
	};
	walk(object);
	return lines;
}

/** The runner payload a rendered ConfigMap carries. */
function payloadOf(configMap: Json): AppRunnerPayload {
	return JSON.parse(String(configMap.data[APP_RUNNER_CONFIGMAP_REQUESTS_KEY])) as AppRunnerPayload;
}

const requestsOf = (configMap: Json): AppRunnerRequestData[] => payloadOf(configMap).requests;

function planFor(change: (draft: Json) => void, options?: AppJobOptions): AppJobRenderPlan {
	return inputWith(change, options).plan;
}

function jobObject(change: (draft: Json) => void, name: string, options?: AppJobOptions): Json {
	const found = objectNamed(planFor(change, options), 'Job', name);
	expect(found, `a Job named ${name}`).toBeDefined();
	return found as Json;
}

function cronObject(change: (draft: Json) => void, name: string, options?: AppJobOptions): Json {
	const found = objectNamed(planFor(change, options), 'CronJob', name);
	expect(found, `a CronJob named ${name}`).toBeDefined();
	return found as Json;
}

const podSpecOf = (workload: Json): Json => workload.spec.template.spec;
const cronPodSpecOf = (cronJob: Json): Json => cronJob.spec.jobTemplate.spec.template.spec;

const RUNNER_JOB = 'job-seed-5e6f7a8b';
const PURGE = 'cron-purge-trash';
const PING = 'cron-ping';

const seedChange = (draft: Json): void => {
	draft.jobs.push(httpJob());
};

// --- the runner image constant ---------------------------------------------

describe('APP_RUNNER_IMAGE (plan §4.8 — "a digest-pinned public Node.js runtime image")', () => {
	it('is digest-pinned, so a bumped tag can never change what runs', () => {
		expect(APP_RUNNER_IMAGE).toMatch(/@sha256:[0-9a-f]{64}$/);
		expect(APP_RUNNER_IMAGE).not.toMatch(/:(latest|22|22-alpine)$/);
	});

	it('is a public Node.js runtime image needing no pull credential', () => {
		// No private registry host: the runner Job carries no `imagePullSecrets` (§4.8 gives the
		// runner none), so the reference must be pullable as-is.
		expect(APP_RUNNER_IMAGE.startsWith('node@')).toBe(true);
	});
});

// --- command jobs (plan §4.8 bullet 1) -------------------------------------

describe('renderCommandJob (plan §4.8: "a Job with the component\'s image, env, security context and resources")', () => {
	const MIGRATE = 'job-migrate-5e6f7a8b';

	it('maps `retries` to backoffLimit, and 0 when the spec is silent', () => {
		expect(jobObject(() => undefined, MIGRATE).spec.backoffLimit).toBe(1);
		expect(
			jobObject((draft) => {
				delete draft.jobs[0].retries;
			}, MIGRATE).spec.backoffLimit
		).toBe(0);
	});

	it('maps `timeoutSeconds` to activeDeadlineSeconds, and 600 when the spec is silent', () => {
		expect(jobObject(() => undefined, MIGRATE).spec.activeDeadlineSeconds).toBe(900);
		expect(
			jobObject((draft) => {
				delete draft.jobs[0].timeoutSeconds;
			}, MIGRATE).spec.activeDeadlineSeconds
		).toBe(APP_JOB_TIMEOUT_DEFAULT_S);
		expect(APP_JOB_TIMEOUT_DEFAULT_S).toBe(600);
	});

	it('sets ttlSecondsAfterFinished to 86 400 (§4.8 TTL) and restartPolicy Never', () => {
		const job = jobObject(() => undefined, MIGRATE);
		expect(job.spec.ttlSecondsAfterFinished).toBe(APP_JOB_TTL_SECONDS);
		expect(APP_JOB_TTL_SECONDS).toBe(86_400);
		expect(podSpecOf(job).restartPolicy).toBe('Never');
	});

	it('uses the component image, command, args, resources and security context', () => {
		const job = jobObject((draft) => {
			draft.components[0].args = ['--verbose'];
		}, MIGRATE);
		const container = podSpecOf(job).containers[0];

		expect(container.image).toContain('registry.example.com/example-org/helpdesk@sha256:');
		expect(container.command).toEqual(['node', 'dist/migrate.js']);
		expect(container.args).toEqual(['--verbose']);
		expect(container.imagePullPolicy).toBe('IfNotPresent');
		expect(container.resources.requests).toEqual({ cpu: '500m', memory: '768Mi' });
		expect(container.securityContext.allowPrivilegeEscalation).toBe(false);
		expect(container.securityContext.readOnlyRootFilesystem).toBe(true);
		expect(container.securityContext.capabilities).toEqual({ drop: ['ALL'] });
		expect(podSpecOf(job).securityContext.runAsNonRoot).toBe(true);
		expect(podSpecOf(job).securityContext.seccompProfile).toEqual({ type: 'RuntimeDefault' });
	});

	it('references the App env through `envFrom` and writes no env value (§4.3, ACC-06-16)', () => {
		const { input } = inputWith(() => undefined);
		const render = planAppRender(input);
		const job = asJson(renderCommandJob(input, input.jobs[0]) as never);
		const container = podSpecOf(job).containers[0];

		expect(container.env).toBeUndefined();
		expect(container.envFrom).toEqual([
			{ secretRef: { name: render.envSecretName, optional: false } },
			{ configMapRef: { name: render.platformConfigMapName, optional: false } }
		]);
		expect(JSON.stringify(job)).not.toContain('fixture-placeholder-session-secret');
	});

	it('never mounts a service-account token', () => {
		const podSpec = podSpecOf(jobObject(() => undefined, MIGRATE));
		expect(podSpec.automountServiceAccountToken).toBe(false);
		expect(podSpec.serviceAccountName).toBe('app');
		expect(podSpec.enableServiceLinks).toBe(false);
	});

	it('names the Job `job-<name>-<deploymentShort>` and labels it `ever-works.io/job`', () => {
		const job = jobObject(() => undefined, MIGRATE);
		expect(job.metadata.name).toBe('job-migrate-5e6f7a8b');
		expect(job.metadata.namespace).toBe('ew-helpdesk-1a2b3c4d');
		expect(job.metadata.labels['ever-works.io/job']).toBe('migrate');
		expect(job.spec.template.metadata.labels['ever-works.io/job']).toBe('migrate');
	});

	it('never carries `ever-works.io/component`, so no Service selector can route to a job pod', () => {
		const job = jobObject(() => undefined, MIGRATE);
		expect(job.metadata.labels['ever-works.io/component']).toBeUndefined();
		expect(job.spec.template.metadata.labels['ever-works.io/component']).toBeUndefined();
	});

	it('renders nothing for a job whose component is not in the render input', () => {
		const { input } = inputWith((draft) => {
			draft.jobs[0].component = 'missing';
		});
		expect(renderCommandJob(input, input.jobs[0])).toBeNull();
	});

	it('keeps at most the last 3 runs of each job name (plan §4.8)', () => {
		expect(APP_JOB_RUNS_KEPT).toBe(3);
	});
});

// --- runner jobs (plan §4.8 bullets 2-4) -----------------------------------

describe('renderRunnerJob (plan §4.8: "http jobs, http cron and every smoke run use the runner")', () => {
	it('runs a digest-pinned Node.js image with the mounted script, not the App image', () => {
		const container = podSpecOf(jobObject(seedChange, RUNNER_JOB)).containers[0];

		expect(container.image).toBe(APP_RUNNER_IMAGE);
		expect(container.command).toEqual(['node', APP_RUNNER_SCRIPT_FILE]);
		expect(container.name).toBe('runner');
	});

	it('mounts the runner ConfigMap read-only and passes the request file through the environment', () => {
		const plan = planFor(seedChange);
		const container = podSpecOf(jobObject(seedChange, RUNNER_JOB)).containers[0];
		const volume = podSpecOf(jobObject(seedChange, RUNNER_JOB)).volumes.find(
			(entry: Json) => entry.name === 'runner'
		);
		const configMap = configMapFor(plan, 'http-job', 'seed');

		expect(volume.configMap.name).toBe(configMap.metadata.name);
		expect(volume.configMap.name).toBe(runnerConfigMapName(runnerConfigHash(payloadOf(configMap))));
		expect(volume.configMap.defaultMode).toBe(0o444);
		expect(container.volumeMounts).toContainEqual({
			name: 'runner',
			mountPath: APP_RUNNER_MOUNT_PATH,
			readOnly: true
		});
		expect(container.env).toContainEqual({ name: APP_RUNNER_REQUESTS_ENV, value: APP_RUNNER_REQUESTS_FILE });
	});

	it('hardens the runner: uid 10001, non-root, read-only root, no token, no privilege escalation', () => {
		const podSpec = podSpecOf(jobObject(seedChange, RUNNER_JOB));
		const container = podSpec.containers[0];

		expect(APP_RUNNER_RUN_AS_USER).toBe(10001);
		expect(podSpec.securityContext.runAsUser).toBe(APP_RUNNER_RUN_AS_USER);
		expect(podSpec.securityContext.runAsNonRoot).toBe(true);
		expect(podSpec.securityContext.seccompProfile).toEqual({ type: 'RuntimeDefault' });
		expect(podSpec.automountServiceAccountToken).toBe(false);
		expect(podSpec.serviceAccountName).toBe('app');
		expect(container.securityContext.allowPrivilegeEscalation).toBe(false);
		expect(container.securityContext.readOnlyRootFilesystem).toBe(true);
		expect(container.securityContext.capabilities).toEqual({ drop: ['ALL'] });
		expect(container.envFrom).toBeUndefined();
	});

	it('asks for 50m/64Mi and limits the runner to 500m/128Mi (plan §4.8)', () => {
		expect(podSpecOf(jobObject(seedChange, RUNNER_JOB)).containers[0].resources).toEqual({
			requests: { cpu: '50m', memory: '64Mi' },
			limits: { cpu: '500m', memory: '128Mi' }
		});
	});

	it('sets activeDeadlineSeconds to the window + 30, the 86 400 s TTL and restartPolicy Never', () => {
		const job = jobObject(seedChange, RUNNER_JOB);
		expect(job.spec.activeDeadlineSeconds).toBe(150);

		const wide = jobObject(seedChange, RUNNER_JOB, { windowSeconds: 600 });
		expect(wide.spec.activeDeadlineSeconds).toBe(630);

		expect(job.spec.ttlSecondsAfterFinished).toBe(APP_JOB_TTL_SECONDS);
		expect(podSpecOf(job).restartPolicy).toBe('Never');
	});

	it('targets `http://<component>.<namespace>.svc:80<path>` (plan §4.9) with the POST default', () => {
		const request = requestsOf(configMapFor(planFor(seedChange), 'http-job', 'seed'))[0];

		expect(request.url).toBe('http://web.ew-helpdesk-1a2b3c4d.svc:80/api/seed');
		expect(request.method).toBe(APP_JOB_HTTP_METHOD_DEFAULT);
		expect(APP_JOB_HTTP_METHOD_DEFAULT).toBe('POST');
		expect(request.expect?.status).toEqual([200, 201, 204]);
	});

	it('is named `run-<name>-<8 hex>` for a manual run (plan §4.1, FR-51)', () => {
		const { input } = inputWith(seedChange);
		const job = asJson(
			renderRunnerJob(input, 'http-job', { job: input.jobs[1], manualRunShort: 'a1b2c3d4' }) as never
		);

		expect(job.metadata.name).toBe('run-seed-a1b2c3d4');
		expect(job.metadata.labels['ever-works.io/job']).toBe('seed');
	});

	it('mounts `authEnv` through `secretKeyRef`, never as a value (plan §4.8, ACC-06-16)', () => {
		const job = jobObject(seedChange, RUNNER_JOB);
		const container = podSpecOf(job).containers[0];

		expect(container.env).toContainEqual({
			name: 'SESSION_SECRET',
			valueFrom: { secretKeyRef: { name: 'app-env-b41d7e6c0a', key: 'SESSION_SECRET', optional: false } }
		});
		expect(JSON.stringify(job)).not.toContain('fixture-placeholder-session-secret');
	});

	it('defaults `authScheme` to bearer and carries `raw` through to the request data', () => {
		const bearer = requestsOf(configMapFor(planFor(seedChange), 'http-job', 'seed'))[0];
		expect(bearer.authScheme).toBe(APP_AUTH_SCHEME_DEFAULT);
		expect(APP_AUTH_SCHEME_DEFAULT).toBe('bearer');

		const raw = requestsOf(
			configMapFor(
				planFor((draft) => {
					draft.jobs.push(httpJob({ http: { authScheme: 'raw' } }));
				}),
				'http-job',
				'seed'
			)
		)[0];
		expect(raw.authScheme).toBe('raw');
	});

	it('resolves `{{env.NAME}}` from a `secretKeyRef` env var, and never inlines the value', () => {
		const change = (draft: Json): void => {
			draft.jobs.push(httpJob({ http: { body: { token: '{{env.SESSION_SECRET}}', keep: 'plain' } } }));
		};
		const job = jobObject(change, RUNNER_JOB);
		const configMap = configMapFor(planFor(change), 'http-job', 'seed');
		const container = podSpecOf(job).containers[0];

		expect(container.env).toContainEqual({
			name: 'SESSION_SECRET',
			valueFrom: { secretKeyRef: { name: 'app-env-b41d7e6c0a', key: 'SESSION_SECRET', optional: false } }
		});
		expect(payloadOf(configMap).secrets).toContain('SESSION_SECRET');
		expect(requestsOf(configMap)[0].body).toEqual({ token: '{{env.SESSION_SECRET}}', keep: 'plain' });
		expect(JSON.stringify(job)).not.toContain('fixture-placeholder-session-secret');
	});

	it('refuses an http job with no authEnv: no Job, no ConfigMap, and `job_auth_env_unset`', () => {
		const plan = planFor((draft) => {
			draft.jobs.push(httpJob({ http: { authEnv: undefined } }));
		});

		expect(objectNamed(plan, 'Job', RUNNER_JOB)).toBeUndefined();
		expect(plan.runnerConfigMaps.some((configMap) => payloadOf(asJson(configMap)).kind === 'http-job')).toBe(false);
		expect(plan.refusals.map((refusal) => refusal.code)).toContain('job_auth_env_unset');
		expect(plan.ok).toBe(false);
	});

	it('refuses an http job whose authEnv has no value in the env source', () => {
		const plan = planFor((draft) => {
			draft.jobs.push(httpJob({ http: { authEnv: 'NOT_SET_ANYWHERE' } }));
		});
		const refusal = plan.refusals.find((entry) => entry.code === 'job_auth_env_unset');

		expect(refusal).toBeDefined();
		expect(refusal?.names).toContain('seed');
	});

	it('renders a `smoke` runner job against the component Service, with the smoke defaults', () => {
		const plan = planFor(() => undefined);
		const smoke = objectNamed(plan, 'Job', 'job-smoke-5e6f7a8b');

		expect(smoke).toBeDefined();
		const request = requestsOf(configMapFor(plan, 'smoke'))[0];
		expect(request.url).toBe('http://web.ew-helpdesk-1a2b3c4d.svc:80/healthz');
		expect(request.method).toBe(APP_SMOKE_HTTP_METHOD_DEFAULT);
		expect(APP_SMOKE_HTTP_METHOD_DEFAULT).toBe('GET');
		expect(request.expect?.status).toEqual([...APP_SMOKE_EXPECT_STATUS]);
		expect(request.expect?.maxLatencyMs).toBe(10_000);
	});

	it('leaves a `first-deploy` smoke check out of a later Deployment (plan §5.5)', () => {
		const setup = {
			name: 'setup',
			component: 'web',
			http: { path: '/setup' },
			expect: { status: [200] },
			when: 'first-deploy'
		};
		const later = planFor((draft) => {
			draft.smoke.push(setup);
		});
		expect(requestsOf(configMapFor(later, 'smoke')).map((request) => request.name)).toEqual(['health']);

		const first = planFor((draft) => {
			draft.isFirstDeploymentOnCluster = true;
			draft.smoke.push(setup);
		});
		expect(requestsOf(configMapFor(first, 'smoke')).map((request) => request.name)).toEqual(['health', 'setup']);
	});

	it("renders a `smoke` runner job from a manual run's own checks (FR-51, `runner: 'smoke'`)", () => {
		const { input } = inputWith(() => undefined);
		const job = asJson(
			renderRunnerJob(input, 'smoke', {
				manualRunShort: 'deadbeef',
				checks: [
					{
						name: 'manual',
						component: 'web',
						http: { path: '/manual', method: 'GET' },
						expect: { status: [204], bodyContains: ['ok'], bodyNotContains: ['down'], maxLatencyMs: 500 }
					}
				]
			}) as never
		);

		expect(job.metadata.name).toBe('run-smoke-deadbeef');
	});

	it('targets the public URL for a `hairpin` run, and renders nothing when it cannot', () => {
		const plan = planFor(() => undefined);
		expect(objectNamed(plan, 'Job', 'job-hairpin-5e6f7a8b')).toBeDefined();
		expect(requestsOf(configMapFor(plan, 'hairpin'))[0].url).toBe('https://helpdesk.example.com/healthz');

		const off = planFor((draft) => {
			draft.network.needsHairpin = false;
		});
		expect(objectNamed(off, 'Job', 'job-hairpin-5e6f7a8b')).toBeUndefined();

		const hostless = planFor((draft) => {
			draft.hosts.primary = null;
		});
		expect(objectNamed(hostless, 'Job', 'job-hairpin-5e6f7a8b')).toBeUndefined();

		const verification = planFor((draft) => {
			draft.purpose = 'verification';
		});
		expect(objectNamed(verification, 'Job', 'job-hairpin-5e6f7a8b')).toBeUndefined();
	});

	it('labels an `isolation-probe` pod with `ever-works.io/isolation-probe` (plan §4.10, APW06-G18)', () => {
		const plan = planFor(() => undefined);
		const probe = objectNamed(plan, 'Job', 'job-isolation-probe-5e6f7a8b') as Json;

		expect(probe.spec.template.metadata.labels[APP_ISOLATION_PROBE_LABEL]).toBe('true');
		expect(probe.spec.template.metadata.labels['ever-works.io/component']).toBeUndefined();
		expect(payloadOf(configMapFor(plan, 'isolation-probe')).isolationProbe?.timeoutMs).toBe(3000);
		expect(requestsOf(configMapFor(plan, 'isolation-probe'))).toEqual([]);
	});

	it('renders no isolation probe when isolation is off (§4.10: "no probe runs")', () => {
		const plan = planFor((draft) => {
			draft.network.isolation = false;
		});
		expect(objectNamed(plan, 'Job', 'job-isolation-probe-5e6f7a8b')).toBeUndefined();
	});

	it('names the runner ConfigMap `ew-runner-<hash10>` — identical payload, identical name', () => {
		const first = configMapFor(planFor(seedChange), 'http-job', 'seed');
		const second = configMapFor(planFor(seedChange), 'http-job', 'seed');
		expect(first.metadata.name).toMatch(/^ew-runner-[0-9a-f]{10}$/);
		expect(first.metadata.name).toBe(second.metadata.name);

		const changed = configMapFor(
			planFor((draft) => {
				draft.jobs.push(httpJob({ http: { path: '/api/seed-v2' } }));
			}),
			'http-job',
			'seed'
		);
		expect(changed.metadata.name).not.toBe(first.metadata.name);
	});

	it('carries the runner script itself in the ConfigMap, under the documented key', () => {
		const configMap = configMapFor(
			planFor(() => undefined),
			'smoke'
		);
		expect(configMap.data[APP_RUNNER_CONFIGMAP_SCRIPT_KEY]).toBe(APP_RUNNER_SCRIPT);
		expect(APP_RUNNER_MAX_BODY_BYTES).toBe(1_048_576);
		expect(APP_RUNNER_FOUND_CHARS).toBe(200);
	});

	it('renders no Job for a `when` phase the caller did not ask for', () => {
		const plan = planFor(
			(draft) => {
				draft.jobs.push(httpJob({ when: 'post-deploy' }));
			},
			{ when: 'pre-deploy' }
		);
		expect(objectNamed(plan, 'Job', RUNNER_JOB)).toBeUndefined();
		expect(objectNamed(plan, 'Job', 'job-migrate-5e6f7a8b')).toBeDefined();
	});
});

// --- data, never a command line (plan §4.8, Constitution X) ----------------

describe('paths and bodies are data, never a command line (plan §4.8, T8 `**Done when**`)', () => {
	const HOSTILE_PATH = '/api/$(id)/`tick`/"quoted"/${HOME}/it\'s';
	const HOSTILE_BODY = { note: '`tick`', command: '$(whoami)', quote: '"double"', single: "'single'" };

	it('keeps `$(`, backticks and quotes verbatim as JSON data in the ConfigMap', () => {
		const plan = planFor((draft) => {
			draft.jobs.push(httpJob({ http: { path: HOSTILE_PATH, body: HOSTILE_BODY } }));
		});
		const configMap = configMapFor(plan, 'http-job', 'seed');
		const raw = String(configMap.data[APP_RUNNER_CONFIGMAP_REQUESTS_KEY]);
		const request = requestsOf(configMap)[0];

		expect(raw).toContain('$(id)');
		expect(raw).toContain('`tick`');
		// Quotes are JSON-escaped in the serialized text and byte-exact once parsed back.
		expect(raw).toContain('quoted');
		expect(request.url.endsWith(HOSTILE_PATH)).toBe(true);
		expect(request.body).toEqual(HOSTILE_BODY);
		expect(JSON.parse(raw).requests[0].url.endsWith(HOSTILE_PATH)).toBe(true);
	});

	it('never puts a value read from an App spec `http` block into a `command` or `args`', () => {
		const plan = planFor((draft) => {
			draft.jobs.push(httpJob({ http: { path: HOSTILE_PATH, body: HOSTILE_BODY } }));
			draft.cron.push(httpCron({ http: { path: HOSTILE_PATH, body: HOSTILE_BODY } }));
		});

		const forbidden = ['$(id)', '`tick`', '"quoted"', '$(whoami)', '/api/', '{{env.', HOSTILE_PATH];
		const lines = plan.objects.flatMap((object) => commandLines(asJson(object)));

		expect(lines.length).toBeGreaterThan(0);
		for (const line of lines) {
			for (const needle of forbidden) {
				expect(line, `command/args must not contain ${needle}`).not.toContain(needle);
			}
		}
		// The only command lines in the whole render are the components' own and the runner's.
		expect(lines).toContain('dist/migrate.js');
		expect(lines).toContain(APP_RUNNER_SCRIPT_FILE);
	});

	it('never writes the App image, an env value or a secret into the runner ConfigMap', () => {
		const plan = planFor(seedChange);
		const raw = JSON.stringify(plan.runnerConfigMaps.map((configMap) => asJson(configMap).data));

		expect(raw).not.toContain('registry.example.com');
		expect(raw).not.toContain('fixture-placeholder');
		expect(raw).not.toContain('{{env.DATABASE_URL}}');
	});
});

// --- CronJobs (plan §4.9) --------------------------------------------------

describe('renderCronJob (plan §4.9)', () => {
	it('renders schedule, UTC time zone, starting deadline and history limits', () => {
		const cron = cronObject(() => undefined, PURGE);

		expect(cron.apiVersion).toBe('batch/v1');
		expect(cron.spec.schedule).toBe('30 3 * * *');
		expect(cron.spec.timeZone).toBe(APP_CRON_TIME_ZONE);
		expect(APP_CRON_TIME_ZONE).toBe('Etc/UTC');
		expect(cron.spec.startingDeadlineSeconds).toBe(APP_CRON_STARTING_DEADLINE_S);
		expect(APP_CRON_STARTING_DEADLINE_S).toBe(300);
		expect(cron.spec.successfulJobsHistoryLimit).toBe(APP_CRON_SUCCESSFUL_HISTORY_LIMIT);
		expect(APP_CRON_SUCCESSFUL_HISTORY_LIMIT).toBe(1);
		expect(cron.spec.failedJobsHistoryLimit).toBe(APP_CRON_FAILED_HISTORY_LIMIT);
		expect(APP_CRON_FAILED_HISTORY_LIMIT).toBe(3);
		expect(cron.metadata.name).toBe(PURGE);
		expect(cron.metadata.labels['ever-works.io/cron']).toBe('purge-trash');
	});

	it('maps `concurrency` to concurrencyPolicy, defaulting to Forbid', () => {
		expect(cronObject(() => undefined, PURGE).spec.concurrencyPolicy).toBe('Forbid');
		expect(
			cronObject((draft) => {
				draft.cron[0].concurrency = 'allow';
			}, PURGE).spec.concurrencyPolicy
		).toBe('Allow');
		expect(
			cronObject((draft) => {
				draft.cron[0].concurrency = 'forbid';
			}, PURGE).spec.concurrencyPolicy
		).toBe('Forbid');
	});

	it('sets `suspend: true` when paused, and leaves the CronJob in place (ACC-06-35)', () => {
		expect(cronObject(() => undefined, PURGE, { paused: true }).spec.suspend).toBe(true);
		expect(cronObject(() => undefined, PURGE, { paused: false }).spec.suspend).toBe(false);
		expect(cronObject(() => undefined, PURGE).spec.suspend).toBe(false);
	});

	it('runs a `command` cron on the component image with the component command', () => {
		const cron = cronObject(() => undefined, PURGE);
		const container = cronPodSpecOf(cron).containers[0];

		expect(container.image).toContain('registry.example.com/example-org/helpdesk@sha256:');
		expect(container.command).toEqual(['node', 'dist/purge.js']);
		expect(cronPodSpecOf(cron).restartPolicy).toBe('Never');
		expect(cron.spec.jobTemplate.spec.activeDeadlineSeconds).toBe(300);
		expect(cron.spec.jobTemplate.spec.ttlSecondsAfterFinished).toBe(APP_JOB_TTL_SECONDS);
	});

	it('runs an `http` cron through the runner with the credential in a `secretKeyRef`', () => {
		const change = (draft: Json): void => {
			draft.cron.push(httpCron());
		};
		const plan = planFor(change);
		const cron = objectNamed(plan, 'CronJob', PING) as Json;
		const container = cronPodSpecOf(cron).containers[0];

		expect(container.image).toBe(APP_RUNNER_IMAGE);
		expect(container.env).toContainEqual({
			name: 'SESSION_SECRET',
			valueFrom: { secretKeyRef: { name: 'app-env-b41d7e6c0a', key: 'SESSION_SECRET', optional: false } }
		});
		expect(
			container.env.some((entry: Json) => typeof entry.value === 'string' && entry.value.includes('fixture'))
		).toBe(false);
		expect(configMapSources(cron)).toContain(configMapFor(plan, 'cron', 'ping').metadata.name);
		expect(requestsOf(configMapFor(plan, 'cron', 'ping'))[0].url).toBe(
			'http://web.ew-helpdesk-1a2b3c4d.svc:80/api/ping'
		);
		expect(requestsOf(configMapFor(plan, 'cron', 'ping'))[0].authScheme).toBe('bearer');
	});

	it('refuses an `http` cron with no credential: no CronJob and `cron_auth_env_unset`', () => {
		const plan = planFor((draft) => {
			draft.cron.push(httpCron({ http: { authEnv: undefined } }));
		});

		expect(objectNamed(plan, 'CronJob', PING)).toBeUndefined();
		expect(plan.refusals.map((refusal) => refusal.code)).toContain('cron_auth_env_unset');
		expect(plan.ok).toBe(false);
	});

	it('refuses an `http` cron whose authEnv value is empty', () => {
		const plan = planFor((draft) => {
			draft.env.values.SESSION_SECRET = '';
			draft.cron.push(httpCron());
		});
		expect(plan.refusals.map((refusal) => refusal.code)).toContain('cron_auth_env_unset');
	});

	it('refuses a managed schedule that can fire more often than every 5 minutes', () => {
		const managed = planFor((draft) => {
			draft.ref.target = 'ever-works-apps';
			draft.cron.push(httpCron({ schedule: '*/1 * * * *' }));
		});
		expect(managed.refusals.map((refusal) => refusal.code)).toContain('cron_too_frequent');
		expect(objectNamed(managed, 'CronJob', PING)).toBeUndefined();

		const everyFive = planFor((draft) => {
			draft.ref.target = 'ever-works-apps';
			draft.cron.push(httpCron({ schedule: '*/5 * * * *' }));
		});
		expect(everyFive.refusals.map((refusal) => refusal.code)).not.toContain('cron_too_frequent');
		expect(objectNamed(everyFive, 'CronJob', PING)).toBeDefined();
	});

	it('leaves Your cluster free of the managed 5-minute rule (plan §4.9: `ever-works-apps` only)', () => {
		const yours = planFor((draft) => {
			draft.ref.target = 'your-cluster';
			draft.cron.push(httpCron({ schedule: '* * * * *' }));
		});
		expect(yours.refusals.map((refusal) => refusal.code)).not.toContain('cron_too_frequent');
		expect(objectNamed(yours, 'CronJob', PING)).toBeDefined();
	});

	it('honours a caller-supplied `cronMinIntervalMinutes` instead of the default 5', () => {
		const strict = planFor((draft) => {
			draft.ref.target = 'ever-works-apps';
			draft.policy.cronMinIntervalMinutes = 15;
			draft.cron.push(httpCron({ schedule: '*/10 * * * *' }));
		});
		expect(strict.refusals.map((refusal) => refusal.code)).toContain('cron_too_frequent');

		expect(APP_MANAGED_CRON_MIN_INTERVAL_MIN).toBe(5);
	});

	it('writes no per-Deployment value into the CronJob (plan §4.3, APW06-G07, ACC-06-58)', () => {
		const raw = JSON.stringify(
			planFor((draft) => {
				draft.cron.push(httpCron());
			}).objects.filter((object) => object.kind === 'CronJob')
		);
		expect(raw).not.toContain('5e6f7a8b');
		expect(raw).not.toContain('5e6f7a8b-3333-4444-8555-666677778888');
		expect(raw).not.toContain('ever-works.io/deployment-id');
		expect(raw).not.toContain('ever-works.io/env-checksum');
	});

	it('renders no CronJob for a verification ref (plan §4.12)', () => {
		const plan = planFor((draft) => {
			draft.purpose = 'verification';
		});
		expect(plan.cronJobs).toHaveLength(0);
	});
});

// --- the cron frequency rule (plan §4.9) -----------------------------------

describe('cronMinIntervalMinutes (plan §4.9: "schedules that can fire more often than every 5 minutes")', () => {
	const cases: Array<[string, number | null]> = [
		['* * * * *', 1],
		['*/1 * * * *', 1],
		['*/10 * * * *', 10],
		['0,30 * * * *', 30],
		['0 * * * *', 60],
		['30 3 * * *', 1440],
		['0 0 * * 0', 10_080],
		['@hourly', 60],
		['@daily', 1440],
		['@weekly', 10_080],
		['*/7 * * * *', 4]
	];

	for (const [schedule, expected] of cases) {
		it(`reports ${String(expected)} minute(s) for \`${schedule}\``, () => {
			expect(cronMinIntervalMinutes(schedule), schedule).toBe(expected);
		});
	}

	it('reports nothing it cannot prove: a yearly schedule and an unparseable one', () => {
		// A yearly (or rarer) schedule can never be too frequent; an unparseable one is
		// `spec_invalid` (§5.1), a different code — this check must not invent a refusal.
		for (const schedule of ['0 0 1 1 *', 'not a schedule', '', '   ']) {
			const interval = cronMinIntervalMinutes(schedule);
			expect(interval === null || interval >= APP_MANAGED_CRON_MIN_INTERVAL_MIN, schedule).toBe(true);
		}
		expect(cronMinIntervalMinutes('not a schedule')).toBeNull();
	});

	it('reads `*/7` as 4 minutes — the last fire of an hour to the first of the next', () => {
		// The reason the check is a real scan and not "the smallest step in the field".
		expect(cronMinIntervalMinutes('*/7 * * * *')).toBe(4);
	});

	it('treats a 6-field schedule (seconds) as firing more often than a minute', () => {
		expect(cronMinIntervalMinutes('*/30 * * * * *')).toBe(1);
	});

	it('respects a day-of-month + day-of-week union (robfig/cron, as Kubernetes uses it)', () => {
		// `0 0 1 * 1` fires on the 1st **or** on a Monday. The two can fall on consecutive days —
		// 2024-09-01 is a Sunday and 2024-09-02 is a Monday — so the shortest gap is one day, not a
		// week: the union of two restricted day fields is what a step-size reading would miss.
		expect(cronMinIntervalMinutes('0 0 1 * 1')).toBe(1_440);
		// `0 0 * * 1` (Mondays only) is a real week.
		expect(cronMinIntervalMinutes('0 0 * * 1')).toBe(10_080);
	});
});

// --- the whole plan --------------------------------------------------------

describe('planAppJobs', () => {
	it('applies each runner ConfigMap before the Job or CronJob that mounts it', () => {
		const plan = planFor((draft) => {
			draft.jobs.push(httpJob());
			draft.cron.push(httpCron());
		});
		const names = plan.objects.map((object) => `${object.kind}/${object.metadata.name}`);

		for (const object of plan.objects) {
			if (object.kind !== 'Job' && object.kind !== 'CronJob') continue;
			for (const source of configMapSources(asJson(object))) {
				expect(names.indexOf(`ConfigMap/${source}`)).toBeGreaterThanOrEqual(0);
				expect(names.indexOf(`ConfigMap/${source}`)).toBeLessThan(
					names.indexOf(`${object.kind}/${object.metadata.name}`)
				);
			}
		}
	});

	it('reports every rendered job and cron by name, kind and phase', () => {
		const plan = planFor((draft) => {
			draft.jobs.push(httpJob());
			draft.cron.push(httpCron());
		});

		expect(plan.jobs.map((job) => job.name)).toEqual(['migrate', 'seed', 'smoke', 'hairpin', 'isolation-probe']);
		expect(plan.jobs.map((job) => job.kind)).toEqual(['command', 'runner', 'runner', 'runner', 'runner']);
		expect(plan.jobs[0].when).toBe('pre-deploy');
		expect(plan.jobs[1].when).toBe('first-deploy');
		expect(plan.cronJobs.map((cron) => cron.name)).toEqual(['purge-trash', 'ping']);
		expect(plan.cronJobs.map((cron) => cron.kind)).toEqual(['command', 'runner']);
		expect(plan.ok).toBe(true);
	});

	it('is pure: the same input renders byte-identical objects twice', () => {
		const change = (draft: Json): void => {
			draft.jobs.push(httpJob());
			draft.cron.push(httpCron());
		};
		expect(JSON.stringify(planFor(change).objects)).toBe(JSON.stringify(planFor(change).objects));
	});

	it('exposes the refusals on their own, in the `AppPrecondition`-shaped form T6 uses', () => {
		const { input } = inputWith((draft) => {
			draft.jobs.push(httpJob({ http: { authEnv: undefined } }));
			draft.ref.target = 'ever-works-apps';
			draft.cron.push(httpCron({ schedule: '* * * * *' }));
		});
		const codes = appJobRefusals(input).map((refusal) => refusal.code);

		expect(codes).toContain('job_auth_env_unset');
		expect(codes).toContain('cron_too_frequent');
	});

	it('renders a verification ref its jobs but no CronJob and no hairpin (plan §4.12)', () => {
		const plan = planFor((draft) => {
			draft.purpose = 'verification';
			draft.jobs.push(httpJob({ when: 'post-deploy' }));
		});

		expect(plan.cronJobs).toHaveLength(0);
		expect(plan.jobs.map((job) => job.name)).toEqual(['migrate', 'smoke', 'isolation-probe']);
		expect(plan.jobs.every((job) => job.when !== 'post-deploy')).toBe(true);
		expect(objectNamed(plan, 'Job', 'job-hairpin-5e6f7a8b')).toBeUndefined();
	});
});

// --- the four runner kinds -------------------------------------------------

describe('renderRunnerJob kind union (T8: `http-job` | `smoke` | `hairpin` | `isolation-probe`)', () => {
	const kinds: AppRunnerJobKind[] = ['http-job', 'smoke', 'hairpin', 'isolation-probe'];

	it('accepts every kind of the union, and renders nothing it cannot build', () => {
		const { input } = inputWith(() => undefined);
		for (const kind of kinds) {
			const job = renderRunnerJob(input, kind);
			if (kind === 'http-job') {
				// No `job` in the options: there is no http job to run.
				expect(job).toBeNull();
			} else {
				expect(job, kind).not.toBeNull();
			}
		}
	});

	it('renders a ConfigMap for every kind it can run, carrying the same script', () => {
		const { input } = inputWith(() => undefined);
		for (const kind of kinds) {
			const configMap = renderRunnerConfigMap(input, kind);
			if (kind === 'http-job') {
				expect(configMap).toBeNull();
				continue;
			}
			expect(configMap, kind).not.toBeNull();
			expect(asJson(configMap).data[APP_RUNNER_CONFIGMAP_SCRIPT_KEY]).toBe(APP_RUNNER_SCRIPT);
		}
	});
});
