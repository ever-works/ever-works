/**
 * T9 — the rollout predicate and the failure classifier (plan §5.4, §5.3, §4.4; spec FR-15/FR-24,
 * ACC-06-08).
 *
 * Pure functions over **observed cluster state**: a Deployment, its ReplicaSets and its pods come
 * in, a verdict comes out. **No I/O, no clock, no cluster access** — every instant is either
 * cluster data (a `creationTimestamp`, a `startedAt`, a `finishedAt`) or a caller-supplied
 * parameter, so the same observations always classify the same way and a rollout can be replayed
 * from a fixture.
 *
 * ## The predicate (plan §5.4)
 *
 * A component is rolled out ⇔ `metadata.generation ≤ status.observedGeneration` **and**
 * `updatedReplicas = replicas` **and** `availableReplicas = replicas` **and**
 * `unavailableReplicas` absent/0 **and** no ReplicaSet other than the newest has ready pods, and —
 * for a worker without probes — each pod of the current rollout has held `restartCount = 0` for
 * 30 s. `replicas` is `spec.replicas` (the desired count), never `status.replicas`: a Deployment
 * being scaled up is not finished just because every pod it has so far is available.
 *
 * **APW06-G07:** the worker stability check and `crash_loop` count only the pods of the **current
 * rollout**, so a Deployment whose templates and env are unchanged is rolled out as soon as the
 * predicate holds — no new ReplicaSet, no new pod, no 30 s of dead waiting. A no-op Deployment is
 * *complete*, not *restarting*.
 *
 * ## The classifier (plan §5.4, §4.4)
 *
 * Most specific first: the two kubelet root-user messages, then an OOM kill, then a crash loop,
 * then a stuck waiting reason, and last the Deployment's own `ProgressDeadlineExceeded` condition.
 * Each of the seven codes §5.4 names is reachable, and no code outside §3.1's `AppFailureCode`
 * union is ever returned.
 *
 * `container has runAsNonRoot and image will run as root` is **`managed_root_forbidden`**, not
 * `image_runs_as_root`: plan §4.4:499-505 (as corrected) is explicit that the latter is the i18n
 * leaf `failures.imageRunsAsRoot` and was never a code. `image has non-numeric user` is
 * `image_user_unverifiable`. Both are reported once the container has been stuck for the 180 s
 * window of §5.4 — which is what ACC-06-08's "rollout fails ≤ 180 s" measures.
 *
 * ## Reported gaps (parameters, not inventions)
 *
 * - **When the wait started.** A `V1ContainerStatus` carries no timestamp for
 *   `state.waiting` — kubelet writes `reason` and `message` only. "For ≥ 180 s" therefore needs
 *   the caller's own first observation: `options.podWaitingSince['<pod>/<container>']` (recorded by
 *   the polling deployer, `§5.4`'s `APP_ROLLOUT_POLL_S` = 5 s), an explicit
 *   `stuckSeconds`/`podStuckSeconds`, or — failing both — the pod's own
 *   `creationTimestamp`/`status.startTime`, which is an **upper bound** on how long the container
 *   has been unable to start. Every one of them is data; none is a clock read.
 * - **Which pods belong to the current rollout.** §5.4's "pods created after the Deployment
 *   started" is read as "pods of the newest ReplicaSet" first (through `ownerReferences` or the
 *   `pod-template-hash` label), falling back to `options.startedAt` when the pods carry no
 *   ownership information. The ReplicaSet reading is the one that keeps APW06-G07 true.
 */
import type { AppFailureCode } from '@ever-works/plugin';

/* ------------------------------------------------------------------------- *
 * Constants (plan §5.3)
 * ------------------------------------------------------------------------- */

/** A container that has restarted this many times is crash-looping (plan §5.3). */
export const APP_ROLLOUT_RESTARTS_FAIL = 3;
/** A container stuck in one waiting reason for this long has failed (plan §5.3). */
export const APP_ROLLOUT_STUCK_POD_S = 180;
/** A worker pod without probes must hold `restartCount = 0` for this long (plan §5.3). */
export const APP_WORKER_STABLE_S = 30;
/** The pod label the Deployment controller stamps, and the only pod→ReplicaSet link besides owners. */
export const APP_POD_TEMPLATE_HASH_LABEL = 'pod-template-hash';

