import { describe, expect, it, vi } from 'vitest';
import type { FleetJobView, TenantCredentialSnapshot } from '../index.js';
import {
	NodeDispatcherFactory,
	NodeJobOwnerRequiredError,
	NodeJobRuntimePlugin,
	NodeWorkerHostFactory,
	mapNodeEnqueueOptions,
	nextBackoffMs,
	CAPABILITY_TAG_PREFIX
} from '../index.js';
import type { FleetJobStore } from '../node-types.js';

function job(overrides: Partial<FleetJobView> = {}): FleetJobView {
	return {
		id: 'job-1',
		kind: 'acceptance-checks',
		status: 'leased',
		nodeId: 'node-1',
		requiredCapabilities: [],
		payload: null,
		leaseExpiresAt: null,
		attempts: 1,
		maxAttempts: 3,
		createdAt: null,
		startedAt: null,
		completedAt: null,
		...overrides
	};
}

function fakeStore(overrides: Partial<FleetJobStore> = {}): FleetJobStore {
	return {
		enqueue: vi.fn(async () => job({ id: 'created-1', status: 'queued' })),
		...overrides
	};
}

describe('NodeJobRuntimePlugin — contract parity with the sibling runtimes', () => {
	it('declares runtimeId `node` under the job-runtime category', () => {
		const plugin = new NodeJobRuntimePlugin();
		expect(plugin.runtimeId).toBe('node');
		expect(plugin.id).toBe('job-runtime-node');
		expect(plugin.category).toBe('job-runtime');
	});

	it('declares the same capability strings the family uses, plus worker-host', () => {
		const plugin = new NodeJobRuntimePlugin();
		expect(plugin.capabilities).toEqual(
			expect.arrayContaining([
				'job-runtime-enqueue',
				'job-runtime-cancel',
				'job-runtime-status',
				'job-runtime-schedule',
				'job-runtime-worker-host',
				'job-runtime-bind-tenant'
			])
		);
	});

	it('throws a named, actionable error when a dispatcher is unconfigured', () => {
		const plugin = new NodeJobRuntimePlugin();
		const dispatchers = plugin.dispatchers as Record<string, () => unknown>;
		expect(() => dispatchers.dispatchWorkGeneration()).toThrowError(
			/NodeDispatcherNotConfigured|is not configured/
		);
	});

	it('reports disabled until an operator wires a store', () => {
		const plugin = new NodeJobRuntimePlugin();
		expect(plugin.isEnabled()).toBe(false);
		plugin.useDispatcherFactory(new NodeDispatcherFactory({ store: fakeStore() }));
		expect(plugin.isEnabled()).toBe(true);
	});

	it('projects fleet job statuses onto the platform run-status union', async () => {
		const store = fakeStore({ findById: vi.fn(async () => job({ status: 'done' })) });
		const plugin = new NodeJobRuntimePlugin().useDispatcherFactory(new NodeDispatcherFactory({ store }));
		await expect(plugin.getRunStatus('job-1')).resolves.toBe('completed');
	});

	it('returns `unknown` — never throws — for an unresolvable run id', async () => {
		const store = fakeStore({
			findById: vi.fn(async () => {
				throw new Error('boom');
			})
		});
		const plugin = new NodeJobRuntimePlugin().useDispatcherFactory(new NodeDispatcherFactory({ store }));
		await expect(plugin.getRunStatus('nope')).resolves.toBe('unknown');
	});

	it('memoises bindToTenant on (tenantId, credentialVersion)', () => {
		const plugin = new NodeJobRuntimePlugin();
		const snapshot: TenantCredentialSnapshot = {
			tenantId: 'tenant-1',
			providerId: 'node',
			credentialVersion: 3,
			credentials: {}
		};
		const first = plugin.bindToTenant(snapshot);
		expect(plugin.bindToTenant(snapshot)).toBe(first);
		expect(first.tenantId).toBe('tenant-1');
		// A version bump must produce a NEW view, not the cached one.
		expect(plugin.bindToTenant({ ...snapshot, credentialVersion: 4 })).not.toBe(first);
	});

	it('treats registerSchedules as a deliberate no-op', async () => {
		const plugin = new NodeJobRuntimePlugin();
		await expect(plugin.registerSchedules([{ id: 'x', cron: '* * * * *' }])).resolves.toBeUndefined();
	});
});

describe('NodeDispatcherFactory', () => {
	it('refuses to enqueue a job with no owner — an orphan row can never be leased', async () => {
		const factory = new NodeDispatcherFactory({ store: fakeStore() });
		await expect(factory.enqueue({ kind: 'acceptance-checks' })).rejects.toBeInstanceOf(NodeJobOwnerRequiredError);
	});

	it('rejects an unsupported job kind at the edge', async () => {
		const factory = new NodeDispatcherFactory({ store: fakeStore(), defaultUserId: 'u1' });
		await expect(factory.enqueue({ kind: 'not-a-kind' as never })).rejects.toThrowError(
			/unsupported fleet job kind/
		);
	});

	it('turns `cap:` tags into scheduling requirements and stamps the rest onto the payload', async () => {
		const store = fakeStore();
		const factory = new NodeDispatcherFactory({ store, defaultUserId: 'u1' });
		await factory.enqueue(
			{ kind: 'acceptance-checks', payload: { workspacePath: '/w' } },
			{ tags: ['cap:workspace', 'cap:git', 'observability-only'], tenantId: 't1', idempotencyKey: 'k1' }
		);
		expect(store.enqueue).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: 'u1',
				requiredCapabilities: ['workspace', 'git'],
				idempotencyKey: 'k1',
				payload: expect.objectContaining({
					workspacePath: '/w',
					_ew: expect.objectContaining({ tenantId: 't1' })
				})
			})
		);
	});

	it('reports a cancel it could not deliver as false, never as success', async () => {
		const withoutCancel = new NodeDispatcherFactory({ store: fakeStore() });
		await expect(withoutCancel.cancel('job-1')).resolves.toBe(false);

		const throwing = new NodeDispatcherFactory({
			store: fakeStore({
				cancel: vi.fn(async () => {
					throw new Error('nope');
				})
			})
		});
		await expect(throwing.cancel('job-1')).resolves.toBe(false);
	});
});

