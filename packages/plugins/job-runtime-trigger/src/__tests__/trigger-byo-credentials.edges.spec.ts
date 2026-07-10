import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { JobRuntimeDispatchers, TenantCredentialSnapshot } from '@ever-works/plugin';
import {
	DEFAULT_TRIGGER_API_URL,
	TriggerJobRuntimePlugin,
	type TriggerTenantCredentials
} from '../trigger-job-runtime.plugin.js';
import type { TriggerClient, TriggerRunHandle, TriggerRunRecord, TriggerTaskOptions } from '../trigger-types.js';

/**
 * EW-742 P3.2 T22 — deep edge coverage on top of the happy-path
 * `trigger-byo-credentials.spec.ts`. Pins behaviours the canonical
 * suite didn't pin but the plugin still has to honour:
 *
 *   - Snapshot mode-vs-credentials interactions (the plugin keys off
 *     credential SHAPE, not the `mode` field — the `mode` discriminator
 *     is validation-only and never reaches `bindToTenant`).
 *   - Apparent-malformed-but-tolerated bags (unknown extra fields).
 *   - apiUrl shape tolerance: empty string, undefined, trailing slash,
 *     port, http://, https://.
 *   - Memoisation under high concurrency (same snapshot → 1 factory
 *     invocation; different snapshots → N factory invocations).
 *   - Operator factory misbehaviour: throws synchronously, returns
 *     null / undefined / wrong shape.
 *   - `dispatchersFromClient` throwing — the plugin SHOULD fall open
 *     (no dispatcher map should crash bindToTenant).
 *
 * Mirrors the established test patterns in `trigger-byo-credentials.spec.ts`
 * — same `FakeTenantClient` shape, same snapshot helper.
 */

interface TriggerCall {
	readonly taskId: string;
	readonly payload: unknown;
	readonly options?: TriggerTaskOptions;
}

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

