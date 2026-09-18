/**
 * T13 — `app-lifecycle.ts` (plan §4.2, §4.10, §4.11, §9.10; spec FR-48, FR-49, FR-50, FR-51;
 * ACC-06-18, ACC-06-25, ACC-06-34, ACC-06-35, ACC-06-36, ACC-06-37).
 *
 * Every clause of T13's `**Test**` line for this file has an `it` below, and each hard rule of the
 * task (the 1–500 line bound and its 200 default, the 256 KiB cap, secret redaction, "a missing pod
 * or container is a specific error, never an empty tail", `deleteData`'s default, the refusals
 * `scaleApp` owes) has its own `it` as well.
 *
 * **No network, ever.** `FakeCluster` implements the five-method `AppLifecycleApi` port over an
 * in-memory object list with Server-Side-Apply merge semantics: a partial apply merges into the
 * stored object and re-synthesises the `status` and the pods a real controller would report.
 * `TestClock` is a virtual clock, so a 750 s rollout deadline costs one loop.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import type { AppLimitRangeInput, AppTargetRef } from '@ever-works/plugin';

import { K8sPluginError } from '../../errors';
import { APP_LIMITRANGE_FORBIDDEN } from '../app-deployer';
import {
	APP_LIFECYCLE_CODES,
	APP_REPLICA_MAX,
	APP_REPLICA_MIN,
	AppLifecycle,
	boundLogLines,
	logLineBudget,
	logLinesOf,
	minimalRenderInput,
	redactSecretValues,
	type AppLifecycleApi,
	type AppLifecycleOptions
} from '../app-lifecycle';
import { APP_LOG_BYTES_MAX, APP_LOG_LINES_DEFAULT, APP_LOG_LINES_MAX } from '../app-status.reader';
import { APP_DEPENDENCY_POLICY_LABEL } from '../app-network-policy.renderer';
import {
	APP_BASELINE_NETWORK_POLICY_NAMES,
	APP_LABEL_COMPONENT,
	APP_LABEL_CRON,
	APP_LABEL_JOB,
	APP_LABEL_PURPOSE,
	APP_LABEL_WORK_ID,
	appNamespaceName
} from '../app-names';

/* ------------------------------------------------------------------------- *
 * Fixtures
 * ------------------------------------------------------------------------- */

type Json = Record<string, any>;

const WORK_ID = '0f8e2c1a-1111-4a2b-9c3d-4e5f60718293';
const OTHER_WORK_ID = '99999999-2222-4b3c-8d4e-5f6071829304';
const NAMESPACE = appNamespaceName('analytics', WORK_ID);
const NOW = Date.parse('2026-09-17T12:00:00.000Z');
const IMAGE = `registry.example.com/example-org/analytics@sha256:${'a'.repeat(64)}`;
const OTHER_IMAGE = `registry.example.com/example-org/analytics@sha256:${'b'.repeat(64)}`;
const ENV_SECRET = 'app-env-9c1f0a4b7d';
const PLATFORM_CONFIGMAP = 'app-platform-9c1f0a4b7d';
/** The sentinel every "no secret value in the result" assertion looks for. */
const SECRET_VALUE = 'fixture-placeholder-admin-password';
const DATABASE_URL = 'postgres://app:fixture-placeholder-password@db.example.com:5432/analytics';

const REF: AppTargetRef = {
	workId: WORK_ID,
	namespace: NAMESPACE,
	target: 'your-cluster',
	kubeContext: 'kind-app-runtime'
};

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

const UNSUPPORTED_KUBECONFIG = KUBECONFIG.replace(/certificate-authority-data: .*/, 'insecure-skip-tls-verify: true');

const LIMIT_RANGE: AppLimitRangeInput = {
	defaultRequest: { cpu: '100m', memory: '128Mi' },
	defaultLimit: { cpu: '1', memory: '512Mi', ephemeralStorage: '1Gi' },
	max: { cpu: '8', memory: '64Gi' }
};

const SMOKE = [
	{
		name: 'heartbeat',
		component: 'web',
		http: { method: 'GET' as const, path: '/api/heartbeat' },
		expect: { status: [200] },
		when: 'always' as const
	}
];

const PASSING_RUNNER_LOG = '{"kind":"http","name":"heartbeat","status":200,"ok":true,"latencyMs":12}';
const FAILING_RUNNER_LOG = '{"kind":"http","name":"heartbeat","status":500,"ok":false,"latencyMs":12,"found":"boom"}';

/* ------------------------------------------------------------------------- *
 * The virtual clock
 * ------------------------------------------------------------------------- */

class TestClock {
	millis = NOW;
	readonly now = (): number => this.millis;
	readonly sleep = async (millis: number): Promise<void> => {
		this.millis += millis;
	};
}

/* ------------------------------------------------------------------------- *
 * The fake API — the port, with Server-Side-Apply merge semantics
 * ------------------------------------------------------------------------- */

interface Call {
	op: 'apply' | 'read' | 'list' | 'delete' | 'log';
	apiVersion?: string;
	kind?: string;
	name?: string;
	namespace?: string;
	labelSelector?: string;
	propagationPolicy?: string;
	object?: Json;
	tailLines?: number;
	limitBytes?: number;
	previous?: boolean;
}

class FakeCluster implements AppLifecycleApi {
	readonly calls: Call[] = [];
	readonly logs = new Map<string, string>();
	/** A manifest this map matches throws instead of being applied, keyed `Kind/name` or `Kind`. */
	readonly applyFails = new Map<string, Error>();
	/** A Job's verdict, by `ever-works.io/job` label first and by object name second. */
	readonly jobVerdict = new Map<string, 'running' | 'succeeded' | 'failed'>();
	/** The runner report a Job's pod serves; the same text for every runner run. */
	runnerLog = PASSING_RUNNER_LOG;
	/** The address the Ingress controller hands out; `null` means it never answers. */
	ingressAddress: Json | null = { ip: '203.0.113.10' };
	/** How many of a Deployment's replicas report ready — the resume failure switch. */
	nextReadyScale = APP_REPLICA_MAX;
	/** The pods a Deployment apply synthesises: healthy (default) or crash-looping. */
	podMode: 'ready' | 'crash-loop' = 'ready';

	private readonly store: Json[] = [];
	private tick = 0;

	constructor(private readonly clock: TestClock = new TestClock()) {}

	// --- assertions' helpers ------------------------------------------------

	applied(): Json[] {
		return this.calls.filter((call) => call.op === 'apply').map((call) => call.object as Json);
	}

	appliedNames(): string[] {
		return this.calls.filter((call) => call.op === 'apply').map((call) => `${call.kind}/${call.name}`);
	}

	appliedOf(kind: string): Json[] {
		return this.applied().filter((object) => object.kind === kind);
	}

	deletedNames(): string[] {
		return this.calls.filter((call) => call.op === 'delete').map((call) => `${call.kind}/${call.name}`);
	}

	deletesOf(kind: string): Call[] {
		return this.calls.filter((call) => call.op === 'delete' && call.kind === kind);
	}

	// --- seeding ------------------------------------------------------------

	seed(object: Json): void {
		this.upsert(object);
	}

