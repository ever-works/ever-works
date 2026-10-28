import { randomBytes } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	FLEET_LINK_FRAME_KINDS,
	type FleetConsents,
	type FleetLinkCloseReason,
	type FleetLinkExtensionMessage,
	type FleetLinkFrameKind
} from '@ever-works/contracts';
import { DaemonCore } from '../../sessions/daemon/daemon-core';
import { resolveSessionDaemonPaths, type SessionDaemonPaths } from '../../sessions/daemon/daemon-paths';
import { DaemonServer } from '../../sessions/daemon/daemon-server';
import type { PtyFactory } from '../../sessions/daemon/pty-host';
import { SessionStore } from '../../sessions/daemon/session-store';
import { eventually, fakePtyFactory, type FakePty } from '../../sessions/daemon/__tests__/pty-test-kit';
import { SessionDaemonSupervisor } from '../../sessions/daemon-supervisor';
import { ensureDaemonToken } from '../../sessions/daemon-token';
import { NO_HOOK_OVERLAY } from '../../sessions/hook-overlay.port';
import { resolveLoginShell } from '../../sessions/owner-session-launcher';
import { createLinkControlState } from './control';
import type { NodeChannelContext, NodeChannelHandler } from './registry';
import { createSessionModule, type SessionModule } from './session';

/**
 * The node's `session` family end to end against a REAL daemon on a real
 * local socket (the daemon's terminal is an in-memory one the test drives):
 * the supervisor's connect-or-spawn and respawn, the `sessions` tag, the
 * channel bridge (viewer vs driver), channel-0 facts, the kill switch and
 * drain (spec FR-1, FR-10, FR-21 … FR-23, FR-37, FR-38; ACC-FL04-07, 15, 21,
 * 22; CONTRACTS R-5, R-24).
 */

const ALL: FleetConsents = { work: true, attend: false, manage: true, usageScan: false };

class FakeContext implements NodeChannelContext {
	readonly json: Array<Record<string, unknown>> = [];
	readonly binary: Array<{ kind: FleetLinkFrameKind; payload: Uint8Array }> = [];
	readonly control0: FleetLinkExtensionMessage[] = [];
	closedWith: FleetLinkCloseReason | null = null;
	readonly family = 'session' as const;
	readonly nodeVersion = '0.2.5';
	readonly nodeName = 'build-01';
	readonly operations = { start: () => 'op', progress: () => undefined, done: () => undefined };

	constructor(
		readonly channel: number,
		readonly params: Record<string, unknown>,
		readonly control: ReturnType<typeof createLinkControlState>,
		readonly consents: FleetConsents = ALL
	) {}

	sendJson(message: Record<string, unknown>): boolean {
		this.json.push(message);
		return true;
	}

	sendBinary(kind: FleetLinkFrameKind, payload: Uint8Array): boolean {
		this.binary.push({ kind, payload: Buffer.from(payload) });
		return true;
	}

	sendControl(message: FleetLinkExtensionMessage): boolean {
		this.control0.push(message);
		return true;
	}

	close(reason: FleetLinkCloseReason): void {
		this.closedWith = reason;
	}

	reply(requestId: string): Record<string, unknown> | undefined {
		return this.json.find((message) => message.requestId === requestId);
	}

	output(): string {
		return this.binary
			.filter((frame) => frame.kind === FLEET_LINK_FRAME_KINDS.DATA)
			.map((frame) => Buffer.from(frame.payload).toString('utf8'))
			.join('');
	}
}

class FakeLink {
	readonly control = createLinkControlState();
	readonly sent: FleetLinkExtensionMessage[] = [];
	private state = { phase: 'connecting', linkGeneration: null as number | null };
	private readonly listeners = new Set<(state: { phase: string; linkGeneration: number | null }) => void>();

	getState() {
		return this.state;
	}

	onChange(listener: (state: { phase: string; linkGeneration: number | null }) => void) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	sendControl(message: FleetLinkExtensionMessage): boolean {
		if (this.state.phase !== 'connected') return false;
		this.sent.push(message);
		return true;
	}

	connect(generation: number): void {
		this.state = { phase: 'connected', linkGeneration: generation };
		for (const listener of [...this.listeners]) listener(this.state);
	}

	events(event?: string) {
		return this.sent.filter(
			(message) => message.type === 'session.event' && (event === undefined || message.event === event)
		) as Array<Record<string, unknown>>;
	}
}

