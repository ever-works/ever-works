/**
 * Atomic replacement of the files the node keeps beside its config.
 *
 * 2026-10-28 incident: `node-config.json` was rewritten IN PLACE (truncate,
 * then write). A node force-stopped between the two was left with a 0-byte
 * config, which reads as "not enrolled", and the node could not start. With
 * the credential inline (`secretStorage: 'file'`) the machine would have had
 * to re-enroll.
 *
 * {@link replaceFileAtomically} never touches the target until the new
 * content is complete and on disk:
 *
 *   1. create `<file>.<pid>.<random>.tmp` in the SAME directory (a rename
 *      only replaces atomically within one volume), exclusively and EMPTY,
 *      owner-only (0600) from birth on POSIX;
 *   2. `tighten` it (the owner-only ACL on Windows, the final mode on
 *      POSIX) while it still holds NOTHING. On Windows a new file starts
 *      with whatever ACL it inherits from the directory, so this ordering is
 *      what keeps a credential from sitting in a more widely readable file,
 *      even briefly;
 *   3. write the content into that existing file and flush it to disk;
 *   4. rename it over the target, retried briefly while Windows reports the
 *      target busy (another process holding it open), then flush the
 *      directory entry on POSIX.
 *
 * A kill at any step leaves the previous file whole. The most it leaves
 * behind is a stray temp file, which nothing reads as state and
 * {@link sweepStaleTempFiles} removes. A rename keeps the moved file's own
 * permissions: its mode on POSIX, and on NTFS its security descriptor, which
 * the ACL step made explicit (`/inheritance:r`). So the renamed file keeps
 * the owner-only ACL the temp file was given.
 *
 * Builtin-free, like `config-store`: every filesystem call is injected, so
 * specs can interrupt the sequence at any step.
 */

/** The primitives an atomic replace needs. `createConfigFileSystem` supplies all of them. */
export interface AtomicFileOps {
	/** Create a NEW owner-only (0600) file with `content`; reject (`EEXIST`) rather than overwrite. */
	createFileExclusive(filePath: string, content: string): Promise<void>;
	/** Write into an EXISTING file (never creating one) and flush it to stable storage before resolving. */
	writeExistingFile(filePath: string, content: string | Uint8Array): Promise<void>;
	/** Rename `from` over `to`, replacing it. */
	rename(from: string, to: string): Promise<void>;
	/** Remove a file. Missing is success. */
	remove(filePath: string): Promise<void>;
	/** Flush a directory's entries to disk (POSIX). Best-effort. */
	syncDirectory?(dirPath: string): Promise<void>;
	dirname?(filePath: string): string;
}

/** {@link AtomicFileOps} plus an exclusive hard link, for publishing a file that must not replace another. */
export interface ExclusiveAtomicFileOps extends AtomicFileOps {
	/** Create `newPath` as another name for `existing`; reject (`EEXIST`) when `newPath` exists. */
	link(existing: string, newPath: string): Promise<void>;
}

export interface ReplaceFileOptions {
	/** `process.platform`: decides which rename errors are worth retrying, and whether the directory is flushed. */
	platform?: string;
	/**
	 * Make the EMPTY temp file owner-only before any content reaches it. A
	 * rejection aborts the write: the temp is removed and the target is
	 * untouched.
	 */
	tighten?: (tempPath: string) => Promise<void>;
	/** Pauses between rename attempts. Defaults to {@link RENAME_RETRY_DELAYS_MS}. */
	renameRetryDelaysMs?: readonly number[];
	sleep?: (ms: number) => Promise<void>;
	/** The unique part of the temp name. Defaults to `<pid>.<12 hex>`. */
	tempTag?: () => string;
}

/**
 * Pauses before each rename RETRY (at most ~2.3 s in all). Windows refuses to
 * replace a file another process holds open without delete sharing (a
 * scanner, an indexer, an editor), and such a hold is normally brief. One
 * that outlasts this is reported rather than waited out.
 */
