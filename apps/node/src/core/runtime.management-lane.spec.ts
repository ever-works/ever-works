import { describe, expect, it, vi } from 'vitest';
import type { CapabilityEnvironment, CommandRunner } from './capabilities';
import type { FetchLike } from './fleet-client';
import { createLogger } from './logger';
import { MANAGEMENT_LANE_EXECUTORS, planManagementLane, type ManagementLaneTables } from './management-lane';
import { createNodeRuntime } from './runtime';
import type { NodeConfig } from './types';

/**
 * Fleet node link (FL-02, T-27, CONTRACTS R-34) — the management lane: leased
 * only with its kind's consent, never by the work lane, outside the work
 * lane's slots, and not started at all while its kind list is empty (as it
 * ships). The tests register a stand-in kind (`browser-check`) because the
 * real ones arrive with FL-16, FL-18 and FL-20.
 */

const NODE_ID = '11111111-2222-4333-8444-555555555555';
const SECRET = 'ZmFrZS1zZWNyZXQtdmFsdWUtZm9yLXVuaXQtdGVzdHM';

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

function platform() {
	const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
	const fetchFn: FetchLike = async (url, init) => {
		const body = JSON.parse(init.body) as Record<string, unknown>;
		calls.push({ url, body });
		if (url.endsWith('/api/fleet/heartbeat')) {
			return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, node: nodeFromApi }) };
		}
		return { ok: true, status: 200, text: async () => JSON.stringify({ jobs: [] }) };
	};
	const logger = createLogger({ sink: () => undefined });
	return { calls, io: { fetchFn, runner, environment, logger, version: '0.3.0' } };
}

const leases = (calls: Array<{ url: string; body: Record<string, unknown> }>) =>
	calls.filter((call) => call.url.endsWith('/api/fleet/jobs/lease')).map((call) => call.body);

const run = vi.fn(async () => ({}));
const testLane = (consent: 'manage' | 'work' | 'usageScan' = 'manage'): ManagementLaneTables => ({
	kinds: ['browser-check'],
	consents: { 'browser-check': consent },
	executors: [{ kind: 'browser-check', run }]
});

describe('the management lane — as it ships', () => {
	it('owns the FL-16 kinds but, without a virtual data folder, has no executor, so no node starts it', () => {
		// FL-02 shipped the lane with no kinds; FL-16 registered `vm-create` and
		// `vm-control`. Their executors are built by the runtime only for a host
		// with a virtual data folder (`virtualDataDir`), so a process without one
		// owns the kinds (its work lane never leases them) and leases none.
		expect(MANAGEMENT_LANE_EXECUTORS).toEqual([]);
		const plan = planManagementLane({ work: true, attend: true, manage: true, usageScan: true });
		// FL-18 appended `runner-install` / `runner-control` (built only with a runners folder).
		expect(plan).toEqual({
			kinds: [],
			ownedKinds: ['vm-create', 'vm-control', 'runner-install', 'runner-control'],
			executors: []
		});
		const runtime = createNodeRuntime(config(), platform().io, { workerEnabled: true, manageEnabled: true });
		expect(runtime.management).toBeUndefined();
	});

	it('starts with the VM kinds on a Linux host with --manage and a virtual data folder (FL-16)', () => {
		const runtime = createNodeRuntime(config(), platform().io, {
			manageEnabled: true,
			virtualDataDir: '/var/lib/ever-works-node/virtual'
		});
		expect(runtime.management?.kinds).toEqual(['vm-create', 'vm-control']);
		const without = createNodeRuntime(config(), platform().io, {
			workerEnabled: true,
			virtualDataDir: '/var/lib/ever-works-node/virtual'
		});
		expect(without.management).toBeUndefined();
	});

	it('starts with the runner kinds under --work with a runners folder (FL-18), never without --work', () => {
		const runtime = createNodeRuntime(config(), platform().io, {
			workerEnabled: true,
			runnersDataDir: '/var/lib/ever-works-node/actions-runners'
		});
		expect(runtime.management?.kinds).toEqual(['runner-install', 'runner-control']);
		const both = createNodeRuntime(config(), platform().io, {
			workerEnabled: true,
			manageEnabled: true,
			virtualDataDir: '/var/lib/ever-works-node/virtual',
			runnersDataDir: '/var/lib/ever-works-node/actions-runners'
		});
		expect(both.management?.kinds).toEqual(['vm-create', 'vm-control', 'runner-install', 'runner-control']);
		const manageOnly = createNodeRuntime(config(), platform().io, {
			manageEnabled: true,
			runnersDataDir: '/var/lib/ever-works-node/actions-runners'
		});
		expect(manageOnly.management).toBeUndefined();
	});

	it('leaves the work lane exactly as it was (no extra excluded kind)', async () => {
		const p = platform();
		const runtime = createNodeRuntime(config(), p.io, { workerEnabled: true, manageEnabled: true });
		await runtime.loop.start();
		runtime.loop.stop();
		await runtime.worker?.start();
		await runtime.worker?.stop();
		for (const body of leases(p.calls)) {
			expect((body.excludeKinds as string[] | undefined) ?? []).not.toContain('browser-check');
		}
	});
});

