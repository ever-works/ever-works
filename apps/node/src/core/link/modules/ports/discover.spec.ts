import { describe, expect, it } from 'vitest';
import type { CommandRunner } from '../../../capabilities';
import {
	discoverListeners,
	parseLsofListeners,
	parseSsListeners,
	parseWindowsListeners,
	splitHostPort
} from './discover';

const SS_WITH_PROCESSES = [
	'LISTEN 0      4096         0.0.0.0:22         0.0.0.0:*    users:(("sshd",pid=812,fd=3))',
	'LISTEN 0      511          0.0.0.0:3000       0.0.0.0:*    users:(("node",pid=4812,fd=21))',
	'LISTEN 0      511                *:5173             *:*    users:(("node",pid=4901,fd=24))',
	'LISTEN 0      244        127.0.0.1:5432       0.0.0.0:*    users:(("postgres",pid=990,fd=6))',
	'LISTEN 0      4096   127.0.0.53%lo:53         0.0.0.0:*    users:(("systemd-resolve",pid=600,fd=14))',
	'LISTEN 0      4096            [::]:22            [::]:*    users:(("sshd",pid=812,fd=4))'
].join('\n');

const SS_WITHOUT_PROCESSES = ['LISTEN 0 4096 0.0.0.0:8080 0.0.0.0:*', 'LISTEN 0 4096 [::1]:9000 [::]:*'].join('\n');

const LSOF = [
	'p4812',
	'cnode',
	'f21',
	'n*:3000',
	'p990',
	'cpostgres',
	'f6',
	'n127.0.0.1:5432',
	'f7',
	'n[::1]:5432'
].join('\n');

const WINDOWS = JSON.stringify([
	{ a: '0.0.0.0', port: 135, pid: 1100, name: 'svchost', path: null },
	{ a: '127.0.0.1', port: 3000, pid: 7000, name: 'node', path: 'C:\\Program Files\\nodejs\\node.exe' },
	{ a: '::', port: 445, pid: 4, name: 'System', path: null }
]);

describe('splitHostPort', () => {
	it('reads every address shape the tools print', () => {
		expect(splitHostPort('[::]:22')).toEqual({ bind: '::', port: 22 });
		expect(splitHostPort('127.0.0.53%lo:53')).toEqual({ bind: '127.0.0.53', port: 53 });
		expect(splitHostPort('*:80')).toEqual({ bind: '0.0.0.0', port: 80 });
		expect(splitHostPort('nonsense')).toBeNull();
		expect(splitHostPort('1.2.3.4:99999')).toBeNull();
	});
});

describe('parseSsListeners', () => {
	it('keeps program and PID when ss may print them, one row per bind', () => {
		const rows = parseSsListeners(SS_WITH_PROCESSES);
		expect(rows).toContainEqual({ port: 3000, bind: '0.0.0.0', pid: 4812, program: 'node' });
		expect(rows).toContainEqual({ port: 5432, bind: '127.0.0.1', pid: 990, program: 'postgres' });
		expect(rows.filter((row) => row.port === 22)).toHaveLength(2);
	});

	it('keeps listeners with an unknown PID when -p is not permitted', () => {
		expect(parseSsListeners(SS_WITHOUT_PROCESSES)).toEqual([
			{ port: 8080, bind: '0.0.0.0', pid: null, program: null },
			{ port: 9000, bind: '::1', pid: null, program: null }
		]);
	});
});

describe('parseLsofListeners', () => {
	it('attributes each name to its process', () => {
		expect(parseLsofListeners(LSOF)).toEqual([
			{ port: 3000, bind: '0.0.0.0', pid: 4812, program: 'node' },
			{ port: 5432, bind: '127.0.0.1', pid: 990, program: 'postgres' },
			{ port: 5432, bind: '::1', pid: 990, program: 'postgres' }
		]);
	});
});

describe('parseWindowsListeners', () => {
	it('reads the JSON array and a single object', () => {
		const rows = parseWindowsListeners(WINDOWS);
		expect(rows).toHaveLength(3);
		expect(rows[1]).toMatchObject({ port: 3000, bind: '127.0.0.1', pid: 7000, program: 'node' });
		expect(parseWindowsListeners(JSON.stringify({ a: '0.0.0.0', port: 80, pid: 9, name: 'nginx' }))).toHaveLength(
			1
		);
		expect(parseWindowsListeners('not json')).toEqual([]);
	});
});

describe('discoverListeners', () => {
	const runner = (
		answers: Record<string, { code: number | null; stdout?: string; stderr?: string; spawnError?: string }>
	) =>
		({
			run: async (command: string, args: string[]) => {
				const answer = answers[`${command} ${args[0]}`] ?? { code: 1 };
				return {
					code: answer.code,
					stdout: answer.stdout ?? '',
					stderr: answer.stderr ?? '',
					...(answer.spawnError ? { spawnError: answer.spawnError } : {})
				};
			}
		}) as CommandRunner;

	it('falls back to ss without -p', async () => {
		const outcome = await discoverListeners(
			runner({
				'ss -tlnpH': { code: 1, stderr: 'Operation not permitted' },
				'ss -tlnH': { code: 0, stdout: SS_WITHOUT_PROCESSES }
			}),
			'linux'
		);
		expect(outcome).toMatchObject({ ok: true, tool: 'ss' });
	});

	it('reports a missing tool as missing (spec U5)', async () => {
		const outcome = await discoverListeners(runner({ 'ss -tlnpH': { code: null, spawnError: 'ENOENT' } }), 'linux');
		expect(outcome).toMatchObject({ ok: false, reason: 'missing', tool: 'ss' });
	});

	it('treats lsof exit 1 as an empty list', async () => {
		const outcome = await discoverListeners(runner({ 'lsof -nP': { code: 1, stdout: '' } }), 'darwin');
		expect(outcome).toEqual({ ok: true, tool: 'lsof', listeners: [] });
	});
});
