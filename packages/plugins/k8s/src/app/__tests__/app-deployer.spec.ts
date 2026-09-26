/**
 * T12 — `app-deployer.ts` (plan §5.5; spec FR-26, FR-29, FR-31, FR-32, FR-33, FR-35; ACC-06-09 …
 * ACC-06-24).
 *
 * Every clause of T12's `**Test**` line (tasks.md:205-213) has an `it` below whose title names the
 * clause, and `describe('FR-26 — the phase table')` walks the nine rows of spec.md:372-382 one row
 * per `it`, which is the task's Done-when.
 *
 * **No network, ever.** `FakeCluster` is the five-method `AppDeployerApi` port implemented over an
 * in-memory object list: it records every call, synthesises the observed `status` of whatever the
 * deployer applies, and serves the runner's JSON report from a map. `TestClock` is a virtual clock —
 * `sleep` moves time forward instead of waiting — so a 750 s component deadline or the 2 h cap costs
 * one test loop, and every run is replayable byte for byte.
 *
 * The fixture is the committed golden input (`fixtures/render-input.single-web.json`): RFC 2606
 * hosts, RFC 5737 addresses and synthetic digests only. Its one first-deploy job is an `http` job,
 * and T7 refuses an `http` job whose `authEnv` has no value — so the harness gives it the fixture's
 * own `ADMIN_PASSWORD`, exactly as a real App spec would.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import type { AppDeployHooks, AppRenderInput, AppSmokeRun } from '@ever-works/plugin';

import { K8sPluginError } from '../../errors';
import {
	APP_DEPLOY_DEADLINE_MS,
	APP_HAIRPIN_UNREACHABLE,
	APP_ISOLATION_PROBE_INCONCLUSIVE,
	APP_LIMITRANGE_FORBIDDEN,
	APP_PREPARE_DEADLINE_MS,
	APP_PUBLIC_SMOKE_WINDOW_LATER_S,
	APP_PUBLIC_SMOKE_WINDOW_S,
	APP_PUBLISH_DEADLINE_MS,
	APP_CRON_DEADLINE_MS,
	AppDeployer,
	type AppDeployerApi,
	type AppDeployerOptions
} from '../app-deployer';
import {
	APP_LABEL_COMPONENT,
	APP_LABEL_JOB,
	APP_LABEL_WORK_ID,
	envSecretName,
	platformConfigMapName,
	verificationNamespaceName
} from '../app-names';

/* ------------------------------------------------------------------------- *
 * Fixture plumbing
 * ------------------------------------------------------------------------- */

type Json = Record<string, any>;
const asJson = (value: unknown): Json => value as Json;

interface Call {
	op: 'apply' | 'read' | 'list' | 'delete' | 'log';
	apiVersion?: string;
	kind?: string;
	name?: string;
	labelSelector?: string;
	object?: Json;
}

const FIXTURE = 'render-input.single-web.json';
const TWO_WEB_FIXTURE = 'render-input.two-web-components.json';
const WORK_ID = '0f8e2c1a-1111-4a2b-9c3d-4e5f60718293';
const NAMESPACE = 'ew-analytics-0f8e2c1a';
const DEPLOYMENT_SHORT = '3f2b1c4d';

/** The fixture's own checksum → both immutable object names. */
function fixtureChecksum(): string {
	return String(fixture()[1].env.checksum);
}

function fixture(name: string = FIXTURE): [AppRenderInput, Json] {
	const parsed = JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as Json;
	return [parsed as unknown as AppRenderInput, parsed];
}

function baseInput(): AppRenderInput {
	return fixture()[0];
}

function draftOf(change: (draft: Json) => void, name: string = FIXTURE): AppRenderInput {
	const draft = JSON.parse(JSON.stringify(fixture(name)[1])) as Json;
	withRunnableFirstDeploy(draft);
	change(draft);
	return draft as unknown as AppRenderInput;
}

/** T7 refuses an `http` job with no `authEnv`, so the golden job gets a real env name. */
function withRunnableFirstDeploy(draft: Json): void {
	const job = (draft.jobs as Json[]).find((entry) => entry.when === 'first-deploy');
	if (job?.http) {
		job.http.authEnv = 'ADMIN_PASSWORD';
	}
}

const FIRST_DEPLOY_JOB = `job-set-admin-password-${DEPLOYMENT_SHORT}`;
const SMOKE_JOB = `job-smoke-${DEPLOYMENT_SHORT}`;
const HAIRPIN_JOB = `job-hairpin-${DEPLOYMENT_SHORT}`;
const PROBE_JOB = `job-isolation-probe-${DEPLOYMENT_SHORT}`;

const imageOf = (manifest: Json): string => String(manifest?.spec?.template?.spec?.containers?.[0]?.image ?? '');
const envFromOf = (manifest: Json): string =>
	String(manifest?.spec?.template?.spec?.containers?.[0]?.envFrom?.[0]?.secretRef?.name ?? '');

/* ------------------------------------------------------------------------- *
 * The fake API — the port, over an in-memory object list
 * ------------------------------------------------------------------------- */

type Readiness = 'ready' | 'crash-loop' | 'never-ready';

class FakeCluster implements AppDeployerApi {
	readonly calls: Call[] = [];
	readonly logs = new Map<string, string>();
	/** A manifest this map matches throws instead of being applied, keyed `Kind` or `Kind/name`. */
	readonly applyFails = new Map<string, Error>();
	/** A Job's verdict by object name; absent means "succeeded". */
	readonly jobStatus = new Map<string, 'succeeded' | 'failed' | 'never'>();
	/** The runner's stdout by pod label: `smoke`, `hairpin`, `isolation-probe` or a job's own name. */
	readonly runnerLog = new Map<string, string>();
	/** How a Deployment behaves once it is applied — keyed on the manifest, so an old image can be healthy. */
	readiness: (manifest: Json) => Readiness = () => 'ready';
	/** A hook for the tests that need an apply to take time (the prepare budget). */
	onApply?: (manifest: Json) => void;
	/** The address the Ingress controller hands out; `null` means it never answers. */
	ingressAddress: Json | null = { ip: '203.0.113.10' };
	/** Deployment reads that happened **after** this run wrote its first Deployment. */
	deploymentReadsAfterApply = 0;

	private readonly store: Json[] = [];
	private deploymentsApplied = 0;
	private tick = 0;

	// --- assertions' helpers ------------------------------------------------

	appliedNames(): string[] {
		return this.calls.filter((call) => call.op === 'apply').map((call) => `${call.kind}/${call.name}`);
	}

	applied(kind: string): Json[] {
		return this.calls
			.filter((call) => call.op === 'apply' && call.kind === kind)
			.map((call) => call.object as Json);
	}

	appliedRunnerConfigMaps(): Json[] {
		return this.applied('ConfigMap').filter((object) => String(object.metadata?.name).startsWith('ew-runner-'));
	}

	deletedNames(): string[] {
		return this.calls.filter((call) => call.op === 'delete').map((call) => `${call.kind}/${call.name}`);
	}

	indexOfCall(predicate: (call: Call) => boolean): number {
		return this.calls.findIndex(predicate);
	}

	// --- seeding ------------------------------------------------------------

	/** Put an object in the "live cluster" before the Deployment starts. */
	seed(object: Json): void {
		this.upsert(object);
	}

	/** A live component Deployment — what §5.5's capture reads and a rollback restores. */
	seedLiveDeployment(options: { image: string; envSecret: string; replicas?: number; name?: string }): Json {
		const name = options.name ?? 'web';
		const replicas = options.replicas ?? 1;
		const deployment: Json = {
			apiVersion: 'apps/v1',
			kind: 'Deployment',
			metadata: {
				name,
				namespace: NAMESPACE,
				labels: { [APP_LABEL_COMPONENT]: name, [APP_LABEL_WORK_ID]: WORK_ID },
				annotations: { 'ever-works.io/deployment-id': '11111111-2222-4333-8444-555555555555' },
				generation: 4,
				creationTimestamp: '2026-09-01T00:00:00.000Z'
			},
			spec: {
				replicas,
				selector: { matchLabels: { [APP_LABEL_COMPONENT]: name } },
				template: {
					metadata: { labels: { [APP_LABEL_COMPONENT]: name, [APP_LABEL_WORK_ID]: WORK_ID } },
					spec: {
						containers: [
							{
								name,
								image: options.image,
								imagePullPolicy: 'IfNotPresent',
								envFrom: [{ secretRef: { name: options.envSecret, optional: false } }]
							}
						]
					}
				}
			},
			status: {
				observedGeneration: 4,
				replicas,
				updatedReplicas: replicas,
				readyReplicas: replicas,
				availableReplicas: replicas,
				unavailableReplicas: 0
			}
		};
		this.upsert(deployment);
		return deployment;
	}

