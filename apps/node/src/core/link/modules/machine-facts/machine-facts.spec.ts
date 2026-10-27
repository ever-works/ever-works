import { describe, expect, it } from 'vitest';
import type { CommandRunner } from '../../../capabilities';
import { isNodeService, serviceBlastRadius, serviceBlastRadiusKind, type BlastRadiusContext } from './blast-radius';
import { machineChildEnv } from './exec';
import { parseAppleDisplays, parseNvidiaSmi, parseWindowsVideoControllers } from './gpu-stats';
import {
	launchdState,
	parseBrewServices,
	parseLaunchctlDisabled,
	parseLaunchctlList,
	parseLaunchctlPrintServices
} from './launchd-manager';
import { encodePowerShell, psLiteral } from './powershell';
import {
	nameFromCommand,
	parseElapsed,
	parsePsRows,
	parseWindowsProcesses,
	safeCommandLine,
	topProcesses
} from './process-list';
import { createRootRunner, isSudoRefusal, renderPosixCommand } from './root-runner';
import { markProtected, nodeAncestry, protectionOf } from './self-protection';
import {
	parseSystemdJsonUnits,
	parseSystemdShow,
	parseSystemdTextUnits,
	parseSystemdTimestamp,
	parseSystemdUnitFiles,
	systemdAtBoot,
	systemdState,
	systemdUnitName
} from './systemd-manager';
import { parseWindowsServices, windowsActionCommand, windowsState } from './windows-services';

/**
 * FL-09 P1 — the machine-facts building blocks: the root rule, the
 * blast-radius table, the per-OS parsers, and self-protection. Every parser
 * is fed what the real tool prints; every child is a fake.
 */

type Call = { command: string; args: string[] };

function fakeRunner(answer: (call: Call) => { code: number; stdout?: string; stderr?: string; spawnError?: string }): {
	runner: CommandRunner;
	calls: Call[];
} {
	const calls: Call[] = [];
	return {
		calls,
		runner: {
			run: async (command, args) => {
				const call = { command, args: [...args] };
				calls.push(call);
				const result = answer(call);
				return {
					code: result.code,
					stdout: result.stdout ?? '',
					stderr: result.stderr ?? '',
					...(result.spawnError ? { spawnError: result.spawnError } : {})
				};
			}
		}
	};
}