	/** A live component Deployment, with the ReplicaSet and pods a controller would have created. */
	seedDeployment(over: Json = {}): Json {
		const deployment = liveDeployment(over);
		this.upsert(deployment);
		this.synthesisePods(deployment);
		return deployment;
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

		if (object.kind === 'Deployment') {
			this.upsert(this.mergedDeployment(object));
			this.synthesisePods(this.mergedDeployment(object));
			return;
		}
		if (object.kind === 'CronJob') {
			const stored = this.find(
				'batch/v1',
				'CronJob',
				String(object.metadata?.namespace),
				String(object.metadata?.name)
			);
			this.upsert(stored ? { ...stored, spec: { ...stored.spec, ...object.spec } } : object);
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
		this.calls.push({ op: 'read', apiVersion, kind, name, namespace });
		return (this.find(apiVersion, kind, namespace, name) ?? null) as T | null;
	}

	async listObjects<T = Json>(
		_kubeconfigYaml: string,
		apiVersion: string,
		kind: string,
		namespace: string,
		labelSelector?: string
	): Promise<T[]> {
		this.calls.push({ op: 'list', apiVersion, kind, namespace, labelSelector });
		return this.store.filter(
			(object) =>
				object.apiVersion === apiVersion &&
				object.kind === kind &&
				(!namespace || String(object.metadata?.namespace ?? '') === namespace) &&
				matchesSelector(object, labelSelector)
		) as T[];
	}

	async deleteObject(
		_kubeconfigYaml: string,
		apiVersion: string,
		kind: string,
		namespace: string,
		name: string,
		propagationPolicy?: string
	): Promise<void> {
		this.calls.push({ op: 'delete', apiVersion, kind, name, namespace, propagationPolicy });
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
		namespace: string,
		pod: string,
		container: string,
		options: { tailLines?: number; limitBytes?: number; previous?: boolean } = {}
	): Promise<string | null> {
		this.calls.push({
			op: 'log',
			name: pod,
			namespace,
			tailLines: options.tailLines,
			limitBytes: options.limitBytes,
			previous: options.previous
		});
		return this.logs.get(`${pod}/${container}`) ?? null;
	}

	// --- internals ----------------------------------------------------------

	private stamp(): string {
		return new Date(NOW + this.tick++ * 1_000).toISOString();
	}

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

	/** Server-Side Apply: a partial object merges into whatever the cluster already holds. */
	private mergedDeployment(patch: Json): Json {
		const stored = this.find(
			'apps/v1',
			'Deployment',
			String(patch.metadata?.namespace),
			String(patch.metadata?.name)
		);
		const merged: Json = stored
			? {
					...stored,
					...patch,
					metadata: { ...stored.metadata, ...patch.metadata },
					spec: { ...stored.spec, ...patch.spec }
				}
			: patch;
		const replicas = Number(merged.spec?.replicas ?? 0);
		// A crash-looping pod is not a ready replica: the Deployment never reaches its declared count.
		const ready = replicas > 0 && this.podMode === 'ready' ? Math.min(replicas, this.nextReadyScale) : 0;

		return {
			...merged,
			metadata: {
				...merged.metadata,
				generation: 1,
				creationTimestamp: merged.metadata?.creationTimestamp ?? this.stamp()
			},
			status: {
				observedGeneration: 1,
				replicas,
				updatedReplicas: replicas,
				readyReplicas: ready,
				availableReplicas: ready,
				unavailableReplicas: replicas - ready
			}
		};
	}

	/** One ReplicaSet and `replicas` pods, created "now" so §5.4's stability window is measurable. */
	private synthesisePods(deployment: Json): void {
		const replicas = Number(deployment.spec?.replicas ?? 0);
		const name = String(deployment.metadata?.name ?? '');
		const namespace = String(deployment.metadata?.namespace ?? '');
		const labels = { ...(deployment.metadata?.labels ?? {}), [APP_LABEL_COMPONENT]: name };
		const containerName = String(deployment.spec?.template?.spec?.containers?.[0]?.name ?? name);
		const replicaSetName = `${name}-rs1`;
		const created = this.stamp();

		for (const object of [...this.store]) {
			if (object.kind === 'Pod' && String(object.metadata?.labels?.[APP_LABEL_COMPONENT] ?? '') === name) {
				this.store.splice(this.store.indexOf(object), 1);
			}
		}

		this.upsert({
			apiVersion: 'apps/v1',
			kind: 'ReplicaSet',
			metadata: {
				name: replicaSetName,
				namespace,
				labels,
				creationTimestamp: created,
				ownerReferences: [{ apiVersion: 'apps/v1', kind: 'Deployment', name }]
			},
			spec: { replicas },
			status: { replicas, readyReplicas: replicas > 0 ? replicas : 0, observedGeneration: 1 }
		});

		for (let index = 0; index < replicas; index += 1) {
			const crashLooping = this.podMode === 'crash-loop';
			this.upsert({
				apiVersion: 'v1',
				kind: 'Pod',
				metadata: {
					name: `${replicaSetName}-pod${index}`,
					namespace,
					labels,
					creationTimestamp: created,
					ownerReferences: [{ apiVersion: 'apps/v1', kind: 'ReplicaSet', name: replicaSetName }]
				},
				spec: { containers: [{ name: containerName }] },
				status: {
					phase: 'Running',
					startTime: created,
					containerStatuses: [
						crashLooping
							? {
									name: containerName,
									ready: false,
									started: false,
									restartCount: 4,
									state: {
										waiting: {
											reason: 'CrashLoopBackOff',
											message: 'back-off 40s restarting failed container'
										}
									},
									lastState: { terminated: { reason: 'Error', exitCode: 1, finishedAt: created } }
								}
							: {
									name: containerName,
									ready: true,
									started: true,
									restartCount: 0,
									state: { running: { startedAt: created } }
								}
					]
				}
			});
		}
	}

	private storeJob(manifest: Json): void {
		const label = String(manifest.metadata?.labels?.[APP_LABEL_JOB] ?? '');
		const name = String(manifest.metadata?.name ?? '');
		const verdict = this.jobVerdict.get(label) ?? this.jobVerdict.get(name) ?? 'succeeded';

		this.upsert({
			...manifest,
			metadata: { ...manifest.metadata, creationTimestamp: manifest.metadata?.creationTimestamp ?? this.stamp() },
			status:
				verdict === 'succeeded'
					? {
							succeeded: 1,
							startTime: this.stamp(),
							completionTime: this.stamp(),
							conditions: [{ type: 'Complete', status: 'True' }]
						}
					: verdict === 'failed'
						? {
								failed: 1,
								conditions: [{ type: 'Failed', status: 'True', reason: 'BackoffLimitExceeded' }]
							}
						: { active: 1, startTime: this.stamp() }
		});

		const podName = `${name}-pod`;
		const containerName = String(manifest.spec?.template?.spec?.containers?.[0]?.name ?? 'runner');
		this.upsert({
			apiVersion: 'v1',
			kind: 'Pod',
			metadata: {
				name: podName,
				namespace: manifest.metadata?.namespace,
				labels: {
					...(manifest.spec?.template?.metadata?.labels ?? {}),
					...(label ? { [APP_LABEL_JOB]: label } : {})
				},
				creationTimestamp: this.stamp(),
				ownerReferences: [{ apiVersion: 'batch/v1', kind: 'Job', name }]
			},
			spec: { containers: [{ name: containerName }] },
			status: {
				phase: verdict === 'running' ? 'Running' : 'Succeeded',
				containerStatuses: [
					verdict === 'running'
						? {
								name: containerName,
								ready: false,
								started: true,
								restartCount: 0,
								state: { running: { startedAt: this.stamp() } }
							}
						: {
								name: containerName,
								ready: false,
								restartCount: 0,
								state: {
									terminated: { exitCode: verdict === 'succeeded' ? 0 : 1, reason: 'Completed' }
								}
							}
				]
			}
		});

		// A Job that has not finished has written no report yet — the difference between "no output yet"
		// and "checks failed" the runner itself makes.
		if (verdict !== 'running') {
			this.logs.set(`${podName}/${containerName}`, this.runnerLog);
		}
	}
}

function matchesSelector(object: Json, labelSelector?: string): boolean {
	if (!labelSelector) {
		return true;
	}
	const labels: Record<string, string> = object.metadata?.labels ?? {};
	return labelSelector.split(',').every((clause) => {
		const requirement = clause.trim();
		const set = /^([^ ]+) in \(([^)]*)\)$/.exec(requirement);
		if (set) {
			return set[2].split(',').some((value) => labels[set[1]] === value.trim());
		}
		const [key, value] = requirement.split('=');
		return value === undefined ? labels[key] !== undefined : labels[key] === value;
	});
}

/* ------------------------------------------------------------------------- *
 * Object builders
 * ------------------------------------------------------------------------- */

function liveDeployment(over: Json = {}): Json {
	const base: Json = {
		apiVersion: 'apps/v1',
		kind: 'Deployment',
		metadata: {
			name: 'web',
			namespace: NAMESPACE,
			labels: {
				[APP_LABEL_WORK_ID]: WORK_ID,
				[APP_LABEL_COMPONENT]: 'web',
				'app.kubernetes.io/part-of': 'analytics'
			},
			annotations: { 'ever-works.io/deployment-id': '3f2b1c4d-2222-4b3c-8d4e-5f6071829304' },
			generation: 1,
			creationTimestamp: '2026-09-17T08:00:00.000Z'
		},
		spec: {
			replicas: 1,
			template: {
				metadata: {
					labels: { [APP_LABEL_COMPONENT]: 'web' },
					annotations: { 'ever-works.io/env-checksum': '9c1f0a4b7d2e3508' }
				},
				spec: {
					securityContext: { runAsNonRoot: true, seccompProfile: { type: 'RuntimeDefault' } },
					imagePullSecrets: [{ name: 'app-pull' }],
					containers: [
						{
							name: 'web',
							image: IMAGE,
							imagePullPolicy: 'IfNotPresent',
							envFrom: [
								{ secretRef: { name: ENV_SECRET } },
								{ configMapRef: { name: PLATFORM_CONFIGMAP } }
							],
							resources: { requests: { cpu: '250m', memory: '512Mi' }, limits: { memory: '1Gi' } },
							securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } },
							ports: [{ name: 'http', containerPort: 3000 }],
							readinessProbe: { httpGet: { path: '/api/heartbeat', port: 'http' } }
						}
					]
				}
			}
		}
	};

	return {
		...base,
		...over,
		metadata: { ...base.metadata, ...(over.metadata ?? {}) },
		spec: { ...base.spec, ...(over.spec ?? {}) }
	};
}

