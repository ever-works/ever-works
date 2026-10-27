import type { FleetServiceAction, FleetServiceState } from '@ever-works/contracts';
import type { CommandRunner } from '../../../capabilities';
import { firstLine } from './exec';
import { jsonScript, parseJsonList, POWERSHELL, powerShellArgs, psLiteral } from './powershell';
import type { RootRunner } from './root-runner';

/**
 * Machine facts (FL-09, plan §3) — Windows services.
 *
 * One CIM read gives every service with its state, start mode, main process
 * and last exit code. Windows has no "failed" state: a service set to start
 * automatically that is stopped with a non-zero exit code (other than 1077,
 * "never started since boot") is shown as failed, because that is what it is.
 *
 * Acts need administrator rights; a node that is not elevated refuses at once
 * under the root rule with the exact PowerShell line to run in an elevated
 * window (spec U9: `Restart-Service -Name W3SVC`). Every script is passed
 * `-EncodedCommand`, the name a validated literal (`powershell.ts`).
 */

export interface WindowsServiceRow {
	name: string;
	description: string | null;
	state: FleetServiceState;
	exitCode: number | null;
	atBoot: boolean | null;
	/** `Disabled` services cannot be started until their start mode changes. */
	disabled: boolean;
	pid: number | null;
}

const LIST_SCRIPT = jsonScript(
	'Get-CimInstance -ClassName Win32_Service | Select-Object Name,DisplayName,State,StartMode,ProcessId,ExitCode | ConvertTo-Json -Compress -Depth 2'
);

/** Win32_Service `State` → the tab's states. */
export function windowsState(state: string, startMode: string, exitCode: number | null): FleetServiceState {
	switch (state) {
		case 'Running':
			return 'running';
		case 'Start Pending':
		case 'Continue Pending':
			return 'activating';
		case 'Stop Pending':
		case 'Pause Pending':
			return 'deactivating';
		case 'Stopped':
			return startMode === 'Auto' && exitCode !== null && exitCode !== 0 && exitCode !== 1077
				? 'failed'
				: 'inactive';
		case 'Paused':
			return 'inactive';
		default:
			return 'unknown';
	}
}

export function parseWindowsServices(stdout: string): WindowsServiceRow[] {
	const out: WindowsServiceRow[] = [];
	for (const raw of parseJsonList(stdout)) {
		if (typeof raw.Name !== 'string' || !raw.Name) continue;
		const startMode = typeof raw.StartMode === 'string' ? raw.StartMode : '';
		const exitCode = typeof raw.ExitCode === 'number' ? raw.ExitCode : null;
		const state = windowsState(typeof raw.State === 'string' ? raw.State : '', startMode, exitCode);
		const pid = typeof raw.ProcessId === 'number' && raw.ProcessId > 0 ? raw.ProcessId : null;
		out.push({
			name: raw.Name,
			description: typeof raw.DisplayName === 'string' && raw.DisplayName !== raw.Name ? raw.DisplayName : null,
			state,
			exitCode: state === 'failed' ? exitCode : null,
			atBoot:
				startMode === 'Auto' || startMode === 'Boot' || startMode === 'System'
					? true
					: startMode
						? false
						: null,
			disabled: startMode === 'Disabled',
			pid: state === 'running' ? pid : null
		});
	}
	return out;
}

/** The line an owner runs in an elevated PowerShell for one act (spec §5.3). */
export function windowsActionCommand(name: string, action: FleetServiceAction): string {
	switch (action) {
		case 'start':
			return `Start-Service -Name ${name}`;
		case 'stop':
			return `Stop-Service -Name ${name}`;
		case 'restart':
			return `Restart-Service -Name ${name}`;
		case 'enable':
			return `Set-Service -Name ${name} -StartupType Automatic`;
		case 'disable':
			return `Set-Service -Name ${name} -StartupType Disabled`;
	}
}

function actionScript(name: string, action: FleetServiceAction): string {
	const literal = psLiteral(name);
	const act =
		action === 'start'
			? `Start-Service -Name ${literal}`
			: action === 'stop'
				? `Stop-Service -Name ${literal}`
				: action === 'restart'
					? `Restart-Service -Name ${literal}`
					: action === 'enable'
						? `Set-Service -Name ${literal} -StartupType Automatic`
						: `Set-Service -Name ${literal} -StartupType Disabled`;
	return jsonScript(
		[
			act,
			`Get-CimInstance -ClassName Win32_Service -Filter ("Name='" + ${literal} + "'") | Select-Object Name,DisplayName,State,StartMode,ProcessId,ExitCode | ConvertTo-Json -Compress -Depth 2`
		].join('\n')
	);
}

export interface WindowsServicesManager {
	list(): Promise<{ rows: WindowsServiceRow[]; error?: string }>;
	act(input: {
		name: string;
		action: FleetServiceAction;
	}): Promise<
		| { ok: true; row: WindowsServiceRow | null }
		| { ok: false; refusal: 'root'; command: string }
		| { ok: false; refusal: 'not-found' }
		| { ok: false; refusal: 'failed'; message: string }
	>;
}

export function createWindowsServicesManager(deps: {
	runner: CommandRunner;
	root: RootRunner;
}): WindowsServicesManager {
	const { runner, root } = deps;
	return {
		async list() {
			const result = await runner.run(POWERSHELL, powerShellArgs(LIST_SCRIPT), { timeoutMs: 20_000 });
			if (result.code !== 0) {
				return { rows: [], error: firstLine(result.stderr, `PowerShell exited ${result.code ?? 1}`) };
			}
			return { rows: parseWindowsServices(result.stdout) };
		},

		async act({ name, action }) {
			const outcome = await root.runPowerShell({
				script: actionScript(name, action),
				displayCommand: windowsActionCommand(name, action),
				needsAdmin: true,
				timeoutMs: 60_000
			});
			if (!outcome.ok) return { ok: false, refusal: 'root', command: outcome.command };
			if (outcome.code !== 0) {
				const message = firstLine(outcome.stderr || outcome.stdout, `PowerShell exited ${outcome.code ?? 1}`);
				if (/cannot find any service|NoServiceFoundForGivenName/i.test(message))
					return { ok: false, refusal: 'not-found' };
				if (/access is denied|PermissionDenied/i.test(message)) {
					return { ok: false, refusal: 'root', command: windowsActionCommand(name, action) };
				}
				return { ok: false, refusal: 'failed', message };
			}
			return { ok: true, row: parseWindowsServices(outcome.stdout)[0] ?? null };
		}
	};
}
