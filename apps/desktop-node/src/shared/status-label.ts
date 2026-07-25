import type { ConnectionStatusView } from './ipc-contract';

/**
 * Human-readable connection labels, shared by the tray tooltip/menu and the
 * status window so the two can never disagree about what the node is doing.
 *
 * Kept out of `ipc-contract.ts` (which is a pure wire contract) and free of
 * any Electron import, so it is testable in a plain Node process.
 */

/** One-line summary, e.g. for the tray tooltip. */
export function describeStatus(status: ConnectionStatusView): string {
	switch (status.state) {
		case 'connected':
			return 'Connected';
		case 'connecting':
			return 'Connecting…';
		case 'retrying':
			return `Reconnecting (${status.consecutiveFailures} failed)`;
		case 'unauthorized':
			return 'Credential rejected — check Fleet';
		case 'stopped':
			return 'Disconnected';
		case 'idle':
		default:
			return 'Not connected';
	}
}

/** Badge tone for the status pill: ok / warn / err. */
export function statusTone(status: ConnectionStatusView): 'ok' | 'warn' | 'err' {
	switch (status.state) {
		case 'connected':
			return 'ok';
		case 'unauthorized':
			return 'err';
		case 'connecting':
		case 'retrying':
			return 'warn';
		default:
			return 'warn';
	}
}

/** True while the node is connected or actively establishing a connection. */
export function isLive(status: ConnectionStatusView | undefined): boolean {
	return status?.state === 'connected' || status?.state === 'connecting';
}

/** `1.2s ago` / `3m ago` / `never`, for the last-heartbeat readout. */
export function formatSince(timestamp: number | null, now: number): string {
	if (timestamp === null) {
		return 'never';
	}
	const deltaMs = Math.max(0, now - timestamp);
	if (deltaMs < 1_000) {
		return 'just now';
	}
	const seconds = Math.floor(deltaMs / 1000);
	if (seconds < 60) {
		return `${seconds}s ago`;
	}
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) {
		return `${minutes}m ago`;
	}
	return `${Math.floor(minutes / 60)}h ago`;
}