describe('the management lane — with a registered kind', () => {
	it('starts only with that kind’s consent on', () => {
		const withManage = createNodeRuntime(config(), platform().io, {
			manageEnabled: true,
			managementLane: testLane('manage')
		});
		expect(withManage.management?.kinds).toEqual(['browser-check']);
		expect(withManage.management?.worker.registeredKinds).toEqual(['browser-check']);

		const withoutManage = createNodeRuntime(config(), platform().io, {
			workerEnabled: true,
			managementLane: testLane('manage')
		});
		expect(withoutManage.management).toBeUndefined();

		// A runner-style kind rides --work instead.
		const runnerStyle = createNodeRuntime(config(), platform().io, {
			workerEnabled: true,
			managementLane: testLane('work')
		});
		expect(runnerStyle.management?.kinds).toEqual(['browser-check']);
	});

	it('leases only its kinds, one at a time, and the work lane never leases them', async () => {
		const p = platform();
		const runtime = createNodeRuntime(config(), p.io, {
			workerEnabled: true,
			manageEnabled: true,
			concurrency: 3,
			managementLane: testLane('manage')
		});
		await runtime.loop.start();
		runtime.loop.stop();
		await runtime.worker?.start();
		await runtime.management?.worker.start();
		await runtime.worker?.stop();
		await runtime.management?.worker.stop();

		const bodies = leases(p.calls);
		const managementLeases = bodies.filter((body) => Array.isArray(body.kinds));
		expect(managementLeases.length).toBeGreaterThan(0);
		for (const body of managementLeases) {
			expect(body.kinds).toEqual(['browser-check']);
			expect(body.max).toBe(1);
		}
		const workLeases = bodies.filter((body) => !Array.isArray(body.kinds));
		expect(workLeases.length).toBeGreaterThan(0);
		for (const body of workLeases) {
			expect(body.excludeKinds).toEqual(expect.arrayContaining(['browser-check']));
		}
	});

	it('keeps its kind out of the work lane even while its consent is off', async () => {
		const p = platform();
		const runtime = createNodeRuntime(config(), p.io, {
			workerEnabled: true,
			managementLane: testLane('manage')
		});
		expect(runtime.management).toBeUndefined();
		await runtime.loop.start();
		runtime.loop.stop();
		await runtime.worker?.start();
		await runtime.worker?.stop();
		for (const body of leases(p.calls)) {
			expect(body.excludeKinds).toEqual(expect.arrayContaining(['browser-check']));
		}
	});

	it('does not lease a kind this node has no executor for', () => {
		const plan = planManagementLane(
			{ work: false, attend: false, manage: true, usageScan: false },
			{ kinds: ['browser-check'], consents: {}, executors: [] }
		);
		expect(plan.kinds).toEqual([]);
		expect(plan.ownedKinds).toEqual(['browser-check']);
	});
});
