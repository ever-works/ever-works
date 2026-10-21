import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import {
	isFleetDaemonSessionId,
	isFleetSessionEndedReason,
	isFleetSessionKind,
	isFleetSessionProvider,
	isFleetSessionStarter,
	clampFleetSessionSize,
	type FleetSessionEndedReason,
	type FleetSessionKind,
	type FleetSessionProvider,
	type FleetSessionStarter
} from '@ever-works/contracts';

/**
 * Sessions on computers (FL-04) — what the daemon remembers on disk (spec
 * FR-8, FR-9, U15).
 *
 * Per session, under `<stateDir>/records/`:
 *
 *  - `<id>.json` — kind, provider, folder, title, start time, starter, size
 *    and, once it ended, the end facts. Written at start, on rename and at
 *    exit, ATOMICALLY (a temp file renamed over the old one), so a crash
 *    mid-write leaves the previous record, never half of one.
 *  - `<id>.screen` — the last screen as plain text, written at most
 *    {@link FLEET_SESSION_SCREEN_PERSIST_MS} after it changed and at exit.
 *
 * An ended session's files stay until the node confirms the platform has its
 * screen (`ack-ended`). After a daemon restart (the machine rebooted, the
 * daemon crashed) every record without an end is a session whose process is
 * gone: it is reported as lost, with its last persisted screen.
 *
 * A failed write (a full disk) is never fatal: the session keeps running,
 * the store reports `failing`, and the node says so in its health — "title
 * may not survive a restart" — rather than the session dying for want of a
 * metadata file.
 */

export interface StoredSession {
	version: 1;
	id: string;
	kind: FleetSessionKind;
	provider: FleetSessionProvider;
	cwd: string;
	title: string;
	startedAt: string;
	startedBy: FleetSessionStarter;
	cols: number;
	rows: number;
	endedAt: string | null;
	exitCode: number | null;
	endReason: FleetSessionEndedReason | null;
}

export interface LoadedSession {
	record: StoredSession;
	screen: string | null;
}

/** The file operations the store needs — injectable so a full disk can be simulated. */
export interface SessionStoreFs {
	mkdir(dir: string): Promise<void>;
	readdir(dir: string): Promise<string[]>;
	readFile(file: string): Promise<string | null>;
	writeFile(file: string, content: string): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	unlink(file: string): Promise<void>;
}

export const nodeSessionStoreFs: SessionStoreFs = {
	mkdir: async (dir) => {
		await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
	},
	readdir: async (dir) => {
		try {
			return await fsp.readdir(dir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
			throw error;
		}
	},
	readFile: async (file) => {
		try {
			return await fsp.readFile(file, 'utf8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
			throw error;
		}
	},
	writeFile: (file, content) => fsp.writeFile(file, content, { encoding: 'utf8', mode: 0o600 }),
	rename: (from, to) => fsp.rename(from, to),
	unlink: async (file) => {
		try {
			await fsp.unlink(file);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		}
	}
};

/** Parse a stored record; null for anything that is not one (a foreign or corrupted file is skipped). */
export function parseStoredSession(raw: string | null): StoredSession | null {
	if (!raw) return null;
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof value !== 'object' || value === null) return null;
	const record = value as Record<string, unknown>;
	if (record.version !== 1 || !isFleetDaemonSessionId(record.id)) return null;
	if (!isFleetSessionKind(record.kind) || !isFleetSessionProvider(record.provider)) return null;
	if (typeof record.cwd !== 'string' || typeof record.title !== 'string') return null;
	if (typeof record.startedAt !== 'string' || !isFleetSessionStarter(record.startedBy)) return null;
	const size = clampFleetSessionSize(record.cols, record.rows);
	return {
		version: 1,
		id: record.id,
		kind: record.kind,
		provider: record.provider,
		cwd: record.cwd,
		title: record.title,
		startedAt: record.startedAt,
		startedBy: record.startedBy,
		cols: size.cols,
		rows: size.rows,
		endedAt: typeof record.endedAt === 'string' ? record.endedAt : null,
		exitCode: typeof record.exitCode === 'number' && Number.isInteger(record.exitCode) ? record.exitCode : null,
		endReason: isFleetSessionEndedReason(record.endReason) ? record.endReason : null
	};
}

export class SessionStore {
	private readonly dir: string;
	private failing = false;
	private ready: Promise<void> | null = null;

	constructor(
		stateDir: string,
		private readonly fs: SessionStoreFs = nodeSessionStoreFs
	) {
		this.dir = path.join(stateDir, 'records');
	}

	/** `failing` once a write failed, until the next write succeeds. */
	get storage(): 'ok' | 'failing' {
		return this.failing ? 'failing' : 'ok';
	}

	/** Every stored session with its last screen. Unreadable files are skipped. */
	async load(): Promise<LoadedSession[]> {
		await this.ensureDir();
		let names: string[];
		try {
			names = await this.fs.readdir(this.dir);
		} catch {
			return [];
		}
		const out: LoadedSession[] = [];
		for (const name of names.sort()) {
			if (!name.endsWith('.json')) continue;
			const id = name.slice(0, -'.json'.length);
			if (!isFleetDaemonSessionId(id)) continue;
			let record: StoredSession | null = null;
			let screen: string | null = null;
			try {
				record = parseStoredSession(await this.fs.readFile(path.join(this.dir, name)));
				screen = await this.fs.readFile(path.join(this.dir, `${id}.screen`));
			} catch {
				record = null;
			}
			if (record && record.id === id) out.push({ record, screen });
		}
		return out;
	}

	/** Write a record atomically. False (and `failing`) when it could not be written. */
	save(record: StoredSession): Promise<boolean> {
		return this.writeAtomic(`${record.id}.json`, `${JSON.stringify(record)}\n`);
	}

	saveScreen(id: string, text: string): Promise<boolean> {
		return this.writeAtomic(`${id}.screen`, text);
	}

	/** Forget an ended session the platform acknowledged. */
	async forget(id: string): Promise<void> {
		if (!isFleetDaemonSessionId(id)) return;
		for (const name of [`${id}.json`, `${id}.screen`]) {
			try {
				await this.fs.unlink(path.join(this.dir, name));
			} catch {
				// best effort: a leftover file is re-reported and re-acknowledged
			}
		}
	}

	private ensureDir(): Promise<void> {
		this.ready ??= this.fs.mkdir(this.dir).catch(() => {
			this.ready = null;
		});
		return this.ready;
	}

	private async writeAtomic(name: string, content: string): Promise<boolean> {
		const target = path.join(this.dir, name);
		const temp = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`;
		try {
			await this.ensureDir();
			await this.fs.writeFile(temp, content);
			await this.fs.rename(temp, target);
			this.failing = false;
			return true;
		} catch {
			this.failing = true;
			try {
				await this.fs.unlink(temp);
			} catch {
				// nothing to clean
			}
			return false;
		}
	}
}
