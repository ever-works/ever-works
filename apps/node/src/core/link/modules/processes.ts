import * as fsp from 'node:fs/promises';
import { totalmem } from 'node:os';
import {
	fleetProcessMatchesFind,
	FLEET_PROCESS_LIST_MAX,
	FLEET_PROCESSES_CAPABILITY,
	makeFleetLinkError,
	type FleetProcessesListResult,
	type FleetProcessSignal,
	type FleetProcessSignalResult,
	type FleetProcessSort
} from '@ever-works/contracts';
import type { CommandRunner } from '../../capabilities';
import { assertPid, assertSignal } from './machine-facts/argv-safety';
import { createMachineCommandRunner, firstLine } from './machine-facts/exec';
import { readGpus } from './machine-facts/gpu-stats';
import { readProcesses, topProcesses, type ParsedProcess } from './machine-facts/process-list';
import { createRootRunner, type RootRunner } from './machine-facts/root-runner';
import { markProtected, protectionOf, type SelfProtectionContext } from './machine-facts/self-protection';
import { MachineVerbError, type MachineVerbContext, type NodeModule } from './registry';

/**
 * Processes on computers (FL-09 P1, spec §4.2) — the `processes` node
 * module: `processes.list` (the busiest 300 and the GPUs above them) and
 * `processes.signal` (Stop = SIGTERM, Kill = SIGKILL; on Windows a graceful
 * close, then a forced termination) on the `machine` channel, and the
 * `processes` capability tag under `--manage`.
 *
 * `processes.signal` refuses, on the machine, the node's own process and
 * every process it runs under, its session daemon and PID 1 (FR-12, U10).
 * Another user's process follows the root rule (FR-13, U11): `sudo -n kill`,
 * or `root_required` with `sudo kill -TERM <pid>` as the hint.
 */

/** How long a Stop waits to see the process go before answering (the UI asks "Kill?" after 5 s, S8). */
export const SIGNAL_SETTLE_MS = 1_500;

export interface ProcessesModuleDeps {
	runner?: CommandRunner;
	platform?: string;
	root?: RootRunner;
	selfPid?: number;
	parentPid?: number | null;
	daemonPid?: () => number | null;
	/** `process.kill`, injected for tests. */
	kill?: (pid: number, signal: NodeJS.Signals | 0) => void;
	sleep?: (ms: number) => Promise<void>;
	now?: () => Date;
	readText?: (path: string) => Promise<string | null>;
	listDir?: (path: string) => Promise<string[]>;
	totalMemBytes?: () => number;
}

function errorCode(error: unknown): string | undefined {
	return error && typeof error === 'object' ? ((error as NodeJS.ErrnoException).code ?? undefined) : undefined;
}

