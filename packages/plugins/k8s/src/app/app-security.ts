/**
 * T5 — App security contexts (plan §4.4, spec FR-12/FR-13, ACC-06-07/ACC-06-08).
 *
 * Pure functions: no I/O, no clock, no cluster access. Every value here comes from the render
 * input and the component, so the same input always renders the same pod.
 *
 * The `ever-works-apps` column of §4.4 is what this renderer produces when APW-10's in-zone
 * controller calls it; the zone then applies its own non-overridable overlays (runtime class,
 * token, labels) and the platform applies none of it (R-5).
 *
 * ## Spec gap — the numeric `runAsUser` (reported, not invented)
 *
 * §4.4 (plan.md:473-495) has no `runAsUser` row, and the App spec of APW-03 has no field for one
 * (APW-03 `schema.md:183-198`, `components` — `name`, `role`, `command`, `args`, `target`, `port`,
 * `replicas`, `writableRootFilesystem`, `probes`, `resources`, `volumes`). Yet §4.4 itself records
 * that an image switching user **by name** cannot satisfy `runAsNonRoot` — the kubelet message
 * `image has non-numeric user` is classified `image_user_unverifiable` (plan.md:489-490), which is
 * exactly Umami's `nextjs` user. `runAsNonRoot: true` therefore refuses such a deployment and no
 * input exists that could rescue it (spec FR-13, S18).
 *
 * Additive resolution: `AppSecurityInput.runAsUser` is an **optional, caller-supplied** numeric
 * seam. When a caller has established a safe numeric uid — for the runner Job, plan §4.8 line 542
 * names `10001` — it passes it here; otherwise **no uid is emitted at all**. This function never
 * derives, guesses or defaults a uid, so nothing about the §4.4 table changes for a caller that
 * does not use the seam. A uid must be a non-negative safe integer: anything else (a name, a
 * fraction, `0`-with-`runAsNonRoot` handled by the caller's preconditions) is treated as not
 * supplied rather than silently rounded.
 */
import type { AppDeployTarget } from '@ever-works/plugin';

/**
 * Deploy target — **re-exported from the plugin contract, never redeclared.**
 *
 * This was a local two-value union (`'your-cluster' | 'ever-works-apps'`), written when plan §3
 * still described the plugin's `AppDeployTarget` that way. `AppDeployTarget` is really the
 * **three**-value union — `none` is a real value (CONTRACTS R-12: the deploy target is `None`,
 * stored as `none`, with no separate "not yet" state; R-27 restates all three) — so the local
 * union made `AppRenderInput` **unassignable** to `AppSecurityInput`:
 *
 *     TS2322: Type '"none"' is not assignable to type 'AppSecurityTarget'.
 *
 * Aliasing rather than redeclaring means the two can never drift again, and it *widens* this type
 * instead of narrowing anything: every caller that only ever passed `your-cluster` or
 * `ever-works-apps` keeps compiling unchanged.
 */
export type AppSecurityTarget = AppDeployTarget;

/** §4.4 last row: the PodSecurity level a namespace enforces. */
export type AppPodSecurityPolicy = 'restricted' | 'baseline';

/**
 * The component fields §4.4 reads. Structurally a subset of `AppComponentInput`
 * (plan §3.1 — APW-03's `AppSpecComponent` with defaults resolved), so a rendered component can
 * be passed straight through without a cast.
 */
export interface AppSecurityComponent {
	name: string;
	role?: 'web' | 'worker';
	/** Container port. §4.4: `NET_BIND_SERVICE` only below 1024, refused below 1024 on the managed target. */
	port?: number | null;
	/** Declared volumes. §4.4: `fsGroup` / `fsGroupChangePolicy` only when the component has volumes. */
	volumes?: readonly unknown[] | null;
	/** APW-03 schema §10 `writableRootFilesystem` (default `false`). */
	writableRootFilesystem?: boolean | null;
}

/**
 * The render-input fields §4.4 reads — structurally a subset of `AppRenderInput` (plan §3):
 * `ref.target`, `policy.allowRoot`, plus the optional numeric-uid seam documented above.
 */
export interface AppSecurityInput {
	ref: { target: AppSecurityTarget };
	policy: { allowRoot: boolean };
	/** Optional caller-supplied numeric uid. Never derived here — see the module doc. */
	runAsUser?: number | null;
}

