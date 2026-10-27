import { describe, expect, it } from 'vitest';
import { classifyListener, isSystemNoise, mergeByPort } from './classify';
import type { HttpProbeResult } from './http-probe';
import { extractTitle } from './http-probe';
import { StoppedPortTracker, waitingRows } from './watch-list';
import { parseDockerPorts, parseLsofCwd } from './join';

const web = (status: number, server: string | null = 'node', title: string | null = 'App'): HttpProbeResult => ({
	kind: 'http',
	scheme: 'http',
	status,
	title,
	server,
	probedAt: '2026-10-21T09:41:00.000Z'
});

describe('classifyListener', () => {
	it('a port that answers HTTP is a web server with its title and status', () => {
		const row = classifyListener({
			listener: { port: 3000, bind: '0.0.0.0', pid: 4812, program: 'node' },
			platform: 'linux',
			probe: web(200, 'node', 'Acme — Checkout'),
			program: { name: 'node', pid: 4812, cwd: '~/code/api' }
		});
		expect(row).toMatchObject({ kind: 'web', web: { status: 200, title: 'Acme — Checkout' }, localOnly: false });
	});

	it('marks a loopback-only port and keeps it a web server (spec S6)', () => {
		const row = classifyListener({
			listener: { port: 9000, bind: '127.0.0.1', pid: 1, program: 'minio' },
			platform: 'linux',
			probe: web(200)
		});
		expect(row.localOnly).toBe(true);
		expect(row.kind).toBe('web');
	});

	it('names a well-known other port and flags no HTTP answer (spec U6)', () => {
		const row = classifyListener({
			listener: { port: 5432, bind: '127.0.0.1', pid: 990, program: 'postgres' },
			platform: 'linux',
			probe: { kind: 'silent' }
		});
		expect(row).toMatchObject({ kind: 'other', wellKnown: 'postgres', noHttpAnswer: true });
	});

	it('hides Windows noise and never counts the built-in HTTP error page as a web server (spec U7)', () => {
		expect(
			classifyListener({
				listener: { port: 5357, bind: '0.0.0.0', pid: 4, program: 'System' },
				platform: 'win32',
				probe: web(503, 'Microsoft-HTTPAPI/2.0')
			}).kind
		).toBe('noise');
		expect(isSystemNoise({ port: 49670, bind: '0.0.0.0', pid: 900, program: 'lsass' }, 'win32')).toBe(true);
		expect(
			classifyListener({
				listener: { port: 8081, bind: '0.0.0.0', pid: 4, program: 'System' },
				platform: 'win32',
				probe: web(404, 'Microsoft-HTTPAPI/2.0')
			}).kind
		).toBe('noise');
		// A real site on HTTP.sys answers with its own server name.
		expect(
			classifyListener({
				listener: { port: 80, bind: '0.0.0.0', pid: 4, program: 'System' },
				platform: 'win32',
				probe: web(200, 'Microsoft-IIS/10.0')
			}).kind
		).toBe('web');
	});

	it('hides rpcbind, CUPS and the resolver stub on Unix', () => {
		expect(isSystemNoise({ port: 111, bind: '0.0.0.0', pid: 1, program: 'rpcbind' }, 'linux')).toBe(true);
		expect(isSystemNoise({ port: 53, bind: '127.0.0.53', pid: 1, program: null }, 'linux')).toBe(true);
		expect(isSystemNoise({ port: 53, bind: '0.0.0.0', pid: 1, program: 'dnsmasq' }, 'linux')).toBe(false);
	});
});

describe('mergeByPort', () => {
	it('keeps the widest bind of a dual-stack server', () => {
		const merged = mergeByPort([
			{ port: 3000, bind: '127.0.0.1', pid: null, program: null },
			{ port: 3000, bind: '::', pid: 7, program: 'node' }
		]);
		expect(merged).toEqual([{ port: 3000, bind: '::', pid: 7, program: 'node' }]);
	});
});

describe('extractTitle', () => {
	it('reads, decodes, collapses and caps the title', () => {
		expect(extractTitle('<html><head><TITLE lang="en">\n  Vite &amp; App </TITLE></head>')).toBe('Vite & App');
		expect(extractTitle('<titlebar>x</titlebar>')).toBeNull();
		expect(extractTitle('<title></title>')).toBeNull();
		expect(extractTitle(`<title>${'x'.repeat(500)}</title>`)?.length).toBe(120);
	});
});

describe('waiting and stopped rows', () => {
	it('lists a watched port until it listens (spec S5)', () => {
		expect(waitingRows([4000, 3000], new Set([3000]))).toEqual([
			{ port: 4000, proto: 'tcp', bind: '127.0.0.1', localOnly: true, kind: 'waiting' }
		]);
	});

	it('marks a vanished server stopped once, then drops it (spec S7)', () => {
		const tracker = new StoppedPortTracker();
		const row = { port: 5173, proto: 'tcp' as const, bind: '0.0.0.0', localOnly: false, kind: 'web' as const };
		expect(tracker.stoppedSince([row])).toEqual([]);
		expect(tracker.stoppedSince([])).toEqual([{ ...row, stopped: true }]);
		expect(tracker.stoppedSince([])).toEqual([]);
	});
});

describe('joins', () => {
	it('maps published host ports to containers', () => {
		const map = parseDockerPorts(
			'abc123\tacme-proxy\t0.0.0.0:8080->80/tcp, :::8080->80/tcp\nfff\tminio\t127.0.0.1:9000-9001->9000-9001/tcp'
		);
		expect(map.get(8080)).toEqual({ id: 'abc123', name: 'acme-proxy' });
		expect(map.get(9001)?.name).toBe('minio');
	});

	it('reads lsof cwd output', () => {
		expect(parseLsofCwd('p4812\nfcwd\nn/Users/ops/code/api\n').get(4812)).toBe('/Users/ops/code/api');
	});
});