export function createProcessesModule(deps: ProcessesModuleDeps = {}): NodeModule {
	const platform = deps.platform ?? process.platform;
	const runner = deps.runner ?? createMachineCommandRunner();
	const root = deps.root ?? createRootRunner({ runner, platform });
	const kill = deps.kill ?? ((pid: number, signal: NodeJS.Signals | 0) => void process.kill(pid, signal));
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const now = deps.now ?? (() => new Date());
	const protection = (): SelfProtectionContext => ({
		selfPid: deps.selfPid ?? process.pid,
		parentPid: deps.parentPid === undefined ? process.ppid : deps.parentPid,
		daemonPid: deps.daemonPid?.() ?? null
	});
	const readText =
		deps.readText ??
		((path: string) =>
			fsp.readFile(path, 'utf8').then(
				(text) => text,
				() => null
			));
	const listDir =
		deps.listDir ??
		((path: string) =>
			fsp.readdir(path).then(
				(entries) => entries.map(String),
				() => []
			));

	const readAll = async (): Promise<ParsedProcess[]> => {
		const read = await readProcesses(runner, platform);
		if ('error' in read) throw new MachineVerbError(makeFleetLinkError('operation_failed', read.error));
		return read.processes;
	};

	const isAlive = (pid: number): boolean => {
		try {
			kill(pid, 0);
			return true;
		} catch (error) {
			// EPERM: it exists, we just may not signal it.
			return errorCode(error) === 'EPERM';
		}
	};

	const list = async (context: MachineVerbContext): Promise<FleetProcessesListResult> => {
		const sort: FleetProcessSort = context.params.sort === 'mem' ? 'mem' : 'cpu';
		const find = typeof context.params.find === 'string' ? context.params.find.slice(0, 200) : '';
		const [all, gpus] = await Promise.all([
			readAll(),
			readGpus({ runner, platform, readText, listDir, totalMemBytes: deps.totalMemBytes ?? totalmem })
		]);
		const matching = all.filter((row) => fleetProcessMatchesFind(row, find));
		const top = topProcesses(matching, sort, FLEET_PROCESS_LIST_MAX);
		return {
			gpus,
			processes: markProtected(top, all, protection()),
			total: all.length,
			sampledAt: now().toISOString()
		};
	};

	/** Windows: `taskkill` (graceful close) for TERM, `taskkill /F` for KILL — argv, no shell. */
	const signalWindows = async (pid: number, signal: FleetProcessSignal, machine: string): Promise<void> => {
		const args = signal === 'KILL' ? ['/PID', String(pid), '/F'] : ['/PID', String(pid)];
		const result = await runner.run('taskkill', args, { timeoutMs: 10_000 });
		if (result.code === 0) return;
		const message = firstLine(result.stderr || result.stdout, `taskkill exited ${result.code ?? 1}`);
		if (/not found|no running instance/i.test(message)) {
			throw new MachineVerbError(makeFleetLinkError('not_found', `process ${pid} is not running on ${machine}`));
		}
		if (/access is denied/i.test(message)) {
			const command = signal === 'KILL' ? `Stop-Process -Id ${pid} -Force` : `taskkill /PID ${pid}`;
			throw new MachineVerbError(
				makeFleetLinkError('root_required', command, { command, shell: 'powershell', machine })
			);
		}
		// A graceful close of a process with no window is refused by Windows: say what would work.
		if (signal === 'TERM' && /forcefully|\/F/i.test(message)) {
			throw new MachineVerbError(
				makeFleetLinkError('operation_failed', `process ${pid} has no window to close; use Kill to end it`)
			);
		}
		throw new MachineVerbError(makeFleetLinkError('operation_failed', message));
	};

	/** Unix: `process.kill`, then the root rule for another user's process (`sudo -n kill`). */
	const signalUnix = async (pid: number, signal: FleetProcessSignal, machine: string): Promise<void> => {
		try {
			kill(pid, signal === 'KILL' ? 'SIGKILL' : 'SIGTERM');
			return;
		} catch (error) {
			const code = errorCode(error);
			if (code === 'ESRCH') {
				throw new MachineVerbError(
					makeFleetLinkError('not_found', `process ${pid} is not running on ${machine}`)
				);
			}
			if (code !== 'EPERM') throw error;
		}
		const outcome = await root.run({
			argv: ['kill', `-${signal}`, String(pid)],
			needsRoot: true,
			timeoutMs: 10_000
		});
		if (!outcome.ok) {
			throw new MachineVerbError(
				makeFleetLinkError('root_required', outcome.command, { command: outcome.command, shell: 'sh', machine })
			);
		}
		if (outcome.code !== 0) {
			throw new MachineVerbError(
				makeFleetLinkError('operation_failed', firstLine(outcome.stderr, `kill exited ${outcome.code ?? 1}`))
			);
		}
	};

	const signal = async (context: MachineVerbContext): Promise<FleetProcessSignalResult> => {
		const pid = assertPid(context.params.pid);
		const which = assertSignal(context.params.signal);
		const all = await readAll();
		const mark = protectionOf(pid, all, protection());
		if (mark) {
			throw new MachineVerbError(
				makeFleetLinkError(
					'invalid',
					mark === 'init'
						? 'Ever Works will not signal the init process from here.'
						: 'Ever Works will not stop its own node from here. Use the machine or Settings → Fleet.',
					{ field: 'pid', protected: mark }
				)
			);
		}
		if (!all.some((row) => row.pid === pid) && !isAlive(pid)) {
			throw new MachineVerbError(
				makeFleetLinkError('not_found', `process ${pid} is not running on ${context.nodeName}`)
			);
		}
		if (platform === 'win32') await signalWindows(pid, which, context.nodeName);
		else await signalUnix(pid, which, context.nodeName);
		context.logger?.info(`processes: SIG${which} sent to ${pid}`);

		await sleep(SIGNAL_SETTLE_MS);
		return { pid, signal: which, sent: true, stillRunningAfterMs: isAlive(pid) ? SIGNAL_SETTLE_MS : null };
	};

	return {
		id: 'processes',
		tags: (environment) => (environment.consents.manage ? [FLEET_PROCESSES_CAPABILITY] : []),
		machineVerbs: {
			'processes.list': { stateChanging: false, run: list },
			'processes.signal': { stateChanging: true, run: signal }
		}
	};
}
