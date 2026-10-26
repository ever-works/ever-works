import { basename, join } from 'node:path';
import type { FleetActionsRunnerServiceState } from '@ever-works/contracts';
import { isSudoRefusal, renderPosixCommand } from '../machine-facts/root-runner';
import { firstOutputLine, RunnerHostError, type RunnerExecResult, type RunnerHostDeps } from './host';
import { runnerScriptCommand } from './config';
import type { RunnerMeta } from './state';

/**
 * Actions runners on computers (FL-18, plan §6.1 `runner-service.ts`, §6.2,
 * spec FR-9, U3–U5) — the runner as a service through the machine's own
 * service manager, the root rule of FL-09's machine facts applied:
 *
 * | OS      | Manager          | How                                  | Privilege                                   |
 * | ------- | ---------------- | ------------------------------------ | ------------------------------------------- |
 * | Linux   | systemd          | the runner's `svc.sh` unit           | passwordless `sudo -n` (else the command)   |
 * | macOS   | launchd          | the runner's `svc.sh` LaunchAgent    | none                                        |
 * | Windows | Windows services | `config.cmd --runasservice`, `sc.exe`| elevation (else the command); service-only  |
 *
 * Ever Works never types, asks for, stores or transmits a password: an act
 * that needs root runs only when the machine already lets the node's user do
 * it without one (`sudo -n`), else it is refused `root_required` with the exact
 * command the owner runs once on the machine (README §3).
 */

export type RunnerServiceManager = 'systemd' | 'launchd' | 'windows';

const SERVICE_TIMEOUT_MS = 120_000;

/** The service manager runners are installed through here, or null (U3: no `actions-runner` tag then). */
export function runnerServiceManagerFor(platform: string, hasSystemd: boolean): RunnerServiceManager | null {
	if (platform === 'linux') return hasSystemd ? 'systemd' : null;
	if (platform === 'darwin') return 'launchd';
	if (platform === 'win32') return 'windows';
	return null;
}

/** The sudoers drop-in that lets the node's user run the runners' `svc.sh` (and nothing else) without a password. */
export const RUNNERS_SUDOERS_FILE = '/etc/sudoers.d/ever-works-actions-runners';

/** The exact one-time command for U4 — narrow: only `svc.sh` under this node's runners folder. */
export function linuxSudoersCommand(user: string, root: string): string {
	const rule = `${user} ALL=(root) NOPASSWD: ${root}/*/svc.sh`;
	return `echo ${renderPosixCommand([rule])} | sudo tee ${RUNNERS_SUDOERS_FILE} >/dev/null && sudo chmod 0440 ${RUNNERS_SUDOERS_FILE}`;
}

/** The exact command for U5: the node itself must run elevated to install Windows services. */
export const WINDOWS_ELEVATED_COMMAND = 'ever-works-node start --work';

