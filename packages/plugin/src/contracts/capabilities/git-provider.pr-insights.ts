import type {
	GitCiState,
	GitDiffFile,
	GitDiffOptions,
	GitDiffResult,
	GitPullRequestCheck
} from './git-provider.interface.js';

/**
 * PR insights (kanban run cockpit M5/M6) — the PURE half of the two new
 * git-provider capabilities.
 *
 * Both the CI rollup and the diff caps are provider-independent rules,
 * and both are the parts most likely to be got subtly wrong (a pending
 * check reported as green; a 40 MB diff streamed into a browser). They
 * live here so every provider implementation shares one tested
 * definition instead of re-deriving it, and so the conformance suite can
 * assert the same invariants against any implementation.
 */

/** Default byte budget for returned patch text (256 KiB). */
export const DEFAULT_DIFF_MAX_BYTES = 256 * 1024;

/** Default cap on the number of files described in one diff response. */
export const DEFAULT_DIFF_MAX_FILES = 100;

/** Nothing may ask for more than this, however generous the caller is. */
export const HARD_DIFF_MAX_BYTES = 1024 * 1024;
export const HARD_DIFF_MAX_FILES = 300;

/** Cap on checks carried on a PR status (the pill lists a handful). */
export const MAX_PR_CHECKS = 20;

/**
 * Roll a check list up into the board's four-state CI dot.
 *
 * Ordering is deliberate and fails LOUD rather than optimistic:
 *
 *  1. no checks at all            → `unknown` (gray — we know nothing)
 *  2. any completed failure       → `failing` (red beats everything else;
 *                                    one red check is the actionable fact)
 *  3. any not-yet-completed check → `pending` (amber — never green early)
 *  4. otherwise                   → `passing`
 *
 * `neutral`, `skipped` and `stale` are NOT failures; `action_required`
 * and `timed_out` are. `cancelled` is treated as non-blocking (a human
 * stopped it) — it neither reds nor holds the rollup.
 */
export function deriveCiState(checks: readonly GitPullRequestCheck[] | undefined): GitCiState {
	if (!checks || checks.length === 0) return 'unknown';

	let sawPending = false;
	for (const check of checks) {
		if (check.status !== 'completed') {
			sawPending = true;
			continue;
		}
		switch (check.conclusion) {
			case 'failure':
			case 'timed_out':
			case 'action_required':
				return 'failing';
			case null:
			case undefined:
				// Completed with no verdict — treat as still-unsettled
				// rather than inventing a pass.
				sawPending = true;
				break;
			default:
				break;
		}
	}
	return sawPending ? 'pending' : 'passing';
}

/** Clamp caller-supplied caps into the hard platform ceilings. */
export function resolveDiffCaps(opts?: GitDiffOptions): { maxBytes: number; maxFiles: number } {
	const requestedBytes = Number.isFinite(opts?.maxBytes)
		? Math.floor(opts!.maxBytes as number)
		: DEFAULT_DIFF_MAX_BYTES;
	const requestedFiles = Number.isFinite(opts?.maxFiles)
		? Math.floor(opts!.maxFiles as number)
		: DEFAULT_DIFF_MAX_FILES;
	return {
		maxBytes: Math.max(0, Math.min(requestedBytes, HARD_DIFF_MAX_BYTES)),
		maxFiles: Math.max(1, Math.min(requestedFiles, HARD_DIFF_MAX_FILES))
	};
}

/** Byte length of a patch string as it will travel over the wire. */
function patchBytes(patch: string | undefined): number {
	if (!patch) return 0;
	// eslint-disable-next-line no-undef
	return typeof TextEncoder === 'function' ? new TextEncoder().encode(patch).length : patch.length;
}

/**
 * Apply the file + byte caps to a provider's raw file list.
 *
 * The file cap drops whole entries; the byte budget drops PATCH TEXT
 * only, keeping the file row (path + add/del counts) so the sheet can
 * still show the shape of the change. Either kind of drop sets
 * `truncated`.
 */
export function capDiffFiles(files: readonly GitDiffFile[], opts?: GitDiffOptions): GitDiffResult {
	const { maxBytes, maxFiles } = resolveDiffCaps(opts);
	const totalFiles = files.length;
	const kept = files.slice(0, maxFiles);

	let spent = 0;
	let truncated = totalFiles > maxFiles;
	let totalAdditions = 0;
	let totalDeletions = 0;

	const out: GitDiffFile[] = kept.map((file) => {
		totalAdditions += Number.isFinite(file.additions) ? file.additions : 0;
		totalDeletions += Number.isFinite(file.deletions) ? file.deletions : 0;
		const size = patchBytes(file.patch);
		if (!file.patch) {
			// Provider gave no patch (binary, too large upstream). Not a
			// truncation WE performed — report the row as-is.
			return { ...file };
		}
		if (spent + size > maxBytes) {
			truncated = true;
			const { patch: _dropped, ...rest } = file;
			return { ...rest, patchOmitted: true };
		}
		spent += size;
		return { ...file };
	});

	return {
		files: out,
		truncated,
		totalFiles,
		totalAdditions,
		totalDeletions,
		patchBytes: spent
	};
}

/** Trim a provider's check list to the pill's bounded size. */
export function capChecks(checks: readonly GitPullRequestCheck[]): GitPullRequestCheck[] {
	return checks.slice(0, MAX_PR_CHECKS).map((check) => ({ ...check }));
}