function workerDeployment(over: Json = {}): Json {
	const web = liveDeployment();
	return liveDeployment({
		...over,
		metadata: {
			...web.metadata,
			name: 'worker',
			labels: {
				[APP_LABEL_WORK_ID]: WORK_ID,
				[APP_LABEL_COMPONENT]: 'worker',
				'app.kubernetes.io/part-of': 'analytics'
			},
			...(over.metadata ?? {})
		},
		spec: {
			...web.spec,
			template: {
				metadata: {
					labels: { [APP_LABEL_COMPONENT]: 'worker' },
					annotations: { 'ever-works.io/env-checksum': '9c1f0a4b7d2e3508' }
				},
				spec: {
					securityContext: { runAsNonRoot: true },
					containers: [
						{
							name: 'worker',
							image: IMAGE,
							envFrom: [{ secretRef: { name: ENV_SECRET } }],
							resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { memory: '512Mi' } }
						}
					]
				}
			},
			...(over.spec ?? {})
		}
	});
}

function liveCronJob(over: Json = {}): Json {
	return {
		apiVersion: 'batch/v1',
		kind: 'CronJob',
		metadata: {
			name: 'cron-nightly',
			namespace: NAMESPACE,
			labels: { [APP_LABEL_WORK_ID]: WORK_ID, [APP_LABEL_CRON]: 'nightly' }
		},
		spec: { schedule: '0 3 * * *', suspend: false },
		status: { lastScheduleTime: '2026-09-17T03:00:00.000Z' },
		...over
	};
}

function liveIngress(over: Json = {}): Json {
	return {
		apiVersion: 'networking.k8s.io/v1',
		kind: 'Ingress',
		metadata: { name: 'web', namespace: NAMESPACE, labels: { [APP_LABEL_WORK_ID]: WORK_ID } },
		spec: {
			ingressClassName: 'nginx',
			rules: [
				{
					host: 'analytics.example.com',
					http: { paths: [{ path: '/', backend: { service: { name: 'web', port: { number: 80 } } } }] }
				}
			]
		},
		status: { loadBalancer: { ingress: [{ ip: '203.0.113.10' }] } },
		...over
	};
}

function namespaceObject(over: Json = {}): Json {
	return {
		apiVersion: 'v1',
		kind: 'Namespace',
		metadata: { name: NAMESPACE, labels: { [APP_LABEL_WORK_ID]: WORK_ID } },
		...over
	};
}

function named(kind: string, apiVersion: string, name: string, over: Json = {}): Json {
	const { metadata, ...rest } = over;

	return {
		apiVersion,
		kind,
		metadata: { name, namespace: NAMESPACE, labels: { [APP_LABEL_WORK_ID]: WORK_ID }, ...(metadata ?? {}) },
		...rest
	};
}

/* ------------------------------------------------------------------------- *
 * Harness
 * ------------------------------------------------------------------------- */

interface Harness {
	cluster: FakeCluster;
	clock: TestClock;
	lifecycle: AppLifecycle;
}

function harness(options: { extra?: AppLifecycleOptions } = {}): Harness {
	const clock = new TestClock();
	const cluster = new FakeCluster(clock);
	return {
		cluster,
		clock,
		lifecycle: new AppLifecycle(cluster, { now: clock.now, sleep: clock.sleep, ...options.extra })
	};
}

/** A live App: one web component, one schedule, a namespace, an Ingress and the immutable maps. */
function liveApp(h: Harness, over: { worker?: boolean; cron?: boolean; ingress?: boolean } = {}): FakeCluster {
	h.cluster.seed(namespaceObject());
	h.cluster.seedDeployment();
	if (over.worker) {
		h.cluster.seedDeployment(workerDeployment());
	}
	if (over.cron !== false) {
		h.cluster.seed(liveCronJob());
	}
	if (over.ingress !== false) {
		h.cluster.seed(liveIngress());
	}
	h.cluster.seed(named('Secret', 'v1', ENV_SECRET, { data: { ADMIN_PASSWORD: SECRET_VALUE } }));
	h.cluster.seed(named('ConfigMap', 'v1', PLATFORM_CONFIGMAP, { data: {} }));
	return h.cluster;
}

/* ------------------------------------------------------------------------- *
 * getAppLogs (FR-48, ACC-06-34)
 * ------------------------------------------------------------------------- */

describe('getAppLogs (FR-48, ACC-06-34)', () => {
	it('replaces a secret value appearing mid-line with its name and returns no value', async () => {
		const h = harness();
		liveApp(h);
		h.cluster.logs.set(
			'web-rs1-pod0/web',
			'2026-09-17T12:00:00Z boot ok\n' +
				`2026-09-17T12:00:01Z connecting to ${DATABASE_URL} now\n` +
				`2026-09-17T12:00:02Z admin password is ${SECRET_VALUE}\n`
		);

		const tail = await h.lifecycle.getAppLogs(REF, KUBECONFIG, {
			component: 'web',
			lines: 200,
			secretValues: { DATABASE_URL, ADMIN_PASSWORD: SECRET_VALUE }
		});

		expect(tail.containers).toHaveLength(1);
		expect(tail.containers[0].pod).toBe('web-rs1-pod0');
		expect(tail.containers[0].container).toBe('web');
		expect(tail.containers[0].lines[1]).toBe('2026-09-17T12:00:01Z connecting to DATABASE_URL now');
		expect(tail.containers[0].lines[2]).toBe('2026-09-17T12:00:02Z admin password is ADMIN_PASSWORD');
		expect(tail.redactedNames).toEqual(['ADMIN_PASSWORD', 'DATABASE_URL']);
		expect(tail.fetchedAt).toBe(new Date(NOW).toISOString());
		// The sentinel check the task's Done-when asks for: no secret value in the result, anywhere.
		expect(JSON.stringify(tail)).not.toContain(DATABASE_URL);
		expect(JSON.stringify(tail)).not.toContain(SECRET_VALUE);
	});

	it('leaves a value shorter than 8 characters alone', async () => {
		const h = harness();
		liveApp(h);
		h.cluster.logs.set('web-rs1-pod0/web', 'DISABLE_TELEMETRY is 1\n');

		const tail = await h.lifecycle.getAppLogs(REF, KUBECONFIG, {
			component: 'web',
			lines: 200,
			secretValues: { DISABLE_TELEMETRY: '1' }
		});

		// A 1-character secret would match inside ordinary words, so it is not redacted (FR-48 says
		// "of 8 or more characters") — and it is not claimed as redacted either.
		expect(tail.containers[0].lines[0]).toBe('DISABLE_TELEMETRY is 1');
		expect(tail.redactedNames).toEqual([]);
	});

	it('bounds the read at 1–500 lines, default 200', async () => {
		const h = harness();
		liveApp(h);
		h.cluster.logs.set(
			'web-rs1-pod0/web',
			Array.from({ length: 900 }, (_value, index) => `line ${index}`).join('\n') + '\n'
		);
		const base = { component: 'web', secretValues: {} };
		const lastLogCall = (): Call | undefined => [...h.cluster.calls].reverse().find((call) => call.op === 'log');

		expect(logLineBudget(0)).toBe(APP_LOG_LINES_DEFAULT);
		expect(logLineBudget(undefined)).toBe(APP_LOG_LINES_DEFAULT);
		expect(logLineBudget(Number.NaN)).toBe(APP_LOG_LINES_DEFAULT);
		expect(logLineBudget(-5)).toBe(APP_LOG_LINES_DEFAULT);
		expect(logLineBudget(APP_LOG_LINES_MAX)).toBe(APP_LOG_LINES_MAX);
		expect(logLineBudget(5_000)).toBe(APP_LOG_LINES_MAX);

		const many = await h.lifecycle.getAppLogs(REF, KUBECONFIG, { ...base, lines: 5_000 });
		expect(lastLogCall()?.tailLines).toBe(APP_LOG_LINES_MAX);
		expect(lastLogCall()?.limitBytes).toBe(APP_LOG_BYTES_MAX);
		expect(many.containers[0].lines).toHaveLength(APP_LOG_LINES_MAX);
		// The newest lines are the ones FR-48 shows.
		expect(many.containers[0].lines[APP_LOG_LINES_MAX - 1]).toBe('line 899');
		expect(many.containers[0].truncated).toBe(true);

		const defaults = await h.lifecycle.getAppLogs(REF, KUBECONFIG, { ...base, lines: 0 });
		expect(lastLogCall()?.tailLines).toBe(APP_LOG_LINES_DEFAULT);
		expect(defaults.containers[0].lines).toHaveLength(APP_LOG_LINES_DEFAULT);

		const requested = await h.lifecycle.getAppLogs(REF, KUBECONFIG, { ...base, lines: 50 });
		expect(requested.containers[0].lines).toHaveLength(50);
		expect(requested.containers[0].truncated).toBe(true);
	});

	it('bounds the payload at 256 KiB per container', async () => {
		const h = harness();
		liveApp(h);
		h.cluster.logs.set('web-rs1-pod0/web', Array.from({ length: 300 }, () => 'x'.repeat(2_048)).join('\n') + '\n');

		const tail = await h.lifecycle.getAppLogs(REF, KUBECONFIG, { component: 'web', lines: 500, secretValues: {} });
		const bytes = tail.containers[0].lines.reduce((total, line) => total + Buffer.byteLength(line, 'utf8') + 1, 0);

		expect(bytes).toBeLessThanOrEqual(APP_LOG_BYTES_MAX);
		expect(tail.containers[0].lines.length).toBeGreaterThan(0);
		expect(tail.containers[0].truncated).toBe(true);
	});

	it('names a missing component, pod and container instead of returning an empty tail', async () => {
		const missing = harness();
		missing.cluster.seed(namespaceObject());
		await expect(
			missing.lifecycle.getAppLogs(REF, KUBECONFIG, { component: 'web', lines: 200, secretValues: {} })
		).rejects.toThrow(/log_workload_missing: Component 'web' has no Deployment 'web'/);

		const noPods = harness();
		noPods.cluster.seed(namespaceObject());
		noPods.cluster.seed(liveDeployment());
		await expect(
			noPods.lifecycle.getAppLogs(REF, KUBECONFIG, { component: 'web', lines: 200, secretValues: {} })
		).rejects.toThrow(/log_workload_missing: Component 'web' has no pod/);

		const noContainer = harness();
		liveApp(noContainer);
		noContainer.cluster.seed(
			named('Pod', 'v1', 'web-rs1-pod0', {
				metadata: { labels: { [APP_LABEL_COMPONENT]: 'web' } },
				spec: { containers: [] },
				status: {}
			})
		);
		await expect(
			noContainer.lifecycle.getAppLogs(REF, KUBECONFIG, { component: 'web', lines: 200, secretValues: {} })
		).rejects.toThrow(/log_workload_missing: Pod 'web-rs1-pod0' in namespace .* reports no container/);
	});

	it('names a pod whose log the API server does not have', async () => {
		const h = harness();
		liveApp(h);

		await expect(
			h.lifecycle.getAppLogs(REF, KUBECONFIG, { component: 'web', lines: 200, secretValues: {} })
		).rejects.toThrow(/log_workload_missing: Pod 'web-rs1-pod0' has no logs for container 'web'/);
	});

	it('asks for one target: neither is a refusal, both is a refusal', async () => {
		const h = harness();
		liveApp(h);
		const base = { lines: 200, secretValues: {} };

		await expect(h.lifecycle.getAppLogs(REF, KUBECONFIG, base)).rejects.toThrow(/log_target_required/);
		await expect(
			h.lifecycle.getAppLogs(REF, KUBECONFIG, { ...base, component: 'web', job: 'migrate' })
		).rejects.toThrow(/log_target_ambiguous/);
	});

	it('reads the newest run of a job and passes `previous` through', async () => {
		const h = harness();
		liveApp(h);
		await h.lifecycle.runAppJob(REF, KUBECONFIG, { name: 'migrate', image: IMAGE });
		const runName = String(h.cluster.appliedOf('Job')[0].metadata.name);

		const tail = await h.lifecycle.getAppLogs(REF, KUBECONFIG, {
			job: 'migrate',
			lines: 100,
			previous: true,
			secretValues: {}
		});

		expect(tail.containers).toHaveLength(1);
		expect(tail.containers[0].pod).toBe(`${runName}-pod`);
		expect(h.cluster.calls.filter((call) => call.op === 'log').at(-1)?.previous).toBe(true);
	});

	it('refuses a log read for a Deployment the cluster is no longer running', async () => {
		const h = harness();
		liveApp(h);

		await expect(
			h.lifecycle.getAppLogs(REF, KUBECONFIG, {
				component: 'web',
				deploymentId: '11111111-2222-4333-8444-555555555555',
				lines: 200,
				secretValues: {}
			})
		).rejects.toThrow(/deployment_gone: .*is running deployment '3f2b1c4d-2222-4b3c-8d4e-5f6071829304'/);
	});

	it('reads every pod of a component, in pod-name order', async () => {
		const h = harness();
		liveApp(h);
		h.cluster.seedDeployment({ spec: { ...liveDeployment().spec, replicas: 2 } });
		h.cluster.logs.set('web-rs1-pod0/web', 'first\n');
		h.cluster.logs.set('web-rs1-pod1/web', 'second\n');

		const tail = await h.lifecycle.getAppLogs(REF, KUBECONFIG, { component: 'web', lines: 200, secretValues: {} });

		expect(tail.containers.map((entry) => entry.pod)).toEqual(['web-rs1-pod0', 'web-rs1-pod1']);
		expect(tail.containers.map((entry) => entry.lines[0])).toEqual(['first', 'second']);
	});

	it('refuses a kubeconfig §6.1 refuses before the first call (FR-4)', async () => {
		const h = harness();
		liveApp(h);

		await expect(
			h.lifecycle.getAppLogs(REF, UNSUPPORTED_KUBECONFIG, { component: 'web', lines: 200, secretValues: {} })
		).rejects.toBeInstanceOf(K8sPluginError);
		expect(h.cluster.calls).toEqual([]);
	});
});

