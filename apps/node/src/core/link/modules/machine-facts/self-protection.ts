import type { FleetProcessProtection } from '@ever-works/contracts';
import type { ParsedProcess } from './process-list';

/**
 * Machine facts (FL-09, spec FR-12, U10) — the processes Ever Works will not
 * signal from the browser: the node itself and every process it runs under
 * (stopping a parent stops the node), its session daemon (FL-04 — stopping it
 * ends every owner session on the machine), and the init process. Their rows
 * carry a marker and no buttons, and a signal naming one is refused `invalid`
 * on the machine whatever the platform asked.
 *
 * The node's CHILDREN are not protected: a runaway Agent task is exactly what
 * a person may want to stop.
 */

export interface SelfProtectionContext {
	/** This node's pid. */
	selfPid: number;
	/** This node's parent pid (`process.ppid`). */
	parentPid: number | null;
	/** The session daemon's pid when the node knows it. */
	daemonPid?: number | null;
}

/** A session daemon's command line (`… session-daemon --state-dir … --socket …`, runtime.ts). */
// Matched on the verb alone: the line reaching here is already cut at 200
// characters, and protecting one process too many is the safe side.
const DAEMON_COMMAND = /\bsession-daemon\b/;

/** The pids of this node and every ancestor up to (not including) init, from one process read. */
export function nodeAncestry(processes: readonly ParsedProcess[], context: SelfProtectionContext): number[] {
	const parentOf = new Map<number, number | null>();
	for (const process of processes) parentOf.set(process.pid, process.ppid);
	const chain: number[] = [context.selfPid];
	let next: number | null = context.parentPid ?? parentOf.get(context.selfPid) ?? null;
	const seen = new Set<number>(chain);
	while (next !== null && next > 1 && !seen.has(next) && chain.length < 64) {
		chain.push(next);
		seen.add(next);
		next = parentOf.get(next) ?? null;
	}
	return chain;
}

/** Why a pid is protected, or null. `processes` lets ancestors and the daemon be recognised. */
export function protectionOf(
	pid: number,
	processes: readonly ParsedProcess[],
	context: SelfProtectionContext
): FleetProcessProtection | null {
	if (pid === 1) return 'init';
	if (context.daemonPid && pid === context.daemonPid) return 'daemon';
	if (nodeAncestry(processes, context).includes(pid)) return 'node';
	const row = processes.find((process) => process.pid === pid);
	if (row && DAEMON_COMMAND.test(row.command)) return 'daemon';
	return null;
}

/** Mark every row (one ancestry walk for the whole list). */
export function markProtected<T extends ParsedProcess>(
	rows: readonly T[],
	all: readonly ParsedProcess[],
	context: SelfProtectionContext
): (T & { protected: FleetProcessProtection | null })[] {
	const ancestry = new Set(nodeAncestry(all, context));
	return rows.map((row) => {
		let mark: FleetProcessProtection | null = null;
		if (row.pid === 1) mark = 'init';
		else if (context.daemonPid && row.pid === context.daemonPid) mark = 'daemon';
		else if (ancestry.has(row.pid)) mark = 'node';
		else if (DAEMON_COMMAND.test(row.command)) mark = 'daemon';
		return { ...row, protected: mark };
	});
}
