import { constants as fsConstants, promises as fs } from 'node:fs';
import { join } from 'node:path';
import {
	FLEET_AGENT_TASK_META_DIR,
	FLEET_AGENT_TASK_QUESTION_FILE,
	FLEET_AGENT_TASK_QUESTION_MAX_FILE_BYTES,
	parseFleetAgentTaskQuestionMarkdown,
	type FleetAgentTaskQuestion
} from '@ever-works/contracts';

/**
 * The owner-question file — how a model running on a fleet node asks the
 * Task owner something (self-build slice Q).
 *
 * ## Why the node reads it
 *
 * A fleet run is a model CLI in a worktree on the owner's own machine: no
 * platform credentials, no platform tools. The only channel it has back to
 * the platform is the working tree, and only the node ever sees that tree.
 * So the protocol is a file: the model writes `.ever-works/QUESTION.md`
 * (first non-empty line = the question, the rest = context) and stops; the
 * node reads it after the model step, removes it, and reports it as
 * `FleetAgentTaskResult.question`. Everything after that — parking the run,
 * filing the Inbox item, delivering the answer to the next run — happens
 * on the platform.
 *
 * ## Why removal happens BEFORE finalize
 *
 * The finalize is `git add -A` + commit + push. A question file left in the
 * tree would become part of the Task branch and of the pull request. The
 * node removes it (and the directory when that leaves it empty) before any
 * Git command runs, and the provisioner ALSO excludes `/.ever-works/` from
 * every repository's view — belt and braces, because a file that reaches
 * the owner's repository is a bug the owner sees.
 *
 * ## Why writable mounts are scanned too
 *
 * With multi-repo workspaces the model may spend its whole turn under
 * `.mounts/<dir>` and plausibly writes the file where it is working. The
 * exclude rule keeps such a file out of Git, but only this scan gets it to
 * the owner. The primary wins when both exist; every file found is removed.
 *
 * ## Why a pre-model discard exists
 *
 * The provisioner reuses a task worktree IN PLACE with no clean ("resume in
 * place, no re-clone" in the local-workspace plugin), so a file left by an
 * aborted or crashed attempt — or by the previous run, whose question the
 * owner has since answered — would otherwise be reported as a fresh
 * question, or read by the model as context. Only a file written by THIS
 * run counts.
 */

/** Filesystem seam for the question file; defaults to `node:fs`. */
export interface AgentTaskQuestionFs {
	/**
	 * First `maxBytes` bytes decoded as UTF-8; `null` when NOTHING is at the
	 * path. Rejects (code `EFTYPE`) when something is there that is not a
	 * regular file — a symlink, a directory, a FIFO — so the caller can
	 * treat it as "present but unreadable" and still remove it.
	 */
	readHead(path: string, maxBytes: number): Promise<string | null>;
	/** Remove one file; absent is fine. */
	remove(path: string): Promise<void>;
	/** rmdir only when empty; ENOENT / ENOTEMPTY / EEXIST are fine. */
	removeDirIfEmpty(path: string): Promise<void>;
}

/** One place the question file may be: the primary worktree or a writable mount. */
export interface AgentTaskQuestionMount {
	mountDir: string;
	path: string;
	writable: boolean;
}

export interface CollectOwnerQuestionInput {
	/** The primary worktree root (the path the model was told is the repository root). */
	primaryPath: string;
	/** Mounted repositories of the workspace; only writable ones are scanned. */
	mounts?: readonly AgentTaskQuestionMount[];
}

/**
 * Production filesystem: lstat-gated, bounded read; forced single-file
 * remove; empty-only rmdir.
 *
 * WHY the lstat gate (review SR-1): `open()` follows symlinks, so a
 * `.ever-works/QUESTION.md -> <any readable file>` planted by a
 * prompt-injected model would have been reported verbatim as the
 * question — up to 64 KiB of whatever the link points at. Worse, on a
 * POSIX node `open()` on a FIFO (`mkfifo`) or a link to `/dev/tty` blocks
 * until a writer appears, and no abort signal reaches a blocked syscall:
 * the job would sit until the lease budget ran out and, at the default
 * concurrency of one, wedge the node until a restart. Only a regular,
 * non-symlink entry is ever opened; on POSIX the open itself also carries
 * `O_NOFOLLOW`, which closes the lstat → open window. Anything else that
 * IS at the path rejects with `EFTYPE`, so the caller still removes it
 * (`fs.rm` unlinks a link or a FIFO, never a target).
 */
export const defaultQuestionFs: AgentTaskQuestionFs = {
	readHead: async (path, maxBytes) => {
		let stats: Awaited<ReturnType<typeof fs.lstat>>;
		try {
			stats = await fs.lstat(path);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === 'ENOENT' || code === 'ENOTDIR') return null;
			throw error;
		}
		if (!stats.isFile()) throw notRegularFile(path, stats);
		let handle: Awaited<ReturnType<typeof fs.open>>;
		try {
			handle = await fs.open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === 'ENOENT' || code === 'ENOTDIR') return null;
			throw error;
		}
		try {
			// A bounded read, never `readFile`: the cap is what keeps an
			// enormous file from ever reaching the result (which the platform
			// would reject outright) or the node's memory.
			const buffer = Buffer.alloc(maxBytes);
			let total = 0;
			while (total < maxBytes) {
				const { bytesRead } = await handle.read(buffer, total, maxBytes - total, total);
				if (bytesRead === 0) break;
				total += bytesRead;
			}
			return buffer.subarray(0, total).toString('utf8');
		} finally {
			await handle.close();
		}
	},
	remove: (path) => fs.rm(path, { force: true }),
	removeDirIfEmpty: async (path) => {
		try {
			await fs.rmdir(path);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === 'ENOENT' || code === 'ENOTEMPTY' || code === 'EEXIST' || code === 'ENOTDIR') return;
			throw error;
		}
	}
};

