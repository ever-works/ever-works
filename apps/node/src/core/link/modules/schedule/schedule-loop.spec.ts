import { describe, expect, it, vi } from 'vitest';
import type { FleetScheduleDefinition, FleetScheduleRunReport } from '@ever-works/contracts';
import type { CommandExit, CommandRunHandle } from '../command/command-runner';
import type { ScheduleHistory } from './schedule-history';
import { ScheduleLoop } from './schedule-loop';
import type { ScheduleStore, StoredSchedule } from './schedule-store';

const ID = '3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6b';
const at = (iso: string) => Date.parse(iso);

function definition(patch: Partial<FleetScheduleDefinition> = {}): FleetScheduleDefinition {
	return {
		id: ID,
		name: 'Nightly tests',
		command: 'pnpm test',
		cadence: { kind: 'daily', at: '02:00', timezone: 'node' },
		timeoutSec: 21_600,
		revision: '',
		...patch
	};
}

/** An in-memory store and history, a fake clock, and a runner whose runs end when told. */
function harness(options: { now: number; stored?: StoredSchedule[]; paused?: boolean }) {
	let now = options.now;
	const reports: FleetScheduleRunReport[] = [];
	const runs: Array<{ finish(exit?: Partial<CommandExit>): void; stopped: boolean }> = [];
	const state = { generation: 0, paused: options.paused ?? false };
	const store = {
		load: async () => ({ schedules: options.stored ?? [], state: { ...state } }),
		replace: async (definitions: FleetScheduleDefinition[]) =>
			definitions.map((entry) => ({ definition: entry, armedAt: now, lastFireAt: null })),
		markFired: async (stored: StoredSchedule, when: number) => {
			stored.lastFireAt = when;
		},
		setPaused: async (paused: boolean) => {
			state.paused = paused;
		},
		touchAlive: async () => undefined
	} as unknown as ScheduleStore;
	const history = {
		put: async (report: FleetScheduleRunReport) => {
			const index = reports.findIndex((entry) => entry.runId === report.runId);
			if (index >= 0) reports[index] = report;
			else reports.push(report);
		},
		settleInterrupted: async () => 0,
		output: () => ({
			open: async () => ({ write: () => undefined, close: async () => undefined }),
			prune: async () => undefined
		})
	} as unknown as ScheduleHistory;
	const start = vi.fn(async () => {
		let resolve: (exit: CommandExit) => void = () => undefined;
		const done = new Promise<CommandExit>((r) => {
			resolve = r;
		});
		const entry = {
			stopped: false,
			finish: (exit: Partial<CommandExit> = {}) =>
				resolve({ exitCode: 0, signal: null, bytes: 0, capped: false, timedOut: false, ...exit })
		};
		runs.push(entry);
		const handle: CommandRunHandle = {
			pid: 42,
			shell: '/bin/sh -l',
			stop: () => {
				entry.stopped = true;
				entry.finish({ exitCode: 137 });
			},
			done
		};
		return handle;
	});
	let ids = 0;
	const loop = new ScheduleLoop({
		store,
		history,
		nodeName: 'build-01',
		platform: 'linux',
		homedir: '/home/me',
		env: { SHELL: '/bin/sh' },
		timeZone: () => 'UTC',
		start: start as never,
		realpath: async (target) => target,
		now: () => now,
		setTimer: () => 'timer',
		clearTimer: () => undefined,
		newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`
	});
	const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
	return {
		loop,
		reports,
		runs,
		start,
		state,
		settle,
		setNow: (value: number) => {
			now = value;
		}
	};
}

describe('ScheduleLoop (FL-13, FR-12 … FR-17)', () => {
	it('fires at its time from the machine clock, with no link', async () => {
		const stored: StoredSchedule = { definition: definition(), armedAt: at('2026-01-10T00:00:00Z'), lastFireAt: null };
		const h = harness({ now: at('2026-01-10T02:00:00.500Z'), stored: [stored] });
		await h.loop.start();
		await h.settle();
		expect(h.start).toHaveBeenCalledTimes(1);
		expect(h.reports[0]).toMatchObject({ status: 'running', scheduledFor: '2026-01-10T02:00:00.000Z', trigger: 'timer' });
		h.runs[0].finish({ exitCode: 0 });
		await h.settle();
		expect(h.reports[0]).toMatchObject({ status: 'done', exitCode: 0 });
	});

	it('records skipped-overlap while the previous run is still going (FR-13)', async () => {
		const stored: StoredSchedule = {
			definition: definition({ cadence: { kind: 'interval', expr: '5', timezone: 'node' } }),
			armedAt: at('2026-01-10T00:00:00Z'),
			lastFireAt: null
		};
		const h = harness({ now: at('2026-01-10T00:05:00Z'), stored: [stored] });
		await h.loop.start();
		await h.settle();
		h.setNow(at('2026-01-10T00:10:00Z'));
		await h.loop.tick();
		expect(h.start).toHaveBeenCalledTimes(1);
		expect(h.reports.map((report) => report.status)).toEqual(['running', 'skipped-overlap']);
	});

	it('runs two missed fires once within the grace, and records one skip past it (FR-16)', async () => {
		const within: StoredSchedule = {
			definition: definition(),
			armedAt: at('2026-01-01T00:00:00Z'),
			lastFireAt: at('2026-01-10T02:00:00Z')
		};
		const h = harness({ now: at('2026-01-12T02:40:00Z'), stored: [within] });
		await h.loop.start();
		await h.settle();
		expect(h.start).toHaveBeenCalledTimes(1);
		expect(h.reports[0]).toMatchObject({ scheduledFor: '2026-01-12T02:00:00.000Z', trigger: 'catch-up' });

		const past: StoredSchedule = {
			definition: definition(),
			armedAt: at('2026-01-01T00:00:00Z'),
			lastFireAt: at('2026-01-10T02:00:00Z')
		};
		const late = harness({ now: at('2026-01-12T05:00:00Z'), stored: [past] });
		await late.loop.start();
		await late.settle();
		expect(late.start).not.toHaveBeenCalled();
		expect(late.reports).toHaveLength(1);
		expect(late.reports[0]).toMatchObject({ status: 'skipped-offline', scheduledFor: '2026-01-12T02:00:00.000Z' });
	});

	it('never catches up a fire from before it held the schedule', async () => {
		const fresh: StoredSchedule = { definition: definition(), armedAt: at('2026-01-12T02:30:00Z'), lastFireAt: null };
		const h = harness({ now: at('2026-01-12T02:31:00Z'), stored: [fresh] });
		await h.loop.start();
		await h.settle();
		expect(h.start).not.toHaveBeenCalled();
		expect(h.reports).toHaveLength(0);
	});

	it('the kill switch ends a run as kill-switch and stops firing; resume re-arms (FR-17)', async () => {
		const stored: StoredSchedule = { definition: definition(), armedAt: at('2026-01-10T00:00:00Z'), lastFireAt: null };
		const h = harness({ now: at('2026-01-10T02:00:00Z'), stored: [stored] });
		await h.loop.start();
		await h.settle();
		await h.loop.pause();
		await h.settle();
		expect(h.runs[0].stopped).toBe(true);
		expect(h.reports[0]).toMatchObject({ status: 'failed', failedReason: 'kill-switch', exitCode: 137 });
		expect(h.state.paused).toBe(true);
		expect(await h.loop.runNow(ID, '00000000-0000-4000-8000-0000000000aa')).toMatchObject({
			error: { code: 'kill_switch' }
		});
		h.setNow(at('2026-01-11T02:00:00Z'));
		await h.loop.tick();
		expect(h.start).toHaveBeenCalledTimes(1);
		await h.loop.resume();
		await h.settle();
		expect(h.start).toHaveBeenCalledTimes(2);
	});

	it('Run now is busy while a run is in flight (FR-19)', async () => {
		const stored: StoredSchedule = { definition: definition(), armedAt: at('2026-01-10T00:00:00Z'), lastFireAt: null };
		const h = harness({ now: at('2026-01-10T12:00:00Z'), stored: [stored] });
		await h.loop.start();
		const first = await h.loop.runNow(ID, '00000000-0000-4000-8000-0000000000a1');
		expect(first).toMatchObject({ runId: '00000000-0000-4000-8000-0000000000a1' });
		await h.settle();
		expect(await h.loop.runNow(ID, '00000000-0000-4000-8000-0000000000a2')).toMatchObject({ error: { code: 'busy' } });
		expect(await h.loop.runNow('00000000-0000-4000-8000-0000000000ff', 'x')).toMatchObject({
			error: { code: 'not_found' }
		});
	});

	it('a folder outside home fails the run with the reason, without a process', async () => {
		const stored: StoredSchedule = {
			definition: definition({ cwd: '/etc' }),
			armedAt: at('2026-01-10T00:00:00Z'),
			lastFireAt: null
		};
		const h = harness({ now: at('2026-01-10T02:00:00Z'), stored: [stored] });
		await h.loop.start();
		await h.settle();
		expect(h.start).not.toHaveBeenCalled();
		expect(h.reports[0]).toMatchObject({ status: 'failed', failedReason: 'shell-failed' });
		expect(h.reports[0].head).toContain('outside your home folder');
	});
});