	/** The Ingress a previous Deployment published — what §5.5's capture restores. */
	seedLiveIngress(hosts: string[]): Json {
		const ingress: Json = {
			apiVersion: 'networking.k8s.io/v1',
			kind: 'Ingress',
			metadata: {
				name: 'web',
				namespace: NAMESPACE,
				labels: { [APP_LABEL_COMPONENT]: 'web', [APP_LABEL_WORK_ID]: WORK_ID },
				annotations: { 'nginx.ingress.kubernetes.io/proxy-body-size': '10m' }
			},
			spec: {
				ingressClassName: 'nginx',
				rules: hosts.map((host) => ({ host, http: { paths: [{ path: '/', pathType: 'Prefix' }] } }))
			},
			status: { loadBalancer: { ingress: [{ ip: '203.0.113.10' }] } }
		};
		this.upsert(ingress);
		return ingress;
	}

	// --- the port -----------------------------------------------------------

	async applyObject(_kubeconfigYaml: string, manifest: Record<string, unknown>): Promise<void> {
		const object = manifest as Json;
		this.calls.push({ op: 'apply', kind: object.kind, name: object.metadata?.name, object });

		const failure =
			this.applyFails.get(`${String(object.kind)}/${String(object.metadata?.name)}`) ??
			this.applyFails.get(String(object.kind));
		if (failure) {
			throw failure;
		}

		this.onApply?.(object);

		if (object.kind === 'Deployment') {
			this.deploymentsApplied += 1;
			this.storeDeployment(object);
			return;
		}
		if (object.kind === 'Job') {
			this.storeJob(object);
			return;
		}
		if (object.kind === 'Ingress') {
			this.upsert({
				...object,
				status: this.ingressAddress ? { loadBalancer: { ingress: [this.ingressAddress] } } : {}
			});
			return;
		}
		this.upsert(object);
	}

	async readObject<T = Json>(
		_kubeconfigYaml: string,
		apiVersion: string,
		kind: string,
		namespace: string,
		name: string
	): Promise<T | null> {
		this.calls.push({ op: 'read', apiVersion, kind, name });
		if (kind === 'Deployment' && this.deploymentsApplied > 0) {
			this.deploymentReadsAfterApply += 1;
		}
		return (this.find(apiVersion, kind, namespace, name) ?? null) as T | null;
	}

	async listObjects<T = Json>(
		_kubeconfigYaml: string,
		apiVersion: string,
		kind: string,
		namespace: string,
		labelSelector?: string
	): Promise<T[]> {
		this.calls.push({ op: 'list', apiVersion, kind, labelSelector });
		return this.store.filter(
			(object) =>
				object.apiVersion === apiVersion &&
				object.kind === kind &&
				String(object.metadata?.namespace ?? '') === namespace &&
				matchesSelector(object, labelSelector)
		) as T[];
	}

	async deleteObject(
		_kubeconfigYaml: string,
		apiVersion: string,
		kind: string,
		namespace: string,
		name: string
	): Promise<void> {
		this.calls.push({ op: 'delete', apiVersion, kind, name });
		const index = this.store.findIndex(
			(object) =>
				object.apiVersion === apiVersion &&
				object.kind === kind &&
				String(object.metadata?.namespace ?? '') === namespace &&
				object.metadata?.name === name
		);
		if (index >= 0) {
			this.store.splice(index, 1);
		}
	}

	async readPodLog(
		_kubeconfigYaml: string,
		_namespace: string,
		pod: string,
		_container: string
	): Promise<string | null> {
		this.calls.push({ op: 'log', name: pod });
		return this.logs.get(pod) ?? '';
	}

	// --- internals ----------------------------------------------------------

	private upsert(object: Json): void {
		const index = this.store.findIndex(
			(candidate) =>
				candidate.apiVersion === object.apiVersion &&
				candidate.kind === object.kind &&
				String(candidate.metadata?.namespace ?? '') === String(object.metadata?.namespace ?? '') &&
				candidate.metadata?.name === object.metadata?.name
		);
		if (index >= 0) {
			this.store[index] = object;
		} else {
			this.store.push(object);
		}
	}

	private find(apiVersion: string, kind: string, namespace: string, name: string): Json | undefined {
		return this.store.find(
			(object) =>
				object.apiVersion === apiVersion &&
				object.kind === kind &&
				String(object.metadata?.namespace ?? '') === namespace &&
				object.metadata?.name === name
		);
	}

	private stamp(): string {
		return new Date(Date.parse('2026-09-17T09:00:00.000Z') + this.tick++ * 1_000).toISOString();
	}

	private storeDeployment(manifest: Json): void {
		const replicas = Number(manifest.spec?.replicas ?? 1);
		const mode: Readiness | 'scaled-to-zero' = replicas > 0 ? this.readiness(manifest) : 'scaled-to-zero';
		const observed = mode === 'ready';

		this.upsert({
			...manifest,
			metadata: { ...manifest.metadata, generation: 1, creationTimestamp: this.stamp() },
			status: {
				observedGeneration: 1,
				replicas,
				updatedReplicas: replicas,
				readyReplicas: observed ? replicas : 0,
				availableReplicas: observed ? replicas : 0,
				unavailableReplicas: observed ? 0 : replicas
			}
		});

		if (mode === 'scaled-to-zero') {
			// FR-32's managed-tier path: the workloads stay, scaled to nothing, and no pod exists.
			return;
		}

		const template = manifest.spec?.template ?? {};
		const labels = { ...(manifest.metadata?.labels ?? {}), ...(template.metadata?.labels ?? {}) };
		const replicaSetName = `${String(manifest.metadata?.name)}-rs${this.deploymentsApplied}`;

		// A new template scales the previous ReplicaSet down — no stale RS keeps ready pods, which is
		// the clause of §5.4's predicate a real cluster satisfies by construction.
		const component = String(labels[APP_LABEL_COMPONENT] ?? '');
		for (const object of this.store) {
			if (
				object.kind === 'ReplicaSet' &&
				String(object.metadata?.labels?.[APP_LABEL_COMPONENT] ?? '') === component &&
				object.metadata?.name !== replicaSetName
			) {
				object.status = { ...(object.status ?? {}), replicas: 0, readyReplicas: 0, availableReplicas: 0 };
			}
		}

		this.upsert({
			apiVersion: 'apps/v1',
			kind: 'ReplicaSet',
			metadata: {
				name: replicaSetName,
				namespace: manifest.metadata?.namespace,
				labels,
				creationTimestamp: this.stamp(),
				ownerReferences: [{ apiVersion: 'apps/v1', kind: 'Deployment', name: manifest.metadata?.name }]
			},
			spec: { replicas, template },
			status: { replicas, readyReplicas: observed ? replicas : 0, observedGeneration: 1 }
		});

		for (let index = 0; index < replicas; index++) {
			this.upsert({
				apiVersion: 'v1',
				kind: 'Pod',
				metadata: {
					name: `${replicaSetName}-pod${index}`,
					namespace: manifest.metadata?.namespace,
					labels,
					creationTimestamp: this.stamp(),
					ownerReferences: [{ apiVersion: 'apps/v1', kind: 'ReplicaSet', name: replicaSetName }]
				},
				status: {
					phase: observed ? 'Running' : 'Running',
					startTime: this.stamp(),
					containerStatuses: [
						observed
							? {
									name: String(template.spec?.containers?.[0]?.name ?? 'app'),
									ready: true,
									started: true,
									restartCount: 0,
									state: { running: { startedAt: '2026-09-17T08:00:00.000Z' } }
								}
							: mode === 'crash-loop'
								? {
										name: String(template.spec?.containers?.[0]?.name ?? 'app'),
										ready: false,
										started: false,
										restartCount: 3,
										state: {
											waiting: {
												reason: 'CrashLoopBackOff',
												message: 'back-off 40s restarting failed container'
											}
										},
										lastState: {
											terminated: { reason: 'Error', exitCode: 1, finishedAt: this.stamp() }
										}
									}
								: {
										// `never-ready`: healthy-looking, but the Deployment never reaches its replicas.
										name: String(template.spec?.containers?.[0]?.name ?? 'app'),
										ready: false,
										started: true,
										restartCount: 0,
										state: { running: { startedAt: this.stamp() } }
									}
					]
				}
			});
		}
	}

