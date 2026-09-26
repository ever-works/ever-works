/**
 * T13 — `app-status.reader.ts` (plan §6.3 and §9.10's `status-refresh`; spec FR-46, FR-47,
 * ACC-06-31).
 *
 * Every clause of T13's `**Test**` line for this file has an `it` below, and
 * `describe('FR-46 …')` walks FR-46's field list one field per `it` — "every FR-46 field is filled
 * from a fake cluster" is the task's Done-when for this spec.
 *
 * **No network, ever.** `FakeCluster` implements the three-method `AppStatusApi` port over an
 * in-memory object list: it records every call, answers label selectors, and serves pod logs from a
 * map. The clock is injected, so every snapshot is replayable byte for byte.
 */
import { describe, expect, it } from 'vitest';
import type { AppStatusSpec, AppTargetRef } from '@ever-works/plugin';

import { K8sPluginError } from '../../errors';
import {
	APP_LOG_BYTES_MAX,
	APP_LOG_LINES_DEFAULT,
	AppStatusReader,
	componentPodSummary,
	ingressAddressOf,
	liveEnvChecksum,
	liveEnvFrom,
	livePrimaryDeployment,
	liveWorkSlug,
	newestJob,
	newestPod,
	parseRunnerRecords,
	workSlugFromNamespace,
	type AppLiveDeployment,
	type AppStatusApi
} from '../app-status.reader';
import { APP_LABEL_COMPONENT, APP_LABEL_CRON, APP_LABEL_JOB, APP_LABEL_PURPOSE, APP_LABEL_WORK_ID } from '../app-names';

/* ------------------------------------------------------------------------- *
 * Fixtures
 * ------------------------------------------------------------------------- */

type Json = Record<string, any>;

const WORK_ID = '0f8e2c1a-1111-4a2b-9c3d-4e5f60718293';
const NAMESPACE = 'ew-analytics-0f8e2c1a';
const OTHER_WORK_ID = '99999999-2222-4b3c-8d4e-5f6071829304';
const NOW = Date.parse('2026-09-17T12:00:00.000Z');
const IMAGE = `registry.example.com/example-org/analytics@sha256:${'a'.repeat(64)}`;
const SECRET_VALUE = 'fixture-placeholder-admin-password';

const REF: AppTargetRef = {
	workId: WORK_ID,
	namespace: NAMESPACE,
	target: 'your-cluster',
	kubeContext: 'kind-app-runtime'
};