describe('machineChildEnv', () => {
	it('keeps only what the tools need and never a credential', () => {
		const env = machineChildEnv({
			PATH: '/usr/bin',
			HOME: '/home/ops',
			XDG_RUNTIME_DIR: '/run/user/1000',
			EVER_WORKS_NODE_SECRET: 'nope',
			GITHUB_TOKEN: 'ghp_x',
			AWS_SECRET_ACCESS_KEY: 'x'
		});
		expect(env.PATH).toBe('/usr/bin');
		expect(env.XDG_RUNTIME_DIR).toBe('/run/user/1000');
		expect(env.LC_ALL).toBe('C');
		expect(env).not.toHaveProperty('EVER_WORKS_NODE_SECRET');
		expect(env).not.toHaveProperty('GITHUB_TOKEN');
		expect(env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
	});
});

describe('root runner (FR-4)', () => {
	it('recognises sudo -n refusals', () => {
		expect(isSudoRefusal('sudo: a password is required')).toBe(true);
		expect(isSudoRefusal('sudo: a terminal is required to read the password')).toBe(true);
		expect(isSudoRefusal('ops is not in the sudoers file.  This incident will be reported.')).toBe(true);
		expect(isSudoRefusal('Job for nginx.service failed because the control process exited')).toBe(false);
	});

	it('renders the exact command a person types', () => {
		expect(renderPosixCommand(['systemctl', 'restart', 'nginx'])).toBe('systemctl restart nginx');
		expect(renderPosixCommand(['kill', '-TERM', '4812'])).toBe('kill -TERM 4812');
		expect(renderPosixCommand(['echo', "it's"])).toBe(`echo 'it'\\''s'`);
	});

	it('runs plain when root is not needed', async () => {
		const { runner, calls } = fakeRunner(() => ({ code: 0 }));
		const root = createRootRunner({ runner, platform: 'linux', isRoot: () => false });
		const outcome = await root.run({ argv: ['systemctl', '--user', 'restart', 'x.service'], needsRoot: false });
		expect(outcome.ok).toBe(true);
		expect(calls[0]).toEqual({ command: 'systemctl', args: ['--user', 'restart', 'x.service'] });
	});

	it('uses sudo -n, never -S, and refuses with the command when sudo wants a password', async () => {
		const { runner, calls } = fakeRunner(() => ({ code: 1, stderr: 'sudo: a password is required' }));
		const root = createRootRunner({ runner, platform: 'linux', isRoot: () => false });
		const outcome = await root.run({
			argv: ['systemctl', '--no-ask-password', 'restart', '--', 'nginx.service'],
			display: ['systemctl', 'restart', 'nginx'],
			needsRoot: true
		});
		expect(outcome).toEqual({ ok: false, command: 'sudo systemctl restart nginx', shell: 'sh' });
		expect(calls[0].command).toBe('sudo');
		expect(calls[0].args.slice(0, 2)).toEqual(['-n', '--']);
		expect(calls.flatMap((call) => call.args)).not.toContain('-S');
		// A second click within the cache window does not ask sudo again.
		await root.run({ argv: ['systemctl', '--no-ask-password', 'restart', '--', 'nginx.service'], needsRoot: true });
		expect(calls).toHaveLength(1);
		expect(root.preauthorized(['systemctl', '--no-ask-password', 'restart', '--', 'nginx.service'])).toBe(false);
	});

	it('runs through sudo when the machine already allows it', async () => {
		const { runner } = fakeRunner(() => ({ code: 0, stdout: '' }));
		const root = createRootRunner({ runner, platform: 'linux', isRoot: () => false });
		const outcome = await root.run({ argv: ['systemctl', 'start', 'nginx.service'], needsRoot: true });
		expect(outcome).toMatchObject({ ok: true, viaSudo: true });
		expect(root.preauthorized()).toBe(true);
	});

	it('runs plain as root', async () => {
		const { runner, calls } = fakeRunner(() => ({ code: 0 }));
		const root = createRootRunner({ runner, platform: 'linux', isRoot: () => true });
		await root.run({ argv: ['systemctl', 'start', 'nginx.service'], needsRoot: true });
		expect(calls[0].command).toBe('systemctl');
	});

	it('refuses a Windows admin act at once when the node is not elevated (U9)', async () => {
		const { runner, calls } = fakeRunner(() => ({ code: 0, stdout: 'False\r\n' }));
		const root = createRootRunner({ runner, platform: 'win32' });
		const outcome = await root.runPowerShell({
			script: 'Restart-Service -Name W3SVC',
			displayCommand: 'Restart-Service -Name W3SVC',
			needsAdmin: true
		});
		expect(outcome).toEqual({ ok: false, command: 'Restart-Service -Name W3SVC', shell: 'powershell' });
		expect(calls).toHaveLength(1); // only the admin probe ran
	});
});

describe('PowerShell without a shell string', () => {
	it('encodes the script as UTF-16LE base64', () => {
		expect(Buffer.from(encodePowerShell('Get-Service'), 'base64').toString('utf16le')).toBe('Get-Service');
	});

	it('quotes only validated names', () => {
		expect(psLiteral('W3SVC')).toBe("'W3SVC'");
		expect(psLiteral('MSSQL$SQLEXPRESS')).toBe("'MSSQL$SQLEXPRESS'");
		expect(() => psLiteral("x'; Remove-Item C:\\ -Recurse; '")).toThrow();
		expect(() => psLiteral('$(whoami)')).toThrow();
		expect(() => psLiteral('a`b')).toThrow();
	});
});

describe('blast radius (FR-5)', () => {
	const linux: BlastRadiusContext = { platform: 'linux', machine: 'build-01', nodePids: [912] };

	it.each([
		['NetworkManager', 'network'],
		['systemd-networkd', 'network'],
		['sshd', 'ssh'],
		['ssh', 'ssh'],
		['tailscaled', 'vpn'],
		['wg-quick@wg0', 'vpn'],
		['ever-works-node@ops', 'node']
	] as const)('names %s on Linux as %s', (name, kind) => {
		expect(serviceBlastRadiusKind({ name, manager: 'systemd' }, linux)).toBe(kind);
	});

	it('matches with or without the .service suffix and leaves an ordinary service alone', () => {
		expect(serviceBlastRadiusKind({ name: 'sshd.service', manager: 'systemd' }, linux)).toBe('ssh');
		expect(serviceBlastRadius({ name: 'nginx', manager: 'systemd' }, linux)).toBeNull();
		expect(serviceBlastRadius({ name: 'postgresql', manager: 'systemd' }, linux)).toBeNull();
	});

	it('says the network sentence of spec S4', () => {
		expect(serviceBlastRadius({ name: 'NetworkManager', manager: 'systemd' }, linux)?.sentence).toBe(
			'This stops the network service build-01 connects to Ever Works through. You would need to be at the machine to bring it back.'
		);
	});

	it('treats Docker as a blast radius only when containers are computers (FL-16)', () => {
		expect(serviceBlastRadiusKind({ name: 'docker', manager: 'systemd' }, linux)).toBeNull();
		expect(
			serviceBlastRadiusKind({ name: 'docker', manager: 'systemd' }, { ...linux, hostsChildNodes: true })
		).toBe('docker');
	});

	it('knows the node by its pid whatever its unit is called', () => {
		expect(isNodeService({ name: 'my-agent-box', manager: 'systemd', pid: 912 }, linux)).toBe(true);
		expect(isNodeService({ name: 'my-agent-box', manager: 'systemd', pid: 913 }, linux)).toBe(false);
	});

	it('covers Windows and macOS names', () => {
		const win: BlastRadiusContext = { platform: 'win32', machine: 'win-lab', nodePids: [] };
		expect(serviceBlastRadiusKind({ name: 'Dnscache', manager: 'windows' }, win)).toBe('network');
		expect(serviceBlastRadiusKind({ name: 'sshd', manager: 'windows' }, win)).toBe('ssh');
		expect(serviceBlastRadiusKind({ name: 'Tailscale', manager: 'windows' }, win)).toBe('vpn');
		expect(serviceBlastRadiusKind({ name: 'EverWorksNode', manager: 'windows' }, win)).toBe('node');
		expect(serviceBlastRadiusKind({ name: 'W3SVC', manager: 'windows' }, win)).toBeNull();
		const mac: BlastRadiusContext = { platform: 'darwin', machine: 'design-mac', nodePids: [] };
		expect(serviceBlastRadiusKind({ name: 'com.openssh.sshd', manager: 'launchd' }, mac)).toBe('ssh');
		expect(serviceBlastRadiusKind({ name: 'homebrew.mxcl.tailscale', manager: 'brew' }, mac)).toBe('vpn');
	});
});

describe('systemd parsers', () => {
	it('reads list-units JSON', () => {
		const units = parseSystemdJsonUnits(
			JSON.stringify([
				{
					unit: 'postgresql.service',
					load: 'loaded',
					active: 'failed',
					sub: 'failed',
					description: 'PostgreSQL'
				},
				{ unit: 'nginx.service', load: 'loaded', active: 'active', sub: 'running', description: 'nginx' }
			])
		);
		expect(units?.map((unit) => unit.unit)).toEqual(['postgresql.service', 'nginx.service']);
		expect(parseSystemdJsonUnits('not json')).toBeNull();
	});

	it('reads the plain text table, failed bullets included', () => {
		const units = parseSystemdTextUnits(
			[
				'● postgresql.service loaded failed failed PostgreSQL RDBMS',
				'  nginx.service      loaded active running A high performance web server'
			].join('\n')
		);
		expect(units).toEqual([
			{
				unit: 'postgresql.service',
				load: 'loaded',
				active: 'failed',
				sub: 'failed',
				description: 'PostgreSQL RDBMS'
			},
			{
				unit: 'nginx.service',
				load: 'loaded',
				active: 'active',
				sub: 'running',
				description: 'A high performance web server'
			}
		]);
	});

	it('maps unit-file states to at boot', () => {
		const files = parseSystemdUnitFiles('nginx.service enabled enabled\ngetty@.service static -\n');
		expect(systemdAtBoot(files.get('nginx.service'))).toEqual({ atBoot: true, toggleable: true });
		expect(systemdAtBoot('disabled')).toEqual({ atBoot: false, toggleable: true });
		expect(systemdAtBoot('static')).toEqual({ atBoot: null, toggleable: false });
	});

	it('reads show blocks, timestamps and exit codes', () => {
		const shown = parseSystemdShow(
			[
				'Id=postgresql.service',
				'MainPID=0',
				'ActiveEnterTimestamp=Tue 2026-10-21 09:12:03 UTC',
				'ExecMainStatus=1',
				'',
				'Id=nginx.service',
				'MainPID=1234',
				'ActiveEnterTimestamp=@1761037923',
				'ExecMainStatus=0'
			].join('\n'),
			new Date('2026-10-21T12:00:00Z')
		);
		expect(shown[0]).toMatchObject({
			id: 'postgresql.service',
			mainPid: null,
			exitStatus: 1,
			since: '2026-10-21T09:12:03.000Z'
		});
		expect(shown[1]).toMatchObject({
			id: 'nginx.service',
			mainPid: 1234,
			since: new Date(1761037923000).toISOString()
		});
		expect(parseSystemdTimestamp('n/a')).toBeNull();
	});

	it('maps states and unit names', () => {
		expect(systemdState('failed')).toBe('failed');
		expect(systemdState('active', 'running')).toBe('running');
		expect(systemdState('activating', 'auto-restart')).toBe('failed');
		expect(systemdState('inactive')).toBe('inactive');
		expect(systemdUnitName('nginx')).toBe('nginx.service');
		expect(systemdUnitName('nginx.service')).toBe('nginx.service');
	});
});

describe('launchd and Homebrew parsers', () => {
	it('reads launchctl list and the services block of launchctl print', () => {
		expect(
			parseLaunchctlList(
				'PID\tStatus\tLabel\n-\t0\tcom.example.idle\n412\t0\tcom.example.up\n-\t78\tcom.example.broken\n'
			)
		).toEqual([
			{ pid: null, status: 0, label: 'com.example.idle' },
			{ pid: 412, status: 0, label: 'com.example.up' },
			{ pid: null, status: 78, label: 'com.example.broken' }
		]);
		const printed = parseLaunchctlPrintServices(
			[
				'system = {',
				'\tservices = {',
				'\t\t       0      -9 \tcom.apple.a',
				'\t\t     123       0 \tcom.openssh.sshd',
				'\t}',
				'}'
			].join('\n')
		);
		expect(printed).toEqual([
			{ pid: null, status: -9, label: 'com.apple.a' },
			{ pid: 123, status: 0, label: 'com.openssh.sshd' }
		]);
		expect(launchdState(null, 78)).toBe('failed');
		expect(launchdState(123, 0)).toBe('running');
	});

	it('reads the disabled list in both spellings', () => {
		const disabled = parseLaunchctlDisabled(
			'disabled services = {\n\t"com.a" => disabled\n\t"com.b" => enabled\n\t"com.c" => true\n}'
		);
		expect(disabled.get('com.a')).toBe(true);
		expect(disabled.get('com.b')).toBe(false);
		expect(disabled.get('com.c')).toBe(true);
	});

	it('reads brew services --json', () => {
		const rows = parseBrewServices(
			JSON.stringify([
				{ name: 'postgresql@16', status: 'started', pid: 501, loaded: true },
				{ name: 'redis', status: 'error', exit_code: 1, loaded: true },
				{ name: 'nginx', status: 'none', loaded: false }
			])
		);
		expect(rows.map((row) => [row.name, row.state])).toEqual([
			['postgresql@16', 'running'],
			['redis', 'failed'],
			['nginx', 'inactive']
		]);
	});
});

describe('Windows services', () => {
	it('shows an automatic service that stopped with an error as failed', () => {
		expect(windowsState('Stopped', 'Auto', 1)).toBe('failed');
		expect(windowsState('Stopped', 'Auto', 1077)).toBe('inactive');
		expect(windowsState('Stopped', 'Manual', 1)).toBe('inactive');
		expect(windowsState('Running', 'Auto', 0)).toBe('running');
	});

	it('reads one or many CIM rows', () => {
		const one = parseWindowsServices(
			JSON.stringify({
				Name: 'W3SVC',
				DisplayName: 'World Wide Web Publishing Service',
				State: 'Running',
				StartMode: 'Auto',
				ProcessId: 4100,
				ExitCode: 0
			})
		);
		expect(one[0]).toMatchObject({ name: 'W3SVC', state: 'running', atBoot: true, pid: 4100 });
		const many = parseWindowsServices(
			JSON.stringify([{ Name: 'a', State: 'Stopped', StartMode: 'Disabled', ProcessId: 0, ExitCode: 0 }])
		);
		expect(many[0]).toMatchObject({ name: 'a', state: 'inactive', atBoot: false, disabled: true, pid: null });
	});

	it('words the elevated command of spec U9', () => {
		expect(windowsActionCommand('W3SVC', 'restart')).toBe('Restart-Service -Name W3SVC');
		expect(windowsActionCommand('W3SVC', 'disable')).toBe('Set-Service -Name W3SVC -StartupType Disabled');
	});
});

describe('process list (FR-9, FR-10)', () => {
	it('reads Linux ps rows and scans command lines', () => {
		const rows = parsePsRows(
			[
				' 4812     1 ops        97.0 1258291  724 node ./dist/worker.js --queue builds',
				'    1     0 root        0.0  11264 259200 /sbin/init splash',
				' 3301  3300 postgres   12.4 419840 259200 postgres: checkpointer',
				'  777     1 ops         0.1   2048    60 curl -H Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789 https://x'
			].join('\n'),
			'linux'
		);
		expect(rows[0]).toMatchObject({
			pid: 4812,
			ppid: 1,
			owner: 'ops',
			cpuPercent: 97,
			runtimeSec: 724,
			name: 'node'
		});
		expect(rows[0].memBytes).toBe(1258291 * 1024);
		expect(rows[2].name).toBe('postgres');
		expect(rows[3].command).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
	});

	it('cuts a command line at 200 characters after scanning it', () => {
		expect(safeCommandLine('x'.repeat(500)).length).toBe(200);
	});

	it('reads macOS elapsed times and kernel thread names', () => {
		expect(parseElapsed('12:04')).toBe(724);
		expect(parseElapsed('3-01:00:00')).toBe(3 * 86400 + 3600);
		expect(nameFromCommand('[kthreadd]')).toBe('kthreadd');
		expect(nameFromCommand('/usr/local/bin/node cli.js')).toBe('node');
	});

	it('reads the Windows script answer', () => {
		const rows = parseWindowsProcesses(
			JSON.stringify([
				{
					Id: 4812,
					ParentId: 1000,
					Name: 'node',
					Cpu: 97,
					Mem: 1000,
					User: null,
					Start: '2026-10-21T09:00:00.000Z',
					CommandLine: 'node worker.js'
				}
			]),
			Date.parse('2026-10-21T09:10:00.000Z')
		);
		expect(rows[0]).toMatchObject({
			pid: 4812,
			ppid: 1000,
			cpuPercent: 97,
			runtimeSec: 600,
			command: 'node worker.js'
		});
	});

	it('keeps the busiest 300 by CPU, or the largest by memory', () => {
		const many = Array.from({ length: 400 }, (_, index) => ({
			pid: index + 2,
			ppid: 1,
			name: 'p',
			cpuPercent: index % 50,
			memBytes: 1000 - index,
			owner: 'ops',
			runtimeSec: 1,
			command: 'p'
		}));
		const top = topProcesses(many);
		expect(top).toHaveLength(300);
		expect(top[0].cpuPercent).toBe(49);
		expect(topProcesses(many, 'mem', 1)[0].pid).toBe(2);
	});
});

describe('GPU stats (FR-14)', () => {
	it('reads nvidia-smi with utilisation and memory', () => {
		const gpus = parseNvidiaSmi('NVIDIA GeForce RTX 4090, 61, 9420, 24564\n');
		expect(gpus[0]).toMatchObject({ vendor: 'nvidia', utilizationPercent: 61, memUsedBytes: 9420 * 1024 * 1024 });
	});

	it('reports Apple utilisation as null, never 0', () => {
		const gpus = parseAppleDisplays(
			JSON.stringify({ SPDisplaysDataType: [{ sppci_model: 'Apple M2 Max' }] }),
			38 * 1024 ** 3
		);
		expect(gpus[0]).toMatchObject({
			vendor: 'apple',
			model: 'Apple M2 Max',
			utilizationPercent: null,
			sharedMemory: true,
			memTotalBytes: 38 * 1024 ** 3
		});
	});

	it('ignores a saturated Windows AdapterRAM', () => {
		expect(
			parseWindowsVideoControllers(JSON.stringify({ Name: 'Intel(R) UHD Graphics', AdapterRAM: 4294967295 }))[0]
				.memTotalBytes
		).toBeNull();
	});
});

describe('self-protection (FR-12, U10)', () => {
	const processes = [
		{
			pid: 1,
			ppid: null,
			name: 'systemd',
			cpuPercent: 0,
			memBytes: 1,
			owner: 'root',
			runtimeSec: 1,
			command: '/sbin/init'
		},
		{ pid: 800, ppid: 1, name: 'bash', cpuPercent: 0, memBytes: 1, owner: 'ops', runtimeSec: 1, command: 'bash' },
		{
			pid: 912,
			ppid: 800,
			name: 'node',
			cpuPercent: 0.8,
			memBytes: 1,
			owner: 'ops',
			runtimeSec: 1,
			command: 'node cli.js start --manage'
		},
		{
			pid: 913,
			ppid: 912,
			name: 'node',
			cpuPercent: 0,
			memBytes: 1,
			owner: 'ops',
			runtimeSec: 1,
			command: 'node cli.js session-daemon --state-dir /x --socket /y'
		},
		{
			pid: 4812,
			ppid: 912,
			name: 'node',
			cpuPercent: 97,
			memBytes: 1,
			owner: 'ops',
			runtimeSec: 1,
			command: 'node worker.js'
		}
	];
	const context = { selfPid: 912, parentPid: 800 };

	it('protects init, the node, its ancestors and its daemon — not its children', () => {
		expect(nodeAncestry(processes, context)).toEqual([912, 800]);
		expect(protectionOf(1, processes, context)).toBe('init');
		expect(protectionOf(912, processes, context)).toBe('node');
		expect(protectionOf(800, processes, context)).toBe('node');
		expect(protectionOf(913, processes, context)).toBe('daemon');
		expect(protectionOf(4812, processes, context)).toBeNull();
		expect(markProtected(processes, processes, context).map((row) => row.protected)).toEqual([
			'init',
			'node',
			'node',
			'daemon',
			null
		]);
	});
});
