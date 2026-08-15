import { describe, expect, it } from 'vitest';
import { IDLE_WORKER_STATUS, type ConnectionStatusView } from './ipc-contract';
import { describeStatus, formatSince, isLive, statusTone } from './status-label';

function status(overrides: Partial<ConnectionStatusView> = {}): ConnectionStatusView {
	return {
		state: 'idle',
		lastHeartbeatAt: null,
		consecutiveFailures: 0,
		nextAttemptInMs: null,
		lastError: null,
		platformStatus: null,
		// `worker` became a REQUIRED member of the view when the Fleet branch
		// added work execution (A18); this factory predates it.
		worker: { ...IDLE_WORKER_STATUS },
		...overrides
	};
}

describe('describeStatus', () => {
	it('labels every connection state', () => {
		expect(describeStatus(status({ state: 'connected' }))).toBe('Connected');
		expect(describeStatus(status({ state: 'connecting' }))).toBe('Connecting…');
		expect(describeStatus(status({ state: 'stopped' }))).toBe('Disconnected');
		expect(describeStatus(status())).toBe('Not connected');
	});

	it('counts the failures while retrying and calls out a rejected credential', () => {
		expect(describeStatus(status({ state: 'retrying', consecutiveFailures: 3 }))).toBe('Reconnecting (3 failed)');
		expect(describeStatus(status({ state: 'unauthorized' }))).toBe('Credential rejected — check Fleet');
	});
});

describe('statusTone / isLive', () => {
	it('maps states to badge tones', () => {
		expect(statusTone(status({ state: 'connected' }))).toBe('ok');
		expect(statusTone(status({ state: 'unauthorized' }))).toBe('err');
		expect(statusTone(status({ state: 'retrying' }))).toBe('warn');
		expect(statusTone(status({ state: 'idle' }))).toBe('warn');
	});

	it('treats connected and connecting as live, everything else as not', () => {
		expect(isLive(status({ state: 'connected' }))).toBe(true);
		expect(isLive(status({ state: 'connecting' }))).toBe(true);
		expect(isLive(status({ state: 'retrying' }))).toBe(false);
		expect(isLive(status({ state: 'stopped' }))).toBe(false);
		expect(isLive(undefined)).toBe(false);
	});
});

describe('formatSince', () => {
	const now = 1_700_000_000_000;

	it('renders the heartbeat age at second, minute and hour granularity', () => {
		expect(formatSince(null, now)).toBe('never');
		expect(formatSince(now - 500, now)).toBe('just now');
		expect(formatSince(now - 45_000, now)).toBe('45s ago');
		expect(formatSince(now - 5 * 60_000, now)).toBe('5m ago');
		expect(formatSince(now - 3 * 3_600_000, now)).toBe('3h ago');
	});

	it('never renders a negative age when clocks disagree', () => {
		expect(formatSince(now + 10_000, now)).toBe('just now');
	});
});
