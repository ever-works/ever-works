import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DaemonCore } from '../daemon-core';
import type { DaemonStartRequest, DaemonWatchEvent } from '../daemon-protocol';
import { SessionStore } from '../session-store';
import { eventually, fakePtyFactory } from './pty-test-kit';

/**
 * The daemon's session table and lifecycle (spec FR-2, FR-8, FR-9, FR-11,
 * U3, U13, U17; ACC-FL04-06, ACC-FL04-07).
 */

describe('DaemonCore', () => {
	let dir: string;
	let now: number;

	beforeEach(async () => {
		dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ewn-core-'));
		now = Date.parse('2026-10-18T09:41:00.000Z');
	});

	afterEach(async () => {
		await fsp.rm(dir, { recursive: true, force: true });
	});

	const request = (overrides: Partial<DaemonStartRequest> = {}): DaemonStartRequest => ({
		id: 's1',
		kind: 'owner',
		provider: 'shell',
		command: ['/bin/sh', '-l'],
		cwd: dir,
		env: { HOME: dir },
		cols: 100,
		rows: 30,
		title: '~',
		startedBy: 'user:u1',
		...overrides
	});

	function makeCore(options: Partial<ConstructorParameters<typeof DaemonCore>[0]> = {}) {
		const pty = fakePtyFactory();
		const events: DaemonWatchEvent[] = [];
		let idleExits = 0;
		const core = new DaemonCore({
			version: '0.2.5',
			ptyFactory: pty.factory,
			store: new SessionStore(dir),
			now: () => now,
			onIdleExit: () => {
				idleExits += 1;
			},
			screenPersistMs: 30_000,
			activityReportMs: 30_000,
			...options
		});
		core.watch((event) => events.push(event));
		return { core, pty, events, idleExits: () => idleExits };
	}

	it('starts a session in a real folder, reports it and persists it before anything else', async () => {
		const { core, pty, events } = makeCore();
		const started = await core.start(request());
		expect(started).toEqual({ pid: 4242 });
		expect(pty.spawned[0].options).toMatchObject({
			command: '/bin/sh',
			args: ['-l'],
			cwd: dir,
			cols: 100,
			rows: 30
		});
		expect(pty.spawned[0].options.env).toMatchObject({
			HOME: dir,
			TERM: 'xterm-256color',
			COLORTERM: 'truecolor',
			EVER_WORKS_SESSION_ID: 's1'
		});
		expect(events).toEqual([{ event: 'started', id: 's1', at: '2026-10-18T09:41:00.000Z' }]);
		const [stored] = await new SessionStore(dir).load();
		expect(stored.record).toMatchObject({ id: 's1', title: '~', endedAt: null });
		expect(core.list()).toEqual([
			expect.objectContaining({ id: 's1', alive: true, kind: 'owner', provider: 'shell', viewers: 0, drivers: 0 })
		]);
	});

	it('refuses a folder that does not exist, keeping nothing (U17)', async () => {
		const { core, pty } = makeCore();
		const missing = path.join(dir, 'code', 'apu');
		expect(await core.start(request({ cwd: missing }))).toEqual({
			code: 'invalid',
			hint: `${missing} does not exist on this computer`
		});
		expect(pty.spawned).toEqual([]);
		expect(core.list()).toEqual([]);
	});

	it('refuses to start without terminal support, naming the fix (U3)', async () => {
		const { core } = makeCore({ ptyFactory: null, ptyReason: 'terminal support is missing on this computer' });
		expect(await core.start(request())).toEqual({
			code: 'unsupported_on_node',
			hint: 'terminal support is missing on this computer'
		});
		expect(core.health()).toMatchObject({
			pty: 'missing',
			ptyReason: 'terminal support is missing on this computer'
		});
	});

	it('refuses a second start of the same id, even while the first is in flight', async () => {
		const { core, pty } = makeCore();
		const [first, second] = await Promise.all([core.start(request()), core.start(request())]);
		expect([first, second]).toContainEqual({ pid: 4242 });
		expect([first, second]).toContainEqual({ code: 'invalid', hint: 'a session with this id already exists' });
		expect(pty.spawned).toHaveLength(1);
	});

	it('on exit: persists the last screen and the end, then reports exited (FR-8, FR-9)', async () => {
		const { core, pty, events } = makeCore();
		await core.start(request());
		pty.spawned[0].emit('$ make test\r\nok\r\n');
		pty.spawned[0].exit(0);
		await eventually(() => events.some((event) => event.event === 'exited'));
		expect(events.at(-1)).toEqual({
			event: 'exited',
			id: 's1',
			exitCode: 0,
			reason: null,
			at: '2026-10-18T09:41:00.000Z'
		});
		const [stored] = await new SessionStore(dir).load();
		expect(stored.record).toMatchObject({ endedAt: '2026-10-18T09:41:00.000Z', exitCode: 0, endReason: null });
		expect(stored.screen).toBe('$ make test\nok');
		// Kept until acknowledged.
		expect(core.list()[0]).toMatchObject({ alive: false, exitCode: 0 });
		expect(await core.ackEnded('s1')).toBe(true);
		expect(core.list()).toEqual([]);
		expect(await new SessionStore(dir).load()).toEqual([]);
	});

	it('never forgets a live session on ack', async () => {
		const { core } = makeCore();
		await core.start(request());
		expect(await core.ackEnded('s1')).toBe(false);
		expect(core.list()).toHaveLength(1);
	});

	it('ends with the reason it was given', async () => {
		const { core, pty, events } = makeCore();
		await core.start(request());
		expect(core.end('s1', 'drain', 0)).toEqual({ alreadyEnded: false });
		pty.spawned[0].exit(143);
		await eventually(() => events.some((event) => event.event === 'exited'));
		expect(events.at(-1)).toMatchObject({ event: 'exited', exitCode: 143, reason: 'drain' });
		expect(core.end('s1', 'user')).toEqual({ alreadyEnded: true });
		expect(core.end('nope', 'user')).toMatchObject({ code: 'not_found' });
	});

	it('renames, persists the title, and reports it (FR-19)', async () => {
		const { core, events } = makeCore();
		await core.start(request());
		expect(await core.rename('s1', '  api tests ')).toBeNull();
		expect(events.at(-1)).toMatchObject({ event: 'title', id: 's1', title: 'api tests' });
		const [stored] = await new SessionStore(dir).load();
		expect(stored.record.title).toBe('api tests');
		expect(await core.rename('s1', '')).toMatchObject({ code: 'invalid' });
	});

	it('after a restart, restores a running session as lost with its last persisted screen (FR-11, U13)', async () => {
		const first = makeCore();
		await first.core.start(request());
		first.pty.spawned[0].emit('working…\r\n');
		now += 30_000;
		await first.core.tick();
		// The daemon dies here (the machine rebooted): nothing ended the session.
		const second = makeCore();
		await second.core.boot();
		expect(second.core.list()).toEqual([
			expect.objectContaining({ id: 's1', alive: false, lost: true, exitCode: null })
		]);
		expect(await second.core.screen('s1', 2000)).toMatchObject({ text: 'working…', alive: false });
		// A second restart does not find it "running" again.
		const third = makeCore();
		await third.core.boot();
		expect(third.core.list()[0]).toMatchObject({ lost: false, alive: false });
	});

	it('restores an ended-but-unacknowledged session as ended, not lost', async () => {
		const first = makeCore();
		await first.core.start(request());
		first.pty.spawned[0].exit(2);
		await eventually(() => first.events.some((event) => event.event === 'exited'));
		const second = makeCore();
		await second.core.boot();
		expect(second.core.list()[0]).toMatchObject({ alive: false, lost: false, exitCode: 2 });
	});

	it('persists a changed screen at most 30 s after it changed', async () => {
		const { core, pty } = makeCore();
		await core.start(request());
		pty.spawned[0].emit('first\r\n');
		now += 29_000;
		await core.tick();
		expect((await new SessionStore(dir).load())[0].screen).toBeNull();
		now += 1_000;
		await core.tick();
		expect((await new SessionStore(dir).load())[0].screen).toBe('first');
	});

	it('reports activity at most every 30 s', async () => {
		const { core, pty, events } = makeCore();
		await core.start(request());
		pty.spawned[0].emit('a');
		now += 10_000;
		pty.spawned[0].emit('b');
		expect(events.filter((event) => event.event === 'activity')).toHaveLength(0);
		now += 20_000;
		pty.spawned[0].emit('c');
		expect(events.filter((event) => event.event === 'activity')).toHaveLength(1);
	});

	it('exits on its own only with no session and no node for the idle window (FR-2)', async () => {
		const { core, idleExits } = makeCore({ idleExitMs: 5 * 60_000 });
		const release = core.nodeConnected();
		now += 10 * 60_000;
		await core.tick();
		expect(idleExits()).toBe(0);
		release();
		now += 4 * 60_000;
		await core.tick();
		expect(idleExits()).toBe(0);
		now += 60_000;
		await core.tick();
		expect(idleExits()).toBe(1);
	});

	it('never exits while a session exists, even with no node connected', async () => {
		const { core, idleExits } = makeCore({ idleExitMs: 1_000 });
		await core.start(request());
		now += 60 * 60_000;
		await core.tick();
		expect(idleExits()).toBe(0);
	});

	it('blocks input on every session, including ones started while blocked', async () => {
		const { core, pty } = makeCore();
		await core.start(request());
		core.setInputBlocked(true, 'fleet stop');
		await core.start(request({ id: 's2' }));
		expect(core.input('s1', 'x')).toEqual({ accepted: false });
		expect(core.input('s2', 'x')).toEqual({ accepted: false });
		core.setInputBlocked(false);
		expect(core.input('s2', 'x')).toEqual({ accepted: true });
		expect(pty.spawned[1].writes).toEqual(['x']);
		expect(pty.spawned.every((spawned) => spawned.kills.length === 0)).toBe(true);
	});
});
