import { constants as fsConstants, promises as fs, type Stats } from 'fs';
import type { FleetFileEntryKind } from '@ever-works/contracts';
import type { RootsFs } from '../../allowed-roots';

/**
 * Files on computers (FL-11) — the few filesystem calls the `files` module
 * makes, behind one seam so the specs drive real temporary folders (or a fake)
 * without touching the module. No shell-out anywhere (plan §6.2): every call
 * is `fs`.
 */

export interface FilesStat {
	kind: FleetFileEntryKind;
	size: number;
	mtimeMs: number;
	/** POSIX permission bits (`& 0o777`). */
	mode: number;
}

export interface FilesWriter {
	write(bytes: Uint8Array): Promise<void>;
	close(): Promise<void>;
}

export interface FilesIo extends RootsFs {
	readonly platform: string;
	readonly homedir: string;
	/** Does not follow a link (the entry itself). */
	lstat(path: string): Promise<FilesStat>;
	/** Follows links. */
	stat(path: string): Promise<FilesStat>;
	readdir(path: string): Promise<string[]>;
	/**
	 * A file's bytes in chunks of at most `chunkBytes`. Refuses (POSIX) when
	 * the path became a link after it was checked (`O_NOFOLLOW`).
	 */
	readChunks(path: string, chunkBytes: number, signal: AbortSignal): AsyncIterable<Uint8Array>;
	/** `mkdir -p`. */
	mkdir(path: string): Promise<void>;
	/** A NEW file (exclusive create — a partial folder is always fresh). */
	createWriter(path: string, mode: number): Promise<FilesWriter>;
	symlink(target: string, path: string, kind: 'file' | 'dir'): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	/** Recursive and forceful; removes a link, never its target. */
	remove(path: string): Promise<void>;
	setTimes(path: string, mtimeMs: number): Promise<void>;
	chmod(path: string, mode: number): Promise<void>;
}

function kindOf(stat: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): FleetFileEntryKind {
	if (stat.isSymbolicLink()) return 'link';
	if (stat.isDirectory()) return 'folder';
	if (stat.isFile()) return 'file';
	return 'other';
}

function describe(stat: Stats): FilesStat {
	const kind = kindOf(stat);
	return { kind, size: kind === 'file' ? stat.size : 0, mtimeMs: stat.mtimeMs, mode: stat.mode & 0o777 };
}

export function createNodeFilesIo(input: { platform: string; homedir: string }): FilesIo {
	const noFollow =
		input.platform !== 'win32' && typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
	return {
		platform: input.platform,
		homedir: input.homedir,
		realpath: (path) => fs.realpath(path),
		lstat: async (path) => describe(await fs.lstat(path)),
		stat: async (path) => describe(await fs.stat(path)),
		readdir: (path) => fs.readdir(path),
		readChunks: async function* (path, chunkBytes, signal) {
			const handle = await fs.open(path, fsConstants.O_RDONLY | noFollow);
			try {
				let position = 0;
				while (!signal.aborted) {
					const buffer = Buffer.allocUnsafe(chunkBytes);
					const { bytesRead } = await handle.read(buffer, 0, chunkBytes, position);
					if (bytesRead === 0) return;
					position += bytesRead;
					yield new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead);
				}
			} finally {
				await handle.close().catch(() => undefined);
			}
		},
		mkdir: async (path) => {
			await fs.mkdir(path, { recursive: true });
		},
		createWriter: async (path, mode) => {
			const handle = await fs.open(path, 'wx', input.platform === 'win32' ? undefined : mode & 0o777 || 0o644);
			return {
				write: async (bytes) => {
					let offset = 0;
					while (offset < bytes.byteLength) {
						const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset);
						offset += bytesWritten;
					}
				},
				close: () => handle.close()
			};
		},
		symlink: (target, path, kind) => fs.symlink(target, path, input.platform === 'win32' ? kind : undefined),
		rename: (from, to) => fs.rename(from, to),
		remove: (path) => fs.rm(path, { recursive: true, force: true, maxRetries: 2 }),
		setTimes: async (path, mtimeMs) => {
			const when = new Date(mtimeMs);
			await fs.utimes(path, when, when);
		},
		chmod: async (path, mode) => {
			if (input.platform === 'win32') return; // ACLs are inherited from the destination folder (plan §6.2)
			await fs.chmod(path, mode & 0o777);
		}
	};
}
