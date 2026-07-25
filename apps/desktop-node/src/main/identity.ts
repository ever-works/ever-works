import { normalizeApiUrl, redactConfig, type HeartbeatState, type NodeConfig } from 'ever-works-node';
import {
	API_HOST_OPTIONS,
	MIN_TOKEN_LENGTH,
	type ConnectionStatusView,
	type EnrollRequest,
	type NodeIdentityView
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

export const NOT_ENROLLED: NodeIdentityView = { enrolled: false, capabilities: [] };

/** Project the stored config into the renderer-safe identity view. */
export function toIdentityView(config: NodeConfig | null): NodeIdentityView {
	if (!config) {
		return { ...NOT_ENROLLED };
	}
	const redacted = redactConfig(config);
	const view: NodeIdentityView = {
		enrolled: true,
		nodeId: redacted.nodeId,
		apiUrl: redacted.apiUrl,
		kind: redacted.kind,
		capabilities: redacted.capabilities,
		heartbeatIntervalMs: redacted.heartbeatIntervalMs,
		enrolledAt: redacted.enrolledAt
	};
	if (redacted.name !== undefined) {
		view.name = redacted.name;
	}
	return view;
}

/** Project the heartbeat loop's state into the status view. */
export function toStatusView(state: HeartbeatState): ConnectionStatusView {
	return {
		state: state.state,
		lastHeartbeatAt: state.lastHeartbeatAt,
		consecutiveFailures: state.consecutiveFailures,
		nextAttemptInMs: state.nextAttemptInMs,
		lastError: state.lastError,
		platformStatus: state.node?.status ?? null
	};
}

export const IDLE_STATUS: ConnectionStatusView = {
	state: 'idle',
	lastHeartbeatAt: null,
	consecutiveFailures: 0,
	nextAttemptInMs: null,
	lastError: null,
	platformStatus: null
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
export function resolveEnrollApiUrl(request: EnrollRequest): string | null {
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

/** Main-side token shape check — mirrors the API's credential bounds. */
export function enrollRequestValid(request: EnrollRequest): boolean {
	return (
		typeof request?.token === 'string' &&
		request.token.trim().length >= MIN_TOKEN_LENGTH &&
		resolveEnrollApiUrl(request) !== null
	);
}
