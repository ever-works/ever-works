import { describe, expect, it, vi } from 'vitest';
import type { JobRuntimeDispatchers, TenantCredentialSnapshot } from '@ever-works/plugin';
import {
	DEFAULT_TRIGGER_API_URL,
	TriggerJobRuntimePlugin,
	type TriggerTenantCredentials
} from '../trigger-job-runtime.plugin.js';
import type { TriggerClient, TriggerRunHandle, TriggerRunRecord, TriggerTaskOptions } from '../trigger-types.js';

/**
 * EW-742 P3.2 T22 — BYO / override Trigger.dev credentials test plan.
 *
 * Sibling of `trigger-plugin-operator-hooks.spec.ts` (which covers the
 * inherit / operator-wired path) and `trigger-tenant-conformance.spec.ts`
 * (which exercises the cross-provider P6 contract). This file pins the
 * BYO-specific contract added by EW-742 P3.2:
 *
 *   1. No snapshot is not a real call path (TS type forbids it), but
 *      "snapshot with no credentials" stays on the inherit fast path:
 *      tenantClient `null`, no warn, view's dispatchers identical to
 *      the platform default.
 *   2. Partial credentials (one of accessToken/secretKey/projectRef
 *      missing) fail-open + warn naming the missing field.
 *   3. Full credentials + a wired `clientFactory` build a per-tenant
 *      `TriggerClient` and route the view's dispatchers through it.
 *   4. Missing `clientFactory` even with full creds is fail-open + warn.
 *   5. `apiUrl` override flows through to the factory verbatim.
 *   6. Idempotency on (tenantId, credentialVersion).
 *   7. Cache invalidation on credentialVersion bump.
 *   8. Cross-tenant binding isolation (per-provider — full cross-
 *      provider isolation already lives in #1531).
 */

interface TriggerCall {
	readonly taskId: string;
	readonly payload: unknown;
	readonly options?: TriggerTaskOptions;
}

/**
 * Lightweight stand-in for a per-tenant Trigger.dev SDK client. Each
 * instance carries an `id` tag so tests can assert which client a
 * dispatch was routed to (proves per-tenant isolation at the binding
 * layer).
 */
class FakeTenantClient implements TriggerClient {
	constructor(readonly id: string) {}
	readonly triggerCalls: TriggerCall[] = [];

	readonly tasks = {
		trigger: async (taskId: string, payload: unknown, options?: TriggerTaskOptions): Promise<TriggerRunHandle> => {
			this.triggerCalls.push({ taskId, payload, options });
			return { id: `${this.id}:run` };
		}
	};

	readonly runs = {
		cancel: async (_runId: string): Promise<unknown> => undefined,
		retrieve: async (runId: string): Promise<TriggerRunRecord> => ({
			id: runId,
			status: 'EXECUTING'
		})
	};
}

const snapshot = (overrides: Partial<TenantCredentialSnapshot> = {}): TenantCredentialSnapshot => ({
	tenantId: '00000000-0000-0000-0000-00000000aaaa',
	providerId: 'trigger',
	credentialVersion: 1,
	credentials: {
		accessToken: 'tr_pat_aaaa',
		secretKey: 'tr_dev_aaaa',
		projectRef: 'proj_aaaa'
	},
	...overrides
});

