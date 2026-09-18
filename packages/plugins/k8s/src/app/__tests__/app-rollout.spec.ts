/**
 * T9 — `app-rollout.ts` (plan §5.4, §5.3, §4.4; spec ACC-06-08).
 *
 * Every clause of T9's `**Test**` line (tasks.md:169-172) has an `it` below whose title names the
 * clause:
 *
 * - "`metadata.generation` vs `observedGeneration`"
 * - "old ReplicaSet with ready pods blocks success"
 * - "3 restarts"
 * - "`ImagePullBackOff` for 179 s vs 180 s"
 * - "`OOMKilled`"
 * - "the two root-user kubelet messages classify `managed_root_forbidden` /
 *   `image_user_unverifiable` within 180 s (ACC-06-08)"
 *
 * plus T9's `**Done when**` line (tasks.md:173-174) — "each `AppFailureCode` in plan §5.4 has at
 * least one test"; the §12.1 test list's "updated/available replicas … worker stability 30 s"; and
 * §5.4's APW06-G07 paragraph (only pods created for the current rollout count).
 *
 * **On the root-user code.** tasks.md:171-172 still prints the pre-fix name
 * `image_runs_as_root`; plan §4.4:499-505 (as corrected) says the classifier returns
 * **`managed_root_forbidden`**, the only one of the two that exists in §3.1's `AppFailureCode`
 * union, and `image_runs_as_root` is the i18n leaf `failures.imageRunsAsRoot`. The classifier
 * therefore returns `managed_root_forbidden`, and this file asserts it.
 *
 * Pure functions only: **no clock**. Every instant the classifier needs (`now`, a pod's
 * `creationTimestamp`, a caller-observed `stuckSince`) is an argument or cluster data, so the same
 * observations always classify the same way.
 */
import { describe, expect, it } from 'vitest';
import type { AppFailureCode } from '@ever-works/plugin';

import {
	APP_ROLLOUT_RESTARTS_FAIL,
	APP_ROLLOUT_STUCK_POD_S,
	APP_WORKER_STABLE_S,
	classifyPodFailure,
	classifyPodFailures,
	currentRolloutPods,
	isComponentRolledOut,
	requiresWorkerStability,
	workerStable,
	type AppPodFailure,
	type AppRolloutComponent,
	type AppRolloutDeployment,
	type AppRolloutOptions,
	type AppRolloutPod,
	type AppRolloutReplicaSet
} from '../app-rollout';

// --- fixtures ---------------------------------------------------------------

type Json = Record<string, any>;

const T0 = '2026-01-01T00:00:00.000Z';
const STARTED = '2026-01-01T00:00:00.000Z';

/** A fixed instant, `seconds` after {@link T0} — never `Date.now()`. */
const at = (seconds: number): string => new Date(Date.parse(T0) + seconds * 1_000).toISOString();

function merge<T extends Json>(base: T, over: Json = {}): T {
	const out: Json = Array.isArray(base) ? [...(base as unknown as unknown[])] : { ...base };
	for (const [key, value] of Object.entries(over)) {
		const current = out[key];
		out[key] =
			value &&
			typeof value === 'object' &&
			!Array.isArray(value) &&
			current &&
			typeof current === 'object' &&
			!Array.isArray(current)
				? merge(current as Json, value as Json)
				: value;
	}
	return out as T;
}

/** A Deployment that satisfies every clause of §5.4. */
function deployment(over: Json = {}): AppRolloutDeployment {
	return merge(
		{
			metadata: { name: 'web', namespace: 'ew-demo-1a2b3c4d', generation: 3, creationTimestamp: T0 },
			spec: { replicas: 1, template: { metadata: { labels: { 'ever-works.io/component': 'web' } } } },
			status: {
				observedGeneration: 3,
				replicas: 1,
				updatedReplicas: 1,
				readyReplicas: 1,
				availableReplicas: 1,
				unavailableReplicas: 0,
				conditions: []
			}
		} as Json,
		over
	) as AppRolloutDeployment;
}

/** The ReplicaSet the Deployment's controller owns for the current template. */
function replicaSet(over: Json = {}): AppRolloutReplicaSet {
	return merge(
		{
			metadata: {
				name: 'web-7c9f',
				namespace: 'ew-demo-1a2b3c4d',
				creationTimestamp: T0,
				labels: { 'pod-template-hash': '7c9f' },
				ownerReferences: [{ apiVersion: 'apps/v1', kind: 'Deployment', name: 'web' }]
			},
			spec: { replicas: 1 },
			status: { replicas: 1, readyReplicas: 1, availableReplicas: 1, observedGeneration: 1 }
		} as Json,
		over
	) as AppRolloutReplicaSet;
}

