import {
	clampResourceLimits,
	credentialsLookUsable,
	normalizeApiUrl,
	redactConfig,
	type HeartbeatState,
	type NodeConfig,
	type WorkerLoopState
} from 'ever-works-node';
import {
	API_HOST_OPTIONS,
	IDLE_WORKER_STATUS,
	MIN_TOKEN_LENGTH,
	type AuthenticateRequest,
	type ConnectionStatusView,
	type EnrollMode,
	type EnrollRequest,
	type NodeIdentityView,
	type WorkerStatusView
} from '../shared/ipc-contract';

/**
 * Main-process projections between the node core's internal state and the
 * credential-free views that cross the IPC bridge.
 *
 * This module is the choke point for the app's central security property: the
 * heartbeat secret lives in the main process and the protected config file
 * ONLY. Everything the renderer can see passes through `toIdentityView`, which
 * is built on the core's `redactConfig` and structurally cannot carry it.
 */

export const NOT_ENROLLED: NodeIdentityView = {
	enrolled: false,
	capabilities: [],
	limits: clampResourceLimits(null)
};

/** Project the stored config into the renderer-safe identity view. */
export function toIdentityView(config: NodeConfig | null): NodeIdentityView {
	if (!config) {
		return { ...NOT_ENROLLED, limits: clampResourceLimits(null) };
	}
	const redacted = redactConfig(config);
	const view: NodeIdentityView = {
		enrolled: true,
		nodeId: redacted.nodeId,
		apiUrl: redacted.apiUrl,
		kind: redacted.kind,
		capabilities: redacted.capabilities,
		limits: redacted.limits,
		heartbeatIntervalMs: redacted.heartbeatIntervalMs,
		enrolledAt: redacted.enrolledAt
	};
	if (redacted.capabilitySelection !== undefined) {
		view.capabilitySelection = redacted.capabilitySelection;
	}
	if (redacted.name !== undefined) {
		view.name = redacted.name;
	}
	return view;
}

/** Project the worker loop's state into the renderer-safe work view (A18). */
export function toWorkerStatusView(state: WorkerLoopState | null | undefined): WorkerStatusView {
	if (!state) {
		return { ...IDLE_WORKER_STATUS };
	}
	return {
		enabled: true,
		paused: state.paused,
		state: state.state,
		activeJobCount: state.activeJobIds.length,
		completed: state.completed,
		failed: state.failed,
		// The core marks `throttleReason` OPTIONAL (`string | null | undefined`);
		// the IPC view models "no reason" as an explicit null, so normalize here
		// rather than widen the view — the renderer and the tray both branch on
		// `!== null`, and an absent key would read as "unknown", not "not
		// throttled".
		throttleReason: state.throttleReason ?? null
	};
}

/**
 * Project the heartbeat loop's state into the status view.
 *
 * `worker` is passed in rather than derived: the heartbeat and the worker are
 * independent loops, and the status window must be able to show "connected but
 * paused" — the exact state pause/resume produces.
 */
export function toStatusView(state: HeartbeatState, worker?: WorkerStatusView): ConnectionStatusView {
	return {
		state: state.state,
		lastHeartbeatAt: state.lastHeartbeatAt,
		consecutiveFailures: state.consecutiveFailures,
		nextAttemptInMs: state.nextAttemptInMs,
		lastError: state.lastError,
		platformStatus: state.node?.status ?? null,
		worker: worker ?? { ...IDLE_WORKER_STATUS }
	};
}

export const IDLE_STATUS: ConnectionStatusView = {
	state: 'idle',
	lastHeartbeatAt: null,
	consecutiveFailures: 0,
	nextAttemptInMs: null,
	lastError: null,
	platformStatus: null,
	worker: { ...IDLE_WORKER_STATUS }
};

/**
 * Re-derive the API URL for an enrollment request in the MAIN process.
 *
 * The renderer already validates its own inputs, but a renderer is never a
 * trust boundary: the host choice and any custom URL are re-resolved here
 * against the same preset table, and a self-hosted URL is re-parsed by the
 * core's `normalizeApiUrl`. Returns null when the request cannot produce a
 * usable URL.
 */
export function resolveEnrollApiUrl(request: EnrollRequest | AuthenticateRequest): string | null {
	const option = API_HOST_OPTIONS.find((candidate) => candidate.id === request.host);
	if (!option) {
		return null;
	}
	const raw = option.url ?? request.apiUrl;
	if (!raw) {
		return null;
	}
	try {
		return normalizeApiUrl(raw);
	} catch {
		return null;
	}
}

/** The enrollment mode the main process will actually run. Defaults to `token`. */
export function requestedEnrollMode(request: EnrollRequest): EnrollMode {
	return request?.mode === 'sign-in' ? 'sign-in' : 'token';
}

/**
 * Main-side credential shape check.
 *
 * The renderer already validates its own inputs, but a renderer is never a
 * trust boundary — so both legs (pasted token, sign-in) are re-checked here
 * against the same bounds the API enforces.
 */
export function enrollRequestValid(request: EnrollRequest): boolean {
	if (resolveEnrollApiUrl(request) === null) {
		return false;
	}
	if (requestedEnrollMode(request) === 'sign-in') {
		return credentialsLookUsable(request.email, request.password);
	}
	return typeof request?.token === 'string' && request.token.trim().length >= MIN_TOKEN_LENGTH;
}

/** Main-side sign-in shape check (A14). */
export function authenticateRequestValid(request: AuthenticateRequest): boolean {
	return resolveEnrollApiUrl(request) !== null && credentialsLookUsable(request?.email, request?.password);
}

/**
 * Node name registered with the platform when the app mints its own token.
 * Falls back to a stable, non-identifying label rather than anything derived
 * from the host — an operator who wants their hostname in Fleet can type it.
 */
export function resolveNodeName(request: EnrollRequest): string {
	const label = request.name?.trim();
	return label && label.length > 0 ? label : 'Desktop Node';
}