/** §4.4: the shared non-root group for volume ownership. */
export const APP_FS_GROUP = 10001;

/** §4.4: the private temporary directory of a read-only container (FR-12: at most 256 MiB). */
export const APP_TMP_VOLUME_NAME = 'tmp';
export const APP_TMP_VOLUME_PATH = '/tmp';
export const APP_TMP_VOLUME_SIZE_LIMIT = '256Mi';

/** Anything below this port needs a capability, so it is refused on the managed target (§4.4). */
export const APP_PRIVILEGED_PORT_THRESHOLD = 1024;

/**
 * §4.8 line 542: the runner Job ("same security context as §4.4, non-root numeric user `10001`").
 * The **runner's** uid — never applied to an App component container, for which §4.4 names none.
 */
export const APP_RUNNER_RUN_AS_USER = 10001;

export interface AppPodSecurityContext {
	runAsNonRoot: boolean;
	seccompProfile: { type: 'RuntimeDefault' };
	fsGroup?: number;
	fsGroupChangePolicy?: 'OnRootMismatch';
	runAsUser?: number;
}

export interface AppContainerSecurityContext {
	allowPrivilegeEscalation: false;
	capabilities: { drop: ['ALL']; add?: ['NET_BIND_SERVICE'] };
	readOnlyRootFilesystem: boolean;
}

export interface AppTmpVolume {
	name: string;
	emptyDir: { sizeLimit: string };
}

export interface AppTmpVolumeMount {
	name: string;
	mountPath: string;
}

/** A render-time refusal. T6's `validateRenderInput` collects these (§4.4, plan.md:678). */
export interface AppSecurityRefusal {
	code: 'privileged_port';
	message: string;
}

/**
 * §4.4 last row, left column: a deployment namespace on the owner's own cluster.
 */
export function podSecurityPolicyForTarget(target: AppSecurityTarget): AppPodSecurityPolicy {
	return target === 'ever-works-apps' ? 'restricted' : 'baseline';
}

/**
 * §4.4 last row: the namespace PodSecurity labels.
 *
 * - `your-cluster` — enforce `baseline`, warn + audit `restricted` (the exact cell).
 * - `ever-works-apps` — enforce `restricted` (the exact cell). Warn and audit are `restricted` too:
 *   `restricted` is at least as strict as any level this renderer enforces, so carrying it on the
 *   warn/audit labels is additive on both columns and never weakens the managed cell.
 */
export function namespacePodSecurityLabels(policy: AppPodSecurityPolicy): Record<string, string> {
	return {
		'pod-security.kubernetes.io/enforce': policy,
		'pod-security.kubernetes.io/warn': 'restricted',
		'pod-security.kubernetes.io/audit': 'restricted'
	};
}

/**
 * §4.4 row `readOnlyRootFilesystem`: `!writableRootFilesystem` (APW-03 schema §10 default `false`).
 */
export function isReadOnlyRootFilesystem(component: AppSecurityComponent): boolean {
	return component?.writableRootFilesystem !== true;
}

/**
 * The pod-level security context.
 *
 * | §4.4 cell | produced |
 * | --- | --- |
 * | pod `runAsNonRoot` | `true`; `false` when `allowRoot` on `your-cluster`; `true` always on `ever-works-apps` |
 * | pod `seccompProfile` | `RuntimeDefault` on both |
 * | pod `fsGroup` / `fsGroupChangePolicy` | `10001` / `OnRootMismatch` when the component has volumes, on both |
 * | optional `runAsUser` | only a caller-supplied non-negative integer — see the module doc |
 */
export function podSecurityContext(input: AppSecurityInput, component: AppSecurityComponent): AppPodSecurityContext {
	const context: AppPodSecurityContext = {
		runAsNonRoot: runAsNonRootFor(input),
		seccompProfile: { type: 'RuntimeDefault' }
	};

	if (hasVolumes(component)) {
		context.fsGroup = APP_FS_GROUP;
		context.fsGroupChangePolicy = 'OnRootMismatch';
	}

	const runAsUser = callerSuppliedRunAsUser(input);
	if (runAsUser !== null) {
		context.runAsUser = runAsUser;
	}

	return context;
}