/* ------------------------------------------------------------------------- *
 * runAppJob (FR-51, ACC-06-37)
 * ------------------------------------------------------------------------- */

describe('runAppJob (FR-51, ACC-06-37)', () => {
	it("runs the live version's image digest and envFrom, as `run-<name>-<8 hex>`", async () => {
		const h = harness();
		liveApp(h);

		const result = await h.lifecycle.runAppJob(REF, KUBECONFIG, { name: 'migrate', image: IMAGE });
		const job = h.cluster.appliedOf('Job')[0];

		expect(result.runName).toMatch(/^run-migrate-[0-9a-f]{8}$/);
		expect(job.metadata.name).toBe(result.runName);
		expect(job.metadata.labels[APP_LABEL_JOB]).toBe('migrate');
		expect(job.spec.template.spec.containers[0].image).toBe(IMAGE);
		// The live `envFrom` verbatim — never a re-derived checksum.
		expect(job.spec.template.spec.containers[0].envFrom).toEqual([
			{ secretRef: { name: ENV_SECRET } },
			{ configMapRef: { name: PLATFORM_CONFIGMAP } }
		]);
		// §4.8: the component's security context and resources travel with a command job.
		expect(job.spec.template.spec.containers[0].securityContext).toEqual({
			allowPrivilegeEscalation: false,
			capabilities: { drop: ['ALL'] }
		});
		expect(job.spec.template.spec.containers[0].resources).toEqual({
			requests: { cpu: '250m', memory: '512Mi' },
			limits: { memory: '1Gi' }
		});
		// FR-13: the token is never mounted, and no per-Deployment value reaches the template.
		expect(job.spec.template.spec.automountServiceAccountToken).toBe(false);
		expect(job.spec.template.spec.imagePullSecrets).toEqual([{ name: 'app-pull' }]);
		expect(JSON.stringify(job)).not.toContain('3f2b1c4d-2222-4b3c-8d4e-5f6071829304');
		expect(result.status).toBe('succeeded');
		expect(result.when).toBe('post-deploy');
		expect(result.logRef?.pod).toBe(`${result.runName}-pod`);
	});

	it('refuses a second run of the same job while the first is active', async () => {
		const h = harness({ extra: { jobWaitMs: 0 } });
		liveApp(h);
		h.cluster.jobVerdict.set('migrate', 'running');

		const first = await h.lifecycle.runAppJob(REF, KUBECONFIG, { name: 'migrate', image: IMAGE });
		expect(first.status).toBe('running');
		expect(h.cluster.appliedOf('Job')).toHaveLength(1);

		await expect(h.lifecycle.runAppJob(REF, KUBECONFIG, { name: 'migrate', image: IMAGE })).rejects.toThrow(
			/job_active: Job 'migrate' is already running as 'run-migrate-[0-9a-f]{8}'/
		);
		// The refusal happens before anything is applied.
		expect(h.cluster.appliedOf('Job')).toHaveLength(1);
	});

	it('refuses a run whose image is not the live one', async () => {
		const h = harness();
		liveApp(h);

		await expect(h.lifecycle.runAppJob(REF, KUBECONFIG, { name: 'migrate', image: OTHER_IMAGE })).rejects.toThrow(
			/job_image_moved: Job 'migrate' was requested with image/
		);
		expect(h.cluster.applied()).toEqual([]);
	});

	it('refuses a run with no live version at all', async () => {
		const h = harness();
		h.cluster.seed(namespaceObject());

		await expect(h.lifecycle.runAppJob(REF, KUBECONFIG, { name: 'migrate', image: IMAGE })).rejects.toThrow(
			/no_live_version: Namespace 'ew-analytics-0f8e2c1a' has no live component Deployment/
		);
	});

	it('refuses a job whose name is missing and a run the caller did not confirm', async () => {
		const h = harness();
		liveApp(h);

		await expect(h.lifecycle.runAppJob(REF, KUBECONFIG, { name: '', image: IMAGE })).rejects.toThrow(
			/job_name_required/
		);
		await expect(
			h.lifecycle.runAppJob(REF, KUBECONFIG, { name: 'migrate', image: IMAGE, confirmFirstDeploy: false })
		).rejects.toThrow(/job_confirmation_required/);
		expect(h.cluster.applied()).toEqual([]);
	});

	it("runs the App spec's checks through the runner for `runner: 'smoke'` (FR-51, §5.7)", async () => {
		const h = harness();
		liveApp(h);

		const result = await h.lifecycle.runAppJob(REF, KUBECONFIG, {
			name: 'smoke',
			image: IMAGE,
			runner: 'smoke',
			checks: SMOKE
		});

		const job = h.cluster.appliedOf('Job')[0];
		const configMap = h.cluster
			.appliedOf('ConfigMap')
			.find((object) => String(object.metadata.name).startsWith('ew-runner-'));

		expect(configMap).toBeDefined();
		expect(job.metadata.name).toMatch(/^run-smoke-[0-9a-f]{8}$/);
		expect(job.metadata.labels[APP_LABEL_JOB]).toBe('smoke');
		// §4.8: the runner mounts its request list from the ConfigMap it was rendered with, and the
		// request targets the live component's Service in this namespace.
		expect(job.spec.template.spec.volumes[0].configMap.name).toBe(configMap?.metadata.name);
		expect(JSON.parse(configMap?.data['requests.json'] ?? '{}')).toEqual({
			version: 1,
			kind: 'smoke',
			name: null,
			requests: [
				{
					name: 'heartbeat',
					url: `http://web.${NAMESPACE}.svc:80/api/heartbeat`,
					method: 'GET',
					expect: { status: [200], bodyContains: [], bodyNotContains: [], maxLatencyMs: 10_000 },
					timeoutMs: 30_000
				}
			],
			secrets: []
		});
		expect(result.http).toEqual({ name: 'heartbeat', status: 'passed', httpStatus: 200, latencyMs: 12 });
		expect(result.status).toBe('succeeded');
	});

	it('reports a failing smoke run as a failed job with the check that failed', async () => {
		const h = harness();
		liveApp(h);
		h.cluster.runnerLog = FAILING_RUNNER_LOG;

		const result = await h.lifecycle.runAppJob(REF, KUBECONFIG, {
			name: 'smoke',
			image: IMAGE,
			runner: 'smoke',
			checks: SMOKE
		});

		expect(result.http).toEqual({
			name: 'heartbeat',
			status: 'failed',
			httpStatus: 500,
			latencyMs: 12,
			found: 'boom'
		});
	});

	it('refuses a smoke run with no checks to run', async () => {
		const h = harness();
		liveApp(h);

		await expect(
			h.lifecycle.runAppJob(REF, KUBECONFIG, { name: 'smoke', image: IMAGE, runner: 'smoke', checks: [] })
		).rejects.toThrow(/smoke_checks_missing/);
	});
});

