import { FLEET_MAX_CLI_VERSION_LENGTH } from '@ever-works/contracts';
import type { CommandRunner } from './capabilities';

/**
 * Node telemetry probes — the two facts the Fleet runner indicator shows
 * that the node did not previously report: which AGENT CLI is installed,
 * and how much disk is left.
 *
 * Both answer operational questions the existing fields cannot. The
 * node's `version` says whether the DAEMON is current; it says nothing
 * about the tool the daemon shells out to, which is what actually
 * executes an `agent-task` step — so "worked yesterday, fails today on
 * this one machine" had no visible cause. And a runner that is online,
 * idle and out of disk looks perfectly healthy right up to the moment
 * every job it takes fails.
 *
 * Design rules, both inherited from `gpu-probe.ts` and both load-bearing:
 *
 *   1. **A probe never fails the beat.** Every path swallows its own
 *      errors and returns null. A missing tool, an unreadable volume or
 *      a hung binary means a missing FIELD, not a missing heartbeat —
 *      and a heartbeat is the only thing keeping the node visible.
 *   2. **Everything is injected.** The command runner and the
 *      filesystem probe are parameters, so the whole matrix is
 *      unit-testable without touching the host.
 */

/**
 * Agent CLIs worth probing for, in preference order.
 *
 * The list is ORDERED, not exhaustive: the node reports the first one it
 * finds rather than enumerating everything installed, because the field
 * answers "what is this machine able to drive" for a human reading a
 * status popover — a comma-separated inventory would not fit the pill
 * and would not be more actionable.
 *
 * `claude` leads because the `claude-code` pipeline is the one the
 * platform ships with; the rest are the CLI-backed pipelines that also
 * exist as plugins (`codex`, `gemini`, `opencode`).
 */
export const AGENT_CLI_CANDIDATES: readonly string[] = ['claude', 'codex', 'gemini', 'opencode'];

/** Filesystem seam for the free-space probe. */
export interface DiskProbeIo {
	/**
	 * Free bytes available on the volume containing `path`, or null when
	 * the platform / runtime cannot answer.
	 */
	freeBytes(path: string): Promise<number | null> | number | null;
}

/**
 * Extract a version from a CLI's `--version` output.
 *
 * Deliberately permissive about the surrounding text and strict about
 * what it keeps: agent CLIs print anything from `1.2.3` to
 * `1.2.3 (Claude Code)` to a banner line, so the first dotted-numeric
 * token is the only reliably comparable part. Returns null when there is
 * no such token, because reporting a banner as a "version" would put
 * noise in a column operators scan for drift.
 */
export function parseCliVersion(stdout: string): string | null {
	if (typeof stdout !== 'string') return null;
	const match = /\b(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)\b/.exec(stdout);
	return match ? match[1] : null;
}

/**
 * Find the first installed agent CLI and report `"<name> <version>"`.
 *
 * Returns null when none of the candidates answers `--version` with exit
 * code 0 — which is the normal state of a machine enrolled purely for
 * visibility, and must therefore read as "nothing installed" rather than
 * as an error.
 */
export async function detectAgentCliVersion(
	runner: CommandRunner,
	candidates: readonly string[] = AGENT_CLI_CANDIDATES
): Promise<string | null> {
	for (const command of candidates) {
		try {
			const result = await runner.run(command, ['--version']);
			if (result.code !== 0) continue;
			const version = parseCliVersion(`${result.stdout ?? ''}\n${result.stderr ?? ''}`);
			if (!version) continue;
			return `${command} ${version}`.slice(0, FLEET_MAX_CLI_VERSION_LENGTH);
		} catch {
			// A spawn failure is an absent tool, not a probe failure.
			continue;
		}
	}
	return null;
}

/**
 * Free bytes on the volume holding `path`.
 *
 * Non-finite, negative and fractional readings all collapse to null: the
 * server refuses those anyway (it will not store a nonsense figure), and
 * sending one would only produce a rejected field plus a misleading log
 * line on both sides.
 */
export async function detectDiskFreeBytes(io: DiskProbeIo, path: string): Promise<number | null> {
	try {
		const free = await io.freeBytes(path);
		if (typeof free !== 'number' || !Number.isFinite(free) || free < 0) return null;
		return Math.floor(free);
	} catch {
		return null;
	}
}