/** A pod of the current template, running cleanly since {@link STARTED}. */
function pod(over: Json = {}): AppRolloutPod {
	return merge(
		{
			metadata: {
				name: 'web-7c9f-abcde',
				namespace: 'ew-demo-1a2b3c4d',
				creationTimestamp: STARTED,
				labels: { 'pod-template-hash': '7c9f', 'ever-works.io/component': 'web' },
				ownerReferences: [{ apiVersion: 'apps/v1', kind: 'ReplicaSet', name: 'web-7c9f' }]
			},
			status: {
				phase: 'Running',
				containerStatuses: [
					{
						name: 'web',
						ready: true,
						restartCount: 0,
						state: { running: { startedAt: STARTED } },
						lastState: {}
					}
				]
			}
		} as Json,
		over
	) as AppRolloutPod;
}

/** A pod whose single container sits in `waiting` — the stuck-container shape of §5.4. */
function stuckPod(reason: string, over: Json = {}, message?: string): AppRolloutPod {
	return pod(
		merge(
			{
				status: {
					phase: 'Pending',
					containerStatuses: [
						{
							name: 'web',
							ready: false,
							restartCount: 0,
							state: { waiting: { reason, ...(message ? { message } : {}) } }
						}
					]
				}
			} as Json,
			over
		)
	);
}

const worker: AppRolloutComponent = { name: 'worker', role: 'worker', probes: {} };
const web: AppRolloutComponent = { name: 'web', role: 'web', probes: {} };

const opts = (over: AppRolloutOptions = {}): AppRolloutOptions => ({ now: at(600), startedAt: STARTED, ...over });

const ROOT_MESSAGE = 'container has runAsNonRoot and image will run as root';
const NON_NUMERIC_MESSAGE = 'image has non-numeric user (nextjs), cannot verify user is non-root';

// --- isComponentRolledOut (plan §5.4) --------------------------------------

