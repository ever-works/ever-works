import { promises as fsp } from 'fs';
import * as path from 'path';
import {
	isFleetCommandId,
	parseFleetScheduleRunReport,
	FLEET_SCHEDULE_HISTORY,
	FLEET_SCHEDULE_RUNS_PAGE,
	type FleetScheduleRunReport
} from '@ever-works/contracts';
import { CommandOutputStore } from '../command/command-output-store';

/**
 * Schedules on computers (FL-13, FR-15, FR-20, CONTRACTS §6) — the runs this
 * machine made, kept on the machine:
 *
 *  - `<dir>/<scheduleId>/runs.json` — the newest 30 run reports (head and
 *    tail ≤ 64 KiB each), newest first;
 *  - `<dir>/<scheduleId>/<runId>.log` — each run's FULL output (FL-12's
 *    `CommandOutputStore`, ring of 30 per schedule), for "Open full output".
 *
 * `since` answers `schedule.runs`: every run that ended at or after an
 * instant, plus every run still going — the platform upserts them by run id,
 * so answering a run twice is harmless (reconciliation is idempotent).
 * Owner-only like the definitions; writes are atomic.
 */

export interface ScheduleHistoryOptions {
	dir: string;
	keep?: number;
}

export class ScheduleHistory {
	private readonly keep: number;
	private readonly cache = new Map<string, FleetScheduleRunReport[]>();
	private readonly outputs = new Map<string, CommandOutputStore>();

	constructor(private readonly options: ScheduleHistoryOptions) {
		this.keep = Math.max(1, Math.floor(options.keep ?? FLEET_SCHEDULE_HISTORY));
	}

	/** One schedule's runs, newest first. */
	async list(scheduleId: string): Promise<FleetScheduleRunReport[]> {
		if (!isFleetCommandId(scheduleId)) return [];
		const key = scheduleId.toLowerCase();
		const cached = this.cache.get(key);
		if (cached) return cached;
		let runs: FleetScheduleRunReport[] = [];
		try {
			const raw = JSON.parse(await fsp.readFile(this.runsFile(key), 'utf8')) as unknown;
			if (Array.isArray(raw)) {
				runs = raw
					.map((entry) => parseFleetScheduleRunReport(entry))
					.filter((entry): entry is FleetScheduleRunReport => entry !== null);
			}
		} catch {
			runs = [];
		}
		this.cache.set(key, runs);
		return runs;
	}

	/** Insert or replace one run (by run id), keep the newest 30, write the file. */
	async put(report: FleetScheduleRunReport): Promise<void> {
		const key = report.scheduleId.toLowerCase();
		const runs = [...(await this.list(key))].filter((entry) => entry.runId !== report.runId);
		runs.push(report);
		runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
		const kept = runs.slice(0, this.keep);
		this.cache.set(key, kept);
		await fsp.mkdir(path.join(this.options.dir, key), { recursive: true, mode: 0o700 });
		const file = this.runsFile(key);
		const temporary = `${file}.${process.pid}.tmp`;
		await fsp.writeFile(temporary, JSON.stringify(kept), { mode: 0o600 });
		await fsp.rename(temporary, file);
	}

	/**
	 * Every run, across schedules, that ended at or after `since` (all when
	 * null) or is still running — oldest end first, at most one page.
	 */
	async since(
		since: string | null,
		limit = FLEET_SCHEDULE_RUNS_PAGE
	): Promise<{ runs: FleetScheduleRunReport[]; more: boolean }> {
		const all: FleetScheduleRunReport[] = [];
		for (const id of await this.scheduleIds()) {
			for (const run of await this.list(id)) {
				if (run.status === 'running' || since === null || (run.endedAt !== null && run.endedAt >= since)) {
					all.push(run);
				}
			}
		}
		all.sort((a, b) => (a.endedAt ?? '9999').localeCompare(b.endedAt ?? '9999'));
		return { runs: all.slice(0, limit), more: all.length > limit };
	}

	/**
	 * Runs a previous process left `running` (it stopped mid-run): they cannot
	 * report an exit any more, so they end `failed (node-restart)` now.
	 */
	async settleInterrupted(now: number): Promise<number> {
		let settled = 0;
		for (const id of await this.scheduleIds()) {
			for (const run of await this.list(id)) {
				if (run.status !== 'running') continue;
				await this.put({
					...run,
					status: 'failed',
					failedReason: 'node-restart',
					endedAt: new Date(now).toISOString()
				});
				settled += 1;
			}
		}
		return settled;
	}

	/** The ring that keeps this run's full output, or null (FL-12's `command.read` asks). */
	async storeFor(runId: string): Promise<CommandOutputStore | null> {
		if (!isFleetCommandId(runId)) return null;
		for (const id of await this.scheduleIds()) {
			const store = this.output(id);
			if (await store.has(runId)) return store;
		}
		return null;
	}

	/** Where one schedule's full outputs live (a ring of 30). */
	output(scheduleId: string): CommandOutputStore {
		const key = scheduleId.toLowerCase();
		let store = this.outputs.get(key);
		if (!store) {
			store = new CommandOutputStore({ dir: path.join(this.options.dir, key), keep: this.keep });
			this.outputs.set(key, store);
		}
		return store;
	}

	private runsFile(key: string): string {
		return path.join(this.options.dir, key, 'runs.json');
	}

	private async scheduleIds(): Promise<string[]> {
		try {
			const entries = await fsp.readdir(this.options.dir, { withFileTypes: true });
			return entries
				.filter((entry) => entry.isDirectory() && isFleetCommandId(entry.name))
				.map((entry) => entry.name.toLowerCase());
		} catch {
			return [];
		}
	}
}