	private storeJob(manifest: Json): void {
		const verdict = this.jobStatus.get(String(manifest.metadata?.name)) ?? 'succeeded';
		this.upsert({
			...manifest,
			metadata: { ...manifest.metadata, creationTimestamp: this.stamp() },
			status:
				verdict === 'succeeded'
					? { succeeded: 1, completionTime: this.stamp(), conditions: [{ type: 'Complete', status: 'True' }] }
					: verdict === 'failed'
						? {
								failed: 1,
								conditions: [{ type: 'Failed', status: 'True', reason: 'BackoffLimitExceeded' }]
							}
						: {}
		});

		const label = String(manifest.metadata?.labels?.[APP_LABEL_JOB] ?? '');
		if (!label || !isRunnerJob(manifest)) {
			return;
		}

		const podName = `${String(manifest.metadata?.name)}-pod`;
		const labels = manifest.spec?.template?.metadata?.labels ?? {};
		this.upsert({
			apiVersion: 'v1',
			kind: 'Pod',
			metadata: {
				name: podName,
				namespace: manifest.metadata?.namespace,
				labels,
				creationTimestamp: this.stamp(),
				ownerReferences: [{ apiVersion: 'batch/v1', kind: 'Job', name: manifest.metadata?.name }]
			},
			status: {
				phase: verdict === 'never' ? 'Running' : 'Succeeded',
				containerStatuses:
					verdict === 'never'
						? [
								{
									name: 'runner',
									ready: false,
									started: true,
									restartCount: 0,
									state: { running: { startedAt: this.stamp() } }
								}
							]
						: [
								{
									name: 'runner',
									ready: false,
									started: false,
									restartCount: 0,
									state: {
										terminated: {
											exitCode: verdict === 'succeeded' ? 0 : 1,
											reason: verdict === 'succeeded' ? 'Completed' : 'Error'
										}
									}
								}
							]
			}
		});
		this.logs.set(podName, this.runnerLog.get(label) ?? defaultRunnerLog(label));
	}
}

/** §4.8: a runner Job mounts its request list from an `ew-runner-<hash10>` ConfigMap. */
function isRunnerJob(manifest: Json): boolean {
	const volumes: Json[] = manifest?.spec?.template?.spec?.volumes ?? [];
	return volumes.some((volume) => String(volume?.configMap?.name ?? '').startsWith('ew-runner-'));
}

function matchesSelector(object: Json, labelSelector?: string): boolean {
	if (!labelSelector) {
		return true;
	}
	const labels: Record<string, string> = object.metadata?.labels ?? {};
	return labelSelector.split(',').every((pair) => {
		const [key, value] = pair.split('=');
		return labels[key] === value;
	});
}

const checkLine = (name: string, over: Json = {}): string =>
	JSON.stringify({ kind: 'http', name, status: 200, ok: true, latencyMs: 12, ...over });

/** The probe's one record: `connected: false` is "the policies are enforced" (§4.10). */
const probeLine = (connected: boolean): string =>
	JSON.stringify({ kind: 'isolation-probe', name: 'isolation-probe', status: 0, ok: true, connected, latencyMs: 3 });

function defaultRunnerLog(label: string): string {
	if (label === 'isolation-probe') {
		return probeLine(false);
	}
	if (label === 'smoke' || label === 'hairpin') {
		return checkLine('heartbeat');
	}
	return checkLine(label, { status: 201 });
}

/* ------------------------------------------------------------------------- *
 * The virtual clock and the hooks
 * ------------------------------------------------------------------------- */

class TestClock {
	millis = Date.parse('2026-09-17T10:00:00.000Z');
	readonly now = (): number => this.millis;
	readonly sleep = async (millis: number): Promise<void> => {
		this.millis += millis;
	};
}

interface Recorded {
	phases: string[];
	details: (Record<string, unknown> | undefined)[];
	verify: { urls: readonly string[]; checks: readonly unknown[]; windowSeconds: number }[];
	cancelChecks: number;
}

interface Harness {
	cluster: FakeCluster;
	clock: TestClock;
	input: AppRenderInput;
	record: Recorded;
	deploy: (overrides?: Partial<AppDeployerOptions>) => Promise<Awaited<ReturnType<AppDeployer['deployApp']>>>;
}

interface HarnessOptions {
	change?: (draft: Json) => void;
	cluster?: FakeCluster;
	cancelled?: () => boolean;
	publicRun?: AppSmokeRun;
	render?: AppDeployerOptions['render'];
	options?: Partial<AppDeployerOptions>;
	/** Which committed golden input to drive; the single-web one by default. */
	fixtureName?: string;
}

const KUBECONFIG = `apiVersion: v1
kind: Config
current-context: kind-app-runtime
clusters:
  - name: kind-app-runtime
    cluster:
      server: https://kind.example.com:6443
      certificate-authority-data: LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCk1JSUNlcnQ9PQotLS0tLUVORCBDRVJUSUZJQ0FURS0tLS0tCg==
contexts:
  - name: kind-app-runtime
    context:
      cluster: kind-app-runtime
      user: kind-admin
      namespace: ${NAMESPACE}
users:
  - name: kind-admin
    user:
      token: fixture-placeholder-token
`;

/** §6.1 refuses this one before any client call — `insecure-skip-tls-verify` is never accepted. */
const UNSUPPORTED_KUBECONFIG = KUBECONFIG.replace(
	'certificate-authority-data: LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCk1JSUNlcnQ9PQotLS0tLUVORCBDRVJUSUZJQ0FURS0tLS0tCg==',
	'insecure-skip-tls-verify: true'
);

const passingPublicRun = (): AppSmokeRun => ({
	checks: [{ name: 'heartbeat', status: 'passed', httpStatus: 200, latencyMs: 20 }],
	passed: true
});

function harness(options: HarnessOptions = {}): Harness {
	const cluster = options.cluster ?? new FakeCluster();
	const clock = new TestClock();
	const input = draftOf(options.change ?? (() => undefined), options.fixtureName);
	const record: Recorded = { phases: [], details: [], verify: [], cancelChecks: 0 };

	const hooks: AppDeployHooks = {
		onPhase: async (phase, detail) => {
			record.phases.push(phase);
			record.details.push(detail);
		},
		verifyPublic: async (request) => {
			record.verify.push(request);
			return options.publicRun ?? passingPublicRun();
		},
		isCancelled: async () => {
			record.cancelChecks += 1;
			return options.cancelled ? options.cancelled() === true : false;
		}
	};

	return {
		cluster,
		clock,
		input,
		record,
		deploy: (overrides = {}) =>
			new AppDeployer(cluster, {
				now: clock.now,
				sleep: clock.sleep,
				render: options.render,
				...options.options,
				...overrides
			}).deployApp(input, KUBECONFIG, hooks)
	};
}

/** A live version to roll back to: a previous image and a previous env copy (ACC-06-10/15). */
const OLD_IMAGE = `registry.example.com/example-org/analytics@sha256:${'a'.repeat(64)}`;
const OLD_ENV_SECRET = 'app-env-0000000000';