describe('mapNodeEnqueueOptions', () => {
	it('only promotes prefixed tags, so an observability tag cannot strand a job', () => {
		const mapped = mapNodeEnqueueOptions({ tags: ['workspace', `${CAPABILITY_TAG_PREFIX}docker`] });
		expect(mapped.requiredCapabilities).toEqual(['docker']);
	});

	it('derives the lease TTL from the run wall-clock budget, clamped', () => {
		expect(mapNodeEnqueueOptions({ maxDurationSeconds: 5 }).leaseTtlSec).toBe(30);
		expect(mapNodeEnqueueOptions({ maxDurationSeconds: 999_999 }).leaseTtlSec).toBe(3600);
		expect(mapNodeEnqueueOptions({}).leaseTtlSec).toBe(300);
	});
});

describe('nextBackoffMs', () => {
	it('grows exponentially from the base delay and stops at the ceiling', () => {
		expect(nextBackoffMs(1)).toBe(1_000);
		expect(nextBackoffMs(2)).toBe(2_000);
		expect(nextBackoffMs(4)).toBe(8_000);
		expect(nextBackoffMs(99)).toBe(60_000);
	});

	it('collapses nonsense input to the base delay rather than throwing', () => {
		expect(nextBackoffMs(0)).toBe(1_000);
		expect(nextBackoffMs(Number.NaN)).toBe(1_000);
	});
});

describe('NodeWorkerHostFactory', () => {
	// A real macrotask boundary — a microtask-only sleep would starve
	// the timers this loop (and vitest's own timeout) depends on.
	const immediate = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
	// Generous: each loop iteration crosses two real timer boundaries, and
	// Windows timer granularity makes a tight budget flaky rather than fast.
	const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 250));

	it('fails a leased job whose kind has no executor, naming the kind', async () => {
		const complete = vi.fn(async () => true);
		let handedOut = false;
		const host = new NodeWorkerHostFactory({
			transport: {
				lease: async () => {
					if (handedOut) return [];
					handedOut = true;
					return [job({ kind: 'acceptance-checks' })];
				},
				heartbeat: async () => true,
				complete
			},
			sleep: immediate
		});

		const handle = await host.start({ concurrency: 1 });
		await settle();
		await handle.stop();

		expect(complete).toHaveBeenCalledWith(
			'job-1',
			expect.objectContaining({
				success: false,
				error: expect.stringContaining('acceptance-checks')
			})
		);
	});

	it('reports an executor throw as a job failure rather than swallowing it', async () => {
		const complete = vi.fn(async () => true);
		let handedOut = false;
		const host = new NodeWorkerHostFactory({
			transport: {
				lease: async () => {
					if (handedOut) return [];
					handedOut = true;
					return [job()];
				},
				heartbeat: async () => true,
				complete
			},
			sleep: immediate
		});
		host.register('acceptance-checks', async () => {
			throw new Error('check runner exploded');
		});

		const handle = await host.start({ concurrency: 1 });
		await settle();
		await handle.stop();

		expect(complete).toHaveBeenCalledWith(
			'job-1',
			expect.objectContaining({ success: false, error: 'check runner exploded' })
		);
	});

	it('refuses registrations after start so the executor set is fixed while polling', async () => {
		const host = new NodeWorkerHostFactory({
			transport: { lease: async () => [], heartbeat: async () => true, complete: async () => true },
			sleep: immediate
		});
		const handle = await host.start();
		expect(() => host.register('acceptance-checks', async () => undefined)).toThrowError(/cannot register/);
		await handle.stop();
	});

	it('backs off instead of hot-looping when the lease endpoint keeps failing', async () => {
		const delays: number[] = [];
		let calls = 0;
		const host = new NodeWorkerHostFactory({
			transport: {
				lease: async () => {
					calls += 1;
					throw new Error('API down');
				},
				heartbeat: async () => true,
				complete: async () => true
			},
			sleep: async (ms) => {
				delays.push(ms);
				// Let a handful of failures accumulate, then release the loop.
				// NOT awaited: stopping from inside the loop's own await chain
				// is exactly the re-entrancy `stopAll` guards against.
				if (delays.length >= 3) void host.stopAll();
			}
		});

		await host.start();
		await settle();

		expect(calls).toBeGreaterThanOrEqual(3);
		// Doubling from the base delay — not a hot loop against a dead endpoint.
		expect(delays.slice(0, 3)).toEqual([1_000, 2_000, 4_000]);
		// And the stop requested from INSIDE the loop actually took effect.
		expect(delays.length).toBeLessThan(10);
	});

	it('is idempotent on stop — a second stop while draining is a no-op', async () => {
		const host = new NodeWorkerHostFactory({
			transport: { lease: async () => [], heartbeat: async () => true, complete: async () => true },
			sleep: immediate
		});
		const handle = await host.start();
		await Promise.all([handle.stop(), handle.stop()]);
		// A fresh start after a clean stop must be allowed.
		await expect(host.start()).resolves.toBeDefined();
		await host.stopAll();
	});
});
