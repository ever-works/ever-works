import { describe, expect, it } from 'vitest';
import type { FleetLinkExtensionMessage } from '@ever-works/contracts';
import { resolveHookPaths, type HookFs } from '../hook-client';
import { HookEndpoint, type HookEndpointEvent } from '../hook-endpoint';
import { normalizeHookEvent } from '../hook-events';
import { SessionHookOverlay } from '../hook-overlay';
import { SessionStatusPipeline, type SessionStatusDaemon } from '../session-status';
import type { DaemonSessionInfo, DaemonWatchEvent } from '../daemon/daemon-protocol';

/**
 * The node's status pipeline (FL-05 spec FR-12 … FR-19, U5, U12, U15;
 * ACC-FL05-06 … 10): hooks, output, Ctrl-C and silence → `session.status` /
 * `session.attention` on channel 0, once per change.
 */

const SESSION = 'f3c1a0de-1111-4222-8333-444455556666';
const STATE = '/home/dana/.config/ever-works-node/sessions';

const nullFs: HookFs = {
	mkdir: async () => undefined,
	writeFile: async () => undefined,
	readFile: async () => {
		throw new Error('ENOENT');
	},
	rename: async () => undefined,
	unlink: async () => undefined,
	readdir: async () => [],
	stat: async () => ({ mtimeMs: 0, size: 0 }),
	chmod: async () => undefined
};

function info(overrides: Partial<DaemonSessionInfo> = {}): DaemonSessionInfo {
	return {
		id: SESSION,
		kind: 'owner',
		provider: 'claude-code',
		cwd: '/home/dana/code/api',
		title: 'api tests',
		startedAt: '2026-10-21T10:00:00.000Z',
		startedBy: 'user:u1',
		alive: true,
		exitCode: null,
		endReason: null,
		lost: false,
		cols: 120,
		rows: 32,
		viewers: 0,
		drivers: 0,
		...overrides
	};
}

function harness(provider: DaemonSessionInfo['provider'] = 'claude-code') {
	let now = Date.parse('2026-10-21T10:00:00.000Z');
	const sent: FleetLinkExtensionMessage[] = [];
	const eventListeners: Array<(event: DaemonWatchEvent) => void> = [];
	const connectedListeners: Array<(client: unknown) => void> = [];
	const daemon: SessionStatusDaemon = {
		healthy: true,
		request: async <T,>() => ({ sessions: [info({ provider })] }) as T,
		onEvent: (listener) => {
			eventListeners.push(listener);
			return () => undefined;
		},
		onConnected: (listener) => {
			connectedListeners.push(listener);
			return () => undefined;
		}
	};
	let onHook: ((event: HookEndpointEvent) => void) | null = null;
	const endpoint = new HookEndpoint({
		token: 't'.repeat(64),
		isKnownSession: () => true,
		onEvent: (event) => onHook?.(event)
	});
	const paths = resolveHookPaths(STATE, 'linux');
	const overlay = new SessionHookOverlay({
		paths,
		nodePath: '/usr/bin/node',
		platform: 'linux',
		homedir: '/home/dana',
		env: {},
		fs: nullFs
	});
	const pipeline = new SessionStatusPipeline({
		daemon,
		paths,
		overlay,
		homedir: '/home/dana',
		platform: 'linux',
		fs: nullFs,
		endpoint,
		now: () => now,
		scheduler: { setTimeout: () => null, clearTimeout: () => undefined }
	});
	let linkListener: ((state: { phase: string; linkGeneration: number | null }) => void) | null = null;
	pipeline.bindLink({
		getState: () => ({ phase: 'connected', linkGeneration: 1 }),
		onChange: (listener) => {
			linkListener = listener;
			return () => undefined;
		},
		sendControl: (message) => {
			sent.push(message);
			return true;
		}
	});
	const hook = async (body: Record<string, unknown>) => {
		const event: HookEndpointEvent = { sessionId: SESSION, provider: provider === 'codex' ? 'codex' : 'claude', body, at: now };
		const evidence = await normalizeHookEvent(event, { homedir: '/home/dana' });
		await pipeline.addEvidence(SESSION, evidence);
	};
	return {
		pipeline,
		sent,
		hook,
		advance: (ms: number) => {
			now += ms;
		},
		connect: async () => {
			for (const listener of connectedListeners) listener(null);
			await new Promise((resolve) => setTimeout(resolve, 0));
		},
		daemonEvent: (event: DaemonWatchEvent) => {
			for (const listener of eventListeners) listener(event);
		},
		reconnect: () => linkListener?.({ phase: 'connected', linkGeneration: 2 }),
		types: () => sent.map((message) => `${message.type}:${String(message.state ?? '')}`)
	};
}

describe('SessionStatusPipeline', () => {
	it('prompt → permission → stop reports each change once (ACC-FL05-06)', async () => {
		const h = harness();
		await h.connect();
		await h.hook({ hook_event_name: 'SessionStart', source: 'startup' });
		h.advance(10_000);
		await h.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'run the migration tests' });
		await h.hook({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'pnpm db:migrate' } });
		const permission = h.sent.find((message) => message.type === 'session.attention');
		expect(permission?.attention).toMatchObject({ reason: 'permission', prompt: 'Allow Bash(pnpm db:migrate)?' });
		h.advance(30_000);
		await h.hook({ hook_event_name: 'Stop', last_assistant_message: 'All 42 tests pass.' });
		const statuses = h.sent.filter((message) => message.type === 'session.status').map((message) => message.state);
		expect(statuses).toEqual(['working', 'working', 'needs_you', 'done']);
		const finished = h.sent.filter((message) => message.type === 'session.attention').at(-1);
		expect(finished?.finished).toBe(true);
	});

	it('a driver’s Ctrl-C in a running turn is done · interrupted, never news (U15)', async () => {
		const h = harness();
		await h.connect();
		await h.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go' });
		h.pipeline.observeInput(SESSION, '\u0003');
		await h.pipeline.addEvidence(SESSION, []);
		const last = h.sent.filter((message) => message.type === 'session.status').at(-1);
		expect(last).toMatchObject({ state: 'done', outcome: 'interrupted' });
		expect(h.sent.some((message) => message.finished === true)).toBe(false);
	});

	it('a shell never reports needs_you or done (U20)', async () => {
		const h = harness('shell');
		await h.connect();
		h.daemonEvent({ event: 'activity', id: SESSION, at: '2026-10-21T10:00:01.000Z' });
		h.pipeline.observeInput(SESSION, '\u0003');
		await h.pipeline.addEvidence(SESSION, []);
		for (const message of h.sent) expect(['needs_you', 'done']).not.toContain(message.state);
	});

	it('re-sends where every reported session stands after a reconnect', async () => {
		const h = harness();
		await h.connect();
		await h.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go' });
		const before = h.sent.length;
		h.reconnect();
		expect(h.sent.length).toBeGreaterThan(before);
		expect(h.sent.at(-1)?.type).toBe('session.status');
	});

	it('reports the hook counters for the heartbeat', () => {
		const h = harness();
		expect(h.pipeline.hooksReport()).toMatchObject({ badTokenLastMinute: 0, spooled: 0 });
	});
});