const SPEC: AppStatusSpec = {
	components: [{ name: 'web', role: 'web', replicas: 2, primary: true }],
	jobs: ['set-admin-password'],
	cron: ['nightly']
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

/** §6.1 refuses this one before any client call — `insecure-skip-tls-verify` is never accepted. */
const UNSUPPORTED_KUBECONFIG = KUBECONFIG.replace(/certificate-authority-data: .*/, 'insecure-skip-tls-verify: true');

/* ------------------------------------------------------------------------- *
 * The fake API — the port, over an in-memory object list
 * ------------------------------------------------------------------------- */

interface Call {
	op: 'read' | 'list' | 'log';
	apiVersion?: string;
	kind?: string;
	name?: string;
	namespace?: string;
	labelSelector?: string;
	context?: string;
	tailLines?: number;
	limitBytes?: number;
	previous?: boolean;
}

class FakeCluster implements AppStatusApi {
	readonly calls: Call[] = [];
	readonly logs = new Map<string, string>();
	private readonly store: Json[] = [];

	/** Seed any object — the tests build the "live cluster" with the helpers below. */
	seed(object: Json): void {
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

	read(kind: string, name: string): Json | undefined {
		return this.store.find((object) => object.kind === kind && object.metadata?.name === name);
	}

	listed(kind: string): Json[] {
		return this.store.filter((object) => object.kind === kind);
	}

	callsOf(op: Call['op']): Call[] {
		return this.calls.filter((call) => call.op === op);
	}

	async readObject<T = Json>(
		_kubeconfigYaml: string,
		apiVersion: string,
		kind: string,
		namespace: string,
		name: string,
		contextOverride?: string
	): Promise<T | null> {
		this.calls.push({ op: 'read', apiVersion, kind, name, namespace, context: contextOverride });
		return (this.find(apiVersion, kind, namespace, name) ?? null) as T | null;
	}

	async listObjects<T = Json>(
		_kubeconfigYaml: string,
		apiVersion: string,
		kind: string,
		namespace: string,
		labelSelector?: string,
		contextOverride?: string
	): Promise<T[]> {
		this.calls.push({ op: 'list', apiVersion, kind, namespace, labelSelector, context: contextOverride });
		return this.store.filter(
			(object) =>
				object.apiVersion === apiVersion &&
				object.kind === kind &&
				(!namespace || String(object.metadata?.namespace ?? '') === namespace) &&
				matchesSelector(object, labelSelector)
		) as T[];
	}

	async readPodLog(
		_kubeconfigYaml: string,
		namespace: string,
		pod: string,
		container: string,
		options: { tailLines?: number; limitBytes?: number; previous?: boolean } = {},
		contextOverride?: string
	): Promise<string | null> {
		this.calls.push({
			op: 'log',
			name: pod,
			namespace,
			context: contextOverride,
			tailLines: options.tailLines,
			limitBytes: options.limitBytes,
			previous: options.previous
		});
		return this.logs.get(`${pod}/${container}`) ?? null;
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
 * Object builders — what a real cluster would report
 * ------------------------------------------------------------------------- */

function deployment(over: Json = {}): Json {
	return {
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
			creationTimestamp: '2026-09-17T08:00:00.000Z',
			generation: 3
		},
		spec: {
			replicas: 2,
			template: {
				metadata: {
					labels: { [APP_LABEL_COMPONENT]: 'web' },
					annotations: { 'ever-works.io/env-checksum': '9c1f0a4b7d2e3508' }
				},
				spec: {
					containers: [
						{
							name: 'web',
							image: IMAGE,
							envFrom: [{ secretRef: { name: 'app-env-9c1f0a4b7d' } }],
							ports: [{ name: 'http', containerPort: 3000 }]
						}
					]
				}
			}
		},
		status: { observedGeneration: 3, replicas: 2, updatedReplicas: 2, readyReplicas: 2, availableReplicas: 2 },
		...over
	};
}

function pod(over: Json = {}): Json {
	return {
		apiVersion: 'v1',
		kind: 'Pod',
		metadata: {
			name: 'web-rs1-pod0',
			namespace: NAMESPACE,
			labels: { [APP_LABEL_WORK_ID]: WORK_ID, [APP_LABEL_COMPONENT]: 'web' },
			creationTimestamp: '2026-09-17T08:00:00.000Z'
		},
		spec: { containers: [{ name: 'web', image: IMAGE }] },
		status: {
			phase: 'Running',
			containerStatuses: [
				{
					name: 'web',
					ready: true,
					started: true,
					restartCount: 0,
					state: { running: { startedAt: '2026-09-17T08:00:00.000Z' } }
				}
			]
		},
		...over
	};
}

function job(over: Json = {}): Json {
	return {
		apiVersion: 'batch/v1',
		kind: 'Job',
		metadata: {
			name: 'job-set-admin-password-3f2b1c4d',
			namespace: NAMESPACE,
			labels: { [APP_LABEL_WORK_ID]: WORK_ID, [APP_LABEL_JOB]: 'set-admin-password' },
			creationTimestamp: '2026-09-17T09:00:00.000Z'
		},
		status: {
			succeeded: 1,
			startTime: '2026-09-17T09:00:00.000Z',
			completionTime: '2026-09-17T09:00:21.000Z',
			conditions: [{ type: 'Complete', status: 'True' }]
		},
		...over
	};
}

function cronJob(over: Json = {}): Json {
	return {
		apiVersion: 'batch/v1',
		kind: 'CronJob',
		metadata: {
			name: 'cron-nightly',
			namespace: NAMESPACE,
			labels: { [APP_LABEL_WORK_ID]: WORK_ID, [APP_LABEL_CRON]: 'nightly' }
		},
		spec: { schedule: '0 3 * * *', suspend: false },
		status: { lastScheduleTime: '2026-09-17T03:00:00.000Z', lastSuccessfulTime: '2026-09-17T03:01:00.000Z' },
		...over
	};
}

function cronRun(over: Json = {}): Json {
	return {
		apiVersion: 'batch/v1',
		kind: 'Job',
		metadata: {
			name: 'cron-nightly-29000000',
			namespace: NAMESPACE,
			labels: { [APP_LABEL_WORK_ID]: WORK_ID, [APP_LABEL_CRON]: 'nightly' },
			creationTimestamp: '2026-09-17T03:00:00.000Z'
		},
		status: {
			succeeded: 1,
			startTime: '2026-09-17T03:00:00.000Z',
			completionTime: '2026-09-17T03:01:00.000Z',
			conditions: [{ type: 'Complete', status: 'True' }]
		},
		...over
	};
}

function ingress(over: Json = {}): Json {
	return {
		apiVersion: 'networking.k8s.io/v1',
		kind: 'Ingress',
		metadata: { name: 'web', namespace: NAMESPACE, labels: { [APP_LABEL_WORK_ID]: WORK_ID } },
		spec: { ingressClassName: 'nginx', rules: [{ host: 'analytics.example.com' }] },
		status: { loadBalancer: { ingress: [{ ip: '203.0.113.10' }] } },
		...over
	};
}

function namespace(over: Json = {}): Json {
	return {
		apiVersion: 'v1',
		kind: 'Namespace',
		metadata: { name: NAMESPACE, labels: { [APP_LABEL_WORK_ID]: WORK_ID } },
		...over
	};
}

function runnerJob(name: string, label: string, over: Json = {}): Json {
	return {
		apiVersion: 'batch/v1',
		kind: 'Job',
		metadata: {
			name,
			namespace: NAMESPACE,
			labels: { [APP_LABEL_WORK_ID]: WORK_ID, [APP_LABEL_JOB]: label },
			creationTimestamp: '2026-09-17T10:00:00.000Z'
		},
		status: { succeeded: 1, startTime: '2026-09-17T10:00:00.000Z', completionTime: '2026-09-17T10:00:12.000Z' },
		...over
	};
}

function runnerPod(name: string, label: string, container = 'runner'): Json {
	return {
		apiVersion: 'v1',
		kind: 'Pod',
		metadata: {
			name,
			namespace: NAMESPACE,
			labels: { [APP_LABEL_WORK_ID]: WORK_ID, [APP_LABEL_JOB]: label },
			creationTimestamp: '2026-09-17T10:00:00.000Z'
		},
		spec: { containers: [{ name: container }] },
		status: { phase: 'Succeeded', containerStatuses: [{ name: container, restartCount: 0 }] }
	};
}

const checkLine = (name: string, over: Json = {}): string =>
	JSON.stringify({ kind: 'http', name, status: 200, ok: true, latencyMs: 12, ...over });
const probeLine = (connected: boolean): string =>
	JSON.stringify({ kind: 'isolation-probe', name: 'isolation-probe', status: 0, ok: true, connected, latencyMs: 3 });

/** A "live" Work: one ready component, one job, one schedule, one published Ingress. */
function liveCluster(over: { cluster?: FakeCluster; spec?: AppStatusSpec } = {}): {
	cluster: FakeCluster;
	read: () => Promise<Awaited<ReturnType<AppStatusReader['getAppStatus']>>>;
} {
	const cluster = over.cluster ?? new FakeCluster();
	cluster.seed(namespace());
	cluster.seed(deployment());
	cluster.seed(pod());
	cluster.seed(job());
	cluster.seed(cronJob());
	cluster.seed(cronRun());
	cluster.seed(ingress());

	return {
		cluster,
		read: () => new AppStatusReader(cluster, { now: () => NOW }).getAppStatus(REF, KUBECONFIG, over.spec ?? SPEC)
	};
}

/* ------------------------------------------------------------------------- *
 * FR-46 — the field walk (ACC-06-31)
 * ------------------------------------------------------------------------- */

describe('FR-46 — every field of the snapshot is filled from a fake cluster (ACC-06-31)', () => {
	it('reports exactly the fields §3.1 gives an observation, and nothing else', async () => {
		const { read } = liveCluster();
		const snapshot = await read();

		expect(Object.keys(snapshot).sort()).toEqual([
			'components',
			'cron',
			'ingressAddress',
			'isolationEnforced',
			'jobs',
			'observedAt'
		]);
		// FR-46's target, state, URL, Source and "outcomes of any action still in flight" are the
		// platform's (`work_app_runtime_states` + §2.3's `ops[]`), which is why §9.10's op calls this
		// reader and stores the result. The reader reports the cluster half, and only the cluster half.
		expect(snapshot).not.toHaveProperty('state');
		expect(snapshot).not.toHaveProperty('ops');
		expect(snapshot).not.toHaveProperty('source');
	});

	it('fills per component: name, role, desired, ready, restarts and the last termination', async () => {
		const { cluster, read } = liveCluster();
		cluster.seed(
			pod({
				metadata: { name: 'web-rs1-pod1', namespace: NAMESPACE, labels: { [APP_LABEL_COMPONENT]: 'web' } },
				status: {
					phase: 'Running',
					containerStatuses: [
						{
							name: 'web',
							ready: true,
							restartCount: 4,
							state: { running: { startedAt: '2026-09-17T08:00:00.000Z' } },
							lastState: {
								terminated: { reason: 'Error', exitCode: 1, finishedAt: '2026-09-17T11:00:00.000Z' }
							}
						}
					]
				}
			})
		);

		const [component] = (await read()).components;

		expect(component).toEqual({
			name: 'web',
			role: 'web',
			desired: 2,
			ready: 2,
			restarts: 4,
			lastTerminationReason: 'Error',
			oomKilledAt: null
		});
	});

	it("reports the last OOM kill only inside FR-46's 24-hour window", async () => {
		const { cluster, read } = liveCluster();
		const withOom = (finishedAt: string): Json =>
			pod({
				status: {
					phase: 'Running',
					containerStatuses: [
						{
							name: 'web',
							ready: true,
							restartCount: 1,
							state: { running: { startedAt: finishedAt } },
							lastState: { terminated: { reason: 'OOMKilled', exitCode: 137, finishedAt } }
						}
					]
				}
			});

		// Two hours ago — inside the window.
		cluster.seed(withOom('2026-09-17T10:00:00.000Z'));
		expect((await read()).components[0].oomKilledAt).toBe('2026-09-17T10:00:00.000Z');

		// Thirty hours ago — outside it.
		cluster.seed(withOom('2026-09-16T06:00:00.000Z'));
		expect((await read()).components[0].oomKilledAt).toBeNull();
	});

	it("fills each job's last result: run name, status, times, exit code and log ref", async () => {
		const { cluster, read } = liveCluster();
		cluster.seed(runnerPod('job-set-admin-password-3f2b1c4d-pod', 'set-admin-password', 'web'));
		cluster.seed(
			pod({
				metadata: {
					name: 'job-set-admin-password-3f2b1c4d-pod',
					namespace: NAMESPACE,
					labels: { [APP_LABEL_JOB]: 'set-admin-password' },
					creationTimestamp: '2026-09-17T09:00:00.000Z'
				}
			})
		);

		const [entry] = (await read()).jobs;

		expect(entry.name).toBe('set-admin-password');
		expect(entry.last).toEqual({
			name: 'set-admin-password',
			// §4.8's renderer stamps a Job with `ever-works.io/job` and no phase label, and
			// `AppStatusSpec.jobs` carries names only — so the neutral phase is reported, not invented.
			when: 'post-deploy',
			runName: 'job-set-admin-password-3f2b1c4d',
			status: 'succeeded',
			startedAt: '2026-09-17T09:00:00.000Z',
			completedAt: '2026-09-17T09:00:21.000Z',
			logRef: {
				job: 'set-admin-password',
				pod: 'job-set-admin-password-3f2b1c4d-pod',
				container: 'web',
				previous: false
			}
		});
	});

	it('reports a running and a timed-out job with the codes §9.10 writes into statusSnapshot', async () => {
		const { cluster, read } = liveCluster();
		cluster.seed(
			job({
				metadata: {
					name: 'job-set-admin-password-3f2b1c4d',
					namespace: NAMESPACE,
					labels: { [APP_LABEL_JOB]: 'set-admin-password' },
					creationTimestamp: '2026-09-17T09:00:00.000Z'
				},
				status: { active: 1, startTime: '2026-09-17T09:00:00.000Z' }
			})
		);
		expect((await read()).jobs[0].last?.status).toBe('running');

		cluster.seed(
			job({
				metadata: {
					name: 'job-set-admin-password-3f2b1c4d',
					namespace: NAMESPACE,
					labels: { [APP_LABEL_JOB]: 'set-admin-password' },
					creationTimestamp: '2026-09-17T09:00:00.000Z'
				},
				status: {
					failed: 1,
					conditions: [{ type: 'Failed', status: 'True', reason: 'DeadlineExceeded' }]
				}
			})
		);
		expect((await read()).jobs[0].last?.status).toBe('timeout');
	});

	it('fills each scheduled call: last schedule, last success and the last outcome', async () => {
		const { read } = liveCluster();
		const [entry] = (await read()).cron;

		expect(entry).toEqual({
			name: 'nightly',
			lastScheduleAt: '2026-09-17T03:00:00.000Z',
			lastSuccessAt: '2026-09-17T03:01:00.000Z',
			lastResult: 'succeeded'
		});
	});

	it("fills the latest smoke results from the newest smoke run's report", async () => {
		const { cluster, read } = liveCluster();
		cluster.seed(runnerJob('job-smoke-3f2b1c4d', 'smoke'));
		cluster.seed(runnerPod('job-smoke-3f2b1c4d-pod', 'smoke'));
		cluster.logs.set('job-smoke-3f2b1c4d-pod/runner', `${checkLine('heartbeat')}\n${checkLine('assets')}\n`);

		const { smoke } = await read();

		expect(smoke?.inCluster).toEqual([
			{ name: 'heartbeat', status: 'passed', httpStatus: 200, latencyMs: 12 },
			{ name: 'assets', status: 'passed', httpStatus: 200, latencyMs: 12 }
		]);
		// The public half is the platform's (`AppPublicSmokeService`); a status read never dials the app.
		expect(smoke?.public).toEqual([]);
		expect(smoke?.observedAt).toBe(new Date(NOW).toISOString());
	});

	it('fills network-isolation enforcement from the newest isolation probe', async () => {
		const { cluster, read } = liveCluster();
		cluster.seed(runnerJob('job-isolation-probe-3f2b1c4d', 'isolation-probe'));
		cluster.seed(runnerPod('job-isolation-probe-3f2b1c4d-pod', 'isolation-probe'));
		cluster.logs.set('job-isolation-probe-3f2b1c4d-pod/runner', probeLine(false));

		// `connected: false` — the probe never reached the API server, so the policies are enforced.
		expect((await read()).isolationEnforced).toBe(true);

		cluster.logs.set('job-isolation-probe-3f2b1c4d-pod/runner', probeLine(true));
		expect((await read()).isolationEnforced).toBe(false);
	});

	it('fills the URL from the published Ingress address', async () => {
		const { cluster, read } = liveCluster();
		expect((await read()).ingressAddress).toEqual({ ip: '203.0.113.10' });

		cluster.seed(ingress({ status: { loadBalancer: { ingress: [{ hostname: 'lb.example.com' }] } } }));
		expect((await read()).ingressAddress).toEqual({ hostname: 'lb.example.com' });

		cluster.seed(ingress({ status: {} }));
		expect((await read()).ingressAddress).toBeNull();
	});

	it('reports the time it was observed from the injected clock', async () => {
		const { read } = liveCluster();
		expect((await read()).observedAt).toBe(new Date(NOW).toISOString());
	});

	it('omits smoke when nothing has run and reports null isolation when no probe ran', async () => {
		const { read } = liveCluster();
		const snapshot = await read();

		// `smoke` is optional in §3.1: absent means "no run", which is not the same as "no checks passed".
		expect('smoke' in snapshot).toBe(false);
		// §4.10: no probe Job ⇒ `null`, **never** `true`.
		expect(snapshot.isolationEnforced).toBeNull();
	});

	it('fills a component with no live Deployment from the declared replicas, reading no pods', async () => {
		const cluster = new FakeCluster();
		cluster.seed(namespace());

		const snapshot = await new AppStatusReader(cluster, { now: () => NOW }).getAppStatus(REF, KUBECONFIG, SPEC);
		expect(snapshot.components[0]).toEqual({
			name: 'web',
			role: 'web',
			desired: 2,
			ready: 0,
			restarts: 0,
			oomKilledAt: null
		});
		// A component Deployment that does not exist has no pods to ask about.
		expect(cluster.callsOf('list').filter((call) => call.kind === 'Pod')).toEqual([]);
	});

	it("reads only the Work's own namespace", async () => {
		const { cluster, read } = liveCluster();
		cluster.seed(
			deployment({
				metadata: {
					name: 'web',
					namespace: 'ew-other-99999999',
					labels: { [APP_LABEL_WORK_ID]: OTHER_WORK_ID, [APP_LABEL_COMPONENT]: 'web' }
				}
			})
		);

		await read();

		const namespaced = cluster.calls.filter((call) => call.op !== 'read' || call.kind !== 'Namespace');
		expect(namespaced.every((call) => call.namespace === NAMESPACE)).toBe(true);
		// …and the other Work's Deployment was never read.
		expect(cluster.calls.some((call) => call.name === 'web' && call.namespace === 'ew-other-99999999')).toBe(false);
	});
});

/* ------------------------------------------------------------------------- *
 * FR-47 — the numbers the three states come from
 * ------------------------------------------------------------------------- */

describe("the state inputs FR-47 reads (Degraded / Down / Can't reach your cluster)", () => {
	it('shows a web component below its desired replicas as ready < desired', async () => {
		const { cluster, read } = liveCluster();
		cluster.seed(
			deployment({
				status: {
					observedGeneration: 3,
					replicas: 2,
					updatedReplicas: 2,
					readyReplicas: 1,
					availableReplicas: 1
				}
			})
		);

		const [component] = (await read()).components;
		expect(component.desired).toBe(2);
		expect(component.ready).toBe(1);
	});

	it('shows a primary web component with no ready replica as ready = 0', async () => {
		const { cluster, read } = liveCluster();
		cluster.seed(
			deployment({
				status: {
					observedGeneration: 3,
					replicas: 2,
					updatedReplicas: 2,
					readyReplicas: 0,
					availableReplicas: 0
				}
			})
		);

		expect((await read()).components[0].ready).toBe(0);
	});
});

/* ------------------------------------------------------------------------- *
 * §4.12 — a verification ref
 * ------------------------------------------------------------------------- */

describe('a verification ref (§4.12: components, jobs and smoke only)', () => {
	it('omits cron and ingressAddress but still reports the probe', async () => {
		const cluster = new FakeCluster();
		cluster.seed(namespace({ metadata: { name: NAMESPACE, labels: { [APP_LABEL_PURPOSE]: 'verification' } } }));
		cluster.seed(deployment());
		cluster.seed(pod());
		cluster.seed(job());
		cluster.seed(ingress());
		cluster.seed(runnerJob('job-isolation-probe-abcdef12', 'isolation-probe'));
		cluster.seed(runnerPod('job-isolation-probe-abcdef12-pod', 'isolation-probe'));
		cluster.logs.set('job-isolation-probe-abcdef12-pod/runner', probeLine(false));

		const snapshot = await new AppStatusReader(cluster, { now: () => NOW }).getAppStatus(REF, KUBECONFIG, SPEC);

		expect(snapshot.components).toHaveLength(1);
		expect(snapshot.jobs).toHaveLength(1);
		expect(snapshot.cron).toEqual([]);
		expect(snapshot.isolationEnforced).toBe(true);
		// §4.12 renders no Ingress for a verification ref, so there is no address to report.
		expect('ingressAddress' in snapshot).toBe(false);
		// …and no CronJob is ever read for one.
		expect(cluster.calls.some((call) => call.kind === 'CronJob')).toBe(false);
	});
});

/* ------------------------------------------------------------------------- *
 * The reads themselves
 * ------------------------------------------------------------------------- */

describe('the reads a status observation makes', () => {
	it('refuses a kubeconfig §6.1 refuses before the first API call (FR-4)', async () => {
		const cluster = new FakeCluster();

		await expect(
			new AppStatusReader(cluster, { now: () => NOW }).getAppStatus(REF, UNSUPPORTED_KUBECONFIG, SPEC)
		).rejects.toBeInstanceOf(K8sPluginError);
		expect(cluster.calls).toEqual([]);
	});

	it("passes the ref's kube context to every call", async () => {
		const { cluster, read } = liveCluster();
		await read();

		expect(cluster.calls.length).toBeGreaterThan(0);
		expect(cluster.calls.every((call) => call.context === 'kind-app-runtime')).toBe(true);
	});

	it('reads the newest Job per name and the newest pod of each', async () => {
		const { cluster, read } = liveCluster();
		cluster.seed(
			job({
				metadata: {
					name: 'job-set-admin-password-older',
					namespace: NAMESPACE,
					labels: { [APP_LABEL_JOB]: 'set-admin-password' },
					creationTimestamp: '2026-09-16T09:00:00.000Z'
				}
			})
		);

		expect((await read()).jobs[0].last?.runName).toBe('job-set-admin-password-3f2b1c4d');
	});

	it("caps a runner report read at FR-48's defaults", async () => {
		const { cluster, read } = liveCluster();
		cluster.seed(runnerJob('job-smoke-3f2b1c4d', 'smoke'));
		cluster.seed(runnerPod('job-smoke-3f2b1c4d-pod', 'smoke'));
		cluster.logs.set('job-smoke-3f2b1c4d-pod/runner', checkLine('heartbeat'));

		await read();

		const logCall = cluster.callsOf('log').find((call) => call.name === 'job-smoke-3f2b1c4d-pod');
		expect(logCall?.tailLines).toBe(APP_LOG_LINES_DEFAULT);
		expect(logCall?.limitBytes).toBe(APP_LOG_BYTES_MAX);
		expect(logCall?.previous).toBe(false);
	});
});

/* ------------------------------------------------------------------------- *
 * The shared helpers (used by `app-lifecycle.ts` too)
 * ------------------------------------------------------------------------- */

describe('the live-read helpers', () => {
	it("inverts §4.1's namespace name back to the slug", () => {
		expect(workSlugFromNamespace('ew-analytics-0f8e2c1a')).toBe('analytics');
		expect(workSlugFromNamespace('ew-my-app-01234567')).toBe('my-app');
		// A verification or preview namespace is not the live one — no slug is claimed for it.
		expect(workSlugFromNamespace('ew-analytics-0f8e2c1a-vabc123-1')).toBe('');
		expect(workSlugFromNamespace('owner-chosen-namespace')).toBe('');
		// The name `appNamespaceName` builds for the fallback slug inverts to it exactly.
		expect(workSlugFromNamespace('ew-app-0f8e2c1a')).toBe('app');
	});

	it('reads the slug, the checksum and the envFrom off a live Deployment', () => {
		const live = deployment() as unknown as AppLiveDeployment;
		expect(liveWorkSlug(live)).toBe('analytics');
		expect(liveEnvChecksum(live)).toBe('9c1f0a4b7d2e3508');
		expect(liveEnvFrom(live)).toEqual([{ secretRef: { name: 'app-env-9c1f0a4b7d' } }]);
	});

	it('recovers the checksum from the env Secret name when the annotation is gone', () => {
		const live = deployment({
			spec: {
				replicas: 1,
				template: {
					metadata: { labels: {} },
					spec: { containers: [{ name: 'web', envFrom: [{ secretRef: { name: 'app-env-9c1f0a4b7d' } }] }] }
				}
			}
		}) as unknown as AppLiveDeployment;

		// `envSecretName` takes the first 10 hex of the checksum, so the recovered prefix renders the
		// same Secret name — which is what keeps a re-render from naming a Secret that does not exist.
		expect(liveEnvChecksum(live)).toBe('9c1f0a4b7d');
	});

	it('picks the primary component as the one with a container port (§4.3)', () => {
		const web = deployment() as unknown as AppLiveDeployment;
		const worker = deployment({
			metadata: { name: 'worker', namespace: NAMESPACE, labels: { [APP_LABEL_COMPONENT]: 'worker' } },
			spec: {
				replicas: 1,
				template: { metadata: { labels: {} }, spec: { containers: [{ name: 'worker', image: IMAGE }] } }
			}
		}) as unknown as AppLiveDeployment;

		expect(livePrimaryDeployment([worker, web])?.metadata?.name).toBe('web');
		expect(livePrimaryDeployment([worker])).toBeNull();
	});

	it("reads the runner report's JSON lines and ignores anything that is not one", () => {
		const records = parseRunnerRecords(`${checkLine('heartbeat')}\nnot json\n{"partial":`);
		expect(records.map((record) => record.name)).toEqual(['heartbeat']);
	});

	it('sums restarts over the current pods and windows the OOM kill', () => {
		const summary = componentPodSummary(
			[
				pod({
					status: {
						containerStatuses: [
							{
								name: 'web',
								restartCount: 2,
								lastState: {
									terminated: {
										reason: 'OOMKilled',
										exitCode: 137,
										finishedAt: '2026-09-17T11:00:00.000Z'
									}
								}
							}
						]
					}
				})
			] as never,
			NOW
		);

		expect(summary).toEqual({
			restarts: 2,
			reason: 'OOMKilled',
			oomKilledAt: '2026-09-17T11:00:00.000Z'
		});
	});

	it('reads an Ingress address only when the controller published one', () => {
		expect(ingressAddressOf(ingress())).toEqual({ ip: '203.0.113.10' });
		expect(ingressAddressOf({ status: { loadBalancer: { ingress: [{}] } } })).toBeNull();
		expect(ingressAddressOf(null)).toBeNull();
	});

	it('picks the newest Job and the newest pod, ties broken by name', () => {
		const older = job({
			metadata: { name: 'b', namespace: NAMESPACE, creationTimestamp: '2026-09-16T00:00:00.000Z' }
		});
		const newer = job({
			metadata: { name: 'a', namespace: NAMESPACE, creationTimestamp: '2026-09-17T00:00:00.000Z' }
		});
		const tied = job({
			metadata: { name: 'c', namespace: NAMESPACE, creationTimestamp: '2026-09-17T00:00:00.000Z' }
		});

		expect(newestJob([older, newer, tied])?.metadata?.name).toBe('c');
		expect(newestJob([])).toBeNull();
		expect(newestPod([] as never)).toBeNull();
	});
});
