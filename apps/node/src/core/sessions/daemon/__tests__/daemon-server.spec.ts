import { randomBytes } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DaemonControlClient, DaemonRequestError, openDaemonAttach } from '../../daemon-client';
import { DaemonCore } from '../daemon-core';
import { resolveSessionDaemonPaths } from '../daemon-paths';
import {
	DAEMON_FRAME,
	decodeDaemonExit,
	decodeDaemonJson,
	encodeDaemonFrame,
	encodeDaemonJson,
	type DaemonSessionInfo,
	type DaemonWatchEvent
} from '../daemon-protocol';
import { DaemonServer } from '../daemon-server';
import { SessionStore } from '../session-store';
import { eventually, nodeScript, pipePtyFactory } from './pty-test-kit';

/**
 * The daemon's local socket, end to end with REAL child processes (spec
 * FR-3, FR-4, FR-9, FR-18; ACC-FL04-01 … 05 at the protocol level).
 */

describe('DaemonServer', () => {
	let dir: string;
	let token: string;
	let socketPath: string;
	let core: DaemonCore;
	let server: DaemonServer;
	const clients: DaemonControlClient[] = [];

	beforeEach(async () => {
		dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ewn-srv-'));
		token = randomBytes(32).toString('base64url');
		socketPath = resolveSessionDaemonPaths({
			configPath: path.join(dir, `node-config-${randomBytes(4).toString('hex')}.json`),
			platform: process.platform,
			env: {}
		}).socketPath;
		core = new DaemonCore({ version: '0.2.5', ptyFactory: pipePtyFactory, store: new SessionStore(dir) });
		server = new DaemonServer({ core, socketPath, readToken: async () => token });
		await server.listen();
	});

	afterEach(async () => {
		for (const client of clients.splice(0)) client.close();
		for (const info of core.list()) core.end(info.id, 'user', 0);
		await server.close();
		await new Promise((resolve) => setTimeout(resolve, 50));
		await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
	});

	const control = async (presented = token) => {
		const client = await DaemonControlClient.connect({ socketPath, token: presented });
		clients.push(client);
		return client;
	};

	const start = (client: DaemonControlClient, id: string, script: string) =>
		client.request('start', {
			sessionId: id,
			kind: 'owner',
			provider: 'shell',
			command: nodeScript(script),
			cwd: dir,
			env: { ...process.env } as Record<string, string>,
			cols: 80,
			rows: 24,
			title: id,
			startedBy: 'user:u1'
		});

	it('closes a connection with a wrong token before reading anything else', async () => {
		const socket = net.connect(socketPath);
		const closed = new Promise<boolean>((resolve) => socket.on('close', () => resolve(true)));
		const received: Buffer[] = [];
		socket.on('data', (chunk: Buffer) => received.push(chunk));
		await new Promise((resolve) => socket.once('connect', resolve));
		socket.write(encodeDaemonJson({ op: 'hello', token: 'x'.repeat(43), role: 'control' }));
		expect(await closed).toBe(true);
		expect(Buffer.concat(received).length).toBe(0);
	});

	it('closes a connection whose first frame is not a hello, or is oversized', async () => {
		for (const first of [
			encodeDaemonJson({ op: 'list', id: 1 }),
			encodeDaemonFrame(DAEMON_FRAME.DATA, Buffer.from('ls\r')),
			encodeDaemonJson({ op: 'hello', token, role: 'control', padding: 'x'.repeat(8192) })
		]) {
			const socket = net.connect(socketPath);
			const closed = new Promise<boolean>((resolve) => socket.on('close', () => resolve(true)));
			await new Promise((resolve) => socket.once('connect', resolve));
			socket.write(first);
			expect(await closed).toBe(true);
		}
	});

	it('refuses a connection that pipelines a request behind an unchecked hello', async () => {
		const socket = net.connect(socketPath);
		const closed = new Promise<boolean>((resolve) => socket.on('close', () => resolve(true)));
		await new Promise((resolve) => socket.once('connect', resolve));
		socket.write(
			Buffer.concat([
				encodeDaemonJson({ op: 'hello', token, role: 'control' }),
				encodeDaemonJson({ id: 1, op: 'list' })
			])
		);
		expect(await closed).toBe(true);
	});

	it('welcomes a control connection with health and refuses a client that presents another token', async () => {
		const client = await control();
		expect(client.welcome).toMatchObject({ ok: true, protocol: 1, pty: 'available', sessions: 0 });
		await expect(control('y'.repeat(43))).rejects.toThrow();
	});

	it('starts a real process, attaches with replay then live output, and reports the exit code (FR-4, FR-9)', async () => {
		const client = await control();
		const events: DaemonWatchEvent[] = [];
		client.onEvent((event) => events.push(event));
		await eventually(async () => {
			await client.request('health');
			return true;
		});
		const script = `
			process.stdout.write('ready\\n');
			process.stdin.on('data', (d) => {
				const text = String(d).trim();
				if (text === 'quit') process.exit(7);
				process.stdout.write('echo:' + text + '\\n');
			});
		`;
		expect(await start(client, 's1', script)).toMatchObject({ pid: expect.any(Number) });
		await eventually(() => events.some((event) => event.event === 'started'));
		await eventually(async () =>
			(await client.request<{ text: string }>('screen', { sessionId: 's1', lines: 10 })).text.includes('ready')
		);

		const stream = await openDaemonAttach({
			socketPath,
			token,
			sessionId: 's1',
			mode: 'driver',
			cols: 100,
			rows: 30
		});
		const received: string[] = [];
		let exitCode: number | null | undefined;
		stream.onFrame((kind, payload) => {
			if (kind === DAEMON_FRAME.DATA) received.push(Buffer.from(payload).toString('utf8'));
			if (kind === DAEMON_FRAME.EXIT) exitCode = decodeDaemonExit(payload);
		});
		expect(stream.info).toMatchObject({ alive: true, cols: 100, rows: 30 });
		// The replay carries what was printed before the attach.
		await eventually(() => received.join('').includes('ready'));
		stream.sendInput(Buffer.from('hello\n'));
		await eventually(() => received.join('').includes('echo:hello'));
		stream.sendInput(Buffer.from('quit\n'));
		await eventually(() => exitCode !== undefined);
		expect(exitCode).toBe(7);
		await eventually(() => events.some((event) => event.event === 'exited'));
		expect(events.find((event) => event.event === 'exited')).toMatchObject({ id: 's1', exitCode: 7, reason: null });
		const listed = (await client.request<{ sessions: DaemonSessionInfo[] }>('list')).sessions;
		expect(listed[0]).toMatchObject({ id: 's1', alive: false, exitCode: 7 });
	});

	it("drops a viewer's keystrokes", async () => {
		const client = await control();
		const script = `process.stdin.on('data', (d) => process.stdout.write('got:' + String(d)));`;
		await start(client, 's2', script);
		const viewer = await openDaemonAttach({ socketPath, token, sessionId: 's2', mode: 'viewer' });
		const received: string[] = [];
		viewer.onFrame((kind, payload) => {
			if (kind === DAEMON_FRAME.DATA) received.push(Buffer.from(payload).toString('utf8'));
		});
		viewer.sendInput(Buffer.from('rm -rf ~\n'));
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(received.join('')).not.toContain('got:');
		viewer.close();
	});

	it('ends a process that ignores the polite stop by killing it after the grace (FR-18)', async () => {
		const client = await control();
		const events: DaemonWatchEvent[] = [];
		client.onEvent((event) => events.push(event));
		const script = `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.stdout.write('stubborn\\n');`;
		await start(client, 's3', script);
		await eventually(async () =>
			(await client.request<{ text: string }>('screen', { sessionId: 's3' })).text.includes('stubborn')
		);
		await client.request('end', { sessionId: 's3', reason: 'user', graceMs: 200 });
		await eventually(() => events.some((event) => event.event === 'exited'), 10_000);
		expect(events.find((event) => event.event === 'exited')).toMatchObject({ id: 's3', reason: 'user' });
	});

	it('answers unknown sessions and bad requests with typed errors, never by closing', async () => {
		const client = await control();
		await expect(client.request('end', { sessionId: 'nope' })).rejects.toMatchObject({ code: 'not_found' });
		await expect(client.request('start', { sessionId: '../x' })).rejects.toMatchObject({ code: 'invalid' });
		await expect(client.request('teleport')).rejects.toBeInstanceOf(DaemonRequestError);
		await expect(openDaemonAttach({ socketPath, token, sessionId: 'nope', mode: 'viewer' })).rejects.toMatchObject({
			code: 'not_found'
		});
		expect(client.isClosed).toBe(false);
	});

	it('refuses a second daemon on the same socket rather than stealing it', async () => {
		const second = new DaemonServer({ core, socketPath, readToken: async () => token });
		await expect(second.listen()).rejects.toThrow();
	});

	it('re-reads the token on every hello', async () => {
		const first = await control();
		expect(first.welcome.ok).toBe(true);
		token = randomBytes(32).toString('base64url');
		await expect(DaemonControlClient.connect({ socketPath, token: 'z'.repeat(43) })).rejects.toThrow();
		const second = await control(token);
		expect(second.welcome.ok).toBe(true);
	});

	it('keeps the JSON welcome shape decodable', () => {
		const frame = encodeDaemonJson({ type: 'welcome', ok: true });
		expect(decodeDaemonJson(frame.subarray(5))).toEqual({ type: 'welcome', ok: true });
	});
});