function withLiveVersion(h: Harness): Json {
	return h.cluster.seedLiveDeployment({ image: OLD_IMAGE, envSecret: OLD_ENV_SECRET });
}

/** The new image fails the way `mode` says; the previous one is healthy (ACC-06-10). */
const newImageFails =
	(h: Harness, mode: Readiness) =>
	(manifest: Json): Readiness =>
		imageOf(manifest) === h.input.image.reference ? mode : 'ready';

const preDeployJob = (over: Json = {}): Json => ({
	name: 'migrate',
	when: 'pre-deploy',
	component: 'web',
	command: ['node', 'migrate.js'],
	timeoutSeconds: 300,
	retries: 0,
	...over
});

const postDeployJob = (over: Json = {}): Json => ({
	name: 'seed',
	when: 'post-deploy',
	component: 'web',
	command: ['node', 'seed.js'],
	timeoutSeconds: 300,
	retries: 0,
	...over
});

const phaseAttrs = (h: Harness) => h.record.phases;

/* ------------------------------------------------------------------------- *
 * The task's own cases
 * ------------------------------------------------------------------------- */

describe('T12 — the §5.5 phase machine', () => {
	it('walks §5.5 in order — prepare → pre-deploy jobs → rollout → first-deploy jobs → in-cluster smoke → publish → public smoke → post-deploy jobs → CronJobs → done', async () => {
		const h = harness();

		const result = await h.deploy();

		expect(phaseAttrs(h)).toEqual([
			'prepare',
			'pre-deploy-jobs',
			'rollout',
			'first-deploy-jobs',
			'in-cluster-smoke',
			'publish',
			'public-smoke',
			'post-deploy-jobs',
			'cron',
			'done'
		]);
		expect(result.outcome).toBe('succeeded');
		expect(result.firstDeployJobsCompleted).toBe(true);
		expect(result.isolationEnforced).toBe(true);
		expect(result.ingressAddress).toEqual({ ip: '203.0.113.10' });
		// The App-spec job is a runner Job too (§4.8): its own report is read back from its pod.
		expect(result.jobs.find((job) => job.name === 'set-admin-password')).toMatchObject({
			when: 'first-deploy',
			runName: FIRST_DEPLOY_JOB,
			status: 'succeeded',
			http: { name: 'set-admin-password', status: 'passed', httpStatus: 201 }
		});
		// The smoke and probe runs are reported through `smoke` / `isolationEnforced`, not `jobs[]`.
		expect(result.jobs.map((job) => job.name)).toEqual(['set-admin-password']);
		expect(result.smoke.inCluster[0]).toMatchObject({ name: 'heartbeat', status: 'passed' });
		// `components[]` is the observed state of §4.3's workload, not the input's intent.
		expect(result.components).toEqual([
			{ name: 'web', role: 'web', desired: 1, ready: 1, restarts: 0, oomKilledAt: null }
		]);
	});

	it('waits for every component in parallel, each against its own §5.3 deadline (§5.5)', async () => {
		const h = harness({ fixtureName: TWO_WEB_FIXTURE });
		const startedAt = h.clock.millis;
		h.cluster.readiness = () => 'never-ready';

		const result = await h.deploy();
		const elapsed = h.clock.millis - startedAt;

		// Both components are applied, and both are observed inside one polling window: the shorter
		// deadline (`admin`, 300 s) trips first — a sequential wait would have stalled on `web` (750 s)
		// and then added 300 s more.
		expect(
			h.cluster
				.appliedNames()
				.filter((name) => name.startsWith('Deployment/'))
				.slice(0, 2)
		).toEqual(['Deployment/web', 'Deployment/admin']);
		expect(result.failure).toMatchObject({ phase: 'rollout', code: 'rollout_timeout' });
		expect(result.failure?.message).toContain('admin');
		expect(elapsed).toBeGreaterThan(290_000);
		expect(elapsed).toBeLessThan(400_000);
	});

	it('skips the public smoke entirely when §4.11 renders no Ingress, and reports the renderer’s warning', async () => {
		const h = harness({ change: (draft) => void (draft.ingress.className = null) });

		const result = await h.deploy();

		expect(h.cluster.appliedNames()).not.toContain('Ingress/web');
		expect(h.record.verify).toEqual([]);
		expect(phaseAttrs(h)).not.toContain('public-smoke');
		expect(result.warnings.map((warning) => warning.code)).toContain('no_ingress_controller');
		expect(result.ingressAddress).toBeNull();
		expect(result.outcome).toBe('succeeded');
	});

	it('applies the whole run in §5.5’s object order, and the Ingress only after the first-deploy job (ACC-06-11)', async () => {
		const h = harness();

		await h.deploy();

		const applied = h.cluster.appliedNames();
		const job = applied.indexOf(`Job/${FIRST_DEPLOY_JOB}`);
		const smoke = applied.indexOf(`Job/${SMOKE_JOB}`);
		const probe = applied.indexOf(`Job/${PROBE_JOB}`);
		const ingress = applied.indexOf('Ingress/web');

		expect(job).toBeGreaterThanOrEqual(0);
		// §5.5: rollout → first-deploy jobs → in-cluster smoke → isolation probe → publish.
		expect(applied.indexOf('Deployment/web')).toBeLessThan(job);
		expect(job).toBeLessThan(smoke);
		expect(smoke).toBeLessThan(probe);
		expect(probe).toBeLessThan(ingress);
		// …and the Job was *observed complete* before the Ingress was written (ACC-06-11).
		expect(
			h.cluster.indexOfCall((call) => call.op === 'read' && call.kind === 'Job' && call.name === FIRST_DEPLOY_JOB)
		).toBeLessThan(h.cluster.indexOfCall((call) => call.op === 'apply' && call.kind === 'Ingress'));
		// §4.2's prepare order: the namespace and its policies precede the workloads.
		expect(applied.indexOf('Namespace/ew-analytics-0f8e2c1a')).toBeLessThan(applied.indexOf('Deployment/web'));
		expect(applied.indexOf('NetworkPolicy/ew-default-deny')).toBeLessThan(applied.indexOf('Deployment/web'));
	});

	it('renders no first-deploy Job when isFirstDeploymentOnCluster is false, and still runs the smoke checks (ACC-06-11)', async () => {
		const h = harness({ change: (draft) => void (draft.isFirstDeploymentOnCluster = false) });

		const result = await h.deploy();

		expect(phaseAttrs(h)).not.toContain('first-deploy-jobs');
		expect(h.cluster.appliedNames()).not.toContain(`Job/${FIRST_DEPLOY_JOB}`);
		expect(h.cluster.appliedNames()).toContain(`Job/${SMOKE_JOB}`);
		expect(result.outcome).toBe('succeeded');
		// FR-26 #7's later window, not the first publish's.
		expect(h.record.verify[0].windowSeconds).toBe(APP_PUBLIC_SMOKE_WINDOW_LATER_S);
	});

	it('ends `failed` with zero Deployment writes when a pre-deploy job fails (ACC-06-09)', async () => {
		const h = harness({
			change: (draft) => {
				draft.jobs.unshift(preDeployJob(), preDeployJob({ name: 'seed-db' }));
			}
		});
		h.cluster.jobStatus.set(`job-migrate-${DEPLOYMENT_SHORT}`, 'failed');

		const result = await h.deploy();

		expect(result.outcome).toBe('failed');
		expect(result.failure).toMatchObject({ phase: 'pre-deploy-jobs', code: 'job_failed' });
		expect(result.failure?.message).toContain('migrate');
		// ACC-06-09: the running app is untouched — not one Deployment write, not one rollback.
		expect(h.cluster.appliedNames().filter((name) => name.startsWith('Deployment/'))).toEqual([]);
		expect(phaseAttrs(h)).toEqual(['prepare', 'pre-deploy-jobs']);
		// The second job is behind the first, in declared order.
		expect(h.cluster.appliedNames()).not.toContain(`Job/job-seed-db-${DEPLOYMENT_SHORT}`);
	});

	it('re-applies the captured templates, the previous env copy and the captured hosts when a component crash-loops (ACC-06-10, ACC-06-15)', async () => {
		const h = harness();
		const live = withLiveVersion(h);
		const liveIngress = h.cluster.seedLiveIngress(['analytics.example.com']);
		h.cluster.readiness = newImageFails(h, 'crash-loop');

		const result = await h.deploy();

		expect(result.outcome).toBe('rolled-back');
		expect(result.failure).toMatchObject({ phase: 'rollout', code: 'crash_loop' });
		expect(phaseAttrs(h)).toContain('rollback');

		const deployments = h.cluster.applied('Deployment');
		expect(deployments).toHaveLength(2);
		// ACC-06-15: image and `envFrom` secret of the version that was running come back verbatim.
		expect(imageOf(deployments[1])).toBe(OLD_IMAGE);
		expect(envFromOf(deployments[1])).toBe(OLD_ENV_SECRET);
		expect(deployments[1].metadata.annotations['ever-works.io/deployment-id']).toBe(
			live.metadata.annotations['ever-works.io/deployment-id']
		);
		// FR-33: the previously published hosts come back too — the captured Ingress, verbatim.
		const ingresses = h.cluster.applied('Ingress');
		expect(ingresses).toHaveLength(1);
		expect(ingresses[0].spec.rules).toEqual(liveIngress.spec.rules);
		expect(result.ingressAddress).toBeNull();
		// Nothing was ever smoked: the rollout failed before those phases.
		expect(result.smoke.inCluster).toEqual([]);
		expect(result.smoke.public).toEqual([]);
	});

	it('quotes the found string when an in-cluster `bodyNotContains` check fails, and rolls back (ACC-06-12)', async () => {
		const h = harness();
		withLiveVersion(h);
		h.cluster.runnerLog.set(
			'smoke',
			checkLine('heartbeat', {
				ok: false,
				status: 200,
				failedExpectation: 'bodyNotContains "welcome"',
				found: '<html><body>unexpected-body</body></html>'
			})
		);

		const result = await h.deploy();

		expect(result.outcome).toBe('rolled-back');
		expect(result.failure).toMatchObject({ phase: 'in-cluster-smoke', code: 'smoke_failed' });
		expect(result.failure?.message).toContain('unexpected-body');
		expect(result.smoke.inCluster[0]).toMatchObject({
			name: 'heartbeat',
			status: 'failed',
			httpStatus: 200,
			failedExpectation: 'bodyNotContains "welcome"',
			found: '<html><body>unexpected-body</body></html>'
		});
		// The Job failed as well (the runner exits 1), and the log reference travels with the failure.
		expect(result.jobs.find((job) => job.name === 'smoke')).toBeUndefined();
		expect(h.cluster.deletedNames()).not.toContain('Deployment/web');
	});

	it('ends `succeeded-with-warnings` with no rollback when the public DNS check does not point at the cluster (ACC-06-13)', async () => {
		const h = harness({
			publicRun: {
				checks: [
					{
						name: 'heartbeat',
						status: 'failed',
						classification: 'dns_not_pointing',
						failedExpectation: 'the host resolves elsewhere'
					}
				],
				passed: false
			}
		});
		withLiveVersion(h);

		const result = await h.deploy();

		expect(result.outcome).toBe('succeeded-with-warnings');
		expect(result.warnings.map((warning) => warning.code)).toContain('dns_not_pointing');
		expect(phaseAttrs(h)).not.toContain('rollback');
		expect(h.cluster.applied('Deployment')).toHaveLength(1);
		expect(result.smoke.public[0]).toMatchObject({ name: 'heartbeat', classification: 'dns_not_pointing' });
	});

	it('rolls back when the Ingress cannot be published (FR-26 #6)', async () => {
		const h = harness({ change: (draft) => void (draft.isFirstDeploymentOnCluster = false) });
		withLiveVersion(h);
		h.cluster.applyFails.set('Ingress', new K8sPluginError('APPLY_FAILED', 'the ingress was refused'));

		const result = await h.deploy();

		expect(result.outcome).toBe('rolled-back');
		expect(result.failure).toMatchObject({ phase: 'publish', code: 'publish_failed' });
		expect(imageOf(h.cluster.applied('Deployment')[1])).toBe(OLD_IMAGE);
		// The half-written Ingress is taken back down: there was nothing published before this run.
		expect(h.cluster.deletedNames()).toContain('Ingress/web');
	});

	it('ends `cancelled` when the cancel arrives before anything changed (ACC-06-22)', async () => {
		const h = harness({ cancelled: () => true });
		withLiveVersion(h);

		const result = await h.deploy();

		expect(result.outcome).toBe('cancelled');
		expect(result.cancelReason).toBe('user');
		expect(h.cluster.appliedNames()).toEqual([]);
		expect(h.cluster.deletedNames()).toEqual([]);
		expect(phaseAttrs(h)).toEqual([]);
	});

	it('ends `rolled-back` (cancelled) when the cancel arrives between phases after the components changed (ACC-06-22)', async () => {
		let h: Harness;
		h = harness({ cancelled: () => h.cluster.appliedNames().some((name) => name.startsWith('Deployment/')) });
		withLiveVersion(h);

		const result = await h.deploy();

		expect(result.outcome).toBe('rolled-back');
		expect(result.cancelReason).toBe('user');
		expect(result.failure).toBeUndefined();
		expect(phaseAttrs(h)).toEqual([
			'prepare',
			'pre-deploy-jobs',
			'rollout',
			// The boundary check runs before the next phase is entered, so the cancel is seen here —
			// FR-31's "after components change" case.
			'rollback'
		]);
		expect(imageOf(h.cluster.applied('Deployment')[1])).toBe(OLD_IMAGE);
	});

	it('honours a cancel that arrives during a rollout poll — one is checked on every poll (§5.5, ACC-06-22)', async () => {
		let h: Harness;
		h = harness({
			change: (draft) => void (draft.isFirstDeploymentOnCluster = false),
			cancelled: () => h.cluster.deploymentReadsAfterApply >= 1
		});
		withLiveVersion(h);
		h.cluster.readiness = newImageFails(h, 'never-ready');

		const result = await h.deploy();

		expect(result.outcome).toBe('rolled-back');
		expect(result.cancelReason).toBe('user');
		// The cancel — not a rollout timeout — is what ended the run.
		expect(result.failure).toBeUndefined();
		expect(h.cluster.deploymentReadsAfterApply).toBeGreaterThanOrEqual(1);
		expect(imageOf(h.cluster.applied('Deployment')[1])).toBe(OLD_IMAGE);
	});
});