/* ------------------------------------------------------------------------- *
 * scaleApp (FR-49, ACC-06-35)
 * ------------------------------------------------------------------------- */

describe('scaleApp (FR-49, ACC-06-35)', () => {
	it('pauses: replicas 0 on every component and `suspend: true` on every schedule', async () => {
		const h = harness();
		liveApp(h, { worker: true });

		const result = await h.lifecycle.scaleApp(REF, KUBECONFIG, 'pause', {});

		const deployments = h.cluster.appliedOf('Deployment');
		expect(deployments.map((object) => [object.metadata.name, object.spec.replicas])).toEqual([
			['web', 0],
			['worker', 0]
		]);
		expect(h.cluster.appliedOf('CronJob')).toEqual([
			expect.objectContaining({
				metadata: expect.objectContaining({ name: 'cron-nightly' }),
				spec: { suspend: true }
			})
		]);
		expect(result.components.map((component) => [component.name, component.desired, component.ready])).toEqual([
			['web', 0, 0],
			['worker', 0, 0]
		]);
		// FR-49's resume is the only path that runs checks; a pause runs none.
		expect(result.smoke).toBeNull();
		expect(result.failure).toBeUndefined();
	});

	it('resumes: restores the declared replicas, un-suspends the schedule and runs the phase-5 smoke', async () => {
		const h = harness();
		liveApp(h);

		const result = await h.lifecycle.scaleApp(
			REF,
			KUBECONFIG,
			'resume',
			{ web: 2 },
			{ smoke: SMOKE, deadlines: { web: 60 } }
		);

		const deployment = h.cluster.appliedOf('Deployment')[0];
		expect([deployment.metadata.name, deployment.spec.replicas]).toEqual(['web', 2]);
		expect(h.cluster.appliedOf('CronJob')[0].spec).toEqual({ suspend: false });
		expect(result.components).toEqual([
			expect.objectContaining({ name: 'web', desired: 2, ready: 2, restarts: 0 })
		]);
		expect(result.smoke).toEqual({
			checks: [{ name: 'heartbeat', status: 'passed', httpStatus: 200, latencyMs: 12 }],
			passed: true
		});
		expect(result.failure).toBeUndefined();

		// The smoke ran through §4.8's runner, in the app namespace, against the live env.
		const smokeJob = h.cluster.appliedOf('Job').find((object) => object.metadata.labels[APP_LABEL_JOB] === 'smoke');
		const smokeConfigMap = h.cluster
			.appliedOf('ConfigMap')
			.find((object) => String(object.metadata.name).startsWith('ew-runner-'));
		expect(smokeJob).toBeDefined();
		expect(smokeJob?.metadata.name).toMatch(/^job-smoke-[0-9a-f]{8}$/);
		// §4.8: the runner mounts its request list, and the request targets the live Service.
		expect(smokeJob?.spec.template.spec.volumes[0].configMap.name).toBe(smokeConfigMap?.metadata.name);
		expect(String(smokeConfigMap?.data['requests.json'])).toContain(`http://web.${NAMESPACE}.svc:80/api/heartbeat`);
	});

	it('reports a failing smoke run without rolling back (FR-49)', async () => {
		const h = harness();
		liveApp(h);
		h.cluster.runnerLog = FAILING_RUNNER_LOG;

		const result = await h.lifecycle.scaleApp(
			REF,
			KUBECONFIG,
			'resume',
			{ web: 1 },
			{ smoke: SMOKE, deadlines: { web: 60 } }
		);

		expect(result.failure?.code).toBe('smoke_failed');
		expect(result.failure?.message).toContain('stays resumed');
		expect(result.smoke?.passed).toBe(false);
		expect(result.smoke?.checks[0]).toEqual(
			expect.objectContaining({ name: 'heartbeat', status: 'failed', httpStatus: 500 })
		);
		// No rollback: exactly one replica write, one suspension update and the smoke's own objects.
		expect(h.cluster.appliedOf('Deployment')).toHaveLength(1);
		expect(h.cluster.appliedOf('Deployment')[0].spec.replicas).toBe(1);
	});

	it('reports a smoke run that never reported as `deadline_exceeded`, not as a failed check', async () => {
		const h = harness({ extra: { smokeWindowSeconds: 1 } });
		liveApp(h);
		h.cluster.jobVerdict.set('smoke', 'running');

		const result = await h.lifecycle.scaleApp(
			REF,
			KUBECONFIG,
			'resume',
			{ web: 1 },
			{ smoke: SMOKE, deadlines: { web: 60 } }
		);

		expect(result.failure?.code).toBe('deadline_exceeded');
		expect(result.smoke).toBeNull();
	});

	it('reports a rollout that never becomes ready as `rollout_timeout`, without rolling back', async () => {
		const h = harness();
		liveApp(h);
		h.cluster.nextReadyScale = 0;

		const result = await h.lifecycle.scaleApp(
			REF,
			KUBECONFIG,
			'resume',
			{ web: 3 },
			{ smoke: SMOKE, deadlines: { web: 1 } }
		);

		expect(result.failure?.code).toBe('rollout_timeout');
		expect(result.failure?.message).toContain('1 s');
		expect(result.components).toEqual([expect.objectContaining({ name: 'web', desired: 3, ready: 0 })]);
		expect(result.smoke).toBeNull();
		// The failure is reported, never unwound: §5.4's own verdicts, one replica write only.
		expect(h.cluster.appliedOf('Deployment')).toHaveLength(1);
	});

	it("reports a crash-looping component with the classifier's code (plan §5.4)", async () => {
		const h = harness();
		liveApp(h);
		h.cluster.podMode = 'crash-loop';

		const result = await h.lifecycle.scaleApp(
			REF,
			KUBECONFIG,
			'resume',
			{ web: 2 },
			{ smoke: SMOKE, deadlines: { web: 60 } }
		);

		expect(result.failure?.code).toBe('crash_loop');
		expect(result.failure?.message).toContain('web');
	});

	it("waits for a worker without probes through §5.4's 30 s stability window", async () => {
		const h = harness();
		liveApp(h, { worker: true, cron: false, ingress: false });

		const result = await h.lifecycle.scaleApp(
			REF,
			KUBECONFIG,
			'resume',
			{ worker: 1 },
			{ smoke: [], deadlines: { worker: 60 } }
		);

		expect(result.failure).toBeUndefined();
		expect(result.components).toEqual([expect.objectContaining({ name: 'worker', desired: 1, ready: 1 })]);
		// The stability window is measured, not guessed: the virtual clock moved at least 30 s.
		expect(h.clock.millis - NOW).toBeGreaterThanOrEqual(30_000);
	});

	it('leaves a component the caller did not declare exactly as it is', async () => {
		const h = harness();
		liveApp(h, { worker: true, cron: false, ingress: false });

		const result = await h.lifecycle.scaleApp(
			REF,
			KUBECONFIG,
			'resume',
			{ web: 1 },
			{ smoke: [], deadlines: { web: 60 } }
		);

		expect(h.cluster.appliedOf('Deployment').map((object) => object.metadata.name)).toEqual(['web']);
		expect(result.components.map((component) => component.name)).toEqual(['web']);
	});

	it("refuses a replica count outside FR-11's 0–10 range", async () => {
		const h = harness();
		liveApp(h);

		for (const replicas of [11, -1, 1.5]) {
			await expect(
				h.lifecycle.scaleApp(REF, KUBECONFIG, 'resume', { web: replicas }, { smoke: [], deadlines: {} })
			).rejects.toThrow(/replicas_out_of_range/);
		}
		expect(h.cluster.applied()).toEqual([]);
	});

	it('refuses more than one replica of a component that mounts a volume (§4.6, ACC-06-18)', async () => {
		const h = harness();
		liveApp(h);
		h.cluster.seedDeployment({
			spec: {
				...liveDeployment().spec,
				template: {
					...liveDeployment().spec.template,
					spec: {
						...liveDeployment().spec.template.spec,
						volumes: [{ name: 'data', persistentVolumeClaim: { claimName: 'web-data' } }]
					}
				}
			}
		});

		await expect(
			h.lifecycle.scaleApp(REF, KUBECONFIG, 'resume', { web: 2 }, { smoke: [], deadlines: {} })
		).rejects.toThrow(/volume_replicas: Component 'web' mounts volume claim\(s\) web-data/);
		// One replica of the same component is fine — the volume is the refusal, not the component.
		const single = await h.lifecycle.scaleApp(REF, KUBECONFIG, 'resume', { web: 1 }, { smoke: [], deadlines: {} });
		expect(single.failure).toBeUndefined();
	});

	it('refuses a mode that is neither pause nor resume', async () => {
		const h = harness();
		liveApp(h);

		await expect(h.lifecycle.scaleApp(REF, KUBECONFIG, 'restart' as never, {}, undefined)).rejects.toThrow(
			/scale_mode_unknown/
		);
	});
});

