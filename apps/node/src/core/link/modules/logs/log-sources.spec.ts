import { describe, expect, it } from 'vitest';
import { parseDockerLine } from './container-source';
import { eventLogScript, parseEventLine, powershellArgs } from './event-log-source';
import { parseJournalLine } from './journal-source';
import { listLogSources, parseDockerPs, parseLaunchctlList, parseSystemctlUnits, parseWindowsServices } from './log-sources';
import type { LogDirEntry, LogFs, LogIo } from './log-io';
import { parseLaunchctlLogPaths } from './service-source';
import { parseUnifiedLogLine } from './unified-log-source';

/**
 * Logs on computers (FL-08, T-04 … T-06) — what each tool prints, read the way
 * the readers and the listing read it, and the listing's rules: four groups,
 * newest files first, `root-only`, the journal group hint, the Security log.
 */

describe('readers parse their tools', () => {
	it('journal JSON: priority, identifier, pid, cursor, a byte-array message', () => {
		const entry = parseJournalLine(
			JSON.stringify({
				__REALTIME_TIMESTAMP: '1792578062000000',
				__CURSOR: 's=abc;i=1',
				PRIORITY: '3',
				SYSLOG_IDENTIFIER: 'sshd',
				_PID: '812',
				MESSAGE: [104, 105]
			})
		);
		expect(entry).toMatchObject({ level: 'error', text: 'sshd[812]: hi', cursor: 's=abc;i=1' });
		expect(entry?.ts).toBe(new Date(1792578062000).toISOString());
		expect(parseJournalLine('-- Boot --')).toBeNull();
	});

	it('unified log ndjson: messageType and process', () => {
		expect(
			parseUnifiedLogLine(
				JSON.stringify({
					timestamp: '2026-10-21 09:41:02.123456+0000',
					messageType: 'Fault',
					eventMessage: 'boom',
					processImagePath: '/usr/sbin/sshd'
				})
			)
		).toEqual({ ts: '2026-10-21T09:41:02.123Z', level: 'error', text: 'sshd: boom' });
		expect(parseUnifiedLogLine('{"count":12,"finished":1}')).toBeNull();
	});

	it('event JSON: level, provider, a multi-line message', () => {
		expect(
			parseEventLine(
				JSON.stringify({ log: 'System', id: 9, ts: '2026-10-21T09:41:02.0000000Z', level: 3, provider: 'Disk', msg: 'slow\r\ndisk' })
			)
		).toEqual({ ts: '2026-10-21T09:41:02.000Z', level: 'warning', text: 'Disk: slow\ndisk', key: 'System:9' });
	});

	it('docker --timestamps lines', () => {
		expect(parseDockerLine('2026-10-21T09:41:02.123456789Z GET /health 200')).toEqual({
			ts: '2026-10-21T09:41:02.123Z',
			level: 'info',
			text: 'GET /health 200'
		});
	});

	it('the event-log script quotes names and never splices them into argv', () => {
		const script = eventLogScript({ logs: ['System', 'Application'], provider: 'Service Control Manager' }, 500, '2026-10-21T09:41:02.000Z');
		expect(script).toContain("-LogName 'System','Application' -MaxEvents 500");
		expect(script).toContain("Provider[@Name=''Service Control Manager'']");
		const args = powershellArgs(script);
		expect(args.slice(0, 5)).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand']);
		expect(Buffer.from(args[5]!, 'base64').toString('utf16le')).toBe(script);
	});

	it('launchctl print log paths', () => {
		expect(parseLaunchctlLogPaths('\tstdout path = /usr/local/var/log/nginx.log\n\tstderr path = /dev/null\n')).toEqual({
			stdout: '/usr/local/var/log/nginx.log',
			stderr: '/dev/null'
		});
	});
});

