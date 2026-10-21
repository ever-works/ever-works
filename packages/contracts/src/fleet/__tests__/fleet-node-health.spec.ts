import { describe, expect, it } from 'vitest';

import {
	COMPUTER_STATES,
	diskLowSeverity,
	FLEET_HEALTH_DISK_CRITICAL_MARGIN_BYTES,
	FLEET_HEALTH_MAX_GPU_MODEL_LENGTH,
	FLEET_HEALTH_MAX_GPUS,
	FLEET_HEALTH_ROLLUP_CRON,
	FLEET_CLEAR_MODEL_THROTTLE_COMMAND,
	FLEET_NODE_CLEAR_QUARANTINE_COMMAND,
	fleetNodeDiskLowInput,
	hasFleetNodeHealthReading,
	isFleetNodeHealthStale,
	resolveComputerState,
	sanitizeFleetNodeHealthSnapshot,
	type ComputerStateInput
} from '../fleet-node-health.types.js';
import { normalizeNeedsALookItem } from '../fleet-needs-a-look.types.js';
import { FLEET_NODE_UPGRADE_COMMAND } from '../fleet-node.types.js';

const GIB = 1024 ** 3;
const NOW = Date.parse('2026-10-18T09:41:00Z');
const LATER = '2026-10-19T01:00:00.000Z';
const EARLIER = '2026-10-18T09:00:00.000Z';

function node(overrides: Partial<ComputerStateInput> = {}): ComputerStateInput {
	return { status: 'online', capabilities: ['claude-code'], ...overrides };
}

