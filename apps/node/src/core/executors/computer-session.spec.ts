import { describe, expect, it, vi } from 'vitest';
import type { ITerminalStreamPlugin, TerminalSessionHandle, TerminalTransport } from '@ever-works/plugin';
import type { ComputerNodeToServerFrame, FleetJobView } from '@ever-works/contracts';
import type { CaptureBackend } from '../screen/capture-backend';
import type { WebSocketLike } from '../screen/cdp-connection';
import {
	ComputerSessionPayloadError,
	normalizeComputerSessionPayload,
	runComputerSessionJob,
	type ComputerSessionExecutorDeps
} from './computer-session';

const NODE = '11111111-2222-4333-8444-555555555555';
const OTHER_NODE = '99999999-2222-4333-8444-555555555555';
const SESSION = '33333333-2222-4333-8444-555555555555';
const AGENT = '44444444-2222-4333-8444-555555555555';
const KEY = 'c'.repeat(32);
const TOKEN = `ghp_${'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'}`;

function job(payload: Record<string, unknown>): FleetJobView {
	return {
		id: 'job-1',
		kind: 'computer-session',
		status: 'running',
		nodeId: NODE,
		requiredCapabilities: ['attended'],
		payload,
		leaseExpiresAt: null,
		attempts: 1,
		maxAttempts: 1,
		createdAt: null,
		startedAt: null,
		completedAt: null
	};
}

const payload = (channels: string[]) => ({
	sessionId: SESSION,
	agentId: AGENT,
	nodeId: NODE,
	profileKey: KEY,
	channels,
	quality: 'smooth'
});

function harness(
	options: {
		endAfterPublishes?: number;
		backend?: CaptureBackend | null;
		terminal?: ITerminalStreamPlugin | null;
	} = {}
) {
	const published: ComputerNodeToServerFrame[] = [];
	const heartbeats: Array<Record<string, unknown>> = [];
	let publishes = 0;
	const client = {
		publishComputerFrames: vi.fn(async (_id: string, frames: readonly ComputerNodeToServerFrame[]) => {
			published.push(...frames);
			publishes += 1;
			const ended = options.endAfterPublishes !== undefined && publishes >= options.endAfterPublishes;
			return {
				accepted: frames.length,
				dropped: 0,
				ended,
				closeReason: ended ? ('closed-by-user' as const) : null
			};
		}),
		computerSessionHeartbeat: vi.fn(async (_id: string, report: Record<string, unknown> = {}) => {
			heartbeats.push(report);
			return { ended: false, closeReason: null };
		}),
		mintComputerWorkerToken: vi.fn(async () => ({
			token: 't',
			wsPath: `/ws/computer/${SESSION}`,
			expiresInSec: 60
		})),
		reportComputerProfile: vi.fn(async () => true)
	};
	const profiles = {
		ensure: vi.fn(async () => ({
			dir: '/p',
			browserDir: '/p/browser',
			filesDir: '/p/files',
			created: true,
			reset: false
		})),
		diskBytes: vi.fn(async () => 2048)
	};
	const deps: ComputerSessionExecutorDeps = {
		nodeId: NODE,
		apiUrl: 'https://api.ever.works',
		client,
		profiles,
		captureBackend: options.backend === undefined ? null : options.backend,
		terminalHost: options.terminal === undefined ? null : options.terminal,
		webSocketFactory: null,
		heartbeatIntervalMs: 60_000,
		platform: 'linux',
		parentEnv: { PATH: '/usr/bin' }
	};
	return { deps, client, profiles, published, heartbeats };
}

function screenBackend(): CaptureBackend & { started: string[]; stopped: number } {
	const backend = {
		id: 'fake',
		started: [] as string[],
		stopped: 0,
		isAvailable: () => true,
		start: async ({ profileDir }: { profileDir: string }) => {
			backend.started.push(profileDir);
			return {
				capture: async () => ({ mime: 'image/jpeg' as const, width: 800, height: 600, data: 'QUJD' }),
				countSignedInSites: async () => 3,
				stop: async () => {
					backend.stopped += 1;
				}
			};
		}
	};
	return backend;
}