/** An instant: an ISO 8601 string, epoch milliseconds, or a `Date`. Never a clock read. */
export type Instant = string | number | Date;

/* ------------------------------------------------------------------------- *
 * Input shapes — structural subsets of the Kubernetes objects
 * ------------------------------------------------------------------------- */

export interface AppRolloutContainerState {
	waiting?: { reason?: string; message?: string } | null;
	running?: { startedAt?: Instant | null } | null;
	terminated?: { reason?: string; exitCode?: number; startedAt?: Instant | null; finishedAt?: Instant | null } | null;
}

export interface AppRolloutContainerStatus {
	name?: string;
	ready?: boolean;
	started?: boolean;
	restartCount?: number;
	state?: AppRolloutContainerState | null;
	lastState?: AppRolloutContainerState | null;
	/**
	 * The caller's first observation of this container's current waiting reason — the only way to
	 * measure §5.4's 180 s window, because kubelet records no timestamp for `waiting`. Wins over
	 * `options.podWaitingSince`; `stuckSeconds` wins over both.
	 */
	stuckSince?: Instant | null;
	/** The wait, measured: seconds this container has held its waiting reason. Wins over every instant. */
	stuckSeconds?: number | null;
}

export interface AppRolloutPodStatus {
	phase?: string;
	startTime?: Instant | null;
	containerStatuses?: readonly AppRolloutContainerStatus[] | null;
	initContainerStatuses?: readonly AppRolloutContainerStatus[] | null;
}

export interface AppRolloutOwnerReference {
	apiVersion?: string;
	kind?: string;
	name?: string;
	uid?: string;
}

export interface AppRolloutPod {
	metadata?: {
		name?: string;
		namespace?: string;
		creationTimestamp?: Instant | null;
		labels?: Record<string, string>;
		ownerReferences?: readonly AppRolloutOwnerReference[] | null;
	} | null;
	status?: AppRolloutPodStatus | null;
}

export interface AppRolloutReplicaSet {
	metadata?: {
		name?: string;
		namespace?: string;
		uid?: string;
		creationTimestamp?: Instant | null;
		labels?: Record<string, string>;
		annotations?: Record<string, string>;
		ownerReferences?: readonly AppRolloutOwnerReference[] | null;
	} | null;
	spec?: { replicas?: number; template?: unknown } | null;
	status?: {
		replicas?: number;
		readyReplicas?: number;
		availableReplicas?: number;
		fullyLabeledReplicas?: number;
		observedGeneration?: number;
	} | null;
}

export interface AppRolloutDeploymentCondition {
	type?: string;
	status?: string;
	reason?: string;
	message?: string;
	lastUpdateTime?: Instant | null;
}

export interface AppRolloutDeployment {
	metadata?: {
		name?: string;
		namespace?: string;
		uid?: string;
		generation?: number;
		creationTimestamp?: Instant | null;
		annotations?: Record<string, string>;
	} | null;
	spec?: { replicas?: number; template?: { metadata?: { labels?: Record<string, string> } } | null } | null;
	status?: {
		observedGeneration?: number;
		replicas?: number;
		updatedReplicas?: number;
		readyReplicas?: number;
		availableReplicas?: number;
		unavailableReplicas?: number;
		conditions?: readonly AppRolloutDeploymentCondition[] | null;
	} | null;
}

/** A component as §5.4 reads it — structurally a subset of APW-03's resolved component. */
export interface AppRolloutComponent {
	name?: string;
	role?: 'web' | 'worker';
	probes?: { startup?: unknown; readiness?: unknown; liveness?: unknown } | null;
}