describe('the session module and its daemon', () => {
	let dir: string;
	let paths: SessionDaemonPaths;
	let pty: { factory: PtyFactory; spawned: FakePty[] };
	let server: DaemonServer | null;
	let core: DaemonCore | null;
	let spawns: number;
	let supervisor: SessionDaemonSupervisor;
	let module: SessionModule;
	let link: FakeLink;
	let ptyAvailable: boolean;

	const startDaemon = async () => {
		core = new DaemonCore({
			version: '0.2.5',
			ptyFactory: ptyAvailable ? pty.factory : null,
			ptyReason: 'terminal support is missing on this computer',
			store: new SessionStore(paths.stateDir)
		});
		await core.boot();
		server = new DaemonServer({
			core,
			socketPath: paths.socketPath,
			readToken: async () => (await fsp.readFile(paths.tokenFile, 'utf8')).trim()
		});
		await server.listen();
	};

	beforeEach(async () => {
		dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ewn-mod-'));
		paths = resolveSessionDaemonPaths({
			configPath: path.join(dir, `node-config-${randomBytes(4).toString('hex')}.json`),
			platform: process.platform,
			env: {}
		});
		pty = fakePtyFactory();
		server = null;
		core = null;
		spawns = 0;
		ptyAvailable = true;
		supervisor = new SessionDaemonSupervisor({
			paths,
			nodeVersion: '0.2.5',
			ensureToken: () => ensureDaemonToken({ tokenFile: paths.tokenFile }),
			spawnDaemon: () => {
				spawns += 1;
				void startDaemon();
			},
			healthIntervalMs: 200,
			spawnWaitMs: 5_000
		});
		module = createSessionModule({
			supervisor,
			consents: ALL,
			nodeName: 'build-01',
			launch: {
				platform: process.platform,
				env: { SHELL: '/bin/bash', HOME: dir },
				homedir: dir,
				modelCli: {},
				overlay: NO_HOOK_OVERLAY,
				realpath: async (target: string) => target
			}
		});
		link = new FakeLink();
		module.bindLink(link);
	});

	afterEach(async () => {
		module.dispose();
		supervisor.stop();
		for (const info of core?.list() ?? []) core?.end(info.id, 'user', 0);
		await server?.close();
		await new Promise((resolve) => setTimeout(resolve, 30));
		await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
	});

	const open = async (params: Record<string, unknown>, channel = 1, control = link.control) => {
		const context = new FakeContext(channel, params, control);
		const family = module.families![0];
		const result = await family.open(context);
		return { context, result, handler: result.ok ? (result.handler as NodeChannelHandler) : null };
	};

	let nextRequest = 1;
	const request = async (
		handler: NodeChannelHandler,
		context: FakeContext,
		type: string,
		params: Record<string, unknown> = {}
	) => {
		const requestId = `r-${nextRequest++}`;
		handler.onJson?.({ requestId, type, params });
		await eventually(() => context.reply(requestId) !== undefined);
		return context.reply(requestId)!;
	};

	const startShell = async (sessionId = 's1') => {
		const { context, handler } = await open({ sessionId, mode: 'driver', kind: 'owner' });
		const reply = await request(handler!, context, 'session.start', {
			kind: 'owner',
			provider: 'shell',
			cwd: dir,
			title: '~',
			cols: 100,
			rows: 30,
			startedBy: 'user:u1'
		});
		return reply;
	};

	it('spawns the daemon when none answers, then advertises `sessions` (FR-1, FR-10)', async () => {
		expect(module.tags?.({ consents: ALL, platform: 'linux', nodeVersion: '0.2.5' })).toEqual([]);
		supervisor.start();
		await eventually(() => supervisor.healthy);
		expect(spawns).toBe(1);
		expect(module.tags?.({ consents: ALL, platform: 'linux', nodeVersion: '0.2.5' })).toEqual(['sessions']);
		expect(supervisor.report()).toEqual({ state: 'running', sessions: 0, storage: 'ok' });
	});

	it('adopts a daemon that is already running instead of spawning a second (a node restart)', async () => {
		await ensureDaemonToken({ tokenFile: paths.tokenFile });
		await startDaemon();
		supervisor.start();
		await eventually(() => supervisor.healthy);
		expect(spawns).toBe(0);
	});

	it('withdraws `sessions` with the reason when the daemon cannot host a terminal (U3)', async () => {
		ptyAvailable = false;
		supervisor.start();
		await eventually(() => supervisor.report().state === 'failed');
		expect(supervisor.healthy).toBe(false);
		expect(module.tags?.({ consents: ALL, platform: 'linux', nodeVersion: '0.2.5' })).toEqual([]);
		expect(supervisor.report()).toMatchObject({ reason: 'terminal support is missing on this computer' });
		const { result } = await open({ sessionId: 's1', mode: 'viewer', kind: 'owner' });
		expect(result).toMatchObject({
			ok: false,
			error: {
				code: 'unsupported_on_node',
				hint: 'the session daemon is not running on build-01 — terminal support is missing on this computer'
			}
		});
	});

	it('respawns a daemon that went away, and re-reports the sessions it restored', async () => {
		supervisor.start();
		await eventually(() => supervisor.healthy);
		link.connect(1);
		expect((await startShell()).result).toMatchObject({ daemonSessionId: 's1' });
		// The daemon dies (its process with it): the next one finds the session in its store.
		await server!.close();
		server = null;
		await eventually(() => !supervisor.healthy, 5_000);
		await eventually(() => supervisor.healthy && spawns === 2, 10_000);
		await eventually(() => link.events('lost').length === 1, 5_000);
		expect(link.events('lost')[0]).toMatchObject({ sessionId: 's1', event: 'lost' });
	});

	it('respawns a daemon that went away while a health check was still unanswered', async () => {
		supervisor.start();
		await eventually(() => supervisor.healthy);
		// The daemon dies while it answers the next health check: the socket closes with that
		// request pending. Its rejection must not cancel the reconnect the close scheduled.
		const dying = server!;
		const dyingCore = core!;
		let asked = false;
		dyingCore.health = () => {
			asked = true;
			void dying.close();
			throw new Error('the daemon died');
		};
		await eventually(() => asked, 5_000);
		server = null;
		await eventually(() => !supervisor.healthy, 5_000);
		await eventually(() => supervisor.healthy && spawns === 2, 10_000);
		expect(supervisor.report()).toMatchObject({ state: 'running' });
	});

	describe('with the daemon up', () => {
		beforeEach(async () => {
			supervisor.start();
			await eventually(() => supervisor.healthy);
			link.connect(1);
			await eventually(() => link.sent.some((message) => message.type === 'session.list'));
		});

		it('starts an owner shell through the daemon with the composed command (FR-12)', async () => {
			const reply = await startShell();
			expect(reply).toMatchObject({ result: { daemonSessionId: 's1', pid: 4242 } });
			const [command, ...args] = resolveLoginShell(process.platform, { SHELL: '/bin/bash' });
			expect(pty.spawned[0].options).toMatchObject({ command, args, cwd: dir, cols: 100, rows: 30 });
			await eventually(() => link.events('started').length === 1);
		});

		it('refuses an Agent session on the link (they arrive as jobs) and a kind that does not match', async () => {
			const { context, handler } = await open({ sessionId: 's9', mode: 'driver', kind: 'owner' });
			const agent = await request(handler!, context, 'session.start', {
				kind: 'agent',
				provider: 'shell',
				cwd: dir,
				title: 't',
				startedBy: 'user:u1'
			});
			expect(agent.error).toMatchObject({ code: 'invalid' });
			expect(pty.spawned).toHaveLength(0);
		});

		it('attaches a viewer with the replay first, never forwards its keystrokes (FR-22)', async () => {
			await startShell();
			pty.spawned[0].emit('dana@build-01:~$ ');
			const { context, handler } = await open({ sessionId: 's1', mode: 'viewer', kind: 'owner' }, 2);
			const reply = await request(handler!, context, 'session.attach');
			expect(reply.result).toMatchObject({ alive: true, cols: 100, rows: 30 });
			// The reply is the channel's first message; the replay follows it.
			expect(context.json[0].requestId).toBe(reply.requestId);
			await eventually(() => context.output().includes('dana@build-01'));
			pty.spawned[0].emit('live line\r\n');
			await eventually(() => context.output().includes('live line'));
			// A forged keystroke on a viewer channel goes nowhere.
			handler!.onBinary?.(FLEET_LINK_FRAME_KINDS.DATA, Buffer.from('rm -rf ~\r'));
			const typed = await request(handler!, context, 'session.input', { data: 'rm -rf ~\r' });
			expect(typed.error).toMatchObject({ code: 'permission_denied' });
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(pty.spawned[0].writes.join('')).not.toContain('rm -rf');
		});

		it("forwards a driver's keystrokes and size", async () => {
			await startShell();
			const { context, handler } = await open({ sessionId: 's1', mode: 'driver', kind: 'owner' }, 2);
			await request(handler!, context, 'session.attach', { cols: 140, rows: 40 });
			await eventually(() => pty.spawned[0].resizes.some((size) => size.cols === 140));
			handler!.onBinary?.(FLEET_LINK_FRAME_KINDS.DATA, Buffer.from('ls\r'));
			await eventually(() => pty.spawned[0].writes.join('').includes('ls\r'));
		});

		it('reports the exit on channel 0 with the code and the last screen', async () => {
			await startShell();
			pty.spawned[0].emit('bye\r\n');
			pty.spawned[0].exit(0);
			await eventually(() => link.events('exited').length === 1);
			expect(link.events('exited')[0]).toMatchObject({ sessionId: 's1', exitCode: 0, screen: 'bye' });
		});

		it('ends with the reason, renames, and reads the screen through control channels', async () => {
			await startShell();
			pty.spawned[0].emit('hello\r\n');
			const { context, handler } = await open({ sessionId: 's1', mode: 'driver', kind: 'owner' }, 3);
			expect((await request(handler!, context, 'session.rename', { title: 'api tests' })).result).toEqual({
				ok: true
			});
			await eventually(() => link.events('title').some((event) => event.title === 'api tests'));
			expect((await request(handler!, context, 'session.screen', { lines: 5 })).result).toMatchObject({
				text: 'hello',
				title: 'api tests'
			});
			expect((await request(handler!, context, 'session.end', { reason: 'user', graceMs: 0 })).result).toEqual({
				alreadyEnded: false
			});
			pty.spawned[0].exit(143);
			await eventually(() => link.events('exited').length === 1);
			expect(link.events('exited')[0]).toMatchObject({ exitCode: 143, reason: 'user' });
		});

		it('blocks input under the kill switch, leaves the process running, and resumes (R-24, FR-37)', async () => {
			await startShell();
			const { context, handler } = await open({ sessionId: 's1', mode: 'driver', kind: 'owner' }, 2);
			await request(handler!, context, 'session.attach');
			link.control.pause();
			await eventually(() => context.json.some((message) => message.notice === 'paused'));
			handler!.onBinary?.(FLEET_LINK_FRAME_KINDS.DATA, Buffer.from('x'));
			const refused = await request(handler!, context, 'session.end', { reason: 'user' });
			expect(refused.error).toMatchObject({ code: 'kill_switch' });
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(pty.spawned[0].writes).toEqual([]);
			expect(pty.spawned[0].kills).toEqual([]);
			link.control.resume();
			await eventually(() => context.json.some((message) => message.notice === 'resumed'));
			handler!.onBinary?.(FLEET_LINK_FRAME_KINDS.DATA, Buffer.from('y'));
			await eventually(() => pty.spawned[0].writes.join('') === 'y');
		});

		it('drain warns every owner session and then ends it with `drain` (FR-38)', async () => {
			await startShell();
			const { context, handler } = await open({ sessionId: 's1', mode: 'viewer', kind: 'owner' }, 2);
			await request(handler!, context, 'session.attach');
			link.control.startDrain({ type: 'link.drain', graceSec: 0 }, Date.now());
			await eventually(() => context.json.some((message) => message.notice === 'drain'));
			await eventually(() => pty.spawned[0].kills.length > 0);
			pty.spawned[0].exit(143);
			await eventually(() => link.events('exited').length === 1);
			expect(link.events('exited')[0]).toMatchObject({ reason: 'drain' });
		});

		it('re-reports on every new link: session.list, then each ended session with its screen; ack forgets', async () => {
			await startShell('s1');
			await startShell('s2');
			pty.spawned[1].emit('done\r\n');
			pty.spawned[1].exit(1);
			await eventually(() => core!.list().some((info) => info.id === 's2' && !info.alive));
			link.sent.length = 0;
			link.connect(2);
			await eventually(() => link.events('exited').some((event) => event.sessionId === 's2'));
			const list = link.sent.find((message) => message.type === 'session.list') as Record<string, unknown>;
			expect(list.daemon).toMatchObject({ state: 'running' });
			expect(
				(list.sessions as Array<Record<string, unknown>>).map((entry) => [entry.sessionId, entry.alive])
			).toEqual([
				['s1', true],
				['s2', false]
			]);
			expect(link.events('exited').find((event) => event.sessionId === 's2')).toMatchObject({
				exitCode: 1,
				screen: 'done'
			});
			module.controlHandlers!['session.ack'](
				{ type: 'session.ack', sessionIds: ['s2', 's1'] },
				{
					consents: ALL,
					control: link.control
				}
			);
			await eventually(() => core!.list().length === 1);
			expect(core!.list()[0].id).toBe('s1');
		});

		it('checks the consent on this machine: owner channels need --manage, Agent ones --work (R-5)', async () => {
			const family = module.families![0];
			const consent = family.consent as (params: Record<string, unknown>) => string;
			expect(consent({ sessionId: 's1', mode: 'viewer', kind: 'owner' })).toBe('manage');
			expect(consent({ sessionId: 's1', mode: 'viewer', kind: 'agent' })).toBe('work');
			expect(consent({ sessionId: 's1', mode: 'viewer' })).toBe('work-or-manage');
		});
	});
});