describe('isComponentRolledOut (plan §5.4: "Component rolled out ⇔ …")', () => {
	it('is true when every clause holds', () => {
		expect(isComponentRolledOut(deployment(), [replicaSet()], [pod()], opts({ component: web }))).toBe(true);
	});

	it('compares `metadata.generation` with `status.observedGeneration`', () => {
		expect(isComponentRolledOut(deployment({ metadata: { generation: 4 } }), [replicaSet()], [pod()], opts())).toBe(
			false
		);
		expect(
			isComponentRolledOut(deployment({ status: { observedGeneration: 4 } }), [replicaSet()], [pod()], opts())
		).toBe(true);
	});

	it('requires `updatedReplicas` to equal `replicas`', () => {
		expect(
			isComponentRolledOut(deployment({ status: { updatedReplicas: 0 } }), [replicaSet()], [pod()], opts())
		).toBe(false);
	});

	it('requires `availableReplicas` to equal `replicas`', () => {
		expect(
			isComponentRolledOut(
				deployment({ status: { availableReplicas: 0, readyReplicas: 1 } }),
				[replicaSet()],
				[pod()],
				opts()
			)
		).toBe(false);
	});

	it('requires `unavailableReplicas` to be absent or 0', () => {
		expect(
			isComponentRolledOut(deployment({ status: { unavailableReplicas: 1 } }), [replicaSet()], [pod()], opts())
		).toBe(false);

		const absent = deployment();
		delete (absent.status as Json).unavailableReplicas;
		expect(isComponentRolledOut(absent, [replicaSet()], [pod()], opts())).toBe(true);
	});

	it('means `replicas`, not `status.replicas`: a scaled-up Deployment is not done early', () => {
		expect(
			isComponentRolledOut(
				deployment({
					spec: { replicas: 3 },
					status: { replicas: 3, updatedReplicas: 1, availableReplicas: 1 }
				}),
				[
					replicaSet({
						spec: { replicas: 3 },
						status: { replicas: 3, readyReplicas: 1, availableReplicas: 1 }
					})
				],
				[pod()],
				opts()
			)
		).toBe(false);
	});

	it('is blocked by an old ReplicaSet that still has ready pods', () => {
		const old = replicaSet({
			metadata: { name: 'web-6b8e', creationTimestamp: at(-600), labels: { 'pod-template-hash': '6b8e' } },
			spec: { replicas: 0 },
			status: { replicas: 1, readyReplicas: 1, availableReplicas: 1 }
		});

		expect(isComponentRolledOut(deployment(), [replicaSet(), old], [pod()], opts())).toBe(false);

		const draining = replicaSet({
			metadata: { name: 'web-6b8e', creationTimestamp: at(-600), labels: { 'pod-template-hash': '6b8e' } },
			spec: { replicas: 0 },
			status: { replicas: 0, readyReplicas: 0, availableReplicas: 0 }
		});
		expect(isComponentRolledOut(deployment(), [replicaSet(), draining], [pod()], opts())).toBe(true);
	});

	it('treats the newest ReplicaSet by creationTimestamp, then by name', () => {
		const sameSecondOlder = replicaSet({ metadata: { name: 'web-7c9f', creationTimestamp: T0 } });
		const sameSecondNewer = replicaSet({
			metadata: { name: 'web-8d0a', creationTimestamp: T0, labels: { 'pod-template-hash': '8d0a' } },
			status: { replicas: 1, readyReplicas: 1, availableReplicas: 1 }
		});
		// The alphabetically-later ReplicaSet is the newest, so the other one having ready pods blocks.
		expect(isComponentRolledOut(deployment(), [sameSecondOlder, sameSecondNewer], [pod()], opts())).toBe(false);
	});

	it('ignores ReplicaSets that belong to another Deployment', () => {
		const foreign = replicaSet({
			metadata: {
				name: 'other-1234',
				creationTimestamp: at(600),
				ownerReferences: [{ apiVersion: 'apps/v1', kind: 'Deployment', name: 'other' }]
			},
			status: { replicas: 1, readyReplicas: 1, availableReplicas: 1 }
		});
		expect(isComponentRolledOut(deployment(), [replicaSet(), foreign], [pod()], opts())).toBe(true);
	});

	it('is false for a Deployment that does not exist yet', () => {
		expect(isComponentRolledOut(null, [], [], opts())).toBe(false);
		expect(isComponentRolledOut(undefined, [], [], opts())).toBe(false);
	});

	it('holds as soon as the predicate holds when nothing changed (plan §5.4, APW06-G07)', () => {
		// The unchanged-template case: the ReplicaSet and its pods predate the Deployment's start,
		// yet the rollout is complete — no new ReplicaSet was created and none is needed.
		const old = replicaSet({ metadata: { creationTimestamp: at(-3_600) } });
		const oldPod = pod({ metadata: { creationTimestamp: at(-3_600) } });

		expect(isComponentRolledOut(deployment(), [old], [oldPod], opts({ component: web }))).toBe(true);
	});
});

// --- worker stability (plan §5.4, §5.3 APP_WORKER_STABLE_S = 30) ------------

describe('workerStable (plan §5.4: "for workers without probes — each new pod has restartCount = 0 for 30 s")', () => {
	it('requires a worker pod to have run 30 s without a restart', () => {
		expect(workerStable([pod()], { now: at(29), desiredReplicas: 1 })).toBe(false);
		expect(workerStable([pod()], { now: at(30), desiredReplicas: 1 })).toBe(true);

		expect(APP_WORKER_STABLE_S).toBe(30);
	});

	it("measures from the container's own start, falling back to the pod", () => {
		const runningLate = pod({
			status: {
				containerStatuses: [
					{ name: 'web', ready: true, restartCount: 0, state: { running: { startedAt: at(10) } } }
				]
			}
		});
		expect(workerStable([runningLate], { now: at(39), desiredReplicas: 1 })).toBe(false);
		expect(workerStable([runningLate], { now: at(40), desiredReplicas: 1 })).toBe(true);

		const noStart = pod({
			status: { containerStatuses: [{ name: 'web', ready: true, restartCount: 0, state: {} }] }
		});
		expect(workerStable([noStart], { now: at(30), desiredReplicas: 1 })).toBe(true);
	});

	it('is false after any restart, even a long-running one', () => {
		const restarted = pod({
			status: {
				containerStatuses: [
					{ name: 'web', ready: true, restartCount: 1, state: { running: { startedAt: STARTED } } }
				]
			}
		});
		expect(workerStable([restarted], { now: at(600), desiredReplicas: 1 })).toBe(false);
	});

	it('is false while a container has not started, and for an empty pod list', () => {
		expect(workerStable([stuckPod('ContainerCreating')], { now: at(600), desiredReplicas: 1 })).toBe(false);
		expect(workerStable([pod({ status: { containerStatuses: [] } })], { now: at(600), desiredReplicas: 1 })).toBe(
			false
		);
		expect(workerStable([], { now: at(600), desiredReplicas: 1 })).toBe(false);
	});

	it('has nothing to stabilise when the Deployment asks for 0 replicas', () => {
		expect(workerStable([], { now: at(600), desiredReplicas: 0 })).toBe(true);
	});

	it('ignores pods that predate the current rollout when `startedAt` is given', () => {
		const previous = pod({ metadata: { name: 'web-6b8e-zzzzz', creationTimestamp: at(-600) } });
		expect(workerStable([previous], { now: at(600), startedAt: STARTED, desiredReplicas: 1 })).toBe(false);
	});
});

