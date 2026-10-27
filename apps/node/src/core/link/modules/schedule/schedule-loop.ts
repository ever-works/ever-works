import { randomUUID } from 'node:crypto';
import {
	fleetCommandRunEndFor,
	fleetScheduleCatchUp,
	nextFleetScheduleFire,
	FleetCommandEdgeBuffer,
	FLEET_COMMAND_CANCEL_EXIT_CODE,
	FLEET_COMMAND_STOPPED_EXIT_CODE,
	FLEET_COMMAND_TIMEOUT_EXIT_CODE,
	FLEET_SCHEDULE_MISSED_GRACE_SEC,
	type FleetCommandNodeEndReason,
	type FleetLinkError,
	type FleetScheduleDefinition,
	type FleetScheduleRunReport,
	type FleetScheduleRunTrigger
} from '@ever-works/contracts';
import type { Logger } from '../../../logger';
import { buildNodeCheckEnv } from '../../../executors/acceptance-checks';
import { resolveLoginShell } from '../../../sessions/owner-session-launcher';
import { resolveCommandFolder } from '../command/command-folder';
import type { CommandOutputWriter } from '../command/command-output-store';
import { startCommand, type CommandRunHandle } from '../command/command-runner';
import type { ScheduleHistory } from './schedule-history';
import type { ScheduleStore, StoredSchedule } from './schedule-store';

/**
 * Schedules on computers (FL-13, FR-12 … FR-17, CONTRACTS §6) — the node's
 * own clock. Runs inside the node service, with or without a link, and
 * depends on no cron, launchd or Task Scheduler.
 *
 *  - **One timer.** Armed to the earliest next fire of every held schedule
 *    (at most a minute ahead, so a clock jump or a sleep is noticed), never a
 *    one-second tick: few wake-ups on a laptop, drift-free because every
 *    fire is recomputed from the wall clock in the machine's zone.
 *  - **Missed fires collapse to one.** On every tick, for every schedule:
 *    the latest fire after the last one handled — run once if it is within
 *    the 60-minute grace, else recorded `skipped-offline` once (FR-16). The
 *    same rule covers a node that was not running and a laptop that slept.
 *  - **One run at a time per schedule** — a fire while one runs is recorded
 *    `skipped-overlap` (FR-13); a run is ended at its cap (six hours) and
 *    recorded `timeout` (FR-14). Exactly a one-off Command's process model:
 *    FL-12's runner, the machine owner's login shell, no stdin, the scrubbed
 *    environment, the home folder or a folder the owner allowed (FR-7).
 *  - **Kill switch** (FR-17): `pause()` disarms the timer and ends every
 *    run `failed (kill-switch)`; `resume()` re-arms without replaying fires
 *    older than the grace. The state is persisted and honoured while the
 *    link is down (spec §8b default).
 */

export interface ScheduleLoopOptions {
	store: ScheduleStore;
	history: ScheduleHistory;
	nodeName: string;
	platform: string;
	homedir: string;
	/** This process's environment: the login shell is read from it, and each run's is scrubbed from it. */
	env: Record<string, string | undefined>;
	/** Folders besides home a schedule may run in (the owner sessions' list). */
	extraRoots?: readonly string[];
	/** The machine's IANA zone (`Intl…resolvedOptions().timeZone`). */
	timeZone: () => string | null;
	logger?: Logger;
	/** Test seams. */
	start?: typeof startCommand;
	realpath?: (target: string) => Promise<string>;
	now?: () => number;
	setTimer?: (callback: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
	newId?: () => string;
	/**
	 * FL-13 P3 — the held set changed (loaded, or replaced by a sync): the
	 * OS-scheduler fallback re-installs its entries from it. Never awaited
	 * into the loop; a failure is the callback's own.
	 */
	onHeld?: (definitions: FleetScheduleDefinition[]) => void;
	/** FL-13 P3 — write the loop's lease on every tick (off for the one-shot `schedule-run`). Default on. */
	lease?: boolean;
}

interface RunningRun {
	runId: string;
	stop(reason: FleetCommandNodeEndReason): void;
	done: Promise<void>;
}

/** The timer never sleeps longer than this, so a sleep or a clock change is caught within a minute. */
const MAX_ARM_MS = 60_000;

export class ScheduleLoop {
	private readonly schedules = new Map<string, StoredSchedule>();
	private readonly running = new Map<string, RunningRun>();
	private readonly now: () => number;
	private readonly startCommandFn: typeof startCommand;
	private timer: unknown = null;
	private paused = false;
	private started = false;
	private stopped = false;
	private ticking: Promise<void> | null = null;