describe('sanitizeFleetNodeHealthSnapshot', () => {
	it('keeps every field in bounds and rounds the noisy ones', () => {
		expect(
			sanitizeFleetNodeHealthSnapshot({
				cpuPercent: 31.249,
				memPercent: 58.04,
				memTotalMiB: 16384.7,
				memUsedMiB: 9523,
				diskPercent: 40,
				diskFreeMiB: 120832,
				diskTotalMiB: 201390,
				loadAvg1: 1.9349,
				cpuCores: 4,
				uptimeSec: 273600.9,
				gpu: [{ vendor: 'nvidia', name: 'RTX 4070', utilPercent: 12, memUsedMiB: 2048, memTotalMiB: 8192 }],
				pendingReboot: false,
				failedServices: 1
			})
		).toEqual({
			cpuPercent: 31.2,
			memPercent: 58,
			memTotalMiB: 16384,
			memUsedMiB: 9523,
			diskPercent: 40,
			diskFreeMiB: 120832,
			diskTotalMiB: 201390,
			loadAvg1: 1.93,
			cpuCores: 4,
			uptimeSec: 273600,
			gpu: [{ vendor: 'nvidia', name: 'RTX 4070', utilPercent: 12, memUsedMiB: 2048, memTotalMiB: 8192 }],
			pendingReboot: false,
			failedServices: 1
		});
	});

	it('DROPS an out-of-range value rather than clamping it into a number the machine never sent', () => {
		const out = sanitizeFleetNodeHealthSnapshot({
			cpuPercent: 100.5,
			memPercent: -1,
			loadAvg1: Number.NaN,
			uptimeSec: Number.POSITIVE_INFINITY,
			cpuCores: 0,
			failedServices: '3',
			diskPercent: 12
		});
		expect(out).toEqual({ diskPercent: 12 });
	});

	it('drops a used figure larger than its total (a broken pair), keeping the total', () => {
		expect(sanitizeFleetNodeHealthSnapshot({ memTotalMiB: 8, memUsedMiB: 9 })).toEqual({ memTotalMiB: 8 });
		expect(sanitizeFleetNodeHealthSnapshot({ diskTotalMiB: 8, diskFreeMiB: 9 })).toEqual({ diskTotalMiB: 8 });
	});

	it('keeps gpu: null (asked, no GPU) apart from an absent gpu (not known)', () => {
		expect(sanitizeFleetNodeHealthSnapshot({ gpu: null, cpuCores: 2 })).toEqual({ gpu: null, cpuCores: 2 });
		expect(sanitizeFleetNodeHealthSnapshot({ gpu: [], cpuCores: 2 })).toEqual({ gpu: null, cpuCores: 2 });
		expect(sanitizeFleetNodeHealthSnapshot({ cpuCores: 2 })).toEqual({ cpuCores: 2 });
		// The pre-revision-3 single object, and junk, are "not known" — never "no GPU".
		expect(sanitizeFleetNodeHealthSnapshot({ gpu: { vendor: 'nvidia', name: 'RTX' }, cpuCores: 2 })).toEqual({
			cpuCores: 2
		});
		expect(sanitizeFleetNodeHealthSnapshot({ gpu: ['junk'], cpuCores: 2 })).toEqual({ cpuCores: 2 });
	});

	it('keeps every sane GPU of a list, first adapter first, bounded in count', () => {
		const gpus = sanitizeFleetNodeHealthSnapshot({
			gpu: [{ vendor: 'nvidia', name: 'A' }, 'junk', { vendor: 'intel', name: 'B' }]
		})?.gpu;
		expect(gpus).toEqual([
			{ vendor: 'nvidia', name: 'A' },
			{ vendor: 'intel', name: 'B' }
		]);
		const many = Array.from({ length: FLEET_HEALTH_MAX_GPUS + 4 }, (_, i) => ({ vendor: 'nvidia', name: `G${i}` }));
		expect(sanitizeFleetNodeHealthSnapshot({ gpu: many })?.gpu).toHaveLength(FLEET_HEALTH_MAX_GPUS);
	});

	it('bounds the GPU name, strips control characters and files an unknown vendor as other', () => {
		const [gpu] =
			sanitizeFleetNodeHealthSnapshot({
				gpu: [{ vendor: 'acme', name: `A\u0007B\n${'x'.repeat(200)}`, memUsedMiB: 9, memTotalMiB: 8 }]
			})?.gpu ?? [];
		expect(gpu?.vendor).toBe('other');
		expect(gpu?.name?.startsWith('A B x')).toBe(true);
		expect(gpu?.name).toHaveLength(FLEET_HEALTH_MAX_GPU_MODEL_LENGTH);
		expect(gpu).not.toHaveProperty('memUsedMiB');
		expect(gpu).not.toHaveProperty('memTotalMiB');
	});

	it('ignores unknown keys and answers null when nothing usable remains', () => {
		expect(sanitizeFleetNodeHealthSnapshot({ hostname: 'build-01', cpuPercent: 4 })).toEqual({ cpuPercent: 4 });
		expect(sanitizeFleetNodeHealthSnapshot({ hostname: 'build-01' })).toBeNull();
		expect(sanitizeFleetNodeHealthSnapshot({})).toBeNull();
		expect(sanitizeFleetNodeHealthSnapshot([1, 2])).toBeNull();
		expect(sanitizeFleetNodeHealthSnapshot('cpu 31')).toBeNull();
		expect(sanitizeFleetNodeHealthSnapshot(null)).toBeNull();
	});
});

describe('hasFleetNodeHealthReading', () => {
	it('is true for any fact the node reported — "no GPU" included — and false for none', () => {
		const at = '2026-10-18T09:40:00.000Z';
		expect(hasFleetNodeHealthReading({ cpuPercent: 0 })).toBe(true);
		expect(hasFleetNodeHealthReading({ pendingReboot: false })).toBe(true);
		expect(hasFleetNodeHealthReading({ gpu: null })).toBe(true);
		// The platform's own disk-low marker for an older daemon is not a reading.
		expect(hasFleetNodeHealthReading({ at, diskLowSince: at } as never)).toBe(false);
		expect(hasFleetNodeHealthReading({})).toBe(false);
		expect(hasFleetNodeHealthReading(null)).toBe(false);
		expect(hasFleetNodeHealthReading(undefined)).toBe(false);
	});
});

describe('FLEET_CLEAR_MODEL_THROTTLE_COMMAND', () => {
	it('is a named command a needs-a-look action may carry (CONTRACTS §4.6)', () => {
		expect(FLEET_CLEAR_MODEL_THROTTLE_COMMAND).toBe('fleet.clear-model-throttle');
		// Judged by the REAL normaliser, not a copy of its pattern: an action
		// whose command it refused would be dropped from the row.
		const item = {
			id: 'node-throttled:n1',
			nodeId: 'n1',
			severity: 'warn' as const,
			kind: 'node-throttled' as const,
			title: "Waiting for Claude Code's limit to reset",
			detail: '',
			action: { label: 'Clear limit now', command: FLEET_CLEAR_MODEL_THROTTLE_COMMAND },
			since: '2026-10-18T09:00:00.000Z'
		};
		expect(normalizeNeedsALookItem(item)?.action).toEqual(item.action);
	});
});