describe('requiresWorkerStability (plan §5.4: "for workers without probes")', () => {
	it('is true only for a worker that declares no probe', () => {
		expect(requiresWorkerStability(worker)).toBe(true);
		expect(requiresWorkerStability(web)).toBe(false);
		expect(requiresWorkerStability({ name: 'w', role: 'worker', probes: { readiness: {} as never } })).toBe(false);
		expect(requiresWorkerStability({ name: 'w', role: 'worker', probes: null })).toBe(true);
		expect(requiresWorkerStability(null)).toBe(false);
	});

	it('is applied by isComponentRolledOut when the caller names the component', () => {
		const args: [AppRolloutDeployment, AppRolloutReplicaSet[], AppRolloutPod[]] = [
			deployment(),
			[replicaSet()],
			[pod()]
		];

		expect(isComponentRolledOut(...args, opts({ component: worker, now: at(29) }))).toBe(false);
		expect(isComponentRolledOut(...args, opts({ component: worker, now: at(30) }))).toBe(true);
		expect(isComponentRolledOut(...args, opts({ component: web, now: at(0) }))).toBe(true);
	});

	it('is left to the caller when no component is named — and without `now` it cannot be proven', () => {
		const args: [AppRolloutDeployment, AppRolloutReplicaSet[], AppRolloutPod[]] = [
			deployment(),
			[replicaSet()],
			[pod()]
		];

		expect(isComponentRolledOut(...args, { component: worker, startedAt: STARTED })).toBe(false);
		expect(isComponentRolledOut(...args, { now: at(600) })).toBe(true);
	});
});

// --- currentRolloutPods (plan §5.4, APW06-G07) ------------------------------

describe('currentRolloutPods (plan §5.4: "apply only to pods created after the Deployment started")', () => {
	it('selects the pods of the newest ReplicaSet and nothing else', () => {
		const previous = pod({
			metadata: {
				name: 'web-6b8e-zzzzz',
				creationTimestamp: at(-600),
				labels: { 'pod-template-hash': '6b8e' },
				ownerReferences: [{ apiVersion: 'apps/v1', kind: 'ReplicaSet', name: 'web-6b8e' }]
			}
		});
		const current = currentRolloutPods(deployment(), [replicaSet()], [previous, pod()], opts({ component: web }));

		expect(current.map((entry) => entry.metadata?.name)).toEqual(['web-7c9f-abcde']);
	});

	it('falls back to `startedAt` when the pods carry no ownership information', () => {
		const anonymous = (createdAt: string): AppRolloutPod =>
			pod({ metadata: { name: `web-${createdAt}`, creationTimestamp: createdAt } });
		const pods = [anonymous(at(-600)), anonymous(at(60))];

		expect(
			currentRolloutPods(deployment(), [], pods, opts({ component: web })).map((entry) => entry.metadata?.name)
		).toEqual(['web-2026-01-01T00:01:00.000Z']);
	});

	it('keeps every pod when the caller has no start instant to filter by', () => {
		expect(currentRolloutPods(deployment(), [], [pod()], { component: web })).toHaveLength(1);
	});
});

// --- the failure classifier (plan §5.4) ------------------------------------

