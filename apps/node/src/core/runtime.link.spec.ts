import { describe, expect, it, vi } from 'vitest';
import type { CapabilityEnvironment, CommandRunner } from './capabilities';
import type { FetchLike } from './fleet-client';
import { fakeSocketFactory, flush, readyMessage } from './link/link-test-kit';
import type { NodeLinkRecord } from './link/link-record';
import { createLogger, type LogEntry } from './logger';
import { createNodeRuntime } from './runtime';
import type { NodeConfig } from './types';

/**
 * Fleet node link (FL-02) — the runtime's half: the fourth consent, the
 * consents on the beat, the `managed` tag, and the link opening on the first
 * accepted heartbeat (FR-1, FR-20, FR-21, U11).
 */

const SECRET = 'ZmFrZS1zZWNyZXQtdmFsdWUtZm9yLXVuaXQtdGVzdHM';
const NODE_ID = '11111111-2222-4333-8444-555555555555';

const environment: CapabilityEnvironment = {
	platform: 'linux',
	arch: 'x64',
	nodeVersion: 'v26.1.0',
	hasDisplay: false
};
const runner: CommandRunner = { run: async () => ({ code: 127, stdout: '', stderr: '' }) };

const config = (): NodeConfig => ({
	apiUrl: 'https://api.ever.works',
	nodeId: NODE_ID,
	secret: SECRET,
	kind: 'node',
	name: 'build-01',
	capabilities: [],
	heartbeatIntervalMs: 60_000,
	enrolledAt: '2026-10-18T00:00:00.000Z'
});

const nodeFromApi = {
	id: NODE_ID,
	name: 'build-01',
	kind: 'node',
	status: 'online',
	platform: 'linux/x64',
	version: '0.3.0',
	capabilities: [],
	lastHeartbeatAt: null,
	createdAt: null,
	persisted: true
};

function platform(options: { rejectConsents?: boolean } = {}) {
	const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
	const fetchFn: FetchLike = async (url, init) => {
		const body = JSON.parse(init.body) as Record<string, unknown>;
		calls.push({ url, body });
		if (url.endsWith('/api/fleet/heartbeat')) {
			if (options.rejectConsents && 'consents' in body) return { ok: false, status: 400, text: async () => '{}' };
			return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, node: nodeFromApi }) };
		}
		if (url.endsWith('/api/fleet/link-token')) {
			return {
				ok: true,
				status: 201,
				text: async () =>
					JSON.stringify({ token: 'minted-link-token', wsPath: '/ws/fleet/link', expiresInSec: 300 })
			};
		}
		return { ok: true, status: 200, text: async () => JSON.stringify({ jobs: [] }) };
	};
	const entries: LogEntry[] = [];
	const logger = createLogger({ sink: (entry) => entries.push(entry) });
	return { calls, entries, io: { fetchFn, runner, environment, logger, version: '0.3.0' } };
}

const beats = (calls: Array<{ url: string; body: Record<string, unknown> }>) =>
	calls.filter((call) => call.url.endsWith('/api/fleet/heartbeat')).map((call) => call.body);

describe('createNodeRuntime — consents and the managed tag', () => {
	it('reports all four consents on every beat and advertises managed only with --manage', async () => {
		const managed = platform();
		const runtime = createNodeRuntime(config(), managed.io, { workerEnabled: true, manageEnabled: true });
		await runtime.loop.start();
		runtime.loop.stop();
		expect(runtime.consents).toEqual({ work: true, attend: false, manage: true, usageScan: false });
		expect(beats(managed.calls)[0]).toMatchObject({
			consents: { work: true, attend: false, manage: true, usageScan: false }
		});
		expect(beats(managed.calls)[0].capabilities).toContain('managed');

		const plain = platform();
		const visibilityOnly = createNodeRuntime(config(), plain.io, {});
		await visibilityOnly.loop.start();
		visibilityOnly.loop.stop();
		expect(beats(plain.calls)[0]).toMatchObject({
			consents: { work: false, attend: false, manage: false, usageScan: false }
		});
		expect(beats(plain.calls)[0].capabilities).not.toContain('managed');
	});

	it('keeps --manage independent of --work and --attend', async () => {
		const p = platform();
		const runtime = createNodeRuntime(config(), p.io, {
			manageEnabled: true,
			nodeLink: true,
			linkSocketFactory: null
		});
		await runtime.loop.start();
		runtime.loop.stop();
		expect(runtime.worker).toBeUndefined();
		expect(runtime.attended).toBeUndefined();
		expect(runtime.consents).toEqual({ work: false, attend: false, manage: true, usageScan: false });
	});
});

