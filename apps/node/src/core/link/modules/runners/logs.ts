import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fleetLogSourceId, isFleetActionsRunnerName, type FleetLogSource } from '@ever-works/contracts';
import type { RunnerState } from './state';

/**
 * Actions runners on computers (FL-18, plan §6.1 `runner-logs.ts`, spec FR-18)
 * — the FL-08 log source `runner:<name>`: the runner's newest diagnostic log,
 * `<runners>/<name>/_diag/Runner_*.log`. The machine resolves the path itself
 * from a validated runner name; a caller never names a path.
 */

/** The diagnostic log files a runner writes (`Runner_20261026-101500-utc.log`). */
const RUNNER_DIAG_FILE = /^Runner_[A-Za-z0-9_.-]*\.log$/;

/** Pick the newest diagnostic log out of a folder listing (by modification time, then name). */
export function pickNewestRunnerDiagLog(entries: ReadonlyArray<{ name: string; mtimeMs: number }>): string | null {
	let best: { name: string; mtimeMs: number } | null = null;
	for (const entry of entries) {
		if (!RUNNER_DIAG_FILE.test(entry.name)) continue;
		if (
			!best ||
			entry.mtimeMs > best.mtimeMs ||
			(entry.mtimeMs === best.mtimeMs && entry.name.localeCompare(best.name) > 0)
		) {
			best = entry;
		}
	}
	return best ? best.name : null;
}

/** The absolute path of a runner's newest diagnostic log, or null when it has none (yet). */
export async function newestRunnerDiagLog(state: RunnerState, name: string): Promise<string | null> {
	if (!isFleetActionsRunnerName(name)) return null;
	const diag = join(state.dir(name), '_diag');
	let names: string[];
	try {
		names = await readdir(diag);
	} catch {
		return null;
	}
	const entries: Array<{ name: string; mtimeMs: number }> = [];
	for (const entry of names) {
		if (!RUNNER_DIAG_FILE.test(entry)) continue;
		const info = await stat(join(diag, entry)).catch(() => null);
		if (info?.isFile()) entries.push({ name: entry, mtimeMs: info.mtimeMs });
	}
	const newest = pickNewestRunnerDiagLog(entries);
	return newest ? join(diag, newest) : null;
}

/** One log source per runner this machine holds (the Logs tab's "Actions runners" group). */
export async function listRunnerLogSources(state: RunnerState): Promise<FleetLogSource[]> {
	const out: FleetLogSource[] = [];
	for (const meta of await state.list()) {
		const path = await newestRunnerDiagLog(state, meta.name);
		const info = path ? await stat(path).catch(() => null) : null;
		out.push({
			id: fleetLogSourceId('runner', meta.name),
			kind: 'runner',
			label: meta.name,
			group: meta.target,
			readable: path !== null,
			...(path === null ? { hint: 'This runner has not written a diagnostic log yet' } : {}),
			...(info ? { lastWrittenAt: new Date(info.mtimeMs).toISOString(), sizeBytes: info.size } : {}),
			supportsEarlier: true
		});
	}
	return out;
}
