import { promises as fsp } from 'fs';
import * as path from 'path';
import {
	isFleetCommandId,
	parseFleetScheduleDefinition,
	type FleetScheduleDefinition
} from '@ever-works/contracts';

/**
 * Schedules on computers (FL-13, CONTRACTS §6, plan §6) — the machine's copy
 * of its Command schedules, so they run whether or not the platform is
 * reachable and survive a restart (spec §6 reliability: "a node restart loses
 * no definition").
 *
 *  - `<dir>/<id>.json` — one definition and its clock state: when the machine
 *    first held it (`armedAt`: fires before that are never caught up) and the
 *    last fire it handled (`lastFireAt`);
 *  - `<dir>/_state.json` — the generation the platform last sent and the kill
 *    switch as it was last told (honoured while the link is down, spec §8b).
 *
 * Owner-only (`0700` folder, `0600` files — on Windows the folder inherits the
 * config folder's owner-only ACL). Every write is atomic (a temporary file
 * renamed over the old one), so a crash mid-write leaves the previous copy.
 * `replace` holds the platform's set EXACTLY (FR-11): a definition not in the
 * set is deleted from the folder.
 */

export interface StoredSchedule {
	definition: FleetScheduleDefinition;
	/** Epoch ms the machine first held this cadence (re-armed when the cadence changes). */
	armedAt: number;
	/** Epoch ms of the last fire handled (run or recorded skipped), or null. */
	lastFireAt: number | null;
}

export interface ScheduleStoreState {
	generation: number;
	/** The kill switch as the platform last said it (`link.pause` / `link.resume`). */
	paused: boolean;
}

export interface ScheduleStoreOptions {
	dir: string;
	/** Test seam. */
	fs?: Pick<typeof fsp, 'mkdir' | 'readdir' | 'readFile' | 'writeFile' | 'rename' | 'rm'>;
}

const STATE_FILE = '_state.json';

export class ScheduleStore {
	private readonly fs: NonNullable<ScheduleStoreOptions['fs']>;
	private ready: Promise<void> | null = null;

	constructor(private readonly options: ScheduleStoreOptions) {
		this.fs = options.fs ?? fsp;
	}

	get dir(): string {
		return this.options.dir;
	}

	/** Every stored schedule and the stored state. A file that does not parse is skipped (never a crash). */
	async load(): Promise<{ schedules: StoredSchedule[]; state: ScheduleStoreState }> {
		await this.ensureDir();
		const schedules: StoredSchedule[] = [];
		let names: string[] = [];
		try {
			names = await this.fs.readdir(this.options.dir);
		} catch {
			names = [];
		}
		for (const name of names) {
			const match = /^([0-9a-f-]{36})\.json$/i.exec(name);
			if (!match || !isFleetCommandId(match[1])) continue;
			const stored = await this.readSchedule(path.join(this.options.dir, name));
			if (stored) schedules.push(stored);
		}
		return { schedules, state: await this.readState() };
	}

	/**
	 * Hold exactly `definitions`: write each (keeping the clock state of one
	 * whose cadence did not change), delete every other definition file, and
	 * record the generation. Answers what is now held.
	 */
	async replace(
		definitions: readonly FleetScheduleDefinition[],
		generation: number,
		previous: ReadonlyMap<string, StoredSchedule>,
		now: number
	): Promise<StoredSchedule[]> {
		await this.ensureDir();
		const held: StoredSchedule[] = [];
		for (const definition of definitions) {
			const before = previous.get(definition.id);
			const sameClock = before && JSON.stringify(before.definition.cadence) === JSON.stringify(definition.cadence);
			const stored: StoredSchedule = {
				definition,
				armedAt: sameClock ? before.armedAt : now,
				lastFireAt: sameClock ? before.lastFireAt : null
			};
			await this.writeSchedule(stored);
			held.push(stored);
		}
		const keep = new Set(definitions.map((definition) => `${definition.id}.json`));
		let names: string[] = [];
		try {
			names = await this.fs.readdir(this.options.dir);
		} catch {
			names = [];
		}
		for (const name of names) {
			if (!/^[0-9a-f-]{36}\.json$/i.test(name) || keep.has(name.toLowerCase())) continue;
			await this.fs.rm(path.join(this.options.dir, name), { force: true }).catch(() => undefined);
		}
		const state = await this.readState();
		await this.writeState({ ...state, generation });
		return held;
	}

	/** Record the last fire handled for one schedule. */
	async markFired(stored: StoredSchedule, at: number): Promise<void> {
		stored.lastFireAt = Math.max(stored.lastFireAt ?? 0, at);
		await this.writeSchedule(stored);
	}

	/** Remember the kill switch as told, so a restart without a link honours it. */
	async setPaused(paused: boolean): Promise<void> {
		const state = await this.readState();
		if (state.paused === paused) return;
		await this.writeState({ ...state, paused });
	}

	async readState(): Promise<ScheduleStoreState> {
		try {
			const raw = JSON.parse(await this.fs.readFile(path.join(this.options.dir, STATE_FILE), 'utf8')) as Record<
				string,
				unknown
			>;
			return {
				generation:
					typeof raw.generation === 'number' && Number.isInteger(raw.generation) && raw.generation >= 0
						? raw.generation
						: 0,
				paused: raw.paused === true
			};
		} catch {
			return { generation: 0, paused: false };
		}
	}

	private async readSchedule(file: string): Promise<StoredSchedule | null> {
		try {
			const raw = JSON.parse(await this.fs.readFile(file, 'utf8')) as Record<string, unknown>;
			const definition = parseFleetScheduleDefinition(raw.definition);
			if (!definition) return null;
			const armedAt = typeof raw.armedAt === 'number' && Number.isFinite(raw.armedAt) ? raw.armedAt : Date.now();
			const lastFireAt = typeof raw.lastFireAt === 'number' && Number.isFinite(raw.lastFireAt) ? raw.lastFireAt : null;
			return { definition, armedAt, lastFireAt };
		} catch {
			return null;
		}
	}

	private async writeSchedule(stored: StoredSchedule): Promise<void> {
		await this.writeAtomic(path.join(this.options.dir, `${stored.definition.id}.json`), stored);
	}

	private async writeState(state: ScheduleStoreState): Promise<void> {
		await this.writeAtomic(path.join(this.options.dir, STATE_FILE), state);
	}

	private async writeAtomic(file: string, value: unknown): Promise<void> {
		await this.ensureDir();
		const temporary = `${file}.${process.pid}.tmp`;
		await this.fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
		await this.fs.rename(temporary, file);
	}

	private ensureDir(): Promise<void> {
		this.ready ??= this.fs
			.mkdir(this.options.dir, { recursive: true, mode: 0o700 })
			.then(() => undefined)
			.catch((error: unknown) => {
				this.ready = null;
				throw error;
			});
		return this.ready;
	}
}