describe('classifyPodFailure — crash loops (plan §5.4: "any container restartCount ≥ 3")', () => {
	it('classifies a third restart as `crash_loop`, with the last termination', () => {
		const restarts = (count: number): AppRolloutPod =>
			pod({
				status: {
					containerStatuses: [
						{
							name: 'web',
							ready: false,
							restartCount: count,
							state: { waiting: { reason: 'CrashLoopBackOff' } },
							lastState: { terminated: { reason: 'Error', exitCode: 1, finishedAt: at(120) } }
						}
					]
				}
			});

		expect(classifyPodFailure(deployment(), [replicaSet()], [restarts(2)], opts({ component: web }))).toBeNull();

		const failure = classifyPodFailure(deployment(), [replicaSet()], [restarts(3)], opts({ component: web }));
		expect(failure).toMatchObject({
			code: 'crash_loop',
			signal: 'crash_loop',
			pod: 'web-7c9f-abcde',
			container: 'web',
			reason: 'Error',
			exitCode: 1,
			restarts: 3
		});
		expect(APP_ROLLOUT_RESTARTS_FAIL).toBe(3);
	});

	it('counts restarts only for pods of the current rollout (plan §5.4, APW06-G07)', () => {
		const previous = pod({
			metadata: {
				name: 'web-6b8e-zzzzz',
				creationTimestamp: at(-600),
				labels: { 'pod-template-hash': '6b8e' },
				ownerReferences: [{ apiVersion: 'apps/v1', kind: 'ReplicaSet', name: 'web-6b8e' }]
			},
			status: {
				containerStatuses: [
					{
						name: 'web',
						ready: false,
						restartCount: 9,
						state: { waiting: { reason: 'CrashLoopBackOff' } },
						lastState: { terminated: { reason: 'Error', exitCode: 137, finishedAt: at(-60) } }
					}
				]
			}
		});

		expect(classifyPodFailure(deployment(), [replicaSet()], [previous], opts({ component: web }))).toBeNull();
	});

	it('counts restarts of an init container too', () => {
		const failingInit = pod({
			status: {
				initContainerStatuses: [
					{
						name: 'migrate',
						restartCount: 3,
						state: { waiting: { reason: 'CrashLoopBackOff' } },
						lastState: { terminated: { reason: 'Error', exitCode: 2, finishedAt: at(90) } }
					}
				]
			}
		});

		expect(classifyPodFailure(deployment(), [replicaSet()], [failingInit], opts({ component: web }))).toMatchObject(
			{
				code: 'crash_loop',
				container: 'migrate',
				exitCode: 2
			}
		);
	});
});

describe('classifyPodFailure — OOMKilled (plan §5.4: "counted as a restart and reported (`oom_killed`)")', () => {
	it('classifies an OOM kill at any restart count, with the instant it happened', () => {
		const oom = pod({
			status: {
				containerStatuses: [
					{
						name: 'web',
						ready: false,
						restartCount: 1,
						state: { running: { startedAt: at(200) } },
						lastState: { terminated: { reason: 'OOMKilled', exitCode: 137, finishedAt: at(199) } }
					}
				]
			}
		});

		expect(classifyPodFailure(deployment(), [replicaSet()], [oom], opts({ component: web }))).toMatchObject({
			code: 'oom_killed',
			signal: 'oom_killed',
			container: 'web',
			exitCode: 137,
			restarts: 1,
			oomKilledAt: at(199),
			reason: 'OOMKilled'
		});
	});

	it('reports `oom_killed` rather than `crash_loop` for a looping OOM kill', () => {
		const looping = pod({
			status: {
				containerStatuses: [
					{
						name: 'web',
						ready: false,
						restartCount: 7,
						state: { waiting: { reason: 'CrashLoopBackOff' } },
						lastState: { terminated: { reason: 'OOMKilled', exitCode: 137, finishedAt: at(300) } }
					}
				]
			}
		});

		expect(classifyPodFailure(deployment(), [replicaSet()], [looping], opts({ component: web }))?.code).toBe(
			'oom_killed'
		);
	});

	it("reads an OOM kill from the container's current terminated state as well", () => {
		const terminated = pod({
			status: {
				containerStatuses: [
					{
						name: 'web',
						ready: false,
						restartCount: 0,
						state: { terminated: { reason: 'OOMKilled', exitCode: 137, finishedAt: at(400) } }
					}
				]
			}
		});

		expect(classifyPodFailure(deployment(), [replicaSet()], [terminated], opts({ component: web }))).toMatchObject({
			code: 'oom_killed',
			oomKilledAt: at(400)
		});
	});

	it('is not distracted by a job that completed normally', () => {
		const completed = pod({
			status: {
				containerStatuses: [
					{
						name: 'web',
						ready: false,
						restartCount: 0,
						state: { terminated: { reason: 'Completed', exitCode: 0, finishedAt: at(400) } }
					}
				]
			}
		});

		expect(classifyPodFailure(deployment(), [replicaSet()], [completed], opts({ component: web }))).toBeNull();
	});
});