describe('isFleetNodeHealthStale', () => {
	const fiveMin = 5 * 60_000;
	it('is fresh inside the threshold and stale beyond it', () => {
		expect(isFleetNodeHealthStale({ at: '2026-10-18T09:40:12Z' }, NOW, fiveMin)).toBe(false);
		expect(isFleetNodeHealthStale({ at: '2026-10-18T07:41:00Z' }, NOW, fiveMin)).toBe(true);
	});
	it('never presents an undatable or missing snapshot as fresh', () => {
		expect(isFleetNodeHealthStale({ at: 'yesterday' }, NOW, fiveMin)).toBe(true);
		expect(isFleetNodeHealthStale(null, NOW, fiveMin)).toBe(true);
	});
});

describe('diskLowSeverity (FR-12)', () => {
	const floor = 5 * GIB;
	const total = 100 * GIB;

	it('is critical at or below the floor plus 1 GiB (spec S5: 6 GiB left, floor 5 GiB)', () => {
		expect(diskLowSeverity({ freeBytes: 6 * GIB, totalBytes: total, floorBytes: floor })).toBe('critical');
		expect(
			diskLowSeverity({
				freeBytes: floor + FLEET_HEALTH_DISK_CRITICAL_MARGIN_BYTES,
				totalBytes: total,
				floorBytes: floor
			})
		).toBe('critical');
	});

	it('is a warning below 10% of the volume, and nothing at exactly 10%', () => {
		expect(
			diskLowSeverity({
				freeBytes: floor + FLEET_HEALTH_DISK_CRITICAL_MARGIN_BYTES + 1,
				totalBytes: total,
				floorBytes: floor
			})
		).toBe('warn');
		expect(diskLowSeverity({ freeBytes: 10 * GIB - 1, totalBytes: total, floorBytes: floor })).toBe('warn');
		expect(diskLowSeverity({ freeBytes: 10 * GIB, totalBytes: total, floorBytes: floor })).toBeNull();
		expect(diskLowSeverity({ freeBytes: 40 * GIB, totalBytes: total, floorBytes: floor })).toBeNull();
	});

	it('uses the percentage rule only when the floor is off or unknown', () => {
		expect(diskLowSeverity({ freeBytes: 1 * GIB, totalBytes: total, floorBytes: null })).toBe('warn');
		expect(diskLowSeverity({ freeBytes: 20 * GIB, totalBytes: total, floorBytes: null })).toBeNull();
	});

	it('says nothing when free space is unknown, and only the floor rule speaks without a volume size', () => {
		expect(diskLowSeverity({ freeBytes: null, totalBytes: total, floorBytes: floor })).toBeNull();
		expect(diskLowSeverity({ freeBytes: 6 * GIB, totalBytes: null, floorBytes: floor })).toBe('critical');
		expect(diskLowSeverity({ freeBytes: 7 * GIB, totalBytes: null, floorBytes: floor })).toBeNull();
	});

	it('builds its input from the byte-precise column first, the snapshot second', () => {
		expect(
			fleetNodeDiskLowInput({
				diskFreeBytes: 6 * GIB,
				minFreeDiskBytes: floor,
				health: { diskFreeMiB: 1, diskTotalMiB: 102400 }
			})
		).toEqual({ freeBytes: 6 * GIB, totalBytes: 100 * GIB, floorBytes: floor });
		expect(fleetNodeDiskLowInput({ health: { diskFreeMiB: 1024 } })).toEqual({
			freeBytes: GIB,
			totalBytes: null,
			floorBytes: null
		});
	});
});

