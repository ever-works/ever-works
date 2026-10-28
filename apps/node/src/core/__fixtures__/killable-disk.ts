import type { ConfigFileSystem } from '../config-store';

/**
 * An in-memory disk that can be KILLED, for the atomic-write specs
 * (2026-10-28 incident: a node force-stopped while it rewrote its config
 * left `node-config.json` at 0 bytes).
 *
 * Once a kill point is hit, the operation in progress never settles and
 * neither does any later one: exactly what `Stop-Process -Force` does to a
 * pending write. A `partial` kill first lands half of the content, the way
 * a write cut short does. The `files` map outlives the kill, so a spec can
 * "restart" by building a new disk over the same map.
 *
 * It also models what the atomic writer must preserve: every file carries
 * a POSIX `mode` and a Windows ACL state, both set at creation and MOVED by
 * a rename (NTFS keeps the moved file's own security descriptor; POSIX
 * keeps its inode's mode). `link` shares the file, so its state too.
 */
export interface DiskOp {
	op: 'create' | 'write' | 'writeInPlace' | 'restrict' | 'chmod' | 'rename' | 'link' | 'remove' | 'mkdir' | 'syncDir';
	path: string;
	to?: string;
	content?: string;
	mode?: number;
}

export type KillPoint = (op: DiskOp) => 'kill' | 'partial' | null;

export interface KillableDisk {
	fs: ConfigFileSystem;
	files: Map<string, string>;
	mtimes: Map<string, number>;
	ops: DiskOp[];
	/** Windows: `owner-only` once `restrict` ran on the file (under any of its names). */
	acl: Map<string, 'inherited' | 'owner-only'>;
	/** POSIX mode bits. */
	modes: Map<string, number>;
	readonly killed: boolean;
	killAt(point: KillPoint): void;
	/** The next renames reject with these error codes, in order. */
	failRenames(...codes: string[]): void;
	/** The next links reject with these error codes, in order. */
	failLinks(...codes: string[]): void;
	failRestrict(error: Error | null): void;
	/** Paths currently ending in `.tmp`. */
	temps(): string[];
}

export interface KillableDiskOptions {
	files?: Map<string, string>;
	mtimes?: Map<string, number>;
	now?: () => number;
	/** Leave out the atomic-write primitives, like an older test double. */
	legacy?: boolean;
}

const never = (): Promise<never> => new Promise<never>(() => undefined);

function errno(code: string): Error {
	return Object.assign(new Error(`${code}: simulated`), { code });
}

export function killableDisk(initial: Record<string, string> = {}, options: KillableDiskOptions = {}): KillableDisk {
	const files = options.files ?? new Map(Object.entries(initial));
	const mtimes = options.mtimes ?? new Map<string, number>();
	const now = options.now ?? (() => Date.now());
	const ops: DiskOp[] = [];
	const acl = new Map<string, 'inherited' | 'owner-only'>();
	const modes = new Map<string, number>();
	const renameFailures: string[] = [];
	const linkFailures: string[] = [];
	let restrictFailure: Error | null = null;
	let killPoint: KillPoint | null = null;
	let killed = false;
	for (const path of files.keys()) {
		acl.set(path, 'owner-only');
		modes.set(path, 0o600);
	}

	const dirname = (filePath: string): string => filePath.replace(/[\\/][^\\/]*$/, '');
	const touch = (path: string): void => void mtimes.set(path, now());

	const step = async (op: DiskOp, apply: () => void): Promise<void> => {
		if (killed) return never();
		ops.push(op);
		const verdict = killPoint?.(op) ?? null;
		if (verdict) {
			killed = true;
			if (verdict === 'partial' && op.content !== undefined) {
				files.set(op.path, op.content.slice(0, Math.floor(op.content.length / 2)));
				touch(op.path);
			}
			return never();
		}
		apply();
	};

	const fs: ConfigFileSystem = {
		readFile: async (filePath) => files.get(filePath) ?? null,
		// The in-place write: truncate, then write. What a kill used to tear.
		writeFile: (filePath, content) =>
			step({ op: 'writeInPlace', path: filePath, content }, () => {
				if (!files.has(filePath)) {
					acl.set(filePath, 'inherited');
					modes.set(filePath, 0o600);
				}
				files.set(filePath, content);
				touch(filePath);
			}),
		createFileExclusive: (filePath, content) =>
			step({ op: 'create', path: filePath, content }, () => {
				if (files.has(filePath)) throw errno('EEXIST');
				files.set(filePath, content);
				acl.set(filePath, 'inherited');
				modes.set(filePath, 0o600);
				touch(filePath);
			}),
		mkdir: (dirPath) => step({ op: 'mkdir', path: dirPath }, () => undefined),
		chmod: (filePath, mode) =>
			step({ op: 'chmod', path: filePath, mode }, () => {
				modes.set(filePath, mode);
			}),
		restrict: (filePath) =>
			step({ op: 'restrict', path: filePath }, () => {
				if (restrictFailure) throw restrictFailure;
				acl.set(filePath, 'owner-only');
			}),
		remove: (filePath) =>
			step({ op: 'remove', path: filePath }, () => {
				files.delete(filePath);
				acl.delete(filePath);
				modes.delete(filePath);
			}),
		dirname
	};

	if (!options.legacy) {
		fs.writeExistingFile = (filePath, content) => {
			const text = typeof content === 'string' ? content : new TextDecoder().decode(content);
			return step({ op: 'write', path: filePath, content: text }, () => {
				if (!files.has(filePath)) throw errno('ENOENT');
				files.set(filePath, text);
				touch(filePath);
			});
		};
		fs.rename = (from, to) =>
			step({ op: 'rename', path: from, to }, () => {
				const code = renameFailures.shift();
				if (code) throw errno(code);
				if (!files.has(from)) throw errno('ENOENT');
				files.set(to, files.get(from)!);
				acl.set(to, acl.get(from) ?? 'inherited');
				modes.set(to, modes.get(from) ?? 0o600);
				mtimes.set(to, mtimes.get(from) ?? now());
				files.delete(from);
				acl.delete(from);
				modes.delete(from);
			});
		fs.link = (existing, newPath) =>
			step({ op: 'link', path: existing, to: newPath }, () => {
				const code = linkFailures.shift();
				if (code) throw errno(code);
				if (files.has(newPath)) throw errno('EEXIST');
				files.set(newPath, files.get(existing)!);
				acl.set(newPath, acl.get(existing) ?? 'inherited');
				modes.set(newPath, modes.get(existing) ?? 0o600);
				touch(newPath);
			});
		fs.syncDirectory = (dirPath) => step({ op: 'syncDir', path: dirPath }, () => undefined);
		fs.readDirectory = async (dirPath) =>
			[...files.keys()].filter((path) => dirname(path) === dirPath).map((path) => path.slice(dirPath.length + 1));
		fs.modifiedAtMs = async (filePath) => (files.has(filePath) ? (mtimes.get(filePath) ?? now()) : null);
	}

	return {
		fs,
		files,
		mtimes,
		ops,
		acl,
		modes,
		get killed() {
			return killed;
		},
		killAt: (point) => void (killPoint = point),
		failRenames: (...codes) => void renameFailures.push(...codes),
		failLinks: (...codes) => void linkFailures.push(...codes),
		failRestrict: (error) => void (restrictFailure = error),
		temps: () => [...files.keys()].filter((path) => path.endsWith('.tmp'))
	};
}