export interface AppRolloutOptions {
	/** The instant to evaluate at. Required for every time-based verdict; never read from a clock. */
	now?: Instant | null;
	/** When the current rollout started: the reference for the 30 s stability window (§5.4). */
	startedAt?: Instant | null;
	/** The component being watched — needed for the "worker without probes" clause of §5.4. */
	component?: AppRolloutComponent | null;
	/** The desired replica count, when it is not `spec.replicas`. */
	desiredReplicas?: number | null;
	/** §5.4's crash-loop threshold; default {@link APP_ROLLOUT_RESTARTS_FAIL}. */
	restartsToFail?: number | null;
	/** §5.4's stuck-container window; default {@link APP_ROLLOUT_STUCK_POD_S}. */
	stuckPodSeconds?: number | null;
	/** §5.4's worker stability window; default {@link APP_WORKER_STABLE_S}. */
	workerStableSeconds?: number | null;
	/** First-observed instants per `<pod>/<container>` — the caller's own polling record. */
	podWaitingSince?: Record<string, Instant> | null;
	/** Measured waits per `<pod>/<container>`, when the caller has already done the subtraction. */
	podStuckSeconds?: Record<string, number> | null;
	/** A measured wait for every container under observation. */
	stuckSeconds?: number | null;
}

/** What the classifier proves, and everything a caller needs to report it. */
export interface AppPodFailure {
	code: AppFailureCode;
	/** Which §5.4 signal produced the code. */
	signal: 'root_user' | 'non_numeric_user' | 'oom_killed' | 'crash_loop' | 'stuck_waiting' | 'progress_deadline';
	pod: string;
	container?: string;
	/** The container's `lastState`/`state` reason, or the waiting reason. */
	reason?: string;
	/** The kubelet message, for the two root-user cases. */
	message?: string;
	exitCode?: number;
	restarts?: number;
	/** How long the stuck signal has held, in seconds — `null` when it could not be timed. */
	seconds?: number | null;
	/** `lastState.terminated.finishedAt` of an OOM kill. */
	oomKilledAt?: string | null;
}

/* ------------------------------------------------------------------------- *
 * Instant helpers
 * ------------------------------------------------------------------------- */

/** Epoch milliseconds of an instant, or `null` when it is missing or unparseable. */
export function instantMillis(instant: Instant | null | undefined): number | null {
	if (instant === null || instant === undefined) {
		return null;
	}
	if (instant instanceof Date) {
		const millis = instant.getTime();
		return Number.isFinite(millis) ? millis : null;
	}
	if (typeof instant === 'number') {
		return Number.isFinite(instant) ? instant : null;
	}
	if (typeof instant === 'string') {
		const millis = Date.parse(instant);
		return Number.isFinite(millis) ? millis : null;
	}
	return null;
}

/** An ISO 8601 string for a cluster timestamp, or `null` when it is not one. */
function isoOf(instant: Instant | null | undefined): string | null {
	const millis = instantMillis(instant);
	return millis === null ? null : new Date(millis).toISOString();
}