	constructor(private readonly options: ScheduleLoopOptions) {
		this.now = options.now ?? (() => Date.now());
		this.startCommandFn = options.start ?? startCommand;
	}

	/** Load the held set and the last kill-switch state, settle runs a previous process left, then arm. */
	async start(): Promise<void> {
		if (this.started) return;
		this.started = true;
		const { schedules, state } = await this.options.store.load();
		for (const stored of schedules) this.schedules.set(stored.definition.id, stored);
		this.paused = state.paused;
		this.notifyHeld();
		const settled = await this.options.history.settleInterrupted(this.now()).catch(() => 0);
		if (settled > 0)
			this.options.logger?.info(`Schedules: ${settled} run(s) interrupted by a restart were recorded.`);
		this.options.logger?.info(
			`Schedules: ${this.schedules.size} held${this.paused ? ' (paused by the fleet kill switch)' : ''}.`
		);
		await this.tick();
	}

	/** Stop the timer (process shutdown). Running commands are left to finish on their own. */
	dispose(): void {
		this.stopped = true;
		this.disarm();
	}

	get isPaused(): boolean {
		return this.paused;
	}

	/** The ids held, in no order. */
	held(): string[] {
		return [...this.schedules.keys()];
	}

	/** Hold exactly this set (`schedule.sync`); deleted ones stop firing, a run in flight finishes. */
	async replace(definitions: readonly FleetScheduleDefinition[], generation: number): Promise<void> {
		const held = await this.options.store.replace(definitions, generation, this.schedules, this.now());
		this.schedules.clear();
		for (const stored of held) this.schedules.set(stored.definition.id, stored);
		this.notifyHeld();
		this.arm();
	}

	/** Resolves once no run is in flight (the one-shot `schedule-run` waits for its fire to end). */
	async idle(): Promise<void> {
		while (this.running.size > 0 || this.ticking) {
			await Promise.all([...this.running.values()].map((run) => run.done));
			if (this.ticking) await this.ticking;
		}
	}

	private notifyHeld(): void {
		if (!this.options.onHeld) return;
		try {
			this.options.onHeld([...this.schedules.values()].map((stored) => stored.definition));
		} catch (error) {
			this.options.logger?.warn(`Schedules: the held set could not be passed on: ${describe(error)}`);
		}
	}

	/** Each held schedule's next fire on this machine's clock (ISO, or null) — the `schedule.sync` reply. */
	nextFires(): Record<string, string | null> {
		const out: Record<string, string | null> = {};
		const now = this.now();
		for (const [id, stored] of this.schedules) {
			const next = this.paused ? null : nextFleetScheduleFire(stored.definition.cadence, this.zone(), now);
			out[id] = next === null ? null : new Date(next).toISOString();
		}
		return out;
	}

	/** Run one schedule now (`schedule.runNow`, FR-19): the next fire is not moved. */
	async runNow(id: string, runId: string): Promise<{ runId: string; startedAt: string } | { error: FleetLinkError }> {
		if (this.paused) return { error: { code: 'kill_switch', hint: 'clear it under Settings → Fleet' } };
		const stored = this.schedules.get(id);
		if (!stored) {
			return { error: { code: 'not_found', hint: `${this.options.nodeName} does not hold this schedule yet` } };
		}
		if (this.running.has(id)) return { error: { code: 'busy', hint: 'a run of this schedule is still going' } };
		const startedAt = new Date(this.now()).toISOString();
		void this.run(stored, runId, null, 'run-now');
		return { runId, startedAt };
	}

	/** The fleet kill switch (`link.pause`, FR-17): disarm, end every run `kill-switch`, remember it. */
	async pause(): Promise<void> {
		if (this.paused) return;
		this.paused = true;
		this.disarm();
		for (const run of this.running.values()) run.stop('kill-switch');
		await this.options.store.setPaused(true).catch(() => undefined);
	}