describe('classifyPodFailure — stuck waiting reasons (plan §5.4: "for ≥ 180 s")', () => {
	it('classifies ImagePullBackOff at 180 s and not a second earlier', () => {
		const args: [AppRolloutDeployment, AppRolloutReplicaSet[], AppRolloutPod[]] = [
			deployment(),
			[replicaSet()],
			[stuckPod('ImagePullBackOff')]
		];

		expect(classifyPodFailure(...args, opts({ component: web, stuckSeconds: 179 }))).toBeNull();

		const failure = classifyPodFailure(...args, opts({ component: web, stuckSeconds: 180 }));
		expect(failure).toMatchObject({
			code: 'image_pull',
			signal: 'stuck_waiting',
			reason: 'ImagePullBackOff',
			seconds: 180
		});
		expect(APP_ROLLOUT_STUCK_POD_S).toBe(180);
	});

	it('measures the wait from `stuckSince` when the caller recorded the first observation', () => {
		const args: [AppRolloutDeployment, AppRolloutReplicaSet[], AppRolloutPod[]] = [
			deployment(),
			[replicaSet()],
			[stuckPod('ErrImagePull')]
		];

		expect(
			classifyPodFailure(
				...args,
				opts({ component: web, now: at(179), podWaitingSince: { 'web-7c9f-abcde/web': at(0) } })
			)
		).toBeNull();
		expect(
			classifyPodFailure(
				...args,
				opts({ component: web, now: at(180), podWaitingSince: { 'web-7c9f-abcde/web': at(0) } })
			)
		).toMatchObject({ code: 'image_pull', seconds: 180 });
	});

	it("falls back to the pod's own age when the caller has no observation yet", () => {
		const pending = stuckPod('ImagePullBackOff', { metadata: { creationTimestamp: at(-181) } });

		expect(
			classifyPodFailure(deployment(), [replicaSet()], [pending], opts({ component: web, now: at(0) }))
		).toMatchObject({ code: 'image_pull' });
	});

	it('maps each waiting reason to its §5.4 code', () => {
		const classify = (reason: string, over: Json = {}): string | undefined =>
			classifyPodFailure(
				deployment(),
				[replicaSet()],
				[stuckPod(reason, over)],
				opts({ component: web, stuckSeconds: 300 })
			)?.code;

		expect(classify('ImagePullBackOff')).toBe('image_pull');
		expect(classify('ErrImagePull')).toBe('image_pull');
		expect(classify('InvalidImageName')).toBe('image_pull');
		expect(classify('CreateContainerConfigError')).toBe('create_container_config');
		expect(classify('CreateContainerError')).toBe('create_container_config');
		// A reason §5.4 does not name is not invented into a failure code.
		expect(classify('ContainerCreating')).toBeUndefined();
	});

	it('classifies a stuck waiting container with no reason at all as nothing', () => {
		const reasonless = pod({
			status: {
				phase: 'Pending',
				containerStatuses: [{ name: 'web', ready: false, restartCount: 0, state: { waiting: {} } }]
			}
		});
		expect(
			classifyPodFailure(deployment(), [replicaSet()], [reasonless], opts({ component: web, stuckSeconds: 600 }))
		).toBeNull();
	});
});