function count(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function positive(value: unknown, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/* ------------------------------------------------------------------------- *
 * ReplicaSets (§5.4)
 * ------------------------------------------------------------------------- */

/** Whether a ReplicaSet is owned by this Deployment — by uid when both have one, else by name. */
function replicaSetBelongsTo(deployment: AppRolloutDeployment, replicaSet: AppRolloutReplicaSet): boolean {
	const references = replicaSet?.metadata?.ownerReferences;
	if (!references || references.length === 0) {
		// The caller passed this Deployment's ReplicaSets; nothing contradicts that.
		return true;
	}
	const uid = deployment?.metadata?.uid;
	const name = deployment?.metadata?.name;
	return references.some((reference) => {
		if (reference?.kind !== undefined && reference.kind !== 'Deployment') {
			return false;
		}
		if (uid && reference?.uid) {
			return reference.uid === uid;
		}
		return name !== undefined && reference?.name === name;
	});
}

/** This Deployment's ReplicaSets, oldest first, ties broken by name. */
export function ownedReplicaSets(
	deployment: AppRolloutDeployment | null | undefined,
	replicaSets: readonly AppRolloutReplicaSet[] = []
): AppRolloutReplicaSet[] {
	if (!deployment) {
		return [];
	}
	return replicaSets
		.filter((replicaSet) => replicaSetBelongsTo(deployment, replicaSet))
		.slice()
		.sort(compareReplicaSets);
}

function compareReplicaSets(left: AppRolloutReplicaSet, right: AppRolloutReplicaSet): number {
	const leftCreated = instantMillis(left?.metadata?.creationTimestamp) ?? 0;
	const rightCreated = instantMillis(right?.metadata?.creationTimestamp) ?? 0;
	if (leftCreated !== rightCreated) {
		return leftCreated - rightCreated;
	}
	return String(left?.metadata?.name ?? '').localeCompare(String(right?.metadata?.name ?? ''));
}

/**
 * The ReplicaSet of the current template: the newest one this Deployment owns (§5.4's "the newest"
 * — by `creationTimestamp`, then by name so two ReplicaSets created in the same second still have
 * a stable answer). `null` when there is none.
 */
export function newestReplicaSet(
	deployment: AppRolloutDeployment | null | undefined,
	replicaSets: readonly AppRolloutReplicaSet[] = []
): AppRolloutReplicaSet | null {
	const owned = ownedReplicaSets(deployment, replicaSets);
	return owned.length > 0 ? owned[owned.length - 1] : null;
}

/** Whether a pod belongs to a ReplicaSet: by owner reference, else by `pod-template-hash`. */
function podBelongsToReplicaSet(pod: AppRolloutPod, name: string | undefined, hash: string | undefined): boolean {
	const references = pod?.metadata?.ownerReferences;
	if (references && references.length > 0) {
		return references.some(
			(reference) => reference?.kind === 'ReplicaSet' && name !== undefined && reference?.name === name
		);
	}
	const label = pod?.metadata?.labels?.[APP_POD_TEMPLATE_HASH_LABEL];
	return hash !== undefined && label !== undefined && label === hash;
}

/**
 * §5.4's "pods created after the Deployment started", read as *the pods of the current template*:
 *
 * 1. the pods of the newest ReplicaSet (owner reference, else `pod-template-hash`), when the pods
 *    carry either;
 * 2. otherwise the pods created at or after `options.startedAt`;
 * 3. otherwise every pod the caller passed.
 *
 * Step 1 is what keeps APW06-G07 true: on a Deployment whose templates and env are unchanged the
 * newest ReplicaSet is the **old** one, its pods are the current rollout's pods, and the predicate
 * holds without waiting for anything new.
 */
export function currentRolloutPods(
	deployment: AppRolloutDeployment | null | undefined,
	replicaSets: readonly AppRolloutReplicaSet[] = [],
	pods: readonly AppRolloutPod[] = [],
	options: AppRolloutOptions = {}
): AppRolloutPod[] {
	const all = [...(pods ?? [])];
	if (all.length === 0) {
		return [];
	}

	const newest = newestReplicaSet(deployment, replicaSets);
	if (newest) {
		const selected = all.filter((pod) =>
			podBelongsToReplicaSet(pod, newest.metadata?.name, newest.metadata?.labels?.[APP_POD_TEMPLATE_HASH_LABEL])
		);
		if (selected.length > 0) {
			return selected;
		}
	}

	const startedAt = instantMillis(options?.startedAt);
	if (startedAt !== null) {
		return all.filter((pod) => {
			const created = instantMillis(pod?.metadata?.creationTimestamp);
			return created === null || created >= startedAt;
		});
	}

	return all;
}

/* ------------------------------------------------------------------------- *
 * The predicate (plan §5.4)
 * ------------------------------------------------------------------------- */

/**
 * §5.4: "for workers without probes — each new pod has `restartCount = 0` for 30 s".
 *
 * `true` only when it is **proven**: every container of every pod in the current rollout has never
 * restarted, is not sitting in a terminated failure state, and has been running for the whole
 * window. `replicas: 0` has nothing to stabilise, so it is trivially stable; anything else needs at
 * least one pod, and needs `now` to measure the window.
 */
export function workerStable(pods: readonly AppRolloutPod[], options: AppRolloutOptions = {}): boolean {
	const declared = options?.desiredReplicas;
	const replicas = typeof declared === 'number' && Number.isFinite(declared) ? declared : 1;
	if (replicas <= 0) {
		return true;
	}

	const stableSeconds = positive(options?.workerStableSeconds, APP_WORKER_STABLE_S);
	const now = instantMillis(options?.now);
	const startedAt = instantMillis(options?.startedAt);
	const relevant = (pods ?? []).filter((pod) => {
		if (startedAt === null) {
			return true;
		}
		const created = instantMillis(pod?.metadata?.creationTimestamp);
		return created === null || created >= startedAt;
	});

	if (relevant.length === 0) {
		return false;
	}

	for (const pod of relevant) {
		const containers = containersOf(pod);
		if (containers.length === 0) {
			// No container status yet: the pod has not started, so it is not stable.
			return false;
		}
		for (const container of containers) {
			if (count(container?.restartCount) > 0) {
				return false;
			}
			// A container that is still waiting has not started, so its window has not begun.
			if (container?.state?.waiting) {
				return false;
			}
			const terminated = container?.state?.terminated;
			if (terminated && terminated.reason !== 'Completed') {
				return false;
			}
			const startedRunning = instantMillis(container?.state?.running?.startedAt) ?? podStartedAt(pod);
			if (now === null || startedRunning === null) {
				return false;
			}
			if (now - startedRunning < stableSeconds * 1_000) {
				return false;
			}
		}
	}

	return true;
}

/**
 * §5.4's "for workers without probes": only a worker with **no declared probe** needs the 30 s
 * stability window. A web component — and any component with a probe — has its readiness judged by
 * Kubernetes instead, which is what the probe is for.
 *
 * A caller that does not know the component gets `false`, i.e. the clause is not applied; the
 * deployer always knows whose Deployment it is looking at, so it should pass
 * `options.component`.
 */
export function requiresWorkerStability(component: AppRolloutComponent | null | undefined): boolean {
	if (component?.role !== 'worker') {
		return false;
	}
	const probes = component?.probes;
	if (!probes) {
		return true;
	}
	return !probes.startup && !probes.readiness && !probes.liveness;
}

/**
 * §5.4: is this component's rollout complete?
 *
 * Every clause of the predicate, with one deliberate reading: `replicas` is the **desired** count
 * (`spec.replicas`, or `options.desiredReplicas`) — the plan's `updatedReplicas = replicas` compares
 * against the Deployment's spec, and `status.replicas` can lag it during a scale-up.
 */
export function isComponentRolledOut(
	deployment: AppRolloutDeployment | null | undefined,
	replicaSets: readonly AppRolloutReplicaSet[] = [],
	pods: readonly AppRolloutPod[] = [],
	options: AppRolloutOptions = {}
): boolean {
	if (!deployment) {
		return false;
	}

	const status = deployment.status ?? {};
	const desired = desiredReplicas(deployment, options);

	if (count(deployment.metadata?.generation) > count(status.observedGeneration)) {
		return false;
	}
	if (count(status.updatedReplicas) !== desired) {
		return false;
	}
	if (count(status.availableReplicas) !== desired) {
		return false;
	}
	if (count(status.unavailableReplicas) > 0) {
		return false;
	}

	const newest = newestReplicaSet(deployment, replicaSets);
	for (const replicaSet of ownedReplicaSets(deployment, replicaSets)) {
		if (newest && replicaSet === newest) {
			continue;
		}
		if (count(replicaSet?.status?.readyReplicas) > 0) {
			return false;
		}
	}

	if (!requiresWorkerStability(options?.component)) {
		return true;
	}

	return workerStable(currentRolloutPods(deployment, replicaSets, pods, options), {
		now: options?.now,
		desiredReplicas: desired,
		workerStableSeconds: options?.workerStableSeconds
	});
}

function desiredReplicas(deployment: AppRolloutDeployment, options: AppRolloutOptions): number {
	const declared = options?.desiredReplicas;
	if (typeof declared === 'number' && Number.isFinite(declared)) {
		return declared;
	}
	const replicas = deployment?.spec?.replicas;
	return typeof replicas === 'number' && Number.isFinite(replicas) ? replicas : 1;
}

/* ------------------------------------------------------------------------- *
 * The classifier (plan §5.4, §4.4)
 * ------------------------------------------------------------------------- */

/** The waiting reasons §5.4 names, and the code each one produces. */
const STUCK_WAITING_CODES: Record<string, AppFailureCode> = {
	ImagePullBackOff: 'image_pull',
	ErrImagePull: 'image_pull',
	InvalidImageName: 'image_pull',
	CreateContainerConfigError: 'create_container_config',
	CreateContainerError: 'create_container_config'
};

/** §4.4: the kubelet's "this image runs as root" message → `managed_root_forbidden`. */
const ROOT_USER_MESSAGE = /runAsNonRoot and image will run as root/i;
/** §4.4: the kubelet's "this image's user is a name" message → `image_user_unverifiable`. */
const NON_NUMERIC_USER_MESSAGE = /non-numeric user/i;

function containersOf(pod: AppRolloutPod): AppRolloutContainerStatus[] {
	return [...(pod?.status?.containerStatuses ?? []), ...(pod?.status?.initContainerStatuses ?? [])];
}

function podStartedAt(pod: AppRolloutPod): number | null {
	return instantMillis(pod?.status?.startTime) ?? instantMillis(pod?.metadata?.creationTimestamp);
}

/**
 * How long a container has held the state it is in, in seconds — §5.4's "for ≥ 180 s" without a
 * clock. Precedence, most exact first:
 *
 * 1. `container.stuckSeconds` — the caller measured it;
 * 2. `options.podStuckSeconds['<pod>/<container>']` — the caller measured it;
 * 3. `options.stuckSeconds` — a measured wait for every container under observation;
 * 4. `container.stuckSince` / `options.podWaitingSince['<pod>/<container>']` — the caller's first
 *    observation of this waiting reason, subtracted from `now`;
 * 5. the pod's own `status.startTime` / `metadata.creationTimestamp` — an **upper bound** on the
 *    wait, used only when the caller has recorded nothing.
 *
 * `null` when none of them can be applied (no `now`, no observation), so an unmeasurable container
 * is never reported as failed.
 */
export function containerStuckSeconds(
	pod: AppRolloutPod,
	container: AppRolloutContainerStatus,
	options: AppRolloutOptions = {}
): number | null {
	const key = `${String(pod?.metadata?.name ?? '')}/${String(container?.name ?? '')}`;
	const measured = [container?.stuckSeconds, options?.podStuckSeconds?.[key], options?.stuckSeconds].find(
		(value) => typeof value === 'number' && Number.isFinite(value)
	);
	if (typeof measured === 'number') {
		return Math.max(0, measured);
	}

	const now = instantMillis(options?.now);
	if (now === null) {
		return null;
	}

	const since =
		instantMillis(container?.stuckSince) ?? instantMillis(options?.podWaitingSince?.[key]) ?? podStartedAt(pod);
	if (since === null) {
		return null;
	}

	return Math.max(0, (now - since) / 1_000);
}

function oomTermination(container: AppRolloutContainerStatus): { finishedAt: string | null } | null {
	const terminated = container?.lastState?.terminated ?? container?.state?.terminated;
	if (!terminated || terminated.reason !== 'OOMKilled') {
		return null;
	}
	return { finishedAt: isoOf(terminated.finishedAt) };
}

function lastTermination(container: AppRolloutContainerStatus): { reason?: string; exitCode?: number } | null {
	const terminated = container?.lastState?.terminated ?? container?.state?.terminated;
	if (!terminated) {
		return null;
	}
	return { reason: terminated.reason, exitCode: terminated.exitCode };
}

/**
 * §5.4's `ProgressDeadlineExceeded` condition on the Deployment itself.
 *
 * The reason is the signal, not the `status`: Kubernetes reports it as
 * `{ type: Progressing, status: 'False', reason: 'ProgressDeadlineExceeded' }` — "not progressing,
 * because the deadline passed".
 */
export function hasProgressDeadlineExceeded(deployment: AppRolloutDeployment | null | undefined): boolean {
	return (deployment?.status?.conditions ?? []).some((condition) => condition?.reason === 'ProgressDeadlineExceeded');
}

/**
 * Every §5.4 failure this observation proves, **most specific first**.
 *
 * {@link classifyPodFailure} returns the first of them; this function exists for a caller that
 * wants the whole picture (a status panel, a log bundle) without re-deriving it.
 */
export function classifyPodFailures(
	deployment: AppRolloutDeployment | null | undefined,
	replicaSets: readonly AppRolloutReplicaSet[] = [],
	pods: readonly AppRolloutPod[] = [],
	options: AppRolloutOptions = {}
): AppPodFailure[] {
	const failures: AppPodFailure[] = [];
	const current = currentRolloutPods(deployment, replicaSets, pods, options)
		.slice()
		.sort((left, right) => String(left?.metadata?.name ?? '').localeCompare(String(right?.metadata?.name ?? '')));
	const restartsToFail = positive(options?.restartsToFail, APP_ROLLOUT_RESTARTS_FAIL);
	const stuckThreshold = positive(options?.stuckPodSeconds, APP_ROLLOUT_STUCK_POD_S);

	for (const pod of current) {
		const podName = String(pod?.metadata?.name ?? '');
		for (const container of containersOf(pod)) {
			const containerName = container?.name;
			const waiting = container?.state?.waiting ?? null;
			const message = typeof waiting?.message === 'string' ? waiting.message : '';
			const seconds = containerStuckSeconds(pod, container, options);
			const stuck = seconds !== null && seconds >= stuckThreshold;
			const stuckFields = {
				pod: podName,
				...(containerName ? { container: containerName } : {}),
				...(waiting?.reason ? { reason: waiting.reason } : {}),
				seconds
			};

			// 1. §4.4's two kubelet messages — the most specific verdict there is.
			if (stuck && ROOT_USER_MESSAGE.test(message)) {
				failures.push({
					code: 'managed_root_forbidden',
					signal: 'root_user',
					...stuckFields,
					message
				});
				continue;
			}
			if (stuck && NON_NUMERIC_USER_MESSAGE.test(message)) {
				failures.push({
					code: 'image_user_unverifiable',
					signal: 'non_numeric_user',
					...stuckFields,
					message
				});
				continue;
			}

			// 2. §5.4: `OOMKilled` is counted as a restart *and reported* — it explains the restart,
			// so it outranks the generic crash loop. Every signal the observation proves is kept.
			const oom = oomTermination(container);
			if (oom) {
				const termination = lastTermination(container);
				failures.push({
					code: 'oom_killed',
					signal: 'oom_killed',
					...stuckFields,
					...(termination?.reason ? { reason: termination.reason } : {}),
					...(typeof termination?.exitCode === 'number' ? { exitCode: termination.exitCode } : {}),
					restarts: count(container?.restartCount),
					oomKilledAt: oom.finishedAt
				});
			}

			// 3. §5.4: any container that restarted the threshold number of times is crash-looping.
			const restarts = count(container?.restartCount);
			if (restarts >= restartsToFail) {
				const termination = lastTermination(container);
				failures.push({
					code: 'crash_loop',
					signal: 'crash_loop',
					...stuckFields,
					...(termination?.reason ? { reason: termination.reason } : {}),
					...(typeof termination?.exitCode === 'number' ? { exitCode: termination.exitCode } : {}),
					restarts
				});
			}

			// 4. §5.4: a waiting reason held for the whole window.
			const reason = waiting?.reason ?? '';
			const code = STUCK_WAITING_CODES[reason];
			if (stuck && code) {
				failures.push({ code, signal: 'stuck_waiting', ...stuckFields, restarts });
			}
		}
	}

	// 5. §5.4: the Deployment's own deadline condition, least specific of all.
	if (hasProgressDeadlineExceeded(deployment)) {
		failures.push({
			code: 'rollout_timeout',
			signal: 'progress_deadline',
			pod: '',
			reason: 'ProgressDeadlineExceeded'
		});
	}

	return failures;
}

/**
 * §5.4's early failure, or `null` when the observation proves none — `classifyPodFailures`' most
 * specific verdict.
 */
export function classifyPodFailure(
	deployment: AppRolloutDeployment | null | undefined,
	replicaSets: readonly AppRolloutReplicaSet[] = [],
	pods: readonly AppRolloutPod[] = [],
	options: AppRolloutOptions = {}
): AppPodFailure | null {
	return classifyPodFailures(deployment, replicaSets, pods, options)[0] ?? null;
}