function terminalHost(): ITerminalStreamPlugin & { spawned: Array<{ cwd: string; command: readonly string[] }> } {
	const host = {
		id: 'fake-terminal',
		name: 'Fake terminal',
		version: '1.0.0',
		category: 'utility',
		capabilities: ['terminal-stream'],
		providerName: 'fake-terminal',
		spawned: [] as Array<{ cwd: string; command: readonly string[] }>,
		spawn: async (
			input: { cwd: string; command: readonly string[] },
			transport: TerminalTransport
		): Promise<TerminalSessionHandle> => {
			host.spawned.push({ cwd: input.cwd, command: input.command });
			transport.publish({ kind: 'stdout', seq: 0, data: Buffer.from(`$ echo ${TOKEN}\n`).toString('base64') });
			let resolveExit: (value: { code: number; reason: 'closed' }) => void = () => undefined;
			const exited = new Promise<{ code: number; reason: 'closed' }>((resolve) => (resolveExit = resolve));
			return {
				runId: 'x',
				isPty: false,
				write: () => undefined,
				resize: () => undefined,
				kill: () => resolveExit({ code: 0, reason: 'closed' }),
				exited
			};
		}
	};
	return host as unknown as ITerminalStreamPlugin & { spawned: Array<{ cwd: string; command: readonly string[] }> };
}

describe('normalizeComputerSessionPayload', () => {
	it('accepts a view pinned to this machine and defaults the quality', () => {
		expect(normalizeComputerSessionPayload({ ...payload(['screen', 'screen']), quality: 'nope' }, NODE)).toEqual({
			sessionId: SESSION,
			agentId: AGENT,
			nodeId: NODE,
			profileKey: KEY,
			channels: ['screen'],
			quality: 'sharp'
		});
	});

	it('refuses a view pinned to a different machine, with no channel, or without ids', () => {
		expect(() => normalizeComputerSessionPayload(payload(['screen']), OTHER_NODE)).toThrow(
			ComputerSessionPayloadError
		);
		expect(() => normalizeComputerSessionPayload(payload(['microphone']), NODE)).toThrow(/no channel/);
		expect(() => normalizeComputerSessionPayload({ ...payload(['screen']), sessionId: 'x' }, NODE)).toThrow();
		expect(() => normalizeComputerSessionPayload(null, NODE)).toThrow();
	});
});