describe('classifyPodFailure — the two root-user kubelet messages (plan §4.4, ACC-06-08)', () => {
	/** The kubelet reports these as a `CreateContainerConfigError` waiting state with a message. */
	const rootUser = (message: string): AppRolloutPod => stuckPod('CreateContainerConfigError', {}, message);

	it('classifies "container has runAsNonRoot and image will run as root" as `managed_root_forbidden` at 180 s', () => {
		const args: [AppRolloutDeployment, AppRolloutReplicaSet[], AppRolloutPod[]] = [
			deployment(),
			[replicaSet()],
			[rootUser(ROOT_MESSAGE)]
		];

		// ACC-06-08: the rollout fails ≤ 180 s, and exactly at the 180 s window — not before it.
		expect(classifyPodFailure(...args, opts({ component: web, stuckSeconds: 179 }))).toBeNull();

		const failure = classifyPodFailure(...args, opts({ component: web, stuckSeconds: 180 }));
		expect(failure).toMatchObject({
			code: 'managed_root_forbidden',
			signal: 'root_user',
			reason: 'CreateContainerConfigError',
			message: ROOT_MESSAGE,
			seconds: 180
		});
		// The union member T9's line prints is not a code: §3.1 has `managed_root_forbidden` only.
		expect(failure?.code).not.toBe('image_runs_as_root');
	});

	it('classifies "image has non-numeric user" as `image_user_unverifiable` within 180 s', () => {
		const args: [AppRolloutDeployment, AppRolloutReplicaSet[], AppRolloutPod[]] = [
			deployment(),
			[replicaSet()],
			[rootUser(NON_NUMERIC_MESSAGE)]
		];

		expect(classifyPodFailure(...args, opts({ component: web, stuckSeconds: 179 }))).toBeNull();
		expect(classifyPodFailure(...args, opts({ component: web, stuckSeconds: 180 }))).toMatchObject({
			code: 'image_user_unverifiable',
			signal: 'non_numeric_user',
			message: NON_NUMERIC_MESSAGE
		});
	});

	it('wins over the generic `create_container_config` mapping for the same container', () => {
		const failure = classifyPodFailure(
			deployment(),
			[replicaSet()],
			[rootUser(ROOT_MESSAGE)],
			opts({ component: web, stuckSeconds: 600 })
		);
		expect(failure?.code).toBe('managed_root_forbidden');
	});
});

describe('classifyPodFailure — ProgressDeadlineExceeded (plan §5.4)', () => {
	it("classifies the Deployment's own deadline condition as `rollout_timeout`", () => {
		const exceeded = deployment({
			status: {
				conditions: [
					{
						type: 'Progressing',
						status: 'False',
						reason: 'ProgressDeadlineExceeded',
						message: 'progress dead'
					}
				]
			}
		});

		expect(
			classifyPodFailure(
				exceeded,
				[replicaSet()],
				[pod({ status: { phase: 'Pending', containerStatuses: [] } })],
				opts({ component: web })
			)
		).toMatchObject({ code: 'rollout_timeout', signal: 'progress_deadline' });
	});

	it('leaves a healthy Progressing condition alone', () => {
		const progressing = deployment({
			status: { conditions: [{ type: 'Progressing', status: 'True', reason: 'NewReplicaSetAvailable' }] }
		});
		expect(classifyPodFailure(progressing, [replicaSet()], [pod()], opts({ component: web }))).toBeNull();
	});

	it('prefers a specific pod failure over the Deployment-level deadline', () => {
		const both = deployment({
			status: { conditions: [{ type: 'Progressing', status: 'False', reason: 'ProgressDeadlineExceeded' }] }
		});
		expect(
			classifyPodFailure(
				both,
				[replicaSet()],
				[stuckPod('ImagePullBackOff')],
				opts({ component: web, stuckSeconds: 600 })
			)?.code
		).toBe('image_pull');
	});
});

describe('classifyPodFailures — the whole picture, in precedence order', () => {
	it('returns every signal it can prove, most specific first', () => {
		const messy = pod({
			status: {
				containerStatuses: [
					{
						name: 'web',
						ready: false,
						restartCount: 3,
						state: { waiting: { reason: 'ImagePullBackOff' } },
						lastState: { terminated: { reason: 'OOMKilled', exitCode: 137, finishedAt: at(120) } }
					}
				]
			}
		});
		const failures = classifyPodFailures(
			deployment(),
			[replicaSet()],
			[messy],
			opts({ component: web, stuckSeconds: 600 })
		);

		expect(failures.map((failure) => failure.code)).toEqual(['oom_killed', 'crash_loop', 'image_pull']);
		expect(
			classifyPodFailure(deployment(), [replicaSet()], [messy], opts({ component: web, stuckSeconds: 600 }))?.code
		).toBe('oom_killed');
	});

	it('needs `now` for the time-based signals and reports nothing it cannot time', () => {
		const args: [AppRolloutDeployment, AppRolloutReplicaSet[], AppRolloutPod[]] = [
			deployment(),
			[replicaSet()],
			[stuckPod('ImagePullBackOff')]
		];

		// No `now` and no observed duration: the classifier must not invent a duration.
		expect(classifyPodFailure(...args, { component: web })).toBeNull();

		// An OOM kill needs no clock, so it is still reported.
		const oom = pod({
			status: {
				containerStatuses: [
					{
						name: 'web',
						ready: false,
						restartCount: 1,
						lastState: { terminated: { reason: 'OOMKilled', exitCode: 137 } }
					}
				]
			}
		});
		expect(classifyPodFailure(deployment(), [replicaSet()], [oom], { component: web })?.code).toBe('oom_killed');
	});

	it('is empty for a healthy pod', () => {
		expect(classifyPodFailures(deployment(), [replicaSet()], [pod()], opts({ component: web }))).toEqual([]);
	});
});