describe('resolveComputerState (FR-7, FR-8) — the truth table', () => {
	const resolve = (input: ComputerStateInput, canWake = false) => resolveComputerState(input, { now: NOW, canWake });
	const throttle = (provider: string, until = LATER) => ({
		provider,
		window: 'weekly' as const,
		until,
		reason: 'weekly limit',
		since: EARLIER
	});

	it('has exactly the eleven states of the closed set', () => {
		expect(new Set(COMPUTER_STATES).size).toBe(11);
	});

	it('enrolling, offline, disabled, paused and online are the registry status', () => {
		expect(resolve(node({ status: 'enrolling' })).state).toBe('enrolling');
		expect(resolve(node({ status: 'disabled' })).state).toBe('disabled');
		expect(resolve(node({ status: 'paused' })).state).toBe('paused');
		expect(resolve(node()).state).toBe('online');
		expect(resolve(node({ status: 'offline', lastHeartbeatAt: EARLIER }))).toEqual({
			state: 'offline',
			params: { lastSeenAt: EARLIER },
			action: null
		});
	});

	it('offers Wake on an offline computer only when the caller says it is possible', () => {
		expect(resolve(node({ status: 'offline' }), true).action).toEqual({ kind: 'wake' });
		expect(resolve(node({ status: 'offline' }), false).action).toBeNull();
		expect(resolve(node(), true).action).toBeNull();
	});

	it('offline outranks every worker fact: a silent machine’s last report may be stale', () => {
		expect(resolve(node({ status: 'offline', workerState: 'quarantined' })).state).toBe('offline');
	});

	it('quarantined carries the node’s reason and the exact command, and outranks the owner’s own stop', () => {
		const quarantined = resolve(node({ workerState: 'quarantined', workerStateReason: 'process tree unproven' }));
		expect(quarantined).toEqual({
			state: 'quarantined',
			params: { reason: 'process tree unproven' },
			action: { kind: 'copy-command', command: FLEET_NODE_CLEAR_QUARANTINE_COMMAND }
		});
		expect(resolve(node({ status: 'paused', workerState: 'quarantined' })).state).toBe('quarantined');
		expect(resolve(node({ status: 'disabled', workerState: 'quarantined' })).state).toBe('quarantined');
	});

	it('a disabled computer still finishing jobs is draining', () => {
		expect(resolve(node({ status: 'disabled', load: { activeJobCount: 2 } }))).toEqual({
			state: 'draining',
			params: { jobs: 2 },
			action: null
		});
	});

	it('a node that paused itself is paused', () => {
		expect(resolve(node({ workerState: 'paused' })).state).toBe('paused');
	});

	it('upgrade-required offers the upgrade command and outranks throttles and work', () => {
		const result = resolve(
			node({ upgradeRequired: true, workerState: 'throttled', modelThrottles: [throttle('claude-code')] })
		);
		expect(result).toEqual({
			state: 'upgrade-required',
			params: {},
			action: { kind: 'copy-command', command: FLEET_NODE_UPGRADE_COMMAND }
		});
	});

	it('throttled names the dimension, reading and ceiling the node reported (U13: 92% of 85%)', () => {
		const result = resolve(
			node({
				workerState: 'throttled',
				health: { at: '2026-10-18T09:40:12Z', cpuPercent: 92.4 },
				effectiveLimits: { maxCpuPercent: 85, maxMemoryMb: null }
			})
		);
		expect(result).toEqual({
			state: 'throttled',
			params: { dimension: 'cpu', value: 92, limit: 85 },
			action: { kind: 'change-limits' }
		});
	});

	it('throttled on memory and on the disk floor', () => {
		expect(
			resolve(
				node({
					workerState: 'throttled',
					health: { at: EARLIER, memUsedMiB: 7000 },
					effectiveLimits: { maxCpuPercent: null, maxMemoryMb: 6000 }
				})
			).params
		).toEqual({ dimension: 'memory', value: 7000, limit: 6000 });
		expect(
			resolve(node({ workerState: 'throttled', diskFreeBytes: 3 * GIB, minFreeDiskBytes: 5 * GIB })).params
		).toEqual({ dimension: 'disk', value: 3 * GIB, limit: 5 * GIB });
	});

	it('throttled with no provable dimension and no model limit falls back to the node’s own words', () => {
		expect(
			resolve(
				node({ workerState: 'throttled', workerStateReason: 'host CPU 92% is at or above the 85% ceiling' })
			)
		).toEqual({
			state: 'throttled',
			params: { reason: 'host CPU 92% is at or above the 85% ceiling' },
			action: { kind: 'change-limits' }
		});
	});

	it('limited: the node reports throttled and a model CLI is out of quota (spec S3)', () => {
		expect(resolve(node({ workerState: 'throttled', modelThrottles: [throttle('claude-code')] }))).toEqual({
			state: 'limited',
			params: { provider: 'claude-code', until: LATER, limitedCount: 1 },
			action: { kind: 'clear-model-throttle', provider: 'claude-code' }
		});
	});

	it('limited with two CLIs names the one that resets first and clears both', () => {
		const result = resolve(
			node({
				capabilities: ['claude-code', 'codex'],
				workerState: 'throttled',
				modelThrottles: [throttle('codex', '2026-10-20T00:00:00.000Z'), throttle('claude-code', LATER)]
			})
		);
		expect(result.params).toEqual({ provider: 'claude-code', until: LATER, limitedCount: 2 });
		expect(result.action).toEqual({ kind: 'clear-model-throttle' });
	});

	it('an older node that reports no throttle is limited only when EVERY CLI it advertises is out of quota', () => {
		expect(resolve(node({ workerState: null, modelThrottles: [throttle('claude-code')] })).state).toBe('limited');
		expect(
			resolve(
				node({
					capabilities: ['claude-code', 'codex'],
					workerState: 'idle',
					modelThrottles: [throttle('claude-code')]
				})
			).state
		).toBe('online');
	});

	it('an expired throttle is no throttle', () => {
		expect(resolve(node({ workerState: null, modelThrottles: [throttle('claude-code', EARLIER)] })).state).toBe(
			'online'
		);
	});

	it('busy from the job count, or from the worker when the count is unknown; work outranks a partial limit', () => {
		expect(resolve(node({ load: { activeJobCount: 2 } }))).toEqual({
			state: 'busy',
			params: { jobs: 2 },
			action: null
		});
		expect(resolve(node({ workerState: 'working' }))).toEqual({ state: 'busy', params: {}, action: null });
		expect(resolve(node({ workerState: 'working', modelThrottles: [throttle('claude-code')] })).state).toBe('busy');
	});

	it('reads offline once the last beat is older than the offline window, whatever the stored status says', () => {
		const window = 5 * 60_000;
		const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();
		const judge = (input: ComputerStateInput) =>
			resolveComputerState(input, { now: NOW, offlineAfterMs: window, canWake: true });
		// The sweep only flips online rows, and only on the owner's list read:
		// a single-computer read must not say "online" for a machine silent for an hour.
		for (const status of ['online', 'paused', 'disabled'] as const) {
			expect(judge(node({ status, lastHeartbeatAt: at(60 * 60_000) }))).toEqual({
				state: 'offline',
				params: { lastSeenAt: at(60 * 60_000) },
				action: { kind: 'wake' }
			});
		}
		// Its last report is stale too: no quarantine, throttle or busy is claimed.
		expect(judge(node({ workerState: 'quarantined', lastHeartbeatAt: at(window + 1) })).state).toBe('offline');
		expect(judge(node({ lastHeartbeatAt: null })).state).toBe('offline');
		expect(judge(node({ lastHeartbeatAt: 'not a date' })).state).toBe('offline');
		// At the boundary, and inside it, the stored facts stand.
		expect(judge(node({ lastHeartbeatAt: at(window) })).state).toBe('online');
		expect(judge(node({ status: 'paused', lastHeartbeatAt: at(1_000) })).state).toBe('paused');
		// An enrolling row has never beaten by definition and stays enrolling.
		expect(judge(node({ status: 'enrolling', lastHeartbeatAt: null })).state).toBe('enrolling');
		// Without a window the stored status is trusted (the caller just swept).
		expect(resolve(node({ lastHeartbeatAt: at(60 * 60_000) })).state).toBe('online');
	});
});

describe('FLEET_HEALTH_ROLLUP_CRON', () => {
	it('is hourly at :07 — the one schedule the Trigger.dev task and the API fallback share', () => {
		expect(FLEET_HEALTH_ROLLUP_CRON).toBe('7 * * * *');
	});
});