/* ------------------------------------------------------------------------- *
 * destroyApp (FR-50, ACC-06-18, ACC-06-36)
 * ------------------------------------------------------------------------- */

/** A namespace holding everything FR-50 talks about: an App's objects, a claim and a dependency. */
function destroyableApp(h: Harness): FakeCluster {
	h.cluster.seed(namespaceObject());
	h.cluster.seedDeployment();
	h.cluster.seed(liveCronJob());
	h.cluster.seed(liveIngress());
	h.cluster.seed(named('Service', 'v1', 'web'));
	h.cluster.seed(named('Secret', 'v1', ENV_SECRET));
	h.cluster.seed(named('ConfigMap', 'v1', PLATFORM_CONFIGMAP));
	h.cluster.seed(
		named('Job', 'batch/v1', 'job-migrate-3f2b1c4d', {
			metadata: { labels: { [APP_LABEL_WORK_ID]: WORK_ID, [APP_LABEL_JOB]: 'migrate' } }
		})
	);
	h.cluster.seed(
		named('PersistentVolumeClaim', 'v1', 'web-data', {
			spec: { accessModes: ['ReadWriteOnce'] }
		})
	);
	h.cluster.seed(
		named('NetworkPolicy', 'networking.k8s.io/v1', 'dep-postgres', {
			metadata: { labels: { [APP_LABEL_WORK_ID]: WORK_ID, [APP_DEPENDENCY_POLICY_LABEL]: 'postgres' } }
		})
	);
	for (const name of APP_BASELINE_NETWORK_POLICY_NAMES) {
		h.cluster.seed(named('NetworkPolicy', 'networking.k8s.io/v1', name));
	}
	return h.cluster;
}

describe('destroyApp (FR-50, ACC-06-18, ACC-06-36)', () => {
	it('keeps volumes, dependencies, deny-all and the namespace when deleteVolumes is false', async () => {
		const h = harness();
		destroyableApp(h);

		const result = await h.lifecycle.destroyApp(REF, KUBECONFIG, { deleteVolumes: false });

		// The App's own objects go: workloads, jobs, scheduled calls, services, hosts, secrets, maps and
		// the four policies a Deployment draws.
		expect(h.cluster.deletedNames()).toEqual(
			expect.arrayContaining([
				'Deployment/web',
				'Job/job-migrate-3f2b1c4d',
				'CronJob/cron-nightly',
				'Service/web',
				'Ingress/web',
				`Secret/${ENV_SECRET}`,
				`ConfigMap/${PLATFORM_CONFIGMAP}`,
				'NetworkPolicy/ew-allow-same-namespace',
				'NetworkPolicy/ew-allow-egress'
			])
		);
		// …and exactly these three things never do.
		expect(h.cluster.deletesOf('PersistentVolumeClaim')).toEqual([]);
		expect(h.cluster.deletedNames()).not.toContain('NetworkPolicy/dep-postgres');
		expect(h.cluster.deletesOf('Namespace')).toEqual([]);
		expect(h.cluster.deletedNames()).not.toContain('NetworkPolicy/ew-default-deny');

		expect(result.namespaceDeleted).toBe(false);
		expect(result.kept).toEqual([
			{ kind: 'PersistentVolumeClaim', name: 'web-data' },
			{ kind: 'NetworkPolicy', name: 'dep-postgres' },
			{ kind: 'NetworkPolicy', name: 'ew-default-deny' },
			{ kind: 'Namespace', name: NAMESPACE }
		]);
		// The kept objects are still there: the deny-all policy is what keeps them unreadable.
		expect(result.deleted).not.toContainEqual({ kind: 'PersistentVolumeClaim', name: 'web-data' });
	});

	it('treats a missing deleteVolumes as "keep" (FR-50\'s default)', async () => {
		const h = harness();
		destroyableApp(h);

		const result = await h.lifecycle.destroyApp(REF, KUBECONFIG, {} as { deleteVolumes: boolean });

		expect(h.cluster.deletesOf('PersistentVolumeClaim')).toEqual([]);
		expect(h.cluster.deletesOf('Namespace')).toEqual([]);
		expect(result.namespaceDeleted).toBe(false);
	});

	it('deletes claims, dependencies and the namespace when deleteVolumes is true', async () => {
		const h = harness();
		destroyableApp(h);

		const result = await h.lifecycle.destroyApp(REF, KUBECONFIG, { deleteVolumes: true });

		expect(h.cluster.deletesOf('PersistentVolumeClaim').map((call) => call.name)).toEqual(['web-data']);
		expect(h.cluster.deletedNames()).toContain('NetworkPolicy/dep-postgres');
		expect(h.cluster.deletedNames()).toContain('NetworkPolicy/ew-default-deny');
		const namespaceDeletes = h.cluster.deletesOf('Namespace');
		expect(namespaceDeletes.map((call) => call.name)).toEqual([NAMESPACE]);
		// §4.12's propagation for a namespace the App owns; §9.10's `remove` path relies on it.
		expect(namespaceDeletes[0].propagationPolicy).toBe('Foreground');
		expect(result.namespaceDeleted).toBe(true);
		expect(result.kept).toEqual([]);
		expect(result.deleted).toContainEqual({ kind: 'Namespace', name: NAMESPACE });
	});

	it('deletes a verification namespace whole, whatever deleteVolumes says (§4.12)', async () => {
		const h = harness();
		h.cluster.seed(
			namespaceObject({ metadata: { name: NAMESPACE, labels: { [APP_LABEL_PURPOSE]: 'verification' } } })
		);
		h.cluster.seedDeployment();
		h.cluster.seed(named('PersistentVolumeClaim', 'v1', 'web-data'));

		const result = await h.lifecycle.destroyApp(REF, KUBECONFIG, { deleteVolumes: false });

		expect(h.cluster.deletedNames()).toEqual([`Namespace/${NAMESPACE}`]);
		expect(h.cluster.deletesOf('Namespace')[0].propagationPolicy).toBe('Foreground');
		expect(result).toEqual({
			deleted: [{ kind: 'Namespace', name: NAMESPACE }],
			kept: [],
			namespaceDeleted: true
		});
	});

	it('reports an absent namespace as nothing to destroy', async () => {
		const h = harness();

		expect(await h.lifecycle.destroyApp(REF, KUBECONFIG, { deleteVolumes: false })).toEqual({
			deleted: [],
			kept: [],
			namespaceDeleted: false
		});
		expect(h.cluster.calls.filter((call) => call.op === 'delete')).toEqual([]);
	});

	it('lets ew-default-deny go when no kept claim or dependency remains', async () => {
		const h = harness();
		h.cluster.seed(namespaceObject());
		h.cluster.seedDeployment();
		for (const name of APP_BASELINE_NETWORK_POLICY_NAMES) {
			h.cluster.seed(named('NetworkPolicy', 'networking.k8s.io/v1', name));
		}

		const result = await h.lifecycle.destroyApp(REF, KUBECONFIG, { deleteVolumes: false });

		expect(h.cluster.deletedNames()).toContain('NetworkPolicy/ew-default-deny');
		expect(result.kept).toEqual([{ kind: 'Namespace', name: NAMESPACE }]);
	});

	it('never deletes an object of another Work', async () => {
		const h = harness();
		destroyableApp(h);
		h.cluster.seed(
			named('Deployment', 'apps/v1', 'other', {
				metadata: { labels: { [APP_LABEL_WORK_ID]: OTHER_WORK_ID, [APP_LABEL_COMPONENT]: 'other' } }
			})
		);

		await h.lifecycle.destroyApp(REF, KUBECONFIG, { deleteVolumes: true });

		expect(h.cluster.deletedNames()).not.toContain('Deployment/other');
	});

	it('reports a namespace that will not go away instead of claiming success', async () => {
		const h = harness({ extra: { removeTimeoutMs: 0 } });
		// The fake keeps the namespace: the delete is issued, the read still answers.
		h.cluster.seed(namespaceObject());
		h.cluster.seedDeployment();
		const original: AppLifecycleApi['deleteObject'] = h.cluster.deleteObject.bind(h.cluster);
		h.cluster.deleteObject = async (
			kubeconfigYaml: string,
			apiVersion: string,
			kind: string,
			namespace: string,
			name: string,
			propagationPolicy?: string,
			contextOverride?: string
		): Promise<void> => {
			if (kind === 'Namespace') {
				return;
			}
			await original(kubeconfigYaml, apiVersion, kind, namespace, name, propagationPolicy, contextOverride);
		};

		await expect(h.lifecycle.destroyApp(REF, KUBECONFIG, { deleteVolumes: true })).rejects.toThrow(
			/namespace_delete_timeout/
		);
	});
});