// --- T9 `**Done when**`: every §5.4 code has a test -------------------------

describe('T9 `**Done when**`: each `AppFailureCode` in plan §5.4 has a test', () => {
	const cases: Array<{ code: AppFailureCode; build: () => AppPodFailure | null }> = [
		{
			code: 'crash_loop',
			build: () =>
				classifyPodFailure(
					deployment(),
					[replicaSet()],
					[
						pod({
							status: {
								containerStatuses: [
									{
										name: 'web',
										restartCount: 3,
										state: { waiting: { reason: 'CrashLoopBackOff' } },
										lastState: { terminated: { reason: 'Error', exitCode: 1 } }
									}
								]
							}
						})
					],
					opts({ component: web })
				)
		},
		{
			code: 'oom_killed',
			build: () =>
				classifyPodFailure(
					deployment(),
					[replicaSet()],
					[
						pod({
							status: {
								containerStatuses: [
									{
										name: 'web',
										restartCount: 1,
										lastState: { terminated: { reason: 'OOMKilled', exitCode: 137 } }
									}
								]
							}
						})
					],
					opts({ component: web })
				)
		},
		{
			code: 'image_pull',
			build: () =>
				classifyPodFailure(
					deployment(),
					[replicaSet()],
					[stuckPod('ImagePullBackOff')],
					opts({ component: web, stuckSeconds: 180 })
				)
		},
		{
			code: 'create_container_config',
			build: () =>
				classifyPodFailure(
					deployment(),
					[replicaSet()],
					[stuckPod('CreateContainerConfigError')],
					opts({ component: web, stuckSeconds: 180 })
				)
		},
		{
			code: 'managed_root_forbidden',
			build: () =>
				classifyPodFailure(
					deployment(),
					[replicaSet()],
					[stuckPod('CreateContainerConfigError', {}, ROOT_MESSAGE)],
					opts({ component: web, stuckSeconds: 180 })
				)
		},
		{
			code: 'image_user_unverifiable',
			build: () =>
				classifyPodFailure(
					deployment(),
					[replicaSet()],
					[stuckPod('CreateContainerConfigError', {}, NON_NUMERIC_MESSAGE)],
					opts({ component: web, stuckSeconds: 180 })
				)
		},
		{
			code: 'rollout_timeout',
			build: () =>
				classifyPodFailure(
					deployment({
						status: {
							conditions: [{ type: 'Progressing', status: 'False', reason: 'ProgressDeadlineExceeded' }]
						}
					}),
					[replicaSet()],
					[pod({ status: { phase: 'Pending', containerStatuses: [] } })],
					opts({ component: web })
				)
		}
	];

	it('covers exactly the seven codes §5.4 names, and each one is reachable', () => {
		const reached = new Set(cases.map((entry) => entry.build()?.code));

		expect([...cases.map((entry) => entry.code)].sort()).toEqual([
			'crash_loop',
			'create_container_config',
			'image_pull',
			'image_user_unverifiable',
			'managed_root_forbidden',
			'oom_killed',
			'rollout_timeout'
		]);
		for (const entry of cases) {
			expect(entry.build()?.code, entry.code).toBe(entry.code);
		}
		expect(reached.size).toBe(cases.length);
	});

	it("never returns a code outside §3.1's union, and never the leaf name `image_runs_as_root`", () => {
		const union: AppFailureCode[] = [
			'crash_loop',
			'oom_killed',
			'image_pull',
			'create_container_config',
			'rollout_timeout',
			'job_failed',
			'smoke_failed',
			'publish_failed',
			'rollback_failed',
			'cluster_unreachable',
			'worker_failed',
			'isolation_not_enforced',
			'managed_root_forbidden',
			'image_user_unverifiable',
			'deadline_exceeded',
			'image_not_found',
			'image_private_unsupported',
			'image_unresolvable'
		];
		for (const entry of cases) {
			expect(union, entry.code).toContain(entry.build()?.code);
		}
		expect(union).not.toContain('image_runs_as_root');
	});
});