describe('service and container listings', () => {
	it('systemctl: running and failed units, nothing else', () => {
		const units = parseSystemctlUnits(
			[
				'nginx.service loaded active running A high performance web server',
				'postgresql.service loaded failed failed PostgreSQL',
				'cron.service loaded active exited Regular background program',
				'ghost.service not-found inactive dead ghost'
			].join('\n')
		);
		expect(units.map((u) => [u.label, u.state, u.failed])).toEqual([
			['nginx.service', 'running', false],
			['postgresql.service', 'failed', true]
		]);
	});

	it('launchctl list: running jobs and failed third-party jobs', () => {
		const jobs = parseLaunchctlList('PID\tStatus\tLabel\n412\t0\thomebrew.mxcl.nginx\n-\t78\thomebrew.mxcl.redis\n-\t1\tcom.apple.x\n');
		expect(jobs.map((j) => [j.label, j.state])).toEqual([
			['homebrew.mxcl.nginx', 'running'],
			['homebrew.mxcl.redis', 'failed (exit 78)']
		]);
	});

	it('Windows services: name and display name', () => {
		expect(parseWindowsServices('Spooler\tPrint Spooler\r\nbad$name\tX\r\n').map((s) => [s.id, s.label])).toEqual([
			['service:Spooler', 'Print Spooler']
		]);
	});

	it('docker ps: running first, exit codes in the state', () => {
		const containers = parseDockerPs('old-build\texited\tExited (1) 2 hours ago\nacme-api\trunning\tUp 3 hours\n');
		expect(containers.map((c) => [c.label, c.state])).toEqual([
			['acme-api', 'running'],
			['old-build', 'exited (1)']
		]);
	});
});

describe('listLogSources', () => {
	function io(platform: string, options: { elevated?: boolean; groups?: string; tree?: Record<string, LogDirEntry[]>; unreadable?: string[] }): LogIo {
		const tree = options.tree ?? {};
		const fs: LogFs = {
			realpath: async (path) => path,
			stat: async (path) => ({ size: 10, mtimeMs: path.endsWith('new.log') ? 2_000 : 1_000, ino: 1, isFile: true, isDirectory: false }),
			readdir: async (path) => tree[path] ?? [],
			canRead: async (path) => !(options.unreadable ?? []).includes(path),
			read: async () => new Uint8Array()
		};
		return {
			platform,
			homedir: '/home/ops',
			user: 'ops',
			fs,
			runner: {
				run: async (command: string) => {
					if (command === 'journalctl') return { code: 0, stdout: 'systemd 255', stderr: '' };
					if (command === 'id') return { code: 0, stdout: options.groups ?? 'ops', stderr: '' };
					return { code: 1, stdout: '', stderr: 'not here' };
				}
			},
			spawn: () => {
				throw new Error('no children');
			},
			isElevated: async () => options.elevated === true,
			now: () => Date.parse('2026-10-21T10:00:00.000Z'),
			setTimer: () => 0,
			clearTimer: () => undefined
		} as unknown as LogIo;
	}

	const file = (name: string): LogDirEntry => ({ name, isFile: true, isDirectory: false, isSymbolicLink: false });
	const dir = (name: string): LogDirEntry => ({ name, isFile: false, isDirectory: true, isSymbolicLink: false });

	it('lists the journal with the group hint, files newest first, root-only marked, binaries skipped', async () => {
		const list = await listLogSources({
			io: io('linux', {
				tree: {
					'/var/log': [file('old.log'), file('new.log'), file('auth.log'), file('syslog.2.gz'), file('wtmp'), dir('journal')],
					'/home/ops/code/api': [dir('storage'), file('README.md'), dir('node_modules')],
					'/home/ops/code/api/storage': [dir('logs')],
					'/home/ops/code/api/storage/logs': [file('laravel.log')]
				},
				unreadable: ['/var/log/auth.log']
			}),
			roots: [
				{ path: '/var/log', kind: 'log-dir' },
				{ path: '/home/ops/code/api', kind: 'checkout' }
			],
			nodeName: 'build-01'
		});
		const journal = list.sources.find((s) => s.id === 'system:journal');
		expect(journal).toMatchObject({ readable: true, unreadableReason: 'group-membership', hint: 'sudo usermod -aG systemd-journal ops' });
		const files = list.sources.filter((s) => s.kind === 'file');
		expect(files.map((f) => f.label)).toEqual([
			'/var/log/new.log',
			'/var/log/old.log',
			'/var/log/auth.log',
			'~/code/api/storage/logs/laravel.log'
		]);
		expect(files.find((f) => f.label === '/var/log/auth.log')).toMatchObject({ readable: false, unreadableReason: 'root-only' });
		expect(list.roots).toEqual(['/var/log', '~/code/api']);
	});

	it('lists the Security log as needs-admin without elevation (U7)', async () => {
		const list = await listLogSources({ io: io('win32', { elevated: false }), roots: [], nodeName: 'win-01' });
		expect(list.sources.map((s) => s.id)).toEqual(['system:event-system', 'system:event-application', 'system:event-security']);
		expect(list.sources[2]).toMatchObject({ readable: false, unreadableReason: 'needs-admin' });
	});
});