/**
 * The container security context.
 *
 * | §4.4 cell | produced |
 * | --- | --- |
 * | container `allowPrivilegeEscalation` | `false` on both |
 * | container `capabilities` | `drop: [ALL]` on both; `add: [NET_BIND_SERVICE]` only when `allowRoot` and port < 1024 on `your-cluster`; never added on `ever-works-apps` |
 * | container `readOnlyRootFilesystem` | `!writableRootFilesystem` on both |
 */
export function containerSecurityContext(
	input: AppSecurityInput,
	component: AppSecurityComponent
): AppContainerSecurityContext {
	const capabilities: AppContainerSecurityContext['capabilities'] = { drop: ['ALL'] };
	if (mayAddNetBindService(input, component)) {
		capabilities.add = ['NET_BIND_SERVICE'];
	}

	return {
		allowPrivilegeEscalation: false,
		capabilities,
		readOnlyRootFilesystem: isReadOnlyRootFilesystem(component)
	};
}

/**
 * §4.4 row `/tmp` emptyDir — the private temporary directory of a read-only container
 * (`sizeLimit: 256Mi`, FR-12 "at most 256 MiB"). `null` when the component declares a writable
 * root filesystem, because the row is scoped "when read-only".
 *
 * The row depends on the component alone; `input` is accepted so all four §4.4 helpers share one
 * signature a renderer can call uniformly.
 */
export function tmpVolume(input: AppSecurityInput, component: AppSecurityComponent): AppTmpVolume | null {
	if (!isReadOnlyRootFilesystem(component)) {
		return null;
	}

	return { name: APP_TMP_VOLUME_NAME, emptyDir: { sizeLimit: APP_TMP_VOLUME_SIZE_LIMIT } };
}

/** The matching container mount for {@link tmpVolume}. `null` under the same condition. */
export function tmpVolumeMount(input: AppSecurityInput, component: AppSecurityComponent): AppTmpVolumeMount | null {
	if (!isReadOnlyRootFilesystem(component)) {
		return null;
	}

	return { name: APP_TMP_VOLUME_NAME, mountPath: APP_TMP_VOLUME_PATH };
}

/**
 * §4.4 right column: a port below 1024 is refused on `ever-works-apps` with `privileged_port`.
 * The renderer reports the refusal (T6 collects it into `validateRenderInput`); it also never
 * adds a capability for it, so an ignored refusal still cannot publish a privileged port.
 */
export function appSecurityRefusals(input: AppSecurityInput, component: AppSecurityComponent): AppSecurityRefusal[] {
	const refusals: AppSecurityRefusal[] = [];

	if (input?.ref?.target === 'ever-works-apps' && isPrivilegedPort(component?.port)) {
		refusals.push({
			code: 'privileged_port',
			message: `A container port below ${APP_PRIVILEGED_PORT_THRESHOLD} cannot be published on Ever Works Apps. Declare a port of ${APP_PRIVILEGED_PORT_THRESHOLD} or above.`
		});
	}

	return refusals;
}

// Internal helpers -----------------------------------------------------------

function runAsNonRootFor(input: AppSecurityInput): boolean {
	// `ever-works-apps` is `true` always (§4.4 right column) — `allowRoot` cannot relax it.
	if (input?.ref?.target === 'ever-works-apps') {
		return true;
	}
	return input?.policy?.allowRoot !== true;
}

function mayAddNetBindService(input: AppSecurityInput, component: AppSecurityComponent): boolean {
	if (input?.ref?.target !== 'your-cluster') {
		return false;
	}
	if (input?.policy?.allowRoot !== true) {
		return false;
	}
	return isPrivilegedPort(component?.port);
}

function isPrivilegedPort(port: unknown): boolean {
	return typeof port === 'number' && Number.isFinite(port) && port >= 1 && port < APP_PRIVILEGED_PORT_THRESHOLD;
}

function hasVolumes(component: AppSecurityComponent): boolean {
	return Array.isArray(component?.volumes) && component.volumes.length > 0;
}

function callerSuppliedRunAsUser(input: AppSecurityInput): number | null {
	const value = input?.runAsUser;
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
		return null;
	}
	return value;
}