/* ------------------------------------------------------------------------- *
 * Rollback, first-Deployment handling, the deadline, verification and the seam
 * ------------------------------------------------------------------------- */

describe('T12 — rollback, first-Deployment handling, the deadline and the verification path', () => {
	it('honours skipPreDeployJobs: no pre-deploy Job is rendered and the input’s own image is applied (ACC-06-23)', async () => {
		const h = harness({
			change: (draft) => {
				draft.skipPreDeployJobs = true;
				draft.jobs.unshift(preDeployJob());
			}
		});
		withLiveVersion(h);

		const result = await h.deploy();

		expect(result.outcome).toBe('succeeded');
		expect(h.cluster.appliedNames()).not.toContain(`Job/job-migrate-${DEPLOYMENT_SHORT}`);
		// The manual-rollback path deploys the captured build: the image the render input carries.
		expect(imageOf(h.cluster.applied('Deployment')[0])).toBe(h.input.image.reference);
		expect(h.record.phases).toContain('pre-deploy-jobs');
	});

	it('ends `rollback-failed` when the restored version never becomes ready (ACC-06-24, FR-35)', async () => {
		const h = harness();
		withLiveVersion(h);
		h.cluster.readiness = () => 'never-ready';

		const result = await h.deploy();

		expect(result.outcome).toBe('rollback-failed');
		expect(result.failure).toMatchObject({ phase: 'rollback', code: 'rollback_failed' });
		expect(result.failure?.message).toContain('Rollback did not complete');
		expect(phaseAttrs(h)).toContain('rollback');
	});

	it('scales a failed first Deployment to zero when the policy says so, and leaves it standing when it does not (FR-32)', async () => {
		const scaled = harness();
		scaled.cluster.readiness = () => 'crash-loop';

		const failed = await scaled.deploy();

		expect(failed.outcome).toBe('failed');
		expect(failed.failure).toMatchObject({ phase: 'rollout', code: 'crash_loop' });
		const deployments = scaled.cluster.applied('Deployment');
		expect(deployments).toHaveLength(2);
		expect(deployments[1].spec.replicas).toBe(0);
		expect(failed.components[0]).toMatchObject({ name: 'web', desired: 0, ready: 0 });
		expect(scaled.cluster.appliedNames()).not.toContain('Ingress/web');

		const kept = harness({ change: (draft) => void (draft.policy.scaleFailedFirstDeployToZero = false) });
		kept.cluster.readiness = () => 'crash-loop';

		const keptResult = await kept.deploy();

		expect(keptResult.outcome).toBe('failed');
		expect(kept.cluster.applied('Deployment')).toHaveLength(1);
	});

	it('ends the Deployment at the 2 h cap wherever it is reached, rolling back when a version exists (FR-29)', async () => {
		expect(APP_DEPLOY_DEADLINE_MS).toBe(7_200_000);
		const h = harness({ options: { overallDeadlineMs: 1_000 } });
		withLiveVersion(h);
		h.cluster.readiness = newImageFails(h, 'never-ready');

		const result = await h.deploy();

		expect(result.outcome).toBe('rolled-back');
		expect(result.failure).toMatchObject({ phase: 'rollout', code: 'deadline_exceeded' });
		expect(result.failure?.message).toContain('minute limit');
		expect(imageOf(h.cluster.applied('Deployment')[1])).toBe(OLD_IMAGE);
	});

	it('refuses a kubeconfig §6.1 refuses before the first API call (FR-4)', async () => {
		const cluster = new FakeCluster();
		const clock = new TestClock();
		const record: Recorded = { phases: [], details: [], verify: [], cancelChecks: 0 };
		const hooks: AppDeployHooks = {
			onPhase: async (phase) => void record.phases.push(phase),
			verifyPublic: async () => passingPublicRun(),
			isCancelled: async () => false
		};

		await expect(
			new AppDeployer(cluster, { now: clock.now, sleep: clock.sleep }).deployApp(
				baseInput(),
				UNSUPPORTED_KUBECONFIG,
				hooks
			)
		).rejects.toThrow(/insecure-skip-tls-verify/);

		expect(cluster.calls).toEqual([]);
		expect(record.phases).toEqual([]);
	});

	it('runs a `purpose: verification` ref with in-namespace smoke only: no Ingress, no CronJob, no public smoke (T60, §4.12)', async () => {
		const verificationNamespace = verificationNamespaceName(NAMESPACE, 'ffffffff-1111-4222-8333-444444444444', 1);
		expect(verificationNamespace.length).toBeLessThanOrEqual(52);

		const h = harness({
			change: (draft) => {
				draft.purpose = 'verification';
				draft.ttlMinutes = 60;
				draft.ref.namespace = verificationNamespace;
			},
			render: { now: '2026-09-17T10:00:00.000Z' }
		});

		const result = await h.deploy();

		expect(result.outcome).toBe('succeeded');
		expect(phaseAttrs(h)).toEqual([
			'prepare',
			'pre-deploy-jobs',
			'rollout',
			'first-deploy-jobs',
			'in-cluster-smoke',
			'done'
		]);
		expect(h.cluster.appliedNames().filter((name) => name.startsWith('Ingress/'))).toEqual([]);
		expect(h.cluster.appliedNames().filter((name) => name.startsWith('CronJob/'))).toEqual([]);
		expect(h.cluster.appliedNames().filter((name) => name.startsWith('PersistentVolumeClaim/'))).toEqual([]);
		expect(h.record.verify).toEqual([]);
		expect(result.smoke.public).toEqual([]);
		expect(result.ingressAddress).toBeNull();

		// §4.12's purpose label and expiry annotation, on the namespace this Deployment applied.
		const namespace = h.cluster.applied('Namespace')[0];
		expect(namespace.metadata.name).toBe(verificationNamespace);
		expect(namespace.metadata.labels['ever-works.io/purpose']).toBe('verification');
		expect(namespace.metadata.annotations['ever-works.io/expires-at']).toBe('2026-09-17T11:00:00.000Z');

		// The smoke run targets the component's Service inside the verification namespace (§4.12).
		const smokeConfigMap = h.cluster
			.appliedRunnerConfigMaps()
			.find((object) => String(object.data?.['requests.json']).includes('"kind":"smoke"'));
		expect(String(smokeConfigMap?.data?.['requests.json'])).toContain(`web.${verificationNamespace}.svc:80`);
		expect(result.isolationEnforced).toBe(true);
	});

	it('runs the verification smoke in-namespace ONLY: `http://<component>.<ns>.svc:80`, no Host override, no public and no hairpin run (T60, §4.12:657-658)', async () => {
		const verificationNamespace = verificationNamespaceName(NAMESPACE, 'ffffffff-1111-4222-8333-444444444444', 1);
		const h = harness({
			change: (draft) => {
				draft.purpose = 'verification';
				draft.ttlMinutes = 60;
				draft.ref.namespace = verificationNamespace;
				// The spec asks for the self-address check; §4.12:658 renders none for a verification.
				draft.network.needsHairpin = true;
			},
			render: { now: '2026-09-17T10:00:00.000Z' }
		});

		const result = await h.deploy();

		const smokeConfigMap = h.cluster
			.appliedRunnerConfigMaps()
			.find((object) => String(object.data?.['requests.json']).includes('"kind":"smoke"'));
		const requests = JSON.parse(String(smokeConfigMap?.data?.['requests.json'])).requests as Json[];
		expect(requests.length).toBeGreaterThan(0);

		for (const request of requests) {
			// §4.12:657 — `Host: <component>.<ns>.svc`, which for an in-cluster request IS the URL's
			// authority: the runner sets `Host` from the URL unless a request overrides it.
			expect(String(request.url)).toMatch(
				new RegExp(`^http://web\\.${verificationNamespace.replace(/\./g, '\\.')}\\.svc:80/`)
			);
			const url = new URL(String(request.url));
			expect(url.hostname).toBe(`web.${verificationNamespace}.svc`);
			// `http:` on the default port, so `URL` reports an empty explicit port — the request
			// never leaves the cluster's own DNS.
			expect(url.port).toBe('');
			expect(url.protocol).toBe('http:');
			expect(request.host ?? null).toBeNull();
			// Nothing in the request list can leave the namespace.
			expect(String(request.url)).not.toContain('example.com');
		}

		// No public smoke and no hairpin — and no Ingress that could publish either.
		expect(h.record.verify).toEqual([]);
		expect(result.smoke.public).toEqual([]);
		expect(result.smoke.hairpin).toBeUndefined();
		expect(h.cluster.appliedNames()).not.toContain(`Job/${HAIRPIN_JOB}`);
		expect(h.cluster.appliedNames().filter((name) => name.startsWith('Ingress/'))).toEqual([]);
		expect(h.record.phases).not.toContain('publish');
		expect(h.record.phases).not.toContain('public-smoke');

		// …and the in-cluster smoke really did run, as a Job inside the verification namespace.
		expect(h.cluster.appliedNames()).toContain(`Job/${SMOKE_JOB}`);
		expect(h.cluster.applied('Job').find((job) => job.metadata.name === SMOKE_JOB)?.metadata.namespace).toBe(
			verificationNamespace
		);
		expect(result.smoke.inCluster.length).toBeGreaterThan(0);
	});

	it('reports `isolationEnforced: false` and fails the Deployment when the policy requires enforcement (§4.10)', async () => {
		const h = harness();
		withLiveVersion(h);
		h.cluster.runnerLog.set('isolation-probe', probeLine(true));

		const result = await h.deploy();

		expect(result.isolationEnforced).toBe(false);
		expect(result.outcome).toBe('rolled-back');
		expect(result.failure).toMatchObject({ phase: 'in-cluster-smoke', code: 'isolation_not_enforced' });
	});

	it('reports `isolationEnforced: false` without failing when the target does not require enforcement (§4.10)', async () => {
		const h = harness({ change: (draft) => void (draft.policy.requireIsolationEnforced = false) });
		h.cluster.runnerLog.set('isolation-probe', probeLine(true));

		const result = await h.deploy();

		expect(result.isolationEnforced).toBe(false);
		expect(result.outcome).toBe('succeeded');
	});

	it('never reports `true` for a probe that does not answer: `null` plus the warning (§4.10)', async () => {
		const h = harness();
		h.cluster.jobStatus.set(PROBE_JOB, 'never');

		const result = await h.deploy();

		expect(result.isolationEnforced).toBeNull();
		expect(result.warnings.map((warning) => warning.code)).toContain(APP_ISOLATION_PROBE_INCONCLUSIVE);
		expect(result.outcome).toBe('succeeded-with-warnings');
	});

	it('runs no probe and reports `null` when isolation is off (§4.10)', async () => {
		const h = harness({ change: (draft) => void (draft.network.isolation = false) });

		const result = await h.deploy();

		expect(result.isolationEnforced).toBeNull();
		expect(h.cluster.appliedNames()).not.toContain(`Job/${PROBE_JOB}`);
		expect(result.outcome).toBe('succeeded');
	});

	it('renders the hairpin run after the Ingress apply, and a failing one is a warning, never a rollback (§4.11, T61)', async () => {
		const h = harness({ change: (draft) => void (draft.network.needsHairpin = true) });

		const result = await h.deploy();

		const applied = h.cluster.appliedNames();
		expect(applied).toContain(`Job/${HAIRPIN_JOB}`);
		expect(applied.indexOf(`Job/${HAIRPIN_JOB}`)).toBeGreaterThan(applied.indexOf('Ingress/web'));
		expect(result.smoke.hairpin).toMatchObject({ name: 'heartbeat', status: 'passed' });
		expect(result.outcome).toBe('succeeded');

		const failing = harness({ change: (draft) => void (draft.network.needsHairpin = true) });
		failing.cluster.jobStatus.set(HAIRPIN_JOB, 'failed');
		failing.cluster.runnerLog.set(
			'hairpin',
			checkLine('heartbeat', { ok: false, status: 0, found: 'connect ECONNREFUSED 203.0.113.10:443' })
		);

		const warned = await failing.deploy();

		expect(warned.outcome).toBe('succeeded-with-warnings');
		expect(warned.warnings.map((warning) => warning.code)).toContain(APP_HAIRPIN_UNREACHABLE);
		expect(warned.smoke.hairpin).toMatchObject({
			status: 'failed',
			found: 'connect ECONNREFUSED 203.0.113.10:443'
		});
		expect(phaseAttrs(failing)).not.toContain('rollback');

		const off = harness();
		await off.deploy();
		expect(off.cluster.appliedNames()).not.toContain(`Job/${HAIRPIN_JOB}`);
	});

	it('GCs env Secrets and platform ConfigMaps beyond the three newest ReplicaSets, and Jobs beyond three per name (§4.7, §4.8)', async () => {
		const h = harness();
		const checksum = fixtureChecksum();
		const current = envSecretName(checksum);
		const platform = platformConfigMapName(checksum);
		h.cluster.seed(secretObject(current));
		h.cluster.seed(secretObject('app-env-0000000001'));
		h.cluster.seed(configMapObject(platform));
		h.cluster.seed(configMapObject('app-platform-0000000001'));
		h.cluster.seed(secretObject('unrelated-secret'));
		for (const [index, day] of ['10', '11', '12', '13'].entries()) {
			h.cluster.seed(jobObject(`job-migrate-0000000${index}`, 'migrate', `2026-09-${day}T00:00:00.000Z`));
		}
		h.cluster.seed(jobObject('job-seed-00000000', 'seed', '2026-09-10T00:00:00.000Z'));

		await h.deploy();

		const deleted = h.cluster.deletedNames();
		expect(deleted).toContain('Secret/app-env-0000000001');
		expect(deleted).not.toContain(`Secret/${current}`);
		expect(deleted).toContain('ConfigMap/app-platform-0000000001');
		expect(deleted).not.toContain(`ConfigMap/${platform}`);
		// Never anything without the module's own prefix, and never a Job of a group with ≤ 3 runs.
		expect(deleted).not.toContain('Secret/unrelated-secret');
		expect(deleted).toContain('Job/job-migrate-00000000');
		expect(deleted).not.toContain('Job/job-migrate-00000003');
		expect(deleted).not.toContain('Job/job-seed-00000000');
		expect(asJson(h.record.details.at(-1)?.gc)).toMatchObject({
			secretsDeleted: 1,
			configMapsDeleted: 1,
			jobsDeleted: 1
		});
	});
});

