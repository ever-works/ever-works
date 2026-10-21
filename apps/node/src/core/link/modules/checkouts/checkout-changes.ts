import { promises as fs } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import {
	clampFleetChangesMaxBytes,
	FLEET_CHANGES_EXCLUDED_DIRS,
	FLEET_CHANGES_MAX_FILE_BYTES,
	FLEET_CHANGES_MAX_FILES,
	type FleetChangedFileStatus,
	type FleetCheckoutChangedFile,
	type FleetCheckoutChangesReply
} from '@ever-works/contracts';
import type { CheckoutGitRunner } from './checkout-git';

/**
 * Session git & actions (FL-06, spec FR-9, FR-10, U15; CONTRACTS §3.3
 * `checkouts.changes`) — the uncommitted diff of one checkout, read on the
 * machine, never written anywhere:
 *
 *   git status --porcelain=v2 -z --no-renames --untracked-files=all   what changed (staged + unstaged + untracked)
 *   git diff HEAD --numstat -z --no-renames                            lines added / removed, binary marks
 *   git diff HEAD --no-color --no-ext-diff --no-textconv --no-renames  the unified patch, split per file
 *
 * Every command excludes the node's own folders (`.ever-works/`, `.mounts/`)
 * by pathspec. An untracked text file gets a synthetic "new file" patch read
 * from disk (never through a link, never above the per-file cap); a binary
 * one, a link or anything unreadable is listed without a patch. The caps of
 * CONTRACTS §10 apply here (1 MiB total, 64 KiB per file) and again on the
 * platform. Nothing contacts a remote; no HTML is produced — the text goes
 * out as text and every surface renders it as text (FR-10).
 */

/** One entry of `git status --porcelain=v2 -z`. */
export interface PorcelainChange {
	path: string;
	previousPath: string | null;
	status: FleetChangedFileStatus;
}

/** The pathspec every command carries: the whole tree minus the node's own folders. */
export function changesPathspec(): string[] {
	return ['--', '.', ...FLEET_CHANGES_EXCLUDED_DIRS.map((dir) => `:(exclude)${dir}`)];
}

function isExcluded(path: string): boolean {
	return FLEET_CHANGES_EXCLUDED_DIRS.some((dir) => path === dir || path.startsWith(`${dir}/`));
}

function statusOf(xy: string): FleetChangedFileStatus {
	const x = xy.charAt(0);
	const y = xy.charAt(1);
	if (x === 'R' || y === 'R') return 'renamed';
	if (x === 'C' || y === 'C') return 'copied';
	if (x === 'A') return 'added';
	if (x === 'D' || y === 'D') return 'deleted';
	if (x === 'T' || y === 'T') return 'type-changed';
	return 'modified';
}

/**
 * Parse `git status --porcelain=v2 -z`. Pure; tolerant of entries it does not
 * know. With `-z` a rename's original path is the NEXT NUL-separated field.
 */
export function parsePorcelainV2Changes(output: string): PorcelainChange[] {
	const fields = output.split('\0');
	const out: PorcelainChange[] = [];
	for (let index = 0; index < fields.length; index += 1) {
		const field = fields[index];
		if (!field) continue;
		const kind = field.charAt(0);
		if (kind === '1') {
			// `1 XY sub mH mI mW hH hI <path>` — the path is everything after the eighth space.
			const parts = field.split(' ');
			if (parts.length < 9) continue;
			out.push({ path: parts.slice(8).join(' '), previousPath: null, status: statusOf(parts[1]) });
		} else if (kind === '2') {
			// `2 XY sub mH mI mW hH hI Xscore <path>` then `<origPath>` as its own field.
			const parts = field.split(' ');
			if (parts.length < 10) continue;
			const previousPath = fields[index + 1] ?? null;
			index += 1;
			out.push({ path: parts.slice(9).join(' '), previousPath: previousPath || null, status: statusOf(parts[1]) });
		} else if (kind === 'u') {
			// `u XY sub m1 m2 m3 mW h1 h2 h3 <path>`
			const parts = field.split(' ');
			if (parts.length < 11) continue;
			out.push({ path: parts.slice(10).join(' '), previousPath: null, status: 'conflicted' });
		} else if (kind === '?') {
			out.push({ path: field.slice(2), previousPath: null, status: 'untracked' });
		}
		// `!` (ignored) and `#` headers are not changes.
	}
	return out.filter((change) => change.path.length > 0 && !isExcluded(change.path));
}

/** Parse `git diff --numstat -z --no-renames`: `added\tremoved\tpath\0`; binary files read `-\t-`. */
export function parseNumstatZ(output: string): Map<string, { added: number | null; removed: number | null; binary: boolean }> {
	const out = new Map<string, { added: number | null; removed: number | null; binary: boolean }>();
	for (const record of output.split('\0')) {
		const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(record.replace(/^\n+/, ''));
		if (!match) continue;
		const binary = match[1] === '-' && match[2] === '-';
		out.set(match[3], {
			added: match[1] === '-' ? null : Number(match[1]),
			removed: match[2] === '-' ? null : Number(match[2]),
			binary
		});
	}
	return out;
}

/** The file a `diff --git` section is about: its `+++ b/…` line, or `--- a/…` for a deletion. */
function sectionPath(section: string): string | null {
	let minus: string | null = null;
	for (const line of section.split('\n', 12)) {
		if (line.startsWith('+++ ')) {
			const target = line.slice(4).replace(/\t.*$/, '');
			if (target !== '/dev/null') return target.startsWith('b/') ? target.slice(2) : target;
		} else if (line.startsWith('--- ')) {
			const source = line.slice(4).replace(/\t.*$/, '');
			if (source !== '/dev/null') minus = source.startsWith('a/') ? source.slice(2) : source;
		}
	}
	if (minus) return minus;
	// A mode-only change carries no ---/+++ lines: read the header.
	const header = /^diff --git a\/(.+) b\/(.+)$/m.exec(section);
	return header ? header[2] : null;
}