/* ------------------------------------------------------------------------- *
 * prepareAppNamespace (§4.2, GAP-06)
 * ------------------------------------------------------------------------- */

describe("prepareAppNamespace renders §4.2's subset and persists nothing (GAP-06)", () => {
	it('applies the namespace, the ServiceAccount, the LimitRange and the three baseline policies', async () => {
		const h = harness();

		const result = await h.lifecycle.prepareAppNamespace(REF, KUBECONFIG, {
			isolation: true,
			limitRange: LIMIT_RANGE
		});

		expect(h.cluster.appliedNames()).toEqual([
			`Namespace/${NAMESPACE}`,
			'ServiceAccount/app',
			'LimitRange/ew-defaults',
			'NetworkPolicy/ew-default-deny',
			'NetworkPolicy/ew-allow-same-namespace',
			'NetworkPolicy/ew-allow-egress'
		]);
		expect(result.warnings).toEqual([]);

		const namespace = h.cluster.appliedOf('Namespace')[0];
		expect(namespace.metadata.labels).toEqual(
			expect.objectContaining({
				[APP_LABEL_WORK_ID]: WORK_ID,
				'pod-security.kubernetes.io/enforce': 'baseline'
			})
		);
	});

	it('never draws ew-allow-ingress, ew-allow-deps or a dep-* policy', async () => {
		const h = harness();

		await h.lifecycle.prepareAppNamespace(REF, KUBECONFIG, { isolation: true, limitRange: LIMIT_RANGE });

		const policies = h.cluster.appliedOf('NetworkPolicy').map((object) => object.metadata.name);
		expect(policies).toEqual(['ew-default-deny', 'ew-allow-same-namespace', 'ew-allow-egress']);
		expect(policies.some((name) => name.startsWith('dep-'))).toBe(false);
		expect(policies).not.toContain('ew-allow-ingress');
		expect(policies).not.toContain('ew-allow-deps');
	});

	it('draws no policy at all when isolation is false', async () => {
		const h = harness();

		await h.lifecycle.prepareAppNamespace(REF, KUBECONFIG, { isolation: false, limitRange: LIMIT_RANGE });

		expect(h.cluster.appliedNames()).toEqual([
			`Namespace/${NAMESPACE}`,
			'ServiceAccount/app',
			'LimitRange/ew-defaults'
		]);
	});

	it('is idempotent: a second call applies byte-identical objects', async () => {
		const h = harness();

		await h.lifecycle.prepareAppNamespace(REF, KUBECONFIG, { isolation: true, limitRange: LIMIT_RANGE });
		const first = JSON.parse(JSON.stringify(h.cluster.applied())) as Json[];
		h.cluster.calls.length = 0;
		await h.lifecycle.prepareAppNamespace(REF, KUBECONFIG, { isolation: true, limitRange: LIMIT_RANGE });

		expect(h.cluster.applied()).toEqual(first);
		// Nothing is persisted: no write other than the seven applies, and no read of the runtime state
		// (which this module cannot reach — the plugin holds no database).
		expect(h.cluster.calls.filter((call) => call.op === 'apply')).toHaveLength(6);
	});

	it('reports a forbidden LimitRange as the §4.2 warning on Your cluster', async () => {
		const h = harness();
		h.cluster.applyFails.set('LimitRange', new K8sPluginError('UNAUTHORIZED', 'limitranges is forbidden'));

		const result = await h.lifecycle.prepareAppNamespace(REF, KUBECONFIG, {
			isolation: false,
			limitRange: LIMIT_RANGE
		});

		expect(result.warnings).toEqual([
			{
				code: APP_LIMITRANGE_FORBIDDEN,
				message: expect.stringContaining("the namespace keeps the cluster's own defaults")
			}
		]);
		// The op continues: everything but the refused LimitRange landed.
		expect(h.cluster.appliedNames()).toEqual([
			`Namespace/${NAMESPACE}`,
			'ServiceAccount/app',
			'LimitRange/ew-defaults'
		]);
		expect(h.cluster.appliedOf('LimitRange')).toHaveLength(1);
	});

	it('treats a forbidden LimitRange on Ever Works Apps as fatal (§4.2)', async () => {
		const h = harness();
		h.cluster.applyFails.set('LimitRange', new K8sPluginError('UNAUTHORIZED', 'limitranges is forbidden'));

		await expect(
			h.lifecycle.prepareAppNamespace({ ...REF, target: 'ever-works-apps' }, KUBECONFIG, {
				isolation: true,
				limitRange: LIMIT_RANGE
			})
		).rejects.toBeInstanceOf(K8sPluginError);
	});

	it('adds the managed quota and the restricted pod-security labels on Ever Works Apps', async () => {
		const h = harness();

		await h.lifecycle.prepareAppNamespace({ ...REF, target: 'ever-works-apps' }, KUBECONFIG, {
			isolation: true,
			limitRange: LIMIT_RANGE
		});

		const quota = h.cluster.appliedOf('ResourceQuota')[0];
		expect(quota.metadata.name).toBe('ew-quota');
		expect(quota.spec.hard.pods).toBe(20);
		expect(h.cluster.appliedOf('Namespace')[0].metadata.labels['pod-security.kubernetes.io/enforce']).toBe(
			'restricted'
		);
	});

	it("refuses a namespace owned by another Work (§4.2's ownership check)", async () => {
		const h = harness();
		h.cluster.seed(
			namespaceObject({ metadata: { name: NAMESPACE, labels: { [APP_LABEL_WORK_ID]: OTHER_WORK_ID } } })
		);

		await expect(
			h.lifecycle.prepareAppNamespace(REF, KUBECONFIG, { isolation: true, limitRange: LIMIT_RANGE })
		).rejects.toThrow(/namespace_owned: Namespace 'ew-analytics-0f8e2c1a' belongs to Work/);
		expect(h.cluster.applied()).toEqual([]);
	});

	it("refuses a pre-created namespace that holds another Work's object", async () => {
		const h = harness();
		h.cluster.seed(namespaceObject({ metadata: { name: NAMESPACE, labels: {} } }));
		h.cluster.seed(
			named('Deployment', 'apps/v1', 'other', {
				metadata: { labels: { [APP_LABEL_WORK_ID]: OTHER_WORK_ID, [APP_LABEL_COMPONENT]: 'other' } }
			})
		);

		await expect(
			h.lifecycle.prepareAppNamespace(REF, KUBECONFIG, { isolation: true, limitRange: LIMIT_RANGE })
		).rejects.toThrow(/namespace_owned: Namespace 'ew-analytics-0f8e2c1a' holds Deployment 'other'/);
	});

	it("accepts the owner's own pre-created namespace when it is empty", async () => {
		const h = harness();
		h.cluster.seed(
			namespaceObject({ metadata: { name: NAMESPACE, labels: { 'kubernetes.io/metadata.name': NAMESPACE } } })
		);

		const result = await h.lifecycle.prepareAppNamespace(REF, KUBECONFIG, {
			isolation: true,
			limitRange: LIMIT_RANGE
		});

		expect(result.warnings).toEqual([]);
		expect(h.cluster.appliedNames()).toHaveLength(6);
	});
});

/* ------------------------------------------------------------------------- *
 * publishAppHosts (§4.11, ACC-06-25)
 * ------------------------------------------------------------------------- */