describe('createNodeRuntime — the node link', () => {
	it('is not built unless the shell asks for it (the desktop shell keeps its behaviour)', () => {
		const runtime = createNodeRuntime(config(), platform().io, { workerEnabled: true });
		expect(runtime.link).toBeUndefined();
	});

	it('opens after the first accepted beat and says hello with that beat’s tags (FR-1, FR-4)', async () => {
		const p = platform();
		const sockets = fakeSocketFactory();
		const records: NodeLinkRecord[] = [];
		const runtime = createNodeRuntime(config(), p.io, {
			workerEnabled: true,
			manageEnabled: true,
			nodeLink: true,
			linkSocketFactory: sockets.factory,
			persistLinkState: (record) => {
				records.push(record);
			}
		});
		expect(sockets.sockets).toHaveLength(0);
		expect(runtime.link?.getState().phase).toBe('idle');
		await runtime.loop.start();
		runtime.loop.stop();
		await flush(20);
		const mint = p.calls.find((call) => call.url.endsWith('/api/fleet/link-token'));
		expect(mint?.body).toEqual({ nodeId: NODE_ID, secret: SECRET });
		const socket = sockets.last();
		expect(socket.url).toBe('wss://api.ever.works/ws/fleet/link');
		socket.open();
		const hello = socket.controls()[0] as Record<string, unknown>;
		expect(hello).toMatchObject({
			type: 'link.hello',
			nodeId: NODE_ID,
			token: 'minted-link-token',
			consents: { work: true, attend: false, manage: true, usageScan: false }
		});
		expect(hello.capabilities).toEqual(beats(p.calls)[0].capabilities);
		socket.receiveControl(readyMessage(1));
		await flush();
		expect(runtime.link?.getState().phase).toBe('connected');
		expect(records.map((record) => record.phase)).toEqual(expect.arrayContaining(['connecting', 'connected']));
		runtime.link?.close();
		await runtime.worker?.stop();
	});

	it('stays closed on an enrolled-only node and never mints a token (FR-2)', async () => {
		const p = platform();
		const sockets = fakeSocketFactory();
		const runtime = createNodeRuntime(config(), p.io, { nodeLink: true, linkSocketFactory: sockets.factory });
		await runtime.loop.start();
		runtime.loop.stop();
		await flush(20);
		expect(runtime.link?.getState().phase).toBe('not-open');
		expect(p.calls.some((call) => call.url.endsWith('/api/fleet/link-token'))).toBe(false);
		expect(sockets.sockets).toHaveLength(0);
	});

	it('keeps beating without consents and keeps the link closed when the platform predates them (U11)', async () => {
		const p = platform({ rejectConsents: true });
		const sockets = fakeSocketFactory();
		const runtime = createNodeRuntime(config(), p.io, {
			manageEnabled: true,
			nodeLink: true,
			linkSocketFactory: sockets.factory
		});
		await runtime.loop.start();
		runtime.loop.stop();
		await flush(20);
		const sent = beats(p.calls);
		expect(sent).toHaveLength(2);
		expect(sent[0]).toHaveProperty('consents');
		expect(sent[1]).not.toHaveProperty('consents');
		// Everything else the older platform understands is still reported.
		expect(sent[1].capabilities).toEqual(sent[0].capabilities);
		expect(runtime.loop.getState().lastHeartbeatAt).not.toBeNull();
		expect(runtime.loop.acceptsField('consents')).toBe(false);
		expect(sockets.sockets).toHaveLength(0);
		expect(p.calls.some((call) => call.url.endsWith('/api/fleet/link-token'))).toBe(false);
		expect(p.entries.map((entry) => entry.message).join('\n')).toMatch(/predates consents/);
	});

	it('mints nothing and opens nothing for a plain-http platform (FR-6)', async () => {
		const p = platform();
		const sockets = fakeSocketFactory();
		const runtime = createNodeRuntime({ ...config(), apiUrl: 'http://api.example.com' }, p.io, {
			workerEnabled: true,
			nodeLink: true,
			linkSocketFactory: sockets.factory
		});
		await runtime.loop.start();
		runtime.loop.stop();
		await flush(20);
		expect(runtime.link?.getState().phase).toBe('insecure');
		expect(p.calls.some((call) => call.url.endsWith('/api/fleet/link-token'))).toBe(false);
		expect(sockets.sockets).toHaveLength(0);
		await runtime.worker?.stop();
	});

	it('records the link state through the persist hook only on a change, and survives a failing hook', async () => {
		const p = platform();
		const persist = vi.fn(async () => {
			throw new Error('disk full');
		});
		const runtime = createNodeRuntime(config(), p.io, {
			workerEnabled: true,
			nodeLink: true,
			linkSocketFactory: fakeSocketFactory().factory,
			persistLinkState: persist
		});
		await runtime.loop.start();
		runtime.loop.stop();
		await flush(20);
		expect(persist).toHaveBeenCalled();
		const phases = (persist.mock.calls as unknown as Array<[NodeLinkRecord]>).map(([record]) => record.phase);
		expect(new Set(phases).size).toBe(phases.length);
		expect(p.entries.some((entry) => entry.message.includes('Could not record the node link state'))).toBe(true);
		runtime.link?.close();
		await runtime.worker?.stop();
	});
});