describe('TriggerJobRuntimePlugin — BYO credentials (EW-742 P3.2 T22)', () => {
	describe('1. inherit fast path', () => {
		it('returns a view whose dispatchers equal the platform default when credentials bag is empty', () => {
			const warn = vi.fn();
			const platformDispatchers: JobRuntimeDispatchers = Object.freeze({
				dispatchKbEmbedDocument: () => Promise.resolve('platform-default')
			});
			const plugin = new TriggerJobRuntimePlugin({ logger: { warn } }).useDispatchers(platformDispatchers);
			const view = plugin.bindToTenant(snapshot({ credentials: {} }));
			expect(view.tenantClient).toBeNull();
			expect(view.tenantProjectAccessToken).toBeNull();
			expect(view.dispatchers).toBe(plugin.dispatchers);
			// Empty bag — pure inherit case, no warn noise.
			expect(warn).not.toHaveBeenCalled();
		});
	});

	describe('2. malformed credentials fail-open with named warn', () => {
		it.each([
			['accessToken', { secretKey: 'k', projectRef: 'r' }],
			['secretKey', { accessToken: 't', projectRef: 'r' }],
			['projectRef', { accessToken: 't', secretKey: 'k' }]
		])('missing %s → warn names it, view falls back to platform default', (missing, bag) => {
			const warn = vi.fn();
			const clientFactory = vi.fn();
			const plugin = new TriggerJobRuntimePlugin({
				logger: { warn },
				clientFactory
			});
			const view = plugin.bindToTenant(snapshot({ credentials: bag }));
			expect(view.tenantClient).toBeNull();
			expect(view.dispatchers).toBe(plugin.dispatchers);
			expect(clientFactory).not.toHaveBeenCalled();
			expect(warn).toHaveBeenCalledTimes(1);
			const message = warn.mock.calls[0][0] as string;
			expect(message).toContain('malformed BYO credentials');
			expect(message).toContain(missing);
		});
	});

	describe('3. full credentials + clientFactory → per-tenant routing', () => {
		it('builds a per-tenant client and routes dispatchers through it', async () => {
			const tenantClient = new FakeTenantClient('tenant-a');
			const clientFactory = vi.fn((_creds: TriggerTenantCredentials) => tenantClient);
			const plugin = new TriggerJobRuntimePlugin({
				clientFactory,
				dispatchersFromClient: (c) => ({
					dispatchKbEmbedDocument: async (payload: unknown) => {
						const handle = await c.tasks.trigger('kb-embed-document', payload);
						return handle.id;
					}
				})
			});

			const view = plugin.bindToTenant(snapshot());
			expect(view.tenantClient).toBe(tenantClient);
			expect(view.tenantProjectAccessToken).toBe('tr_pat_aaaa');
			// Sanity — view's dispatchers are NOT the platform default.
			expect(view.dispatchers).not.toBe(plugin.dispatchers);

			const d = view.dispatchers as unknown as {
				dispatchKbEmbedDocument: (p: unknown) => Promise<string | null>;
			};
			await expect(d.dispatchKbEmbedDocument({ workId: 'w1' })).resolves.toBe('tenant-a:run');
			expect(tenantClient.triggerCalls).toEqual([
				{ taskId: 'kb-embed-document', payload: { workId: 'w1' }, options: undefined }
			]);
			// Factory got the validated, typed credentials bundle.
			expect(clientFactory).toHaveBeenCalledTimes(1);
			expect(clientFactory.mock.calls[0][0]).toEqual({
				accessToken: 'tr_pat_aaaa',
				secretKey: 'tr_dev_aaaa',
				projectRef: 'proj_aaaa'
			});
		});
	});

	describe('4. full credentials without clientFactory → fail-open', () => {
		it('no clientFactory wired → tenantClient null, dispatchers are platform default', () => {
			const platformDispatchers: JobRuntimeDispatchers = Object.freeze({
				dispatchKbEmbedDocument: () => Promise.resolve('platform-default')
			});
			const plugin = new TriggerJobRuntimePlugin().useDispatchers(platformDispatchers);
			const view = plugin.bindToTenant(snapshot());
			expect(view.tenantClient).toBeNull();
			expect(view.tenantProjectAccessToken).toBe('tr_pat_aaaa');
			expect(view.dispatchers).toBe(plugin.dispatchers);
		});
	});

	describe('5. apiUrl override flows through to clientFactory', () => {
		it('credentials.apiUrl is passed to clientFactory verbatim', () => {
			const clientFactory = vi.fn((_c: TriggerTenantCredentials) => new FakeTenantClient('x'));
			const plugin = new TriggerJobRuntimePlugin({ clientFactory });
			plugin.bindToTenant(
				snapshot({
					credentials: {
						accessToken: 'tr_pat_x',
						secretKey: 'tr_dev_x',
						projectRef: 'proj_x',
						apiUrl: 'https://trigger.tenant-x.internal'
					}
				})
			);
			expect(clientFactory).toHaveBeenCalledTimes(1);
			expect(clientFactory.mock.calls[0][0]).toEqual({
				accessToken: 'tr_pat_x',
				secretKey: 'tr_dev_x',
				projectRef: 'proj_x',
				apiUrl: 'https://trigger.tenant-x.internal'
			});
		});

		it('no apiUrl in credentials → clientFactory receives no `apiUrl` (operator picks default)', () => {
			const clientFactory = vi.fn((_c: TriggerTenantCredentials) => new FakeTenantClient('x'));
			const plugin = new TriggerJobRuntimePlugin({ clientFactory });
			plugin.bindToTenant(snapshot());
			expect(clientFactory.mock.calls[0][0]).not.toHaveProperty('apiUrl');
			// DEFAULT_TRIGGER_API_URL stays exported for operators that
			// want to apply the default themselves.
			expect(DEFAULT_TRIGGER_API_URL).toBe('https://api.trigger.dev');
		});
	});

	describe('6. idempotency on (tenantId, credentialVersion)', () => {
		it('two bind calls with the same snapshot return the SAME view (cached)', () => {
			const clientFactory = vi.fn(() => new FakeTenantClient('tenant-a'));
			const plugin = new TriggerJobRuntimePlugin({ clientFactory });
			const v1 = plugin.bindToTenant(snapshot());
			const v2 = plugin.bindToTenant(snapshot());
			expect(v2).toBe(v1);
			// Factory invoked exactly once — proves memoisation, not just
			// reference equality after a fresh build.
			expect(clientFactory).toHaveBeenCalledTimes(1);
		});
	});

	describe('7. credentialVersion bump invalidates cache', () => {
		it('bumping credentialVersion returns a FRESH view + a FRESH client', () => {
			let counter = 0;
			const clientFactory = vi.fn(() => new FakeTenantClient(`tenant-a-v${++counter}`));
			const plugin = new TriggerJobRuntimePlugin({ clientFactory });
			const v1 = plugin.bindToTenant(snapshot({ credentialVersion: 1 }));
			const v2 = plugin.bindToTenant(snapshot({ credentialVersion: 2 }));
			expect(v2).not.toBe(v1);
			expect(v1.tenantClient).not.toBe(v2.tenantClient);
			expect((v1.tenantClient as FakeTenantClient).id).toBe('tenant-a-v1');
			expect((v2.tenantClient as FakeTenantClient).id).toBe('tenant-a-v2');
		});
	});

	describe('8. cross-tenant binding isolation', () => {
		it("tenant A's dispatch does NOT route through tenant B's client", async () => {
			const clientByTenant = new Map<string, FakeTenantClient>();
			const clientFactory = (creds: TriggerTenantCredentials): TriggerClient => {
				const client = new FakeTenantClient(creds.projectRef);
				clientByTenant.set(creds.projectRef, client);
				return client;
			};
			const plugin = new TriggerJobRuntimePlugin({
				clientFactory,
				dispatchersFromClient: (c) => ({
					dispatchKbEmbedDocument: async (payload: unknown) => {
						const handle = await c.tasks.trigger('kb-embed-document', payload);
						return handle.id;
					}
				})
			});

			const viewA = plugin.bindToTenant(
				snapshot({
					tenantId: '00000000-0000-0000-0000-0000000000aa',
					credentials: {
						accessToken: 'tr_pat_a',
						secretKey: 'tr_dev_a',
						projectRef: 'proj_a'
					}
				})
			);
			const viewB = plugin.bindToTenant(
				snapshot({
					tenantId: '00000000-0000-0000-0000-0000000000bb',
					credentials: {
						accessToken: 'tr_pat_b',
						secretKey: 'tr_dev_b',
						projectRef: 'proj_b'
					}
				})
			);

			const dA = viewA.dispatchers as unknown as {
				dispatchKbEmbedDocument: (p: unknown) => Promise<string | null>;
			};
			const dB = viewB.dispatchers as unknown as {
				dispatchKbEmbedDocument: (p: unknown) => Promise<string | null>;
			};

			await dA.dispatchKbEmbedDocument({ workId: 'a-work' });
			await dB.dispatchKbEmbedDocument({ workId: 'b-work' });

			expect(clientByTenant.get('proj_a')!.triggerCalls).toHaveLength(1);
			expect(clientByTenant.get('proj_a')!.triggerCalls[0].payload).toEqual({
				workId: 'a-work'
			});
			expect(clientByTenant.get('proj_b')!.triggerCalls).toHaveLength(1);
			expect(clientByTenant.get('proj_b')!.triggerCalls[0].payload).toEqual({
				workId: 'b-work'
			});
			// And the two views themselves are distinct.
			expect(viewA).not.toBe(viewB);
			expect(viewA.tenantClient).not.toBe(viewB.tenantClient);
		});
	});

	describe('bonus: clientFactory error is caught', () => {
		it('clientFactory throwing → warn + view falls back to platform default', () => {
			const warn = vi.fn();
			const plugin = new TriggerJobRuntimePlugin({
				logger: { warn },
				clientFactory: () => {
					throw new Error('boom');
				}
			});
			const view = plugin.bindToTenant(snapshot());
			expect(view.tenantClient).toBeNull();
			expect(view.dispatchers).toBe(plugin.dispatchers);
			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn.mock.calls[0][0]).toContain('clientFactory threw');
			expect(warn.mock.calls[0][0]).toContain('boom');
		});
	});
});
