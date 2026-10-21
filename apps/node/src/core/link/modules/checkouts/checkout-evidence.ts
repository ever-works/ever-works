import { promises as fs } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { FleetCheckoutChangesEvidence } from '@ever-works/contracts';
import type { CheckoutGitRunner } from './checkout-git';
import { parsePorcelainV2 } from './checkout-git-line';

/**
 * Checkouts on computers (FL-14, spec FR-24, S7) — what deleting a checkout
 * would lose, computed on the machine: the same evidence the Task-pool reaper
 * judges by (rules 5–6 of `workspace-reaper.ts`): uncommitted or untracked
 * files, a git lock file, and commits on HEAD that no remote-tracking ref
 * reaches.
 *
 * Fail closed: anything git cannot establish counts as "would be lost" (a
 * large number), never as zero — a delete is then `confirm-destructive` and
 * says so, rather than a one-click removal of work nobody could see.
 *
 * Computed twice for every delete — once for the preview the person
 * confirms, and again on execute, where the node refuses when it grew.
 */

/** What an unreadable count reads as: enough to force the typed confirmation. */
export const EVIDENCE_UNKNOWN = 1_000_000;

export async function readChangesEvidence(
	path: string,
	git: CheckoutGitRunner,
	options: { signal?: AbortSignal } = {}
): Promise<FleetCheckoutChangesEvidence> {
	const run = (args: string[]) => git(args, { cwd: path, ...(options.signal ? { signal: options.signal } : {}) });
	let uncommitted = EVIDENCE_UNKNOWN;
	const status = await run(['status', '--porcelain=v2', '--branch', '--untracked-files=normal']);
	if (status.code === 0) {
		const parsed = parsePorcelainV2(status.stdout);
		uncommitted = parsed.changed + parsed.untracked;
	}
	let unpushedCommits = EVIDENCE_UNKNOWN;
	const head = await run(['rev-parse', '--verify', '--quiet', 'HEAD']);
	if (head.code !== 0) {
		// No commit at all: nothing on HEAD can be lost.
		unpushedCommits = 0;
	} else {
		const unreachable = await run(['rev-list', '--count', 'HEAD', '--not', '--remotes']);
		if (unreachable.code === 0) {
			const parsed = Number.parseInt(unreachable.stdout.trim(), 10);
			if (Number.isSafeInteger(parsed) && parsed >= 0) unpushedCommits = parsed;
		}
	}
	let hasLocks = false;
	const gitDir = await run(['rev-parse', '--git-dir']);
	if (gitDir.code === 0) {
		const raw = gitDir.stdout.trim();
		const dir = isAbsolute(raw) ? raw : join(path, raw);
		hasLocks = await exists(join(dir, 'index.lock'));
	}
	return { uncommitted, unpushedCommits, hasLocks };
}

/** True when the evidence names nothing that would be lost: one `confirm` dialog, else `confirm-destructive`. */
export function isEvidenceClean(evidence: FleetCheckoutChangesEvidence): boolean {
	return evidence.uncommitted === 0 && evidence.unpushedCommits === 0;
}

/** The node's re-check on execute: refused when either count grew past what the person confirmed. */
export function evidenceGrew(
	current: Pick<FleetCheckoutChangesEvidence, 'uncommitted' | 'unpushedCommits'>,
	expected: Pick<FleetCheckoutChangesEvidence, 'uncommitted' | 'unpushedCommits'> | undefined
): boolean {
	if (!expected) return !isEvidenceClean({ ...current, hasLocks: false });
	return current.uncommitted > expected.uncommitted || current.unpushedCommits > expected.unpushedCommits;
}

async function exists(path: string): Promise<boolean> {
	try {
		await fs.lstat(path);
		return true;
	} catch {
		return false;
	}
}
