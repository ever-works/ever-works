import { describe, expect, it, vi } from 'vitest';
import type { CapabilityEnvironment, CommandRunner } from './capabilities';
import type { FetchLike } from './fleet-client';
import { createLogger, type LogEntry } from './logger';
import { clampHeartbeatInterval, createNodeRuntime, enrollNode, installShutdownHandlers } from './runtime';
import {
	DEFAULT_HEARTBEAT_INTERVAL_MS,
	MAX_HEARTBEAT_INTERVAL_MS,
	MIN_HEARTBEAT_INTERVAL_MS,
	type NodeConfig
} from './types';

const TOKEN = 'ZmFrZS1lbnJvbGxtZW50LXRva2VuLWZvci10ZXN0aW5n';
const SECRET = 'ZmFrZS1zZWNyZXQtdmFsdWUtZm9yLXVuaXQtdGVzdHM';
const NODE_ID = '11111111-2222-4333-8444-555555555555';

const environment: CapabilityEnvironment = {
	platform: 'linux',
	arch: 'x64',
	nodeVersion: 'v22.11.0',
	hasDisplay: false
};

const runner: CommandRunner = {
	run: async (command) =>
		command === 'git' ? { code: 0, stdout: 'git version 2.4', stderr: '' } : { code: 127, stdout: '', stderr: '' }
};

function io(fetchFn: FetchLike) {
	const entries: LogEntry[] = [];
	const logger = createLogger({ sink: (entry) => entries.push(entry) });
	return { entries, logger, io: { fetchFn, runner, environment, logger, version: '0.1.0' } };
}

function enrollResponse(body: unknown, status = 201): FetchLike {
	return async () => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
}

const nodeFromApi = {
	id: NODE_ID,
	name: 'build-box-01',
	kind: 'node',
	status: 'online',
	platform: 'linux/x64',
	version: '0.1.0',
	capabilities: ['os:linux'],
	lastHeartbeatAt: null,
	createdAt: null,
	persisted: true
};

describe('clampHeartbeatInterval', () => {
	it('defaults, floors and ceilings the operator-supplied cadence', () => {
		expect(clampHeartbeatInterval(undefined)).toBe(DEFAULT_HEARTBEAT_INTERVAL_MS);
		expect(clampHeartbeatInterval(Number.NaN)).toBe(DEFAULT_HEARTBEAT_INTERVAL_MS);
		expect(clampHeartbeatInterval(1)).toBe(MIN_HEARTBEAT_INTERVAL_MS);
		expect(clampHeartbeatInterval(99_999_999)).toBe(MAX_HEARTBEAT_INTERVAL_MS);
		expect(clampHeartbeatInterval(30_000)).toBe(30_000);
	});
});

describe('enrollNode', () => {
	it('detects capabilities, consumes the token and returns a persistable config', async () => {
		const { io: deps, entries } = io(enrollResponse({ nodeId: NODE_ID, secret: SECRET, node: nodeFromApi }));

		const config = await enrollNode({
			...deps,
			apiUrl: 'https://api.ever.works/',
			token: TOKEN,
			kind: 'node',
			now: () => Date.parse('2026-07-25T10:00:00.000Z')
		});

		expect(config).toEqual<NodeConfig>({
			apiUrl: 'https://api.ever.works',
			nodeId: NODE_ID,
			secret: SECRET,
			kind: 'node',
			capabilities: ['os:linux', 'arch:x64', 'node:22', 'terminal', 'workspace', 'git'],
			name: 'build-box-01',
			heartbeatIntervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
			enrolledAt: '2026-07-25T10:00:00.000Z'
		});

		// The whole enrollment conversation is logged — with neither credential in it.
		const text = entries.map((entry) => entry.message).join('\n');
		expect(text).toContain(`Enrolled as node ${NODE_ID}`);
		expect(text).not.toContain(TOKEN);
		expect(text).not.toContain(SECRET);
	});

	it('prefers an explicit local label over the platform-assigned name', async () => {
		const { io: deps } = io(enrollResponse({ nodeId: NODE_ID, secret: SECRET, node: nodeFromApi }));
		const config = await enrollNode({
			...deps,
			apiUrl: 'https://api.ever.works',
			token: TOKEN,
			kind: 'desktop-node',
			name: '  my-laptop  ',
			heartbeatIntervalMs: 30_000
		});

		expect(config.name).toBe('my-laptop');
		expect(config.kind).toBe('desktop-node');
		expect(config.heartbeatIntervalMs).toBe(30_000);
	});

	it('propagates an invalid token as an unauthorized FleetClientError', async () => {
		const { io: deps } = io(enrollResponse({ message: 'Invalid or expired enrollment token' }, 401));

		await expect(
			enrollNode({ ...deps, apiUrl: 'https://api.ever.works', token: TOKEN, kind: 'node' })
		).rejects.toMatchObject({ kind: 'unauthorized', status: 401 });
	});
});

describe('createNodeRuntime', () => {
	it('wires a client and a loop against the stored config, protecting the secret', async () => {
		const {
			io: deps,
			entries,
			logger
		} = io(async () => ({
			ok: true,
			status: 200,
			text: async () => JSON.stringify({ ok: true, node: nodeFromApi })
		}));

		const config: NodeConfig = {
			apiUrl: 'https://api.ever.works',
			nodeId: NODE_ID,
			secret: SECRET,
			kind: 'node',
			capabilities: ['os:linux'],
			heartbeatIntervalMs: 30_000,
			enrolledAt: '2026-07-25T10:00:00.000Z'
		};

		const runtime = createNodeRuntime(config, deps);
		expect(runtime.client.baseUrl).toBe('https://api.ever.works');

		await runtime.loop.start();
		runtime.loop.stop();

		expect(runtime.loop.getState().node).toMatchObject({ id: NODE_ID });

		logger.info(`secret is ${SECRET}`);
		expect(entries.map((entry) => entry.message).join('\n')).not.toContain(SECRET);
	});
});

describe('installShutdownHandlers', () => {
	it('registers both signals and runs the shutdown exactly once', () => {
		const handlers = new Map<string, () => void>();
		const shutdown = vi.fn();

		installShutdownHandlers({ on: (signal, handler) => handlers.set(signal, handler) }, shutdown);

		expect([...handlers.keys()].sort()).toEqual(['SIGINT', 'SIGTERM']);

		handlers.get('SIGINT')?.();
		handlers.get('SIGINT')?.();
		handlers.get('SIGTERM')?.();

		expect(shutdown).toHaveBeenCalledTimes(1);
	});
});