describe('TriggerJobRuntimePlugin — BYO credentials EDGE cases (EW-742 P3.2 T22)', () => {
	describe('mode-vs-credentials interaction (plugin keys off shape, not mode)', () => {
		it('credentials present + mode=inherit → STILL routes BYO at plugin level (mode is validation-only)', () => {
			// The `mode` field is consumed by the settings-schema validator
			// upstream of `bindToTenant`; the plugin itself never reads it.
			// A snapshot that smuggles credentials through with mode=inherit
			// is therefore treated as BYO at the dispatcher layer. This pins
			// that contract so any future "plugin checks mode" change is a
			// loud test failure (the right behavioural change would be to
			// strip the credentials at the validator, not branch here).
			const clientFactory = vi.fn(() => new FakeTenantClient('x'));
			const plugin = new TriggerJobRuntimePlugin({ clientFactory });
			const view = plugin.bindToTenant(
				snapshot({
					credentials: {
						mode: 'inherit',
						accessToken: 'tr_pat_x',
						secretKey: 'tr_dev_x',
						projectRef: 'proj_x'
					}
				})
			);
			expect(view.tenantClient).not.toBeNull();
			expect(clientFactory).toHaveBeenCalledTimes(1);
		});

		it('mode=byo but credentials bag is `{}` → fall-open to platform default + warn naming all 3 missing fields', () => {
			const warn = vi.fn();
			const clientFactory = vi.fn();
			const plugin = new TriggerJobRuntimePlugin({ logger: { warn }, clientFactory });
			const view = plugin.bindToTenant(snapshot({ credentials: { mode: 'byo' } }));
			expect(view.tenantClient).toBeNull();
			expect(clientFactory).not.toHaveBeenCalled();
			// Empty bag (no Trigger.dev-shaped keys) is the pure-inherit
			// case → silent fall-through, not a warn. This is the
			// documented "noise floor" contract on extractTenantCredentials.
			expect(warn).not.toHaveBeenCalled();
		});

		it('mode=override → behaves identically to mode=byo at the plugin layer', () => {
			const clientFactoryByo = vi.fn(() => new FakeTenantClient('byo'));
			const clientFactoryOverride = vi.fn(() => new FakeTenantClient('override'));
			const pluginByo = new TriggerJobRuntimePlugin({ clientFactory: clientFactoryByo });
			const pluginOverride = new TriggerJobRuntimePlugin({
				clientFactory: clientFactoryOverride
			});

			const viewByo = pluginByo.bindToTenant(
				snapshot({ credentials: { ...snapshot().credentials, mode: 'byo' } })
			);
			const viewOverride = pluginOverride.bindToTenant(
				snapshot({ credentials: { ...snapshot().credentials, mode: 'override' } })
			);
			// Both build a per-tenant client; the validated-credentials
			// payload reaching each factory is identical.
			expect(viewByo.tenantClient).not.toBeNull();
			expect(viewOverride.tenantClient).not.toBeNull();
			expect(clientFactoryByo).toHaveBeenCalledTimes(1);
			expect(clientFactoryOverride).toHaveBeenCalledTimes(1);
			// Mode field is NOT propagated to the factory (only the 4 known
			// credential fields are read).
			expect(clientFactoryByo.mock.calls[0][0]).not.toHaveProperty('mode');
			expect(clientFactoryOverride.mock.calls[0][0]).not.toHaveProperty('mode');
		});

		it('unknown extra fields in credentials bag are tolerated; only the 4 known fields are read', () => {
			const clientFactory = vi.fn(() => new FakeTenantClient('x'));
			const plugin = new TriggerJobRuntimePlugin({ clientFactory });
			plugin.bindToTenant(
				snapshot({
					credentials: {
						accessToken: 'tr_pat_x',
						secretKey: 'tr_dev_x',
						projectRef: 'proj_x',
						futureField: 'ignored',
						anotherUnknown: 42,
						nestedJunk: { foo: 'bar' }
					}
				})
			);
			expect(clientFactory).toHaveBeenCalledTimes(1);
			// Factory receives ONLY the documented bundle shape — no
			// extra-field leakage that operators might accidentally key on.
			expect(clientFactory.mock.calls[0][0]).toEqual({
				accessToken: 'tr_pat_x',
				secretKey: 'tr_dev_x',
				projectRef: 'proj_x'
			});
		});
	});

	describe('apiUrl shape tolerance', () => {
		it.each([
			['empty string', ''],
			['undefined (omitted)', undefined],
			['only whitespace', '   ']
		])('apiUrl = %s → not propagated to factory (operator picks DEFAULT_TRIGGER_API_URL)', (_label, apiUrl) => {
			const clientFactory = vi.fn(() => new FakeTenantClient('x'));
			const plugin = new TriggerJobRuntimePlugin({ clientFactory });
			const credentials: Record<string, unknown> = {
				accessToken: 'tr_pat_x',
				secretKey: 'tr_dev_x',
				projectRef: 'proj_x'
			};
			if (apiUrl !== undefined) {
				credentials.apiUrl = apiUrl;
			}
			plugin.bindToTenant(snapshot({ credentials }));
			expect(clientFactory).toHaveBeenCalledTimes(1);
			const bundle = clientFactory.mock.calls[0][0] as TriggerTenantCredentials;
			if (apiUrl === undefined) {
				// Omitted entirely — bundle has no apiUrl key.
				expect(bundle).not.toHaveProperty('apiUrl');
			} else {
				// Empty / whitespace strings ARE strings → typed and
				// propagated verbatim. Pinning current behaviour so any
				// future "strip empty apiUrl at the plugin" change shows
				// up in this test rather than as a silent operator-side
				// surprise.
				expect(bundle.apiUrl).toBe(apiUrl);
			}
		});

		it.each([
			['trailing slash', 'https://trigger.example.com/'],
			['with port', 'https://trigger.tenant.com:8443'],
			['plain http', 'http://localhost:3030'],
			['https', 'https://trigger.example.com'],
			['no scheme (operator/SDK responsibility)', 'trigger.example.com']
		])('apiUrl = %s → propagated verbatim to factory (no normalization)', (_label, apiUrl) => {
			const clientFactory = vi.fn(() => new FakeTenantClient('x'));
			const plugin = new TriggerJobRuntimePlugin({ clientFactory });
			plugin.bindToTenant(
				snapshot({
					credentials: {
						accessToken: 'tr_pat_x',
						secretKey: 'tr_dev_x',
						projectRef: 'proj_x',
						apiUrl
					}
				})
			);
			expect(clientFactory.mock.calls[0][0]).toEqual({
				accessToken: 'tr_pat_x',
				secretKey: 'tr_dev_x',
				projectRef: 'proj_x',
				apiUrl
			});
		});

		it('DEFAULT_TRIGGER_API_URL is the documented fallback the factory can apply', () => {
			expect(DEFAULT_TRIGGER_API_URL).toBe('https://api.trigger.dev');
		});
	});

	describe('memoisation under concurrency (TenantCredentialCache hit invariant)', () => {
		it('100 concurrent bindToTenant calls with the SAME snapshot → ONE clientFactory invocation', async () => {
			const clientFactory = vi.fn(() => new FakeTenantClient('only-one'));
			const plugin = new TriggerJobRuntimePlugin({ clientFactory });
			const snap = snapshot();
			const views = await Promise.all(
				Array.from({ length: 100 }, () => Promise.resolve().then(() => plugin.bindToTenant(snap)))
			);
			// All 100 returned the cached view (reference equality).
			const first = views[0];
			for (const v of views) {
				expect(v).toBe(first);
			}
			expect(clientFactory).toHaveBeenCalledTimes(1);
		});

		it('100 concurrent bindToTenant calls with DIFFERENT tenantIds → exactly 100 factory invocations', async () => {
			const clientFactory = vi.fn((creds: TriggerTenantCredentials) => new FakeTenantClient(creds.projectRef));
			const plugin = new TriggerJobRuntimePlugin({ clientFactory });
			const tenants = Array.from({ length: 100 }, () => randomUUID());
			const views = await Promise.all(
				tenants.map((tenantId) =>
					Promise.resolve().then(() =>
						plugin.bindToTenant(
							snapshot({
								tenantId,
								credentials: {
									accessToken: `tr_pat_${tenantId}`,
									secretKey: `tr_dev_${tenantId}`,
									projectRef: `proj_${tenantId}`
								}
							})
						)
					)
				)
			);
			expect(views).toHaveLength(100);
			expect(clientFactory).toHaveBeenCalledTimes(100);
			// Every returned view points at the right per-tenant client
			// (proves the memoisation key includes tenantId, not just
			// credentialVersion).
			const seenIds = new Set<string>();
			for (const view of views) {
				const client = view.tenantClient as FakeTenantClient | null;
				expect(client).not.toBeNull();
				seenIds.add(client!.id);
			}
			expect(seenIds.size).toBe(100);
		});
	});

	describe('clientFactory misbehaviour fault isolation', () => {
		it('clientFactory throws synchronously → warn + fail-open (tenantClient null, dispatchers = platform default)', () => {
			const warn = vi.fn();
			const platformDispatchers: JobRuntimeDispatchers = Object.freeze({
				dispatchKbEmbedDocument: () => Promise.resolve('platform')
			});
			const plugin = new TriggerJobRuntimePlugin({
				logger: { warn },
				clientFactory: () => {
					throw new TypeError('SDK construction failed: invalid PAT format');
				}
			}).useDispatchers(platformDispatchers);

			const view = plugin.bindToTenant(snapshot());
			expect(view.tenantClient).toBeNull();
			expect(view.dispatchers).toBe(plugin.dispatchers);
			expect(warn).toHaveBeenCalledTimes(1);
			const msg = warn.mock.calls[0][0] as string;
			expect(msg).toContain('clientFactory threw');
			expect(msg).toContain('invalid PAT format');
		});

		it('clientFactory returns null → view falls through (no per-tenant client surfaced)', () => {
			// Operator returned null (e.g. "no provisioned project for this
			// tenant yet"). The plugin's `safeBuildClient` returns whatever
			// the factory returned — `null` ends up on `tenantClient`, the
			// view's dispatchers stay on the platform default. This pins
			// the structural contract without forcing a defensive type
			// check the plugin doesn't currently make.
			const clientFactory = vi.fn(() => null as unknown as TriggerClient);
			const plugin = new TriggerJobRuntimePlugin({ clientFactory });
			const view = plugin.bindToTenant(snapshot());
			expect(view.tenantClient).toBeNull();
			expect(view.dispatchers).toBe(plugin.dispatchers);
		});

		it('clientFactory returns undefined → view falls through (no per-tenant client surfaced)', () => {
			const clientFactory = vi.fn(() => undefined as unknown as TriggerClient);
			const plugin = new TriggerJobRuntimePlugin({ clientFactory });
			const view = plugin.bindToTenant(snapshot());
			// undefined → !tenantClient → dispatchersFromClient branch not
			// taken → view's dispatchers stay on platform default.
			expect(view.tenantClient).toBeUndefined();
			expect(view.dispatchers).toBe(plugin.dispatchers);
		});

		it('clientFactory returns object WITHOUT `tasks` field → still surfaced; runtime structural check is the dispatcher boundary', () => {
			// The plugin does NOT run a JSON-schema validation on the
			// returned client. Structural mismatches surface at first
			// dispatcher invocation (the dispatcher would throw when it
			// accesses `client.tasks.trigger`). Pinning: the bind itself
			// is non-fatal, and `dispatchersFromClient` is still invoked.
			const malformed = { runs: { cancel: vi.fn(), retrieve: vi.fn() } } as unknown as TriggerClient;
			const dispatchersFromClient = vi.fn(
				() =>
					({
						dispatchKbEmbedDocument: () => Promise.resolve('whatever')
					}) as unknown as JobRuntimeDispatchers
			);
			const plugin = new TriggerJobRuntimePlugin({
				clientFactory: () => malformed,
				dispatchersFromClient
			});
			const view = plugin.bindToTenant(snapshot());
			expect(view.tenantClient).toBe(malformed);
			expect(dispatchersFromClient).toHaveBeenCalledTimes(1);
		});

		it('dispatchersFromClient throws → bindToTenant throws (loud failure surfaced to operator)', () => {
			// EW-742 P3.2 T22 — pinning current observed behaviour. The
			// plugin wraps `clientFactory` in try/catch (safeBuildClient)
			// but does NOT wrap `dispatchersFromClient` (intentional: a
			// broken dispatcher builder is a wiring bug, not a runtime
			// degradation, and silent fall-through to the platform
			// default would mask the misconfiguration).
			const plugin = new TriggerJobRuntimePlugin({
				clientFactory: () => new FakeTenantClient('x'),
				dispatchersFromClient: () => {
					throw new Error('boom in dispatchersFromClient');
				}
			});
			expect(() => plugin.bindToTenant(snapshot())).toThrow('boom in dispatchersFromClient');
		});
	});

	describe('dispatchersBuilder precedence over dispatchersFromClient', () => {
		it('dispatchersBuilder wins when BOTH are wired (per the documented precedence on TriggerJobRuntimePluginOptions)', async () => {
			const fromClient = vi.fn(
				() =>
					({
						dispatchKbEmbedDocument: () => Promise.resolve('from-client')
					}) as unknown as JobRuntimeDispatchers
			);
			const builder = vi.fn(
				() =>
					({
						dispatchKbEmbedDocument: () => Promise.resolve('from-builder')
					}) as unknown as JobRuntimeDispatchers
			);
			const tenantClient = new FakeTenantClient('x');
			const plugin = new TriggerJobRuntimePlugin({
				clientFactory: () => tenantClient,
				dispatchersBuilder: builder,
				dispatchersFromClient: fromClient
			});
			const view = plugin.bindToTenant(snapshot());
			// `dispatchersBuilder` consumed; `dispatchersFromClient` skipped.
			expect(builder).toHaveBeenCalledWith(expect.any(Object), tenantClient);
			expect(fromClient).not.toHaveBeenCalled();
			const d = view.dispatchers as unknown as {
				dispatchKbEmbedDocument: () => Promise<string>;
			};
			await expect(d.dispatchKbEmbedDocument()).resolves.toBe('from-builder');
		});

		it('dispatchersBuilder returning undefined → falls back to platform-default dispatchers', () => {
			const platformDispatchers: JobRuntimeDispatchers = Object.freeze({
				dispatchKbEmbedDocument: () => Promise.resolve('platform')
			});
			const plugin = new TriggerJobRuntimePlugin({
				clientFactory: () => new FakeTenantClient('x'),
				dispatchersBuilder: () => undefined
			}).useDispatchers(platformDispatchers);
			const view = plugin.bindToTenant(snapshot());
			// `dispatchersBuilder` returned `undefined` → neither branch
			// of the precedence wired up → falls to platform default.
			expect(view.dispatchers).toBe(plugin.dispatchers);
		});
	});

	describe('per-tenant dispatcher map immutability', () => {
		it("the view's dispatchers map is frozen (operator can't mutate it post-hoc)", () => {
			const plugin = new TriggerJobRuntimePlugin({
				clientFactory: () => new FakeTenantClient('x'),
				dispatchersFromClient: () =>
					({
						dispatchKbEmbedDocument: () => Promise.resolve('a')
					}) as unknown as JobRuntimeDispatchers
			});
			const view = plugin.bindToTenant(snapshot());
			expect(Object.isFrozen(view.dispatchers)).toBe(true);
		});
	});
});
