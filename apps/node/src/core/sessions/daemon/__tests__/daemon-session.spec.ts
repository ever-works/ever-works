import { describe, expect, it } from 'vitest';
import { DAEMON_FRAME, decodeDaemonExit, decodeDaemonJson, DaemonFrameReader } from '../daemon-protocol';
import { DaemonSession, type DaemonAttachment } from '../daemon-session';
import { SessionProcess } from '../session-process';
import { fakePtyFactory, type FakePty } from './pty-test-kit';

/**
 * One session's attachments (spec FR-5 … FR-7, U10, U11, U16;
 * ACC-FL04-03 … 05, 15, 16, 21).
 */

class Peer implements DaemonAttachment {
	readonly frames: Array<{ kind: number; payload: Buffer }> = [];
	queued = 0;
	drainedAt = 0;
	closedWith: string | null = null;
	connected = true;
	private readonly reader = new DaemonFrameReader();

	constructor(
		readonly id: number,
		readonly mode: 'viewer' | 'driver'
	) {}

	send(frame: Buffer): boolean {
		if (!this.connected) return false;
		for (const decoded of this.reader.push(frame) ?? []) {
			this.frames.push({ kind: decoded.kind, payload: Buffer.from(decoded.payload) });
		}
		return true;
	}

	bufferedBytes(): number {
		return this.queued;
	}

	lastDrainAt(): number {
		return this.drainedAt;
	}

	close(reason: string): void {
		this.closedWith = reason;
		this.connected = false;
	}

	text(): string {
		return this.frames
			.filter((frame) => frame.kind === DAEMON_FRAME.DATA)
			.map((frame) => frame.payload.toString('utf8'))
			.join('');
	}

	json(): Array<Record<string, unknown>> {
		return this.frames
			.filter((frame) => frame.kind === DAEMON_FRAME.JSON)
			.map((frame) => decodeDaemonJson(frame.payload) ?? {});
	}
}

function setup() {
	let now = 1_000_000;
	const { factory, spawned } = fakePtyFactory();
	const exits: string[] = [];
	const session = new DaemonSession(
		{
			id: 's1',
			kind: 'owner',
			provider: 'shell',
			cwd: '/home/dana',
			title: '~',
			startedAt: new Date(now).toISOString(),
			startedBy: 'user:u1',
			cols: 80,
			rows: 24
		},
		{ now: () => now, onOutput: () => undefined, onExit: (s) => exits.push(s.id) }
	);
	const process = new SessionProcess({
		sessionId: 's1',
		command: ['/bin/sh', '-l'],
		cwd: '/home/dana',
		env: {},
		cols: 80,
		rows: 24,
		factory
	});
	session.attachProcess(process);
	const pty = spawned[0] as FakePty;
	return {
		session,
		pty,
		exits,
		advance: (ms: number) => {
			now += ms;
		},
		now: () => now
	};
}