describe('publishAppHosts applies one Ingress and nothing else (ACC-06-25)', () => {
	const HOSTS = {
		primary: 'analytics.example.com',
		extra: ['www.analytics.example.com'],
		previous: ['old.analytics.example.com'],
		tls: 'cert-manager',
		issuer: 'letsencrypt'
	};

	it('re-applies only the Ingress and returns the observed address', async () => {
		const h = harness();
		liveApp(h);

		const result = await h.lifecycle.publishAppHosts(REF, KUBECONFIG, HOSTS);

		expect(h.cluster.appliedNames()).toEqual(['Ingress/web']);
		expect(h.cluster.appliedOf('Deployment')).toEqual([]);
		expect(h.cluster.appliedOf('Service')).toEqual([]);
		expect(result.ingressAddress).toEqual({ ip: '203.0.113.10' });

		const ingress = h.cluster.appliedOf('Ingress')[0];
		expect(ingress.spec.rules.map((rule: Json) => rule.host)).toEqual([
			'analytics.example.com',
			'www.analytics.example.com',
			'old.analytics.example.com'
		]);
		expect(ingress.spec.tls).toEqual([
			{ hosts: ingress.spec.rules.map((rule: Json) => rule.host), secretName: 'analytics-example-com-tls' }
		]);
		expect(ingress.metadata.annotations['cert-manager.io/cluster-issuer']).toBe('letsencrypt');
	});

	it('keeps the class the published Ingress already uses', async () => {
		const h = harness();
		liveApp(h);
		h.cluster.seed({
			apiVersion: 'networking.k8s.io/v1',
			kind: 'IngressClass',
			metadata: {
				name: 'traefik',
				annotations: { 'ingressclass.kubernetes.io/is-default-class': 'true' }
			}
		});

		await h.lifecycle.publishAppHosts(REF, KUBECONFIG, HOSTS);

		// A reconcile must never move a published host to another controller.
		expect(h.cluster.appliedOf('Ingress')[0].spec.ingressClassName).toBe('nginx');
	});

	it("falls back to the cluster's default class when nothing is published yet", async () => {
		const h = harness();
		liveApp(h, { ingress: false });
		h.cluster.calls.length = 0;
		h.cluster.seed({
			apiVersion: 'networking.k8s.io/v1',
			kind: 'IngressClass',
			metadata: {
				name: 'nginx',
				annotations: { 'ingressclass.kubernetes.io/is-default-class': 'true' }
			}
		});

		await h.lifecycle.publishAppHosts(REF, KUBECONFIG, HOSTS);

		expect(h.cluster.appliedOf('Ingress')[0].spec.ingressClassName).toBe('nginx');
		expect(h.cluster.appliedOf('Ingress')[0].metadata.name).toBe('web');
	});

	it('renders no Ingress at all when the cluster has no class (§4.11)', async () => {
		const h = harness();
		liveApp(h, { ingress: false });
		h.cluster.calls.length = 0;

		const result = await h.lifecycle.publishAppHosts(REF, KUBECONFIG, HOSTS);

		expect(result).toEqual({ ingressAddress: null });
		expect(h.cluster.applied()).toEqual([]);
	});

	it('returns no address when the controller never publishes one', async () => {
		const h = harness({ extra: { publishTimeoutMs: 0 } });
		liveApp(h);
		h.cluster.ingressAddress = null;

		expect(await h.lifecycle.publishAppHosts(REF, KUBECONFIG, HOSTS)).toEqual({ ingressAddress: null });
	});

	it('publishes nothing for a verification namespace (§4.12)', async () => {
		const h = harness();
		liveApp(h);
		h.cluster.seed(
			namespaceObject({ metadata: { name: NAMESPACE, labels: { [APP_LABEL_PURPOSE]: 'verification' } } })
		);

		expect(await h.lifecycle.publishAppHosts(REF, KUBECONFIG, HOSTS)).toEqual({ ingressAddress: null });
		expect(h.cluster.applied()).toEqual([]);
	});

	it('refuses a TLS mode §4.11 does not define', async () => {
		const h = harness();
		liveApp(h);

		await expect(h.lifecycle.publishAppHosts(REF, KUBECONFIG, { ...HOSTS, tls: 'acme' })).rejects.toThrow(
			/tls_mode_unknown/
		);
		expect(h.cluster.applied()).toEqual([]);
	});

	it('refuses when the namespace has no web component to publish', async () => {
		const h = harness();
		h.cluster.seed(namespaceObject());

		await expect(h.lifecycle.publishAppHosts(REF, KUBECONFIG, HOSTS)).rejects.toThrow(/ingress_target_unknown/);
	});
});

/* ------------------------------------------------------------------------- *
 * The pure helpers
 * ------------------------------------------------------------------------- */

describe('the FR-48 helpers', () => {
	it('splits a log into lines without inventing a trailing empty one', () => {
		expect(logLinesOf('a\nb\n')).toEqual(['a', 'b']);
		expect(logLinesOf('a\nb')).toEqual(['a', 'b']);
		expect(logLinesOf('')).toEqual([]);
		expect(logLinesOf(null)).toEqual([]);
	});

	it('keeps the newest lines that fit both caps', () => {
		expect(boundLogLines(['a', 'b', 'c'], 2, 1_000)).toEqual({ lines: ['b', 'c'], truncated: true });
		expect(boundLogLines(['a', 'b'], 5, 1_000)).toEqual({ lines: ['a', 'b'], truncated: false });
		// One over-long line is cut rather than dropped: a log with one line still has that line.
		const cut = boundLogLines(['x'.repeat(100)], 5, 10);
		expect(cut.truncated).toBe(true);
		expect(Buffer.byteLength(cut.lines[0], 'utf8')).toBeLessThanOrEqual(10);
	});

	it('redacts longest-first and keeps the name order stable', () => {
		const { lines, redactedNames } = redactSecretValues({ SHORT: 'fixture-abc', LONG: 'fixture-abcdef' }, [
			'value=fixture-abcdef'
		]);

		expect(lines[0]).toBe('value=LONG');
		expect(redactedNames).toEqual(['LONG', 'SHORT']);
	});

	it('builds a render input from the live facts it is given', () => {
		const input = minimalRenderInput(REF);
		expect(input.workSlug).toBe('analytics');
		expect(input.policy.podSecurity).toBe('baseline');
		expect(input.policy.limitRange).toEqual(LIMIT_RANGE);
		expect(input.policy.quota).toBeNull();
		expect(input.network.isolation).toBe(false);
		expect(input.env.checksum).toBe('');

		const managed = minimalRenderInput({ ...REF, target: 'ever-works-apps' }, { envChecksum: '9c1f0a4b7d2e3508' });
		expect(managed.policy.podSecurity).toBe('restricted');
		expect(managed.policy.quota?.pods).toBe(20);
		expect(managed.env.checksum).toBe('9c1f0a4b7d2e3508');
	});
});

/** The constants FR-11 and the plan fix, asserted where this module declares them. */
describe('the bounds and codes this module declares', () => {
	it("is FR-11's 0–10 replica range", () => {
		expect([APP_REPLICA_MIN, APP_REPLICA_MAX]).toEqual([0, 10]);
	});

	it('names every refusal a caller can match on', () => {
		expect(APP_LIFECYCLE_CODES.volume_replicas).toBe('volume_replicas');
		expect(APP_LIFECYCLE_CODES.replicas_out_of_range).toBe('replicas_out_of_range');
		expect(Object.values(APP_LIFECYCLE_CODES)).toEqual(
			expect.arrayContaining([
				'log_target_required',
				'log_workload_missing',
				'no_live_version',
				'job_active',
				'scale_mode_unknown',
				'namespace_owned',
				'ingress_target_unknown'
			])
		);
	});
});

/** The fixtures above are held against the committed golden input, so they cannot drift. */
describe('the fixture this spec builds on', () => {
	it('matches the committed golden render input', () => {
		const golden = JSON.parse(
			readFileSync(new URL('./fixtures/render-input.single-web.json', import.meta.url), 'utf8')
		) as Json;

		expect(NAMESPACE).toBe(golden.ref.namespace);
		expect(WORK_ID).toBe(golden.ref.workId);
		// The fixture's digest is a synthetic 64-hex value; this spec uses its own synthetic digest for
		// the same repository, so the two are compared by shape rather than by value.
		expect(IMAGE.split('@')[0]).toBe(String(golden.image.reference).split('@')[0]);
		expect(IMAGE).toMatch(/@sha256:[0-9a-f]{64}$/);
		expect(OTHER_IMAGE).toMatch(/@sha256:[0-9a-f]{64}$/);
		expect(ENV_SECRET).toBe(`app-env-${String(golden.env.checksum).slice(0, 10)}`);
		expect(SECRET_VALUE).toBe(golden.env.values.ADMIN_PASSWORD);
		expect(DATABASE_URL).toBe(golden.env.values.DATABASE_URL);
		expect(APP_DEPENDENCY_POLICY_LABEL).toBe('ever-works.io/dependency');
		expect(OTHER_WORK_ID).not.toBe(WORK_ID);
		expect(OTHER_IMAGE).not.toBe(IMAGE);
	});
});