describe('runComputerSessionJob', () => {
	it('shows the watched Agent’s own profile, publishes pictures, and stops when the owner ends the view', async () => {
		const backend = screenBackend();
		const { deps, published, profiles, client } = harness({ backend, endAfterPublishes: 2 });
		const controller = new AbortController();

		const result = await runComputerSessionJob(job(payload(['screen'])), deps, controller.signal);

		expect(profiles.ensure).toHaveBeenCalledWith(NODE, AGENT, KEY);
		expect(backend.started).toEqual(['/p/browser']);
		expect(published.some((frame) => frame.kind === 'frame')).toBe(true);
		expect(backend.stopped).toBe(1);
		expect(result).toMatchObject({ endedBy: 'platform', closeReason: 'closed-by-user' });
		// Ended by the platform: no second end frame from this machine.
		expect(published.some((frame) => frame.kind === 'end')).toBe(false);
		await vi.waitFor(() =>
			expect(client.reportComputerProfile).toHaveBeenCalledWith(SESSION, {
				profileKey: KEY,
				signedInSiteCount: 3,
				diskBytes: 2048
			})
		);
	});

	it('ends a live view cleanly with node-unavailable when this machine drains, rather than letting the lease lapse', async () => {
		const backend = screenBackend();
		const { deps, published, heartbeats } = harness({ backend });
		const controller = new AbortController();
		const running = runComputerSessionJob(job(payload(['screen'])), deps, controller.signal);
		await vi.waitFor(() => expect(published.some((frame) => frame.kind === 'frame')).toBe(true));

		controller.abort(new Error('draining'));
		const result = await running;

		expect(result).toMatchObject({ endedBy: 'node', closeReason: 'node-unavailable' });
		expect(published.at(-1)).toEqual({ kind: 'end', reason: 'node-unavailable' });
		expect(heartbeats).toContainEqual({ status: 'ended', closeReason: 'node-unavailable' });
		expect(backend.stopped).toBe(1);
	});

	it('serves a terminal-only view on a machine with no capture, in the Agent’s file root, and scans its output', async () => {
		const host = terminalHost();
		const { deps, published } = harness({ terminal: host, endAfterPublishes: 1 });
		const result = await runComputerSessionJob(job(payload(['terminal'])), deps, new AbortController().signal);

		expect(host.spawned).toEqual([{ cwd: '/p/files', command: ['/bin/sh'] }]);
		const terminalFrames = published.filter((frame) => frame.kind === 'terminal');
		expect(terminalFrames.length).toBeGreaterThan(0);
		for (const frame of terminalFrames) {
			if (frame.kind === 'terminal' && frame.frame.kind === 'stdout') {
				expect(Buffer.from(frame.frame.data, 'base64').toString()).not.toContain(TOKEN);
			}
		}
		expect(published.some((frame) => frame.kind === 'frame')).toBe(false);
		expect(result.endedBy).toBe('platform');
	});

	it('explains and ends a view when this machine can serve none of the channels asked for', async () => {
		const { deps, published } = harness({ backend: null, terminal: null });
		const result = await runComputerSessionJob(job(payload(['screen'])), deps, new AbortController().signal);
		expect(published.find((frame) => frame.kind === 'error')).toBeTruthy();
		expect(published.at(-1)).toEqual({ kind: 'end', reason: 'error' });
		expect(result).toMatchObject({ endedBy: 'node', closeReason: 'error' });
	});

	it('lets the person holding control drive the Agent’s browser, pauses the Agent meanwhile, and resumes it after', async () => {
		const dispatched: unknown[] = [];
		const backend: CaptureBackend = {
			id: 'fake-driveable',
			isAvailable: () => true,
			start: async () => ({
				capture: async () => ({ mime: 'image/jpeg' as const, width: 800, height: 600, data: 'QUJD' }),
				dispatchInput: async (frame) => {
					dispatched.push(frame);
				},
				stop: async () => undefined
			})
		};
		const { deps, published } = harness({ backend });
		const files = new Map<string, string>();
		let leg: WebSocketLike | null = null;
		deps.profileFs = {
			writeTextFile: vi.fn(async (path: string, content: string) => {
				files.set(path, content);
			}),
			rm: vi.fn(async (path: string) => {
				files.delete(path);
			})
		};
		deps.webSocketFactory = () => {
			leg = {
				readyState: 1,
				onopen: null,
				onmessage: null,
				onerror: null,
				onclose: null,
				send: () => undefined,
				close: () => undefined
			};
			return leg;
		};
		const controller = new AbortController();
		const running = runComputerSessionJob(job(payload(['screen'])), deps, controller.signal);
		await vi.waitFor(() => expect(published.some((frame) => frame.kind === 'frame')).toBe(true));
		await vi.waitFor(() => expect(leg).not.toBeNull());
		const socket = leg as unknown as WebSocketLike;
		socket.onopen?.({});
		const send = (frame: Record<string, unknown>) => socket.onmessage?.({ data: JSON.stringify(frame) });

		// Before control is taken, input is not injected.
		send({ kind: 'pointer', action: 'down', x: 1, y: 2, button: 'left' });
		send({ kind: 'mode', mode: 'controlling' });
		send({ kind: 'text', text: 'invoice 42' });
		await vi.waitFor(() => expect(dispatched).toEqual([{ kind: 'text', text: 'invoice 42' }]));
		await vi.waitFor(() => expect(files.size).toBe(1));
		expect([...files.values()][0]).toContain('controlledByPerson');

		send({ kind: 'mode', mode: 'watching' });
		send({ kind: 'text', text: 'too late' });
		await vi.waitFor(() => expect(files.size).toBe(0));
		expect(dispatched).toHaveLength(1);

		// A view that ends while control is held tells the Agent it may resume.
		send({ kind: 'mode', mode: 'controlling' });
		await vi.waitFor(() => expect(files.size).toBe(1));
		controller.abort(new Error('draining'));
		await running;
		expect(files.size).toBe(0);
	});

	it('refuses a job for another machine before touching any profile', async () => {
		const { deps, profiles } = harness({ backend: screenBackend() });
		await expect(
			runComputerSessionJob(
				job({ ...payload(['screen']), nodeId: OTHER_NODE }),
				deps,
				new AbortController().signal
			)
		).rejects.toBeInstanceOf(ComputerSessionPayloadError);
		expect(profiles.ensure).not.toHaveBeenCalled();
	});
});