export const RENAME_RETRY_DELAYS_MS: readonly number[] = Object.freeze([25, 50, 100, 200, 400, 500, 500, 500]);

/**
 * A stray temp file older than this is removed on load. Younger ones may
 * belong to a write still in flight in another process (the CLI's `pause`
 * while the service runs): the Windows ACL step alone can take up to 107 s
 * on a busy machine (`OWNER_ONLY_ACL_RETRY_POLICY`).
 */
export const STALE_TEMP_FILE_AGE_MS = 5 * 60_000;

const TEMP_SUFFIX = /\.\d+\.[0-9a-f]{12}\.tmp$/;

/** `<file>.<tag>.tmp`, beside the file. */
export function tempFilePathFor(filePath: string, tag: string): string {
	return `${filePath}.${tag}.tmp`;
}

/**
 * True for a temp file this module made for `baseName` or any file named
 * after it (`node-config.json.lifecycle.json.<pid>.<hex>.tmp`). Nothing else
 * matches, so a sweep never touches another component's files, even when
 * the config was pointed into a shared directory.
 */
export function isTempFileFor(name: string, baseName: string): boolean {
	return name.startsWith(`${baseName}.`) && TEMP_SUFFIX.test(name);
}

function defaultTempTag(): string {
	const pid = typeof process !== 'undefined' && typeof process.pid === 'number' ? process.pid : 0;
	let hex = '';
	while (hex.length < 12)
		hex += Math.floor(Math.random() * 0x100000000)
			.toString(16)
			.padStart(8, '0');
	return `${pid}.${hex.slice(0, 12)}`;
}

function defaultPlatform(): string {
	return typeof process !== 'undefined' ? process.platform : '';
}

function errorCode(error: unknown): string | undefined {
	return error && typeof error === 'object' ? (error as { code?: string }).code : undefined;
}

/**
 * Whether a failed rename is worth another attempt. `EBUSY` means "in use"
 * everywhere. On Windows a file held open without delete sharing also
 * surfaces as `EPERM` or `EACCES`; on POSIX those are real permission
 * answers, and retrying them would only delay the error.
 */
