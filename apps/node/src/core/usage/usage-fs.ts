import { constants as fsConstants, existsSync, promises as fsp } from 'node:fs';

/**
 * Usage & cost on the fleet (FL-20) — the filesystem seam the transcript scan
 * reads through. Read-only on every record file (opened `O_RDONLY`, never
 * written); the scan's own state lives in the node's config folder.
 * Injected so the specs drive symlinks, truncation and huge files without a
 * real disk.
 */

export interface UsageDirEntry {
	name: string;
	isFile(): boolean;
	isDirectory(): boolean;
	isSymbolicLink(): boolean;
}

export interface UsageFileStat {
	size: number;
	mtimeMs: number;
	isFile(): boolean;
	isDirectory(): boolean;
	isSymbolicLink(): boolean;
}

/** An open record file: read `length` bytes at `position` into a fresh buffer. */
export interface UsageReadHandle {
	read(length: number, position: number): Promise<Buffer>;
	close(): Promise<void>;
}

export interface UsageFs {
	readdir(dir: string): Promise<UsageDirEntry[]>;
	/** Like `lstat`: a symbolic link is reported as one, never followed. */
	lstat(path: string): Promise<UsageFileStat>;
	realpath(path: string): Promise<string>;
	exists(path: string): boolean;
	openRead(path: string): Promise<UsageReadHandle>;
	readFile(path: string): Promise<string | null>;
	/** Atomic owner-only write (temp file + rename). */
	writeFileAtomic(path: string, content: string): Promise<void>;
	mkdir(dir: string): Promise<void>;
}

export const nodeUsageFs: UsageFs = {
	readdir: async (dir) => (await fsp.readdir(dir, { withFileTypes: true })) as unknown as UsageDirEntry[],
	lstat: (path) => fsp.lstat(path),
	realpath: (path) => fsp.realpath(path),
	exists: (path) => {
		try {
			return existsSync(path);
		} catch {
			return false;
		}
	},
	openRead: async (path) => {
		const handle = await fsp.open(path, fsConstants.O_RDONLY);
		return {
			read: async (length, position) => {
				const buffer = Buffer.allocUnsafe(length);
				const { bytesRead } = await handle.read(buffer, 0, length, position);
				return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
			},
			close: () => handle.close()
		};
	},
	readFile: async (path) => {
		try {
			return await fsp.readFile(path, 'utf8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
			throw error;
		}
	},
	writeFileAtomic: async (path, content) => {
		const temp = `${path}.${process.pid}.tmp`;
		await fsp.writeFile(temp, content, { encoding: 'utf8', mode: 0o600 });
		await fsp.rename(temp, path);
		await fsp.chmod(path, 0o600).catch(() => undefined);
	},
	mkdir: async (dir) => {
		await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
	}
};