/* ------------------------------------------------------------------------- *
 * FR-26's phase table, one `it` per row (spec.md:372-382)
 * ------------------------------------------------------------------------- */

describe('FR-26 — the phase table', () => {
	it('1 · Prepare namespace, policies, secrets, volumes — 120 s; a failure leaves the running app untouched', async () => {
		expect(APP_PREPARE_DEADLINE_MS).toBe(120_000);

		const failing = harness();
		withLiveVersion(failing);
		failing.cluster.applyFails.set('Secret', new Error('the Secret was refused'));

		const failed = await failing.deploy();

		expect(failed.outcome).toBe('failed');
		expect(failed.failure).toMatchObject({ phase: 'prepare' });
		expect(phaseAttrs(failing)).toEqual(['prepare']);
		expect(failing.cluster.appliedNames().filter((name) => name.startsWith('Deployment/'))).toEqual([]);

		// The row's own budget: applies that together overrun 120 s end the phase.
		const slow = harness();
		slow.cluster.onApply = () => void (slow.clock.millis += 30_000);

		const overran = await slow.deploy();

		expect(overran.failure).toMatchObject({ phase: 'prepare', code: 'deadline_exceeded' });
		expect(overran.outcome).toBe('failed');
	});

	it('1 · a forbidden LimitRange on Your cluster is skipped with `limitrange_forbidden` (§4.2 step 3)', async () => {
		const h = harness();
		h.cluster.applyFails.set('LimitRange', new K8sPluginError('UNAUTHORIZED', 'limitranges is forbidden'));

		const result = await h.deploy();

		expect(result.warnings.map((warning) => warning.code)).toContain(APP_LIMITRANGE_FORBIDDEN);
		expect(result.outcome).toBe('succeeded-with-warnings');
		expect(h.cluster.appliedNames()).toContain('Deployment/web');
	});

	it('2 · Pre-deploy jobs, in declared order — each job’s own timeout; a failure leaves the running app untouched', async () => {
		const h = harness({
			change: (draft) => {
				draft.jobs.unshift(
					preDeployJob({ timeoutSeconds: 10 }),
					preDeployJob({ name: 'seed-db', timeoutSeconds: 600 })
				);
			}
		});
		h.cluster.jobStatus.set(`job-migrate-${DEPLOYMENT_SHORT}`, 'never');

		const result = await h.deploy();

		expect(result.outcome).toBe('failed');
		expect(result.failure).toMatchObject({ phase: 'pre-deploy-jobs', code: 'job_failed' });
		expect(result.jobs[0]).toMatchObject({ name: 'migrate', status: 'timeout' });
		expect(h.cluster.appliedNames().filter((name) => name.startsWith('Deployment/'))).toEqual([]);
		// The jobs after the failed one never ran.
		expect(h.cluster.appliedNames()).not.toContain(`Job/job-seed-db-${DEPLOYMENT_SHORT}`);
	});

	it('2 · a §5.1 refusal is not rendered and is reported with the renderer’s own code, never invented', async () => {
		const h = harness({
			change: (draft) => {
				// An `http` job whose `authEnv` has no value: T7 draws nothing for it (§4.9/§5.1).
				const job = draft.jobs.find((entry: Json) => entry.when === 'first-deploy');
				job.http.authEnv = 'NOT_SET_ANYWHERE';
			}
		});

		const result = await h.deploy();

		expect(h.cluster.appliedNames()).not.toContain(`Job/${FIRST_DEPLOY_JOB}`);
		expect(result.warnings.map((warning) => warning.code)).toContain('job_auth_env_unset');
		expect(result.outcome).toBe('succeeded-with-warnings');
	});

	it('3 · Components roll out — the per-component deadline; Failed on a first Deployment, rolled back otherwise', async () => {
		const first = harness({ change: (draft) => void (draft.policy.scaleFailedFirstDeployToZero = false) });
		first.cluster.readiness = () => 'never-ready';

		const failed = await first.deploy();

		expect(failed.outcome).toBe('failed');
		expect(failed.failure).toMatchObject({ phase: 'rollout', code: 'rollout_timeout' });
		expect(failed.failure?.message).toContain('750 s');
		// FR-32: Your cluster keeps the unpublished workload for inspection.
		expect(first.cluster.applied('Deployment')).toHaveLength(1);

		const second = harness();
		withLiveVersion(second);
		second.cluster.readiness = newImageFails(second, 'never-ready');

		const rolled = await second.deploy();

		expect(rolled.outcome).toBe('rolled-back');
		expect(rolled.failure).toMatchObject({ phase: 'rollout', code: 'rollout_timeout' });
	});

	it('4 · First-deploy jobs — each job’s timeout; on failure the app is not published', async () => {
		const first = harness();
		first.cluster.jobStatus.set(FIRST_DEPLOY_JOB, 'failed');

		const failed = await first.deploy();

		expect(failed.outcome).toBe('failed');
		expect(failed.failure).toMatchObject({ phase: 'first-deploy-jobs', code: 'job_failed' });
		expect(first.cluster.appliedNames().filter((name) => name.startsWith('Ingress/'))).toEqual([]);
		expect(phaseAttrs(first)).not.toContain('in-cluster-smoke');

		const second = harness();
		withLiveVersion(second);
		second.cluster.jobStatus.set(FIRST_DEPLOY_JOB, 'failed');

		const rolled = await second.deploy();

		expect(rolled.outcome).toBe('rolled-back');
		expect(rolled.failure).toMatchObject({ phase: 'first-deploy-jobs', code: 'job_failed' });
	});

	it('5 · In-cluster smoke — 120 s window; rollback, or Failed with nothing published on a first Deployment', async () => {
		const failing = harness();
		failing.cluster.runnerLog.set('smoke', checkLine('heartbeat', { ok: false, failedExpectation: 'status 500' }));

		const failed = await failing.deploy();

		expect(failed.outcome).toBe('failed');
		expect(failed.failure).toMatchObject({ phase: 'in-cluster-smoke', code: 'smoke_failed' });
		expect(failing.cluster.appliedNames().filter((name) => name.startsWith('Ingress/'))).toEqual([]);
		// The runner's own window is §5.3's 120 s plus the 30 s the renderer adds (§4.8).
		const smokeJob = failing.cluster.applied('Job').find((object) => object.metadata.name === SMOKE_JOB);
		expect(smokeJob?.spec.activeDeadlineSeconds).toBe(150);

		const second = harness();
		withLiveVersion(second);
		second.cluster.runnerLog.set('smoke', checkLine('heartbeat', { ok: false, failedExpectation: 'status 500' }));

		const rolled = await second.deploy();

		expect(rolled.outcome).toBe('rolled-back');
		expect(rolled.failure).toMatchObject({ phase: 'in-cluster-smoke', code: 'smoke_failed' });
	});

	it('6 · Publish domains — 60 s for the address the controller hands out; a failure rolls back', async () => {
		expect(APP_PUBLISH_DEADLINE_MS).toBe(60_000);
		const h = harness();

		const result = await h.deploy();

		expect(result.ingressAddress).toEqual({ ip: '203.0.113.10' });
		// The address is read back *after* the apply — the 60 s the row gives the phase.
		const apply = h.cluster.indexOfCall((call) => call.op === 'apply' && call.kind === 'Ingress');
		const addressRead = h.cluster.calls.findIndex(
			(call, index) => index > apply && call.op === 'read' && call.kind === 'Ingress'
		);
		expect(apply).toBeGreaterThanOrEqual(0);
		expect(addressRead).toBeGreaterThan(apply);
	});

	it('7 · Public smoke and self-address check — 600 s on the first publish, 180 s afterwards; Live with warnings', async () => {
		expect(APP_PUBLIC_SMOKE_WINDOW_S).toBe(600);
		expect(APP_PUBLIC_SMOKE_WINDOW_LATER_S).toBe(180);

		const first = harness();
		await first.deploy();
		expect(first.record.verify[0].windowSeconds).toBe(APP_PUBLIC_SMOKE_WINDOW_S);
		expect(first.record.verify[0].urls).toEqual(['https://analytics.example.com']);

		const later = harness({ change: (draft) => void (draft.isFirstDeploymentOnCluster = false) });
		await later.deploy();
		expect(later.record.verify[0].windowSeconds).toBe(APP_PUBLIC_SMOKE_WINDOW_LATER_S);
	});

	it('8 · Post-deploy jobs — each job’s timeout; a failure is Live with warnings', async () => {
		const h = harness({ change: (draft) => void draft.jobs.push(postDeployJob()) });
		h.cluster.jobStatus.set(`job-seed-${DEPLOYMENT_SHORT}`, 'failed');

		const result = await h.deploy();

		expect(result.outcome).toBe('succeeded-with-warnings');
		expect(result.warnings.map((warning) => warning.code)).toContain('job_failed');
		expect(result.jobs.find((job) => job.name === 'seed')).toMatchObject({
			when: 'post-deploy',
			status: 'failed'
		});
		expect(phaseAttrs(h)).not.toContain('rollback');
		expect(h.cluster.deletedNames()).not.toContain('Deployment/web');
	});

	it('9 · Scheduled calls applied — 60 s; a failure is Live with warnings', async () => {
		expect(APP_CRON_DEADLINE_MS).toBe(60_000);
		const h = harness({
			change: (draft) =>
				void draft.cron.push({
					name: 'ping',
					schedule: '*/5 * * * *',
					component: 'web',
					command: ['node', 'ping.js'],
					timeoutSeconds: 300,
					concurrency: 'forbid'
				})
		});
		h.cluster.applyFails.set('CronJob', new Error('the CronJob was refused'));

		const result = await h.deploy();

		expect(result.outcome).toBe('succeeded-with-warnings');
		expect(result.warnings.map((warning) => warning.code)).toContain('job_failed');
		expect(phaseAttrs(h)).not.toContain('rollback');

		const applied = harness({
			change: (draft) =>
				void draft.cron.push({
					name: 'ping',
					schedule: '*/5 * * * *',
					component: 'web',
					command: ['node', 'ping.js']
				})
		});
		const ok = await applied.deploy();
		expect(ok.outcome).toBe('succeeded');
		expect(applied.cluster.appliedNames()).toContain('CronJob/cron-ping');
	});
});

/* ------------------------------------------------------------------------- *
 * Objects the GC tests seed — §4.1's labels, nothing else
 * ------------------------------------------------------------------------- */

function workLabels(): Json {
	return { [APP_LABEL_WORK_ID]: WORK_ID, 'ever-works.io/kind': 'app' };
}

function secretObject(name: string): Json {
	return { apiVersion: 'v1', kind: 'Secret', metadata: { name, namespace: NAMESPACE, labels: workLabels() } };
}

function configMapObject(name: string): Json {
	return { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name, namespace: NAMESPACE, labels: workLabels() } };
}

function jobObject(name: string, label: string, creationTimestamp: string): Json {
	return {
		apiVersion: 'batch/v1',
		kind: 'Job',
		metadata: {
			name,
			namespace: NAMESPACE,
			labels: { ...workLabels(), [APP_LABEL_JOB]: label },
			creationTimestamp
		}
	};
}