describe('DaemonSession', () => {
	it('sends attached, then the replay, then live output — no gap, no overlap', async () => {
		const { session, pty } = setup();
		pty.emit('before\r\n');
		const viewer = new Peer(1, 'viewer');
		const attaching = session.attach(viewer, null);
		pty.emit('during\r\n');
		await attaching;
		pty.emit('after\r\n');
		expect(viewer.json()[0]).toMatchObject({ type: 'attached', alive: true, cols: 80, rows: 24 });
		const text = viewer.text();
		expect(text.indexOf('before')).toBeGreaterThanOrEqual(0);
		expect(text.split('during').length - 1).toBe(1);
		expect(text.split('after').length - 1).toBe(1);
		expect(text.indexOf('before')).toBeLessThan(text.indexOf('during'));
		expect(text.indexOf('during')).toBeLessThan(text.indexOf('after'));
	});

	it("never sends a viewer's keystrokes to the process (FR-22)", async () => {
		const { session, pty } = setup();
		const viewer = new Peer(1, 'viewer');
		await session.attach(viewer, null);
		session.input(1, 'rm -rf ~\r');
		expect(pty.writes).toEqual([]);
	});

	it('lets several drivers type, and sizes the terminal to the newest one (FR-6, U10)', async () => {
		const { session, pty } = setup();
		const dana = new Peer(1, 'driver');
		const ops = new Peer(2, 'driver');
		await session.attach(dana, { cols: 100, rows: 30 });
		expect(pty.resizes.at(-1)).toEqual({ cols: 100, rows: 30 });
		await session.attach(ops, { cols: 140, rows: 40 });
		expect(pty.resizes.at(-1)).toEqual({ cols: 140, rows: 40 });
		// An older driver asking for a size does not resize while a newer one drives.
		session.resizeFrom(1, 90, 20);
		expect(pty.resizes.at(-1)).toEqual({ cols: 140, rows: 40 });
		session.input(1, 'a');
		session.input(2, 'b');
		expect(pty.writes).toEqual(['a', 'b']);
		// When the newest leaves, the next newest's size applies.
		session.detach(2);
		expect(pty.resizes.at(-1)).toEqual({ cols: 90, rows: 20 });
	});

	it("ignores a viewer's size", async () => {
		const { session, pty } = setup();
		const viewer = new Peer(1, 'viewer');
		await session.attach(viewer, { cols: 200, rows: 60 });
		session.resizeFrom(1, 200, 60);
		expect(pty.resizes).toEqual([]);
	});

	it('answers terminal queries itself only while nobody drives (FR-5)', async () => {
		const { session, pty } = setup();
		pty.emit('\x1b[6n');
		await session.grid.flush();
		expect(pty.writes).toEqual(['\x1b[1;1R']);
		const driver = new Peer(1, 'driver');
		await session.attach(driver, null);
		pty.writes.length = 0;
		pty.emit('\x1b[6n');
		await session.grid.flush();
		// The driver's own terminal answers; the daemon stays quiet.
		expect(pty.writes).toEqual([]);
	});

	it('takes terminal answers only from the newest driver', async () => {
		const { session, pty } = setup();
		await session.attach(new Peer(1, 'driver'), null);
		await session.attach(new Peer(2, 'driver'), null);
		session.input(1, '\x1b[3;7Rq');
		session.input(2, '\x1b[3;7R');
		expect(pty.writes).toEqual(['q', '\x1b[3;7R']);
	});

	it('drops a viewer that stops reading, and the process and others keep going (FR-7, U16)', async () => {
		const { session, pty, advance } = setup();
		const slow = new Peer(1, 'viewer');
		const fast = new Peer(2, 'viewer');
		await session.attach(slow, null);
		await session.attach(fast, null);
		slow.queued = 10;
		slow.drainedAt = 0;
		advance(5_000);
		pty.emit('more output\r\n');
		expect(slow.closedWith).toBe('slow-viewer');
		expect(slow.json().some((message) => message.notice === 'slow-viewer')).toBe(true);
		expect(fast.closedWith).toBeNull();
		pty.emit('still going\r\n');
		expect(fast.text()).toContain('still going');
		expect(session.attachmentCount).toBe(1);
	});

	it('drops a viewer with more than 1 MiB queued at once', async () => {
		const { session, pty } = setup();
		const slow = new Peer(1, 'viewer');
		await session.attach(slow, null);
		slow.queued = 2 * 1024 * 1024;
		slow.drainedAt = Date.now();
		pty.emit('x');
		expect(slow.closedWith).toBe('slow-viewer');
	});

	it('blocks input under the kill switch, keeps the process, and resumes without a reconnect (FR-37)', async () => {
		const { session, pty } = setup();
		const driver = new Peer(1, 'driver');
		await session.attach(driver, null);
		session.setInputBlocked(true, 'Investigating a runaway job');
		session.input(1, 'ls\r');
		expect(session.writeInput('x')).toBe(false);
		expect(pty.writes).toEqual([]);
		expect(pty.kills).toEqual([]);
		expect(driver.json()).toContainEqual({
			type: 'session.notice',
			notice: 'paused',
			reason: 'Investigating a runaway job'
		});
		session.setInputBlocked(false);
		session.input(1, 'ls\r');
		expect(pty.writes).toEqual(['ls\r']);
		expect(driver.json()).toContainEqual({ type: 'session.notice', notice: 'resumed' });
	});

	it('tells a driver who attaches while blocked that input is paused', async () => {
		const { session } = setup();
		session.setInputBlocked(true);
		const driver = new Peer(1, 'driver');
		await session.attach(driver, null);
		expect(driver.json()).toContainEqual({ type: 'session.notice', notice: 'paused' });
	});

	it('warns attachments of a drain', async () => {
		const { session } = setup();
		const viewer = new Peer(1, 'viewer');
		await session.attach(viewer, null);
		session.warn(60);
		expect(viewer.json()).toContainEqual({ type: 'session.notice', notice: 'drain', seconds: 60 });
	});

	it('reports the exit once, with EXIT to every attachment, and remembers the code', async () => {
		const { session, pty, exits } = setup();
		const viewer = new Peer(1, 'viewer');
		await session.attach(viewer, null);
		pty.emit('bye\r\n');
		pty.exit(3);
		expect(session.alive).toBe(false);
		expect(session.exit).toEqual({ exitCode: 3, reason: null });
		expect(exits).toEqual(['s1']);
		const exitFrames = viewer.frames.filter((frame) => frame.kind === DAEMON_FRAME.EXIT);
		expect(exitFrames.map((frame) => decodeDaemonExit(frame.payload))).toEqual([3]);
		// Attaching after the end still shows the screen and the exit, once.
		const late = new Peer(2, 'viewer');
		await session.attach(late, null);
		expect(late.text()).toContain('bye');
		expect(late.frames.filter((frame) => frame.kind === DAEMON_FRAME.EXIT)).toHaveLength(1);
	});

	it('ends with terminate then kill after the grace, keeping the reason (FR-18)', async () => {
		const { session, pty } = setup();
		expect(session.end('user', 0)).toBe(true);
		expect(pty.kills).toEqual([false]);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(pty.kills).toEqual([false, true]);
		pty.exit(143);
		expect(session.exit).toEqual({ exitCode: 143, reason: 'user' });
		expect(session.end('user')).toBe(false);
	});

	it('restores an ended session with its persisted screen', async () => {
		const { session } = setup();
		session.restoreEnded({ screen: 'last line', exitCode: null, endReason: null, lost: true });
		expect(session.lost).toBe(true);
		expect(await session.screen()).toBe('last line');
		const viewer = new Peer(1, 'viewer');
		await session.attach(viewer, null);
		expect(viewer.text()).toContain('last line');
	});
});