/** The error `readHead` rejects with for an entry that exists but is not a regular file. */
function notRegularFile(path: string, stats: Awaited<ReturnType<typeof fs.lstat>>): NodeJS.ErrnoException {
	const kind = stats.isSymbolicLink()
		? 'a symbolic link'
		: stats.isDirectory()
			? 'a directory'
			: stats.isFIFO()
				? 'a FIFO'
				: 'not a regular file';
	const error = new Error(`Owner-question file ${path} is ${kind}; refusing to read it`) as NodeJS.ErrnoException;
	error.code = 'EFTYPE';
	return error;
}

/** OS path of the question file inside a worktree; the contracts own the name. */
export function ownerQuestionPath(workspacePath: string): string {
	return join(workspacePath, ...FLEET_AGENT_TASK_QUESTION_FILE.split('/'));
}

function ownerQuestionDir(workspacePath: string): string {
	return join(workspacePath, FLEET_AGENT_TASK_META_DIR);
}

/**
 * Remove a stale question file (and its directory when that leaves it
 * empty) BEFORE the model runs. Best-effort: every filesystem error is
 * swallowed — a stale file the node cannot remove is still excluded from
 * Git, and a model that then overwrites it produces a fresh one — except
 * an abort, which is the executor's to handle.
 */
export async function discardOwnerQuestion(
	workspacePath: string,
	questionFs: AgentTaskQuestionFs = defaultQuestionFs,
	signal?: AbortSignal
): Promise<void> {
	throwIfQuestionAborted(signal);
	await removeQuestionFile(workspacePath, questionFs);
}

/**
 * Read, parse and remove the question file the model may have written —
 * from the primary worktree first, then from every WRITABLE mount in spec
 * order. Returns the first question parsed (the primary wins); every file
 * found is removed regardless, a blank one included, because a file that
 * parses to nothing must not be committed either. Never throws for a
 * filesystem error (the run's other verdicts are still true); an abort
 * propagates.
 */
export async function collectOwnerQuestion(
	input: CollectOwnerQuestionInput,
	questionFs: AgentTaskQuestionFs = defaultQuestionFs,
	signal?: AbortSignal
): Promise<FleetAgentTaskQuestion | null> {
	const candidates: Array<{ mountDir: string | null; path: string }> = [
		{ mountDir: null, path: input.primaryPath },
		...(input.mounts ?? [])
			.filter((mount) => mount.writable)
			.map((mount) => ({ mountDir: mount.mountDir, path: mount.path }))
	];
	let found: FleetAgentTaskQuestion | null = null;
	for (const candidate of candidates) {
		throwIfQuestionAborted(signal);
		let head: string | null = null;
		let seen = false;
		try {
			head = await questionFs.readHead(
				ownerQuestionPath(candidate.path),
				FLEET_AGENT_TASK_QUESTION_MAX_FILE_BYTES
			);
			seen = head !== null;
		} catch (error) {
			rethrowIfAbort(error);
			// Unreadable is not absent: still attempt the removal below so a
			// file the node could not read does not linger in the tree.
			seen = true;
		}
		if (!seen) continue;
		if (head !== null && !found) {
			const parsed = parseFleetAgentTaskQuestionMarkdown(head, candidate.mountDir);
			if (parsed) {
				// A head that filled the cap means bytes beyond it were never
				// read; the cut is real even when the parsed parts fit.
				const filledCap = Buffer.byteLength(head, 'utf8') >= FLEET_AGENT_TASK_QUESTION_MAX_FILE_BYTES;
				found = filledCap && !parsed.truncated ? { ...parsed, truncated: true } : parsed;
			}
		}
		await removeQuestionFile(candidate.path, questionFs);
	}
	return found;
}

/** Remove the file, then the directory if that emptied it; swallow everything but an abort. */
async function removeQuestionFile(workspacePath: string, questionFs: AgentTaskQuestionFs): Promise<void> {
	try {
		await questionFs.remove(ownerQuestionPath(workspacePath));
	} catch (error) {
		rethrowIfAbort(error);
	}
	try {
		await questionFs.removeDirIfEmpty(ownerQuestionDir(workspacePath));
	} catch (error) {
		rethrowIfAbort(error);
	}
}

function rethrowIfAbort(error: unknown): void {
	if (error instanceof Error && error.name === 'AbortError') throw error;
}

function throwIfQuestionAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	const reason = signal.reason;
	const error = new Error(reason instanceof Error ? reason.message : 'Fleet agent task was cancelled');
	error.name = 'AbortError';
	throw error;
}