/** Split one unified diff into its per-file sections, keyed by path. Pure. */
export function splitUnifiedDiff(diff: string): Map<string, string> {
	const out = new Map<string, string>();
	if (!diff) return out;
	const starts: number[] = [];
	const pattern = /^diff --git /gm;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(diff)) !== null) starts.push(match.index);
	for (let index = 0; index < starts.length; index += 1) {
		const section = diff.slice(starts[index], index + 1 < starts.length ? starts[index + 1] : diff.length);
		const path = sectionPath(section);
		if (path && !out.has(path)) out.set(path, section);
	}
	return out;
}

/** A synthetic "new file" patch for an untracked text file (null: binary, a link, too big, unreadable). */
export async function untrackedPatch(root: string, path: string, maxBytes: number): Promise<string | null> {
	const absolute = resolve(root, path);
	const inside = relative(resolve(root), absolute);
	if (!inside || inside.startsWith('..') || inside.split(sep).includes('..')) return null;
	try {
		const stats = await fs.lstat(absolute);
		if (!stats.isFile() || stats.size > maxBytes) return null;
		const buffer = await fs.readFile(absolute);
		if (buffer.includes(0)) return null;
		const text = buffer.toString('utf8');
		const lines = text.split('\n');
		if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
		const header = `diff --git a/${path} b/${path}\nnew file\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n`;
		return header + lines.map((line) => `+${line}`).join('\n') + (lines.length > 0 ? '\n' : '');
	} catch {
		return null;
	}
}

/**
 * Read the checkout's uncommitted changes, capped. Never throws for a git
 * read that fails: the reply then lists what status could say (or nothing).
 */
export async function readCheckoutChanges(
	path: string,
	git: CheckoutGitRunner,
	options: { maxBytes?: number; signal?: AbortSignal; now?: () => number; readUntracked?: typeof untrackedPatch } = {}
): Promise<FleetCheckoutChangesReply> {
	const now = options.now ?? (() => Date.now());
	const cap = clampFleetChangesMaxBytes(options.maxBytes);
	const readUntracked = options.readUntracked ?? untrackedPatch;
	const run = (args: string[]) => git(args, { cwd: path, ...(options.signal ? { signal: options.signal } : {}) });
	const quote = ['-c', 'core.quotePath=false'];

	const status = await run([
		...quote,
		'status',
		'--porcelain=v2',
		'-z',
		'--no-renames',
		'--untracked-files=all',
		...changesPathspec()
	]);
	const changes = status.code === 0 ? parsePorcelainV2Changes(status.stdout) : [];
	changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

	const hasTracked = changes.some((change) => change.status !== 'untracked');
	let numstat = new Map<string, { added: number | null; removed: number | null; binary: boolean }>();
	let sections = new Map<string, string>();
	let diffCut = false;
	if (hasTracked) {
		const counts = await run([...quote, 'diff', 'HEAD', '--numstat', '-z', '--no-renames', ...changesPathspec()]);
		if (counts.code === 0) numstat = parseNumstatZ(counts.stdout);
		const diff = await run([
			...quote,
			'diff',
			'HEAD',
			'--no-color',
			'--no-ext-diff',
			'--no-textconv',
			'--no-renames',
			...changesPathspec()
		]);
		// A diff bigger than the runner's buffer comes back cut, with a failure code: keep what arrived.
		if (diff.stdout) sections = splitUnifiedDiff(diff.stdout);
		if (diff.code !== 0 && diff.stdout) diffCut = true;
	}

	const files: FleetCheckoutChangedFile[] = [];
	let totalBytes = 0;
	let omittedFiles = 0;
	let omittedBytes = 0;
	let truncated = diffCut;
	for (const change of changes) {
		if (files.length >= FLEET_CHANGES_MAX_FILES) {
			omittedFiles += 1;
			truncated = true;
			continue;
		}
		const counts = numstat.get(change.path);
		const binary = counts?.binary === true;
		let patch: string | null = null;
		if (!binary) {
			patch =
				change.status === 'untracked'
					? await readUntracked(path, change.path, FLEET_CHANGES_MAX_FILE_BYTES * 4)
					: (sections.get(change.path) ?? null);
		}
		let added = counts?.added ?? null;
		let removed = counts?.removed ?? null;
		if (change.status === 'untracked' && patch !== null) {
			added = patch.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++')).length;
			removed = 0;
		}
		let fileTruncated = false;
		if (patch !== null && patch.length > FLEET_CHANGES_MAX_FILE_BYTES) {
			omittedBytes += patch.length - FLEET_CHANGES_MAX_FILE_BYTES;
			patch = patch.slice(0, FLEET_CHANGES_MAX_FILE_BYTES);
			fileTruncated = true;
			truncated = true;
		}
		if (patch !== null && totalBytes + patch.length > cap) {
			omittedBytes += patch.length;
			omittedFiles += 1;
			patch = null;
			truncated = true;
		}
		if (patch !== null) totalBytes += patch.length;
		files.push({
			path: change.path,
			previousPath: change.previousPath,
			status: change.status,
			added: binary ? null : added,
			removed: binary ? null : removed,
			binary,
			patch,
			truncated: fileTruncated
		});
	}
	return {
		path,
		files,
		truncated,
		omittedFiles,
		omittedBytes,
		totalBytes,
		at: new Date(now()).toISOString()
	};
}