	/** `link.resume`: re-arm; fires older than the grace are recorded skipped, never replayed. */
	async resume(): Promise<void> {
		if (!this.paused) return;
		this.paused = false;
		await this.options.store.setPaused(false).catch(() => undefined);
		await this.tick();
	}

	/** Drain-all (`link.drain`): end every run `drain`. The timer keeps its schedule. */
	drain(): void {
		for (const run of this.running.values()) run.stop('drain');
	}

	/** Fire everything due, then re-arm. Serialised: one tick at a time. */
	async tick(): Promise<void> {
		if (this.ticking) return this.ticking;
		this.ticking = this.tickOnce().finally(() => {
			this.ticking = null;
		});
		return this.ticking;
	}

	private async tickOnce(): Promise<void> {
		this.disarm();
		if (this.stopped) return;
		if (this.options.lease !== false) await this.options.store.touchAlive(this.now()).catch(() => undefined);
		if (!this.paused) {
			const now = this.now();
			for (const stored of [...this.schedules.values()]) {
				const since = Math.max(stored.armedAt, stored.lastFireAt ?? 0);
				const due = fleetScheduleCatchUp({
					cadence: stored.definition.cadence,
					timeZone: this.zone(),
					sinceMs: since,
					nowMs: now,
					graceSec: FLEET_SCHEDULE_MISSED_GRACE_SEC
				});
				if (due.run !== null) {
					await this.options.store.markFired(stored, due.run).catch(() => undefined);
					// Within two minutes of the fire it is the timer's own; later, a catch-up.
					const trigger: FleetScheduleRunTrigger = now - due.run <= 120_000 ? 'timer' : 'catch-up';
					if (this.running.has(stored.definition.id)) {
						await this.record(stored, 'skipped-overlap', due.run, trigger);
					} else {
						void this.run(stored, this.newId(), due.run, trigger);
					}
				} else if (due.skipped !== null) {
					await this.options.store.markFired(stored, due.skipped).catch(() => undefined);
					await this.record(stored, 'skipped-offline', due.skipped, 'catch-up');
				}
			}
		}
		this.arm();
	}

	private arm(): void {
		this.disarm();
		if (this.paused || this.stopped || this.schedules.size === 0) return;
		const now = this.now();
		let earliest = Number.POSITIVE_INFINITY;
		for (const stored of this.schedules.values()) {
			const next = nextFleetScheduleFire(stored.definition.cadence, this.zone(), now);
			if (next !== null && next < earliest) earliest = next;
		}
		const delay = Number.isFinite(earliest) ? Math.max(0, Math.min(MAX_ARM_MS, earliest - now)) : MAX_ARM_MS;
		const setTimer =
			this.options.setTimer ??
			((callback: () => void, ms: number) => {
				const timer = setTimeout(callback, ms);
				timer.unref?.();
				return timer;
			});
		this.timer = setTimer(() => {
			this.timer = null;
			void this.tick();
		}, delay);
	}