export function isRetryableRenameError(error: unknown, platform: string): boolean {
	const code = errorCode(error);
	if (code === 'EBUSY') return true;
	return platform === 'win32' && (code === 'EPERM' || code === 'EACCES');
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Create the empty, owner-only temp file, picking a fresh name if one is taken. */
async function createTemp(ops: AtomicFileOps, filePath: string, options: ReplaceFileOptions): Promise<string> {
	const tag = options.tempTag ?? defaultTempTag;
	for (let attempt = 0; ; attempt++) {
		const tempPath = tempFilePathFor(filePath, tag());
		try {
			await ops.createFileExclusive(tempPath, '');
			return tempPath;
		} catch (error) {
			if (errorCode(error) !== 'EEXIST' || attempt >= 4) throw error;
		}
	}
}

/** Steps 1–3: an owner-only, flushed temp file holding `content`. Removed again if any step fails. */
async function stageTemp(
	ops: AtomicFileOps,
	filePath: string,
	content: string | Uint8Array,
	options: ReplaceFileOptions
): Promise<string> {
	const tempPath = await createTemp(ops, filePath, options);
	try {
		if (options.tighten) await options.tighten(tempPath);
		await ops.writeExistingFile(tempPath, content);
		return tempPath;
	} catch (error) {
		await ops.remove(tempPath).catch(() => undefined);
		throw error;
	}
}

async function renameWithRetry(
	ops: AtomicFileOps,
	from: string,
	to: string,
	options: ReplaceFileOptions
): Promise<void> {
	const platform = options.platform ?? defaultPlatform();
	const delays = options.renameRetryDelaysMs ?? RENAME_RETRY_DELAYS_MS;
	const sleep = options.sleep ?? realSleep;
	for (let attempt = 0; ; attempt++) {
		try {
			await ops.rename(from, to);
			return;
		} catch (error) {
			if (attempt >= delays.length || !isRetryableRenameError(error, platform)) throw error;
			await sleep(delays[attempt]);
		}
	}
}

async function syncParent(ops: AtomicFileOps, filePath: string, options: ReplaceFileOptions): Promise<void> {
	// Windows cannot open a directory to flush it; NTFS journals the rename.
	if ((options.platform ?? defaultPlatform()) === 'win32' || !ops.syncDirectory || !ops.dirname) return;
	await ops.syncDirectory(ops.dirname(filePath)).catch(() => undefined);
}

/**
 * Replace `filePath` with `content` so that a crash at any point leaves
 * either the old file or the new one, never a torn mix (see the module
 * comment for the sequence). Rejects, with the target untouched and the
 * temp removed, when any step fails for good.
 */
export async function replaceFileAtomically(
	ops: AtomicFileOps,
	filePath: string,
	content: string | Uint8Array,
	options: ReplaceFileOptions = {}
): Promise<void> {
	const tempPath = await stageTemp(ops, filePath, content, options);
	try {
		await renameWithRetry(ops, tempPath, filePath, options);
	} catch (error) {
		await ops.remove(tempPath).catch(() => undefined);
		throw error;
	}
	await syncParent(ops, filePath, options);
}

/**
 * Publish `filePath` with `content` ONLY if it does not exist yet, complete
 * when it appears: the temp file is staged exactly as for
 * {@link replaceFileAtomically}, then hard-linked into place (which, unlike
 * a rename, refuses an existing target) and its temp name removed.
 *
 * Rejects with the link's error: `EEXIST` when another process published
 * first, or whatever a filesystem without hard links answers (the caller
 * decides whether to fall back). The temp file is removed in every case.
 */
export async function publishFileExclusively(
	ops: ExclusiveAtomicFileOps,
	filePath: string,
	content: string | Uint8Array,
	options: ReplaceFileOptions = {}
): Promise<void> {
	const tempPath = await stageTemp(ops, filePath, content, options);
	try {
		await ops.link(tempPath, filePath);
	} finally {
		await ops.remove(tempPath).catch(() => undefined);
	}
	await syncParent(ops, filePath, options);
}

/** What {@link sweepStaleTempFiles} needs: a directory listing and modification times. */
export interface TempSweepOps {
	readDirectory?(dirPath: string): Promise<string[]>;
	modifiedAtMs?(filePath: string): Promise<number | null>;
	remove?(filePath: string): Promise<void>;
	dirname(filePath: string): string;
}

/**
 * Remove temp files a killed write left beside `filePath` (its own and those
 * of every file named after it). Only files older than `olderThanMs` go, so
 * another process's write in flight is left alone. Best-effort: never
 * throws, and a filesystem without a listing simply keeps its strays, which
 * nothing reads anyway.
 */
export async function sweepStaleTempFiles(
	ops: TempSweepOps,
	filePath: string,
	options: { now?: number; olderThanMs?: number } = {}
): Promise<string[]> {
	if (!ops.readDirectory || !ops.remove) return [];
	const dir = ops.dirname(filePath);
	const baseName = filePath.slice(dir.length).replace(/^[\\/]+/, '');
	if (!baseName) return [];
	const now = options.now ?? Date.now();
	const olderThanMs = options.olderThanMs ?? STALE_TEMP_FILE_AGE_MS;
	const removed: string[] = [];
	let names: string[];
	try {
		names = await ops.readDirectory(dir);
	} catch {
		return [];
	}
	for (const name of names) {
		if (!isTempFileFor(name, baseName)) continue;
		const tempPath = `${filePath.slice(0, filePath.length - baseName.length)}${name}`;
		try {
			if (olderThanMs > 0) {
				const modified = ops.modifiedAtMs ? await ops.modifiedAtMs(tempPath) : null;
				if (modified === null || now - modified < olderThanMs) continue;
			}
			await ops.remove(tempPath);
			removed.push(tempPath);
		} catch {
			// Best-effort: a temp that cannot be removed now is tried again on the next load.
		}
	}
	return removed;
}
