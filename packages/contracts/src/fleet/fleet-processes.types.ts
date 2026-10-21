/**
 * Processes on computers (FL-09 P1, spec §4.2) — the busiest processes and
 * the machine's GPUs, as the node lists them over the link (`processes.list`)
 * and the platform returns them (`GET /api/fleet/nodes/:id/processes`).
 *
 * Read from the Node, never stored (README §1).
 */

/** Capability tag a node advertises under `--manage` when it can list processes (CONTRACTS §1.2). */
export const FLEET_PROCESSES_CAPABILITY = 'processes';

/** The busiest processes one list carries (CONTRACTS §10). */
export const FLEET_PROCESS_LIST_MAX = 300;

/** A command line is cut at this many characters before it leaves the node (FR-10). */
export const FLEET_PROCESS_COMMAND_MAX = 200;

/** Stop = SIGTERM (Windows: a graceful close), Kill = SIGKILL (Windows: forced termination) — FR-11. */
export const FLEET_PROCESS_SIGNALS = ['TERM', 'KILL'] as const;

export type FleetProcessSignal = (typeof FLEET_PROCESS_SIGNALS)[number];

export function isFleetProcessSignal(value: unknown): value is FleetProcessSignal {
	return typeof value === 'string' && (FLEET_PROCESS_SIGNALS as readonly string[]).includes(value);
}

/** The largest pid any supported OS hands out (Linux `pid_max` limit). */
export const FLEET_PROCESS_PID_MAX = 4_194_304;

/** A pid Ever Works may name: a positive integer within {@link FLEET_PROCESS_PID_MAX}. */
export function isFleetProcessPid(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= FLEET_PROCESS_PID_MAX;
}

/** A pid from a route segment or a tool argument, or null. */
export function parseFleetProcessPid(value: unknown): number | null {
	if (typeof value === 'number') return isFleetProcessPid(value) ? value : null;
	if (typeof value !== 'string' || !/^[1-9][0-9]{0,6}$/.test(value)) return null;
	const pid = Number(value);
	return isFleetProcessPid(pid) ? pid : null;
}

/**
 * Why a row has no buttons (FR-12, U10): the node's own process tree, its
 * session daemon, or the machine's init process. The node refuses to signal
 * them with `invalid`.
 */
export const FLEET_PROCESS_PROTECTIONS = ['node', 'daemon', 'init'] as const;

export type FleetProcessProtection = (typeof FLEET_PROCESS_PROTECTIONS)[number];

/** One process, as the Processes tab shows it (spec §5.4). */
export interface FleetProcessView {
	pid: number;
	ppid: number | null;
	name: string;
	/** CPU percent of ONE core (a busy 8-thread process may read 800). */
	cpuPercent: number;
	memBytes: number | null;
	/** The user it runs as, when the OS says. */
	owner: string | null;
	/** Seconds since it started, when the OS says. */
	runtimeSec: number | null;
	/** Its command line, cut at {@link FLEET_PROCESS_COMMAND_MAX} and secret-scanned on the node (FR-10). */
	command: string;
	/** Set when Ever Works will not signal it from here. */
	protected: FleetProcessProtection | null;
}

/** One GPU above the list (FR-14). */
export interface FleetGpuView {
	/** `nvidia · amd · intel · apple · other`. */
	vendor: string;
	model: string | null;
	memUsedBytes: number | null;
	memTotalBytes: number | null;
	/** Null — never 0 — when the vendor tool does not report it ("utilisation unavailable"). */
	utilizationPercent: number | null;
	/** True on unified-memory machines (Apple): the total is shared with the CPU. */
	sharedMemory?: boolean;
}

/** `processes.list` reply / `GET …/processes` body. */
export interface FleetProcessesListResult {
	gpus: FleetGpuView[];
	/** Busiest first (or by memory when asked), at most {@link FLEET_PROCESS_LIST_MAX}. */
	processes: FleetProcessView[];
	/** How many processes the machine runs in all. */
	total: number;
	/** When the node read them (ISO). */
	sampledAt: string;
}

/** How a list is ordered (`?sort=`). */
export type FleetProcessSort = 'cpu' | 'mem';

/** `processes.signal` reply / `POST …/processes/:pid/signal` body. */
export interface FleetProcessSignalResult {
	pid: number;
	signal: FleetProcessSignal;
	sent: true;
	/**
	 * Set when the process was still running this many ms after the signal
	 * (the "still running — Kill?" prompt, spec S8); null when it is gone.
	 */
	stillRunningAfterMs: number | null;
}

/** The Processes tab's find field: name, command or owner (case-insensitive). */
export function fleetProcessMatchesFind(
	process: Pick<FleetProcessView, 'name' | 'command' | 'owner' | 'pid'>,
	find: string
): boolean {
	const needle = find.trim().toLowerCase();
	if (!needle) return true;
	return (
		process.name.toLowerCase().includes(needle) ||
		process.command.toLowerCase().includes(needle) ||
		(process.owner ?? '').toLowerCase().includes(needle) ||
		String(process.pid) === needle
	);
}
