import { createReadStream, createWriteStream, promises as fsp, type ReadStream, type WriteStream } from 'fs';
import * as path from 'path';
import { FLEET_COMMAND_KEPT_RUNS_ON_NODE, isFleetCommandId } from '@ever-works/contracts';

/**
 * Commands on computers (FL-12, spec FR-6) — the full output of the last 30
 * runs, kept on the machine so "Open full output" can fetch it while the
 * machine is online: `<configDir>/commands/<runId>.log`, owner-only (`0700`
 * folder, `0600` files — on Windows the folder inherits the config folder's
 * owner-only ACL), the oldest deleted first once there are more than 30.
 *
 * The platform keeps only the first and last 64 KiB; nothing here leaves the
 * machine except through the `command` family's own request (P2).
 */

export interface CommandOutputWriter {
	write(chunk: Uint8Array): void;
	/** Flush and close; resolves even when a write failed (the run is not failed by its log). */
	close(): Promise<void>;
}

export interface CommandOutputStoreOptions {
	dir: string;
	keep?: number;
}

export class CommandOutputStore {
	private readonly keep: number;
	private ready: Promise<void> | null = null;

	constructor(private readonly options: CommandOutputStoreOptions) {
		this.keep = Math.max(1, Math.floor(options.keep ?? FLEET_COMMAND_KEPT_RUNS_ON_NODE));
	}

	get dir(): string {
		return this.options.dir;
	}

	/** Where a run's output lives, or null for an id that is not one (never a path from the wire). */
	pathFor(runId: string): string | null {
		if (!isFleetCommandId(runId)) return null;
		return path.join(this.options.dir, `${runId.toLowerCase()}.log`);
	}

	/** A writer for one run's output. Rejects when the folder or file cannot be created. */
	async open(runId: string): Promise<CommandOutputWriter> {
		const file = this.pathFor(runId);
		if (!file) throw new Error('not a run id');
		await this.ensureDir();
		const stream: WriteStream = createWriteStream(file, { flags: 'w', mode: 0o600 });
		let failed = false;
		stream.on('error', () => {
			failed = true;
		});
		return {
			write(chunk) {
				if (failed || stream.destroyed) return;
				stream.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
			},
			close() {
				return new Promise<void>((resolve) => {
					if (stream.destroyed) {
						resolve();
						return;
					}
					stream.end(() => resolve());
					stream.once('error', () => resolve());
				});
			}
		};
	}

	/** True when the machine still holds this run's output. */
	async has(runId: string): Promise<boolean> {
		const file = this.pathFor(runId);
		if (!file) return false;
		try {
			return (await fsp.stat(file)).isFile();
		} catch {
			return false;
		}
	}

	/** The size of one run's kept output in bytes (0 when it is gone). */
	async size(runId: string): Promise<number> {
		const file = this.pathFor(runId);
		if (!file) return 0;
		try {
			return (await fsp.stat(file)).size;
		} catch {
			return 0;
		}
	}

	/** A stream of one run's output (P2 "Open full output"), or null when it is gone. */
	async read(runId: string): Promise<ReadStream | null> {
		if (!(await this.has(runId))) return null;
		const file = this.pathFor(runId);
		return file ? createReadStream(file) : null;
	}

	/** Keep the newest `keep` runs; delete the rest, oldest first. Never throws. */
	async prune(): Promise<void> {
		let names: string[];
		try {
			names = (await fsp.readdir(this.options.dir)).filter((name) => /^[0-9a-f-]{36}\.log$/.test(name));
		} catch {
			return;
		}
		if (names.length <= this.keep) return;
		const entries: Array<{ name: string; at: number }> = [];
		for (const name of names) {
			try {
				entries.push({ name, at: (await fsp.stat(path.join(this.options.dir, name))).mtimeMs });
			} catch {
				// gone meanwhile
			}
		}
		entries.sort((a, b) => b.at - a.at);
		for (const entry of entries.slice(this.keep)) {
			await fsp.rm(path.join(this.options.dir, entry.name), { force: true }).catch(() => undefined);
		}
	}

	private ensureDir(): Promise<void> {
		this.ready ??= fsp
			.mkdir(this.options.dir, { recursive: true, mode: 0o700 })
			.then(() => undefined)
			.catch((error: unknown) => {
				this.ready = null;
				throw error;
			});
		return this.ready;
	}
}