/** The name the runner's service is registered under when its `.service` file says nothing. */
export function defaultRunnerServiceName(meta: Pick<RunnerMeta, 'target' | 'name'>, platform: string): string {
	const scopeName = meta.target.replace(/\//g, '-');
	const base = `actions.runner.${scopeName}.${meta.name}`.slice(0, 80);
	return platform === 'linux' ? `${base}.service` : base;
}

async function sudoRun(
	deps: Pick<RunnerHostDeps, 'exec' | 'isRoot' | 'nodeName' | 'user' | 'state'>,
	dir: string,
	argv: string[]
): Promise<RunnerExecResult> {
	if (deps.isRoot()) {
		return deps.exec({ command: argv[0], args: argv.slice(1), cwd: dir, timeoutMs: SERVICE_TIMEOUT_MS });
	}
	const result = await deps.exec({ command: 'sudo', args: ['-n', '--', ...argv], cwd: dir, timeoutMs: SERVICE_TIMEOUT_MS });
	if (result.spawnError === 'ENOENT' || (result.code !== 0 && isSudoRefusal(result.stderr))) {
		throw new RunnerHostError(
			`Installing a service on ${deps.nodeName} needs passwordless sudo for the node's user. Run this once on ${deps.nodeName}: ${linuxSudoersCommand(deps.user, deps.state.root)}`,
			'root_required'
		);
	}
	return result;
}

/**
 * Refuse BEFORE anything is registered when the service install could not
 * run (U4, U5): Linux asks sudo whether `svc.sh` may run without a password
 * (`sudo -n -l`, nothing is executed); Windows checks the node runs elevated.
 */
export async function assertCanInstallService(deps: RunnerHostDeps, dir: string): Promise<void> {
	const manager = runnerServiceManagerFor(deps.platform, deps.hasSystemd());
	if (!manager) throw new RunnerHostError(`no service manager was found on ${deps.nodeName}`, 'unsupported_on_node');
	if (manager === 'systemd' && !deps.isRoot()) {
		const probe = await deps.exec({
			command: 'sudo',
			args: ['-n', '-l', '--', join(dir, 'svc.sh')],
			cwd: dir,
			timeoutMs: 15_000
		});
		if (probe.spawnError || probe.code !== 0) {
			throw new RunnerHostError(
				`Installing a service on ${deps.nodeName} needs passwordless sudo for the node's user. Run this once on ${deps.nodeName}: ${linuxSudoersCommand(deps.user, deps.state.root)}`,
				'root_required'
			);
		}
	}
	if (manager === 'windows' && !(await deps.isElevated())) {
		throw new RunnerHostError(
			`Installing a runner service on ${deps.nodeName} needs the Ever Works node to run elevated. Open PowerShell as Administrator on ${deps.nodeName} and run: ${WINDOWS_ELEVATED_COMMAND}`,
			'root_required'
		);
	}
}

/** Install the service (Linux / macOS through `svc.sh`; Windows did it in `config --runasservice`) and start it. */
export async function installRunnerService(deps: RunnerHostDeps, dir: string, meta: RunnerMeta): Promise<string> {
	const manager = runnerServiceManagerFor(deps.platform, deps.hasSystemd());
	if (manager === 'systemd') {
		const svc = join(dir, 'svc.sh');
		const install = await sudoRun(deps, dir, [svc, 'install', deps.user]);
		if (install.code !== 0) throw new RunnerHostError(`could not install the service: ${firstOutputLine(install, 'svc.sh install failed')}`);
		const start = await sudoRun(deps, dir, [svc, 'start']);
		if (start.code !== 0) throw new RunnerHostError(`could not start the service: ${firstOutputLine(start, 'svc.sh start failed')}`);
	} else if (manager === 'launchd') {
		for (const verb of ['install', 'start'] as const) {
			const { command, args } = runnerScriptCommand(deps.platform, dir, 'svc', [verb]);
			const result = await deps.exec({ command, args, cwd: dir, timeoutMs: SERVICE_TIMEOUT_MS });
			if (result.spawnError || result.code !== 0) {
				throw new RunnerHostError(`could not ${verb} the service: ${firstOutputLine(result, `svc.sh ${verb} failed`)}`);
			}
		}
	} else if (manager === 'windows') {
		const name = (await serviceNameOf(deps, meta)) ?? defaultRunnerServiceName(meta, deps.platform);
		const start = await deps.exec({ command: 'sc.exe', args: ['start', name], timeoutMs: SERVICE_TIMEOUT_MS });
		// 1056: already running — config --runasservice usually starts it itself.
		if (start.code !== 0 && start.code !== 1056) {
			throw new RunnerHostError(`could not start the service: ${firstOutputLine(start, 'sc.exe start failed')}`);
		}
	} else {
		throw new RunnerHostError(`no service manager was found on ${deps.nodeName}`, 'unsupported_on_node');
	}
	return (await serviceNameOf(deps, meta)) ?? defaultRunnerServiceName(meta, deps.platform);
}

/** Start, stop or restart the runner's service (FR-15). */
export async function controlRunnerService(
	deps: RunnerHostDeps,
	dir: string,
	meta: RunnerMeta,
	action: 'start' | 'stop' | 'restart'
): Promise<void> {
	const steps: Array<'start' | 'stop'> = action === 'restart' ? ['stop', 'start'] : [action];
	const manager = runnerServiceManagerFor(deps.platform, deps.hasSystemd());
	for (const step of steps) {
		let result: RunnerExecResult;
		if (manager === 'systemd') {
			result = await sudoRun(deps, dir, [join(dir, 'svc.sh'), step]);
		} else if (manager === 'launchd') {
			const { command, args } = runnerScriptCommand(deps.platform, dir, 'svc', [step]);
			result = await deps.exec({ command, args, cwd: dir, timeoutMs: SERVICE_TIMEOUT_MS });
		} else if (manager === 'windows') {
			if (!(await deps.isElevated())) {
				throw new RunnerHostError(
					`Controlling a runner service on ${deps.nodeName} needs the Ever Works node to run elevated. Open PowerShell as Administrator on ${deps.nodeName} and run: ${WINDOWS_ELEVATED_COMMAND}`,
					'root_required'
				);
			}
			const name = (await serviceNameOf(deps, meta)) ?? defaultRunnerServiceName(meta, deps.platform);
			result = await deps.exec({ command: 'sc.exe', args: [step, name], timeoutMs: SERVICE_TIMEOUT_MS });
			// 1056 already running, 1062 not started: the state asked for already holds.
			if (result.code === 1056 || result.code === 1062) continue;
		} else {
			throw new RunnerHostError(`no service manager was found on ${deps.nodeName}`, 'unsupported_on_node');
		}
		if (result.spawnError || result.code !== 0) {
			throw new RunnerHostError(`could not ${step} ${meta.name}: ${firstOutputLine(result, `${step} failed`)}`);
		}
	}
}

/**
 * Uninstall the service (Linux / macOS `svc.sh uninstall`; Windows: `config remove`
 * does it, and `sc.exe delete` takes back a service it left — 1060 "no such service"
 * is the state asked for). Best-effort on Windows and macOS.
 */
export async function uninstallRunnerService(deps: RunnerHostDeps, dir: string, meta?: RunnerMeta | null): Promise<void> {
	const manager = runnerServiceManagerFor(deps.platform, deps.hasSystemd());
	if (manager === 'systemd') {
		await sudoRun(deps, dir, [join(dir, 'svc.sh'), 'stop']).catch(() => undefined);
		await sudoRun(deps, dir, [join(dir, 'svc.sh'), 'uninstall']);
	} else if (manager === 'launchd') {
		for (const verb of ['stop', 'uninstall'] as const) {
			const { command, args } = runnerScriptCommand(deps.platform, dir, 'svc', [verb]);
			await deps.exec({ command, args, cwd: dir, timeoutMs: SERVICE_TIMEOUT_MS }).catch(() => undefined);
		}
	} else if (manager === 'windows' && meta) {
		const name = (await serviceNameOf(deps, meta).catch(() => null)) ?? defaultRunnerServiceName(meta, deps.platform);
		await deps.exec({ command: 'sc.exe', args: ['stop', name], timeoutMs: SERVICE_TIMEOUT_MS }).catch(() => undefined);
		await deps.exec({ command: 'sc.exe', args: ['delete', name], timeoutMs: SERVICE_TIMEOUT_MS }).catch(() => undefined);
	}
}

/** The unit / launchd label / Windows service name, from the runner's `.service` file. */
export async function serviceNameOf(deps: Pick<RunnerHostDeps, 'state' | 'platform'>, meta: Pick<RunnerMeta, 'name'>): Promise<string | null> {
	const raw = await deps.state.serviceFile(meta.name);
	if (!raw) return null;
	// macOS writes the LaunchAgent's plist path; its label is the file name without `.plist`.
	if (deps.platform === 'darwin') return basename(raw).replace(/\.plist$/, '');
	return raw;
}

/** What the service manager says about one runner (`runner.list`, FR-13). */
export async function runnerServiceState(deps: RunnerHostDeps, meta: RunnerMeta): Promise<FleetActionsRunnerServiceState> {
	const name = await serviceNameOf(deps, meta);
	const manager = runnerServiceManagerFor(deps.platform, deps.hasSystemd());
	if (!name || !manager) return meta.configured ? 'missing' : 'unknown';
	if (manager === 'systemd') {
		const result = await deps.exec({ command: 'systemctl', args: ['is-active', name], timeoutMs: 10_000 });
		const answer = result.stdout.trim();
		if (answer === 'active' || answer === 'reloading' || answer === 'activating') return 'running';
		if (answer === 'inactive' || answer === 'failed' || answer === 'deactivating') return 'stopped';
		return 'unknown';
	}
	if (manager === 'launchd') {
		const result = await deps.exec({ command: 'launchctl', args: ['list', name], timeoutMs: 10_000 });
		if (result.code !== 0) return 'stopped';
		return /"PID"\s*=\s*\d+/.test(result.stdout) ? 'running' : 'stopped';
	}
	const result = await deps.exec({ command: 'sc.exe', args: ['query', name], timeoutMs: 10_000 });
	if (result.code === 1060) return 'missing';
	if (/STATE\s*:\s*\d+\s+RUNNING/i.test(result.stdout)) return 'running';
	if (/STATE\s*:\s*\d+\s+(STOPPED|STOP_PENDING|PAUSED)/i.test(result.stdout)) return 'stopped';
	return 'unknown';
}