	private disarm(): void {
		if (this.timer === null) return;
		const clearTimer = this.options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as NodeJS.Timeout));
		clearTimer(this.timer);
		this.timer = null;
	}

	/** A fire that did not run: one history row, no process. */
	private async record(
		stored: StoredSchedule,
		status: 'skipped-overlap' | 'skipped-offline',
		scheduledFor: number,
		trigger: FleetScheduleRunTrigger
	): Promise<void> {
		const at = new Date(this.now()).toISOString();
		await this.options.history
			.put({
				runId: this.newId(),
				scheduleId: stored.definition.id,
				scheduledFor: new Date(scheduledFor).toISOString(),
				startedAt: at,
				endedAt: at,
				status,
				failedReason: null,
				exitCode: null,
				head: '',
				tail: '',
				truncated: false,
				capped: false,
				bytes: 0,
				kept: false,
				trigger
			})
			.catch((error: unknown) =>
				this.options.logger?.warn(`Schedules: a skipped fire was not recorded: ${describe(error)}`)
			);
	}

	/** One run, start to end, written to the history as it goes. Never throws. */
	private async run(
		stored: StoredSchedule,
		runId: string,
		scheduledFor: number | null,
		trigger: FleetScheduleRunTrigger
	): Promise<void> {
		const { definition } = stored;
		const startedAt = new Date(this.now()).toISOString();
		const base: FleetScheduleRunReport = {
			runId,
			scheduleId: definition.id,
			scheduledFor: scheduledFor === null ? null : new Date(scheduledFor).toISOString(),
			startedAt,
			endedAt: null,
			status: 'running',
			failedReason: null,
			exitCode: null,
			head: '',
			tail: '',
			truncated: false,
			capped: false,
			bytes: 0,
			kept: false,
			trigger
		};
		const fail = async (detail: string) => {
			await this.options.history
				.put({
					...base,
					status: 'failed',
					failedReason: 'shell-failed',
					endedAt: new Date(this.now()).toISOString(),
					head: detail
				})
				.catch(() => undefined);
		};

		let release: () => void = () => undefined;
		const done = new Promise<void>((resolve) => {
			release = resolve;
		});
		let endReason: FleetCommandNodeEndReason | undefined;
		let handle: CommandRunHandle | null = null;
		const entry: RunningRun = {
			runId,
			stop(reason) {
				endReason ??= reason;
				handle?.stop();
			},
			done
		};
		this.running.set(definition.id, entry);
		try {
			const folder = await resolveCommandFolder({
				...(definition.cwd ? { cwd: definition.cwd } : {}),
				homedir: this.options.homedir,
				platform: this.options.platform,
				...(this.options.extraRoots ? { extraRoots: this.options.extraRoots } : {}),
				nodeName: this.options.nodeName,
				...(this.options.realpath ? { realpath: this.options.realpath } : {})
			});
			if (folder.error || !folder.cwd) {
				await fail(folder.error?.hint ?? 'the folder is not allowed');
				return;
			}
			await this.options.history.put(base).catch(() => undefined);
			let writer: CommandOutputWriter | null = null;
			try {
				writer = await this.options.history.output(definition.id).open(runId);
			} catch (error) {
				this.options.logger?.warn(`Schedules: the output of a run cannot be kept: ${describe(error)}`);
			}
			const edges = new FleetCommandEdgeBuffer();
			let capped = false;
			try {
				handle = await this.startCommandFn({
					command: definition.command,
					cwd: folder.cwd,
					timeoutSec: definition.timeoutSec,
					platform: this.options.platform,
					env: buildNodeCheckEnv(null, this.options.env as NodeJS.ProcessEnv),
					shell: resolveLoginShell(this.options.platform, this.options.env),
					onData: (chunk) => {
						edges.push(chunk);
						writer?.write(chunk);
					},
					onCapped: () => {
						capped = true;
					},
					onTimeout: () => {
						endReason ??= 'timeout';
					}
				});
			} catch (error) {
				await writer?.close();
				await fail(describe(error).split(/\r?\n/, 1)[0].slice(0, 300) || 'the shell could not start');
				return;
			}
			// A pause that landed while the shell was starting.
			if (this.paused) entry.stop('kill-switch');
			const exit = await handle.done;
			await writer?.close();
			void this.options.history.output(definition.id).prune();
			const exitCode =
				endReason === 'timeout'
					? FLEET_COMMAND_TIMEOUT_EXIT_CODE
					: endReason === 'cancelled-by-user'
						? FLEET_COMMAND_CANCEL_EXIT_CODE
						: endReason === 'kill-switch' || endReason === 'drain'
							? FLEET_COMMAND_STOPPED_EXIT_CODE
							: (exit.exitCode ?? 1);
			const end = fleetCommandRunEndFor(exitCode, endReason);
			const snapshot = edges.snapshot();
			await this.options.history
				.put({
					...base,
					status: end.status,
					failedReason: end.failedReason,
					exitCode,
					endedAt: new Date(this.now()).toISOString(),
					head: snapshot.head,
					tail: snapshot.tail,
					truncated: snapshot.truncated,
					capped: capped || exit.capped,
					bytes: snapshot.bytes,
					kept: writer !== null
				})
				.catch((error: unknown) =>
					this.options.logger?.warn(`Schedules: a run was not recorded: ${describe(error)}`)
				);
		} catch (error) {
			this.options.logger?.warn(`Schedules: a run failed unexpectedly: ${describe(error)}`);
		} finally {
			if (this.running.get(definition.id) === entry) this.running.delete(definition.id);
			release();
		}
	}

	private zone(): string | null {
		try {
			return this.options.timeZone();
		} catch {
			return null;
		}
	}

	private newId(): string {
		return (this.options.newId ?? randomUUID)();
	}
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
