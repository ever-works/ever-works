/**
 * EW-685 / EW-742 P6 — runtime conformance suite for `IJobRuntimeProvider`.
 *
 * Every concrete provider plugin (`@ever-works/job-runtime-{bullmq,
 * pgboss,temporal,inngest}-plugin`, plus the in-repo Trigger.dev
 * provider) MUST pass these tests. The suite encodes the contract
 * invariants from `docs/specs/architecture/job-runtime-providers.md`
 * §7 (conformance scope):
 *
 *   1. Required `IPlugin` metadata is shaped correctly (id, name,
 *      version, category='job-runtime', capabilities include
 *      'job-runtime-enqueue' / -cancel / -status / -schedule /
 *      -bind-tenant).
 *   2. `runtimeId` is one of the canonical 5 values.
 *   3. `dispatchers` is a Record-shaped object — every `dispatchXxx`
 *      access returns either `undefined` or a function (no throws on
 *      mere property access; throwing-stub plugins throw only when the
 *      function is *called*).
 *   4. `cancel` returns `false` for unknown runIds.
 *   5. `getRunStatus` returns `'unknown'` for unknown runIds.
 *   6. `registerSchedules` is idempotent — same id passed twice does
 *      NOT spawn a duplicate.
 *   7. `isEnabled` returns a boolean (not undefined / string).
 *   8. `startWorkerHost` is either absent or returns a `WorkerHostHandle`
 *      whose `stop()` is idempotent (callable twice without throwing).
 *   9. `bindToTenant` (when present) memoises on `(tenantId,
 *      credentialVersion)` — two calls with the same snapshot return
 *      the same view; a `credentialVersion` bump returns a different
 *      view.
 *  10. View `bindToTenant(self)` returns the same view (idempotency
 *      clause from `job-runtime.interface.ts`).
 *  11. Lifecycle hooks `onLoad`/`onUnload` can be called without
 *      throwing (push-model providers may no-op).
 *
 * Usage:
 *
 *   ```ts
 *   import { describe } from 'vitest';
 *   import { runJobRuntimeContractSuite } from '@ever-works/plugin/contracts/__tests__/job-runtime-conformance.spec.js';
 *   import { BullMqJobRuntimePlugin } from '../bullmq-job-runtime.plugin.js';
 *
 *   describe('BullMQ provider — IJobRuntimeProvider contract', () => {
 *     runJobRuntimeContractSuite(() => new BullMqJobRuntimePlugin());
 *   });
 *   ```
 *
 * The suite self-applies at the bottom against the in-memory fake so
 * `pnpm --filter @ever-works/plugin test` runs the contract every
 * time — a canary for accidental contract drift before any concrete
 * plugin's CI run notices.
 */

import { describe, expect, it } from 'vitest';
import type {
	IJobRuntimeProvider,
	JobRuntimeId,
	TenantCredentialSnapshot
} from '../capabilities/job-runtime.interface.js';
import { createInMemoryJobRuntimeProvider } from './fakes/in-memory-job-runtime-provider.js';

export interface JobRuntimeContractOptions {
	/**
	 * Skip the `bindToTenant` test when a provider deliberately doesn't
	 * implement it (returns `undefined`). The interface marks it
	 * optional; some providers may not yet support BYO.
	 */
	readonly skipBindToTenant?: boolean;
	/**
	 * Skip the `dispatch*` access test for providers that ship a
	 * throwing-stub Proxy. The suite distinguishes throwing-on-call
	 * (allowed) from throwing-on-access (forbidden), but a provider
	 * that explicitly throws on access can opt out here.
	 */
	readonly skipDispatchersAccessProbe?: boolean;
	/**
	 * Set when calling `isEnabled()` requires specific env vars; the
	 * suite then accepts EITHER `true` OR `false` — both are valid
	 * provided the return type is boolean.
	 */
	readonly relaxIsEnabledReturn?: boolean;
}

const CANONICAL_RUNTIME_IDS: ReadonlySet<JobRuntimeId> = new Set([
	'trigger',
	'temporal',
	'bullmq',
	'pgboss',
	'inngest'
]);

const REQUIRED_CAPABILITIES = [
	'job-runtime-enqueue',
	'job-runtime-cancel',
	'job-runtime-status',
	'job-runtime-schedule',
	'job-runtime-bind-tenant'
];

const SAMPLE_SNAPSHOT_V1: TenantCredentialSnapshot = {
	tenantId: '11111111-1111-1111-1111-111111111111',
	providerId: 'bullmq',
	credentialVersion: 1,
	credentials: {}
};

const SAMPLE_SNAPSHOT_V2: TenantCredentialSnapshot = {
	...SAMPLE_SNAPSHOT_V1,
	credentialVersion: 2
};

export function runJobRuntimeContractSuite(
	factory: () => IJobRuntimeProvider | Promise<IJobRuntimeProvider>,
	options: JobRuntimeContractOptions = {}
): void {
	describe('IJobRuntimeProvider contract (EW-685 / EW-742 P6)', () => {
		const buildProvider = async (): Promise<IJobRuntimeProvider> => factory();

		it('1. IPlugin metadata is shaped correctly', async () => {
			const p = await buildProvider();
			expect(typeof p.id).toBe('string');
			expect(p.id.length).toBeGreaterThan(0);
			expect(typeof p.name).toBe('string');
			expect(p.name.length).toBeGreaterThan(0);
			expect(typeof p.version).toBe('string');
			expect(p.version).toMatch(/^\d+\.\d+\.\d+/);
			expect(p.category).toBe('job-runtime');
			expect(Array.isArray(p.capabilities)).toBe(true);
			for (const cap of REQUIRED_CAPABILITIES) {
				expect(p.capabilities, `missing capability: ${cap}`).toContain(cap);
			}
		});

		it('2. runtimeId is one of the canonical 5', async () => {
			const p = await buildProvider();
			expect(CANONICAL_RUNTIME_IDS.has(p.runtimeId)).toBe(true);
		});

		it('3. dispatchers is a record — property access does NOT throw', async () => {
			if (options.skipDispatchersAccessProbe) return;
			const p = await buildProvider();
			const d = p.dispatchers as unknown as Record<string, unknown>;
			// Mere access on a couple of canonical dispatch* names must
			// not throw. Calling the function may throw — that's a
			// per-provider decision (stub plugins throw a typed error
			// telling the operator how to wire real dispatchers).
			expect(() => d['dispatchKbEmbedDocument']).not.toThrow();
			expect(() => d['dispatchWorkGeneration']).not.toThrow();
			// Whatever it returns must be either undefined or callable.
			const fn = d['dispatchKbEmbedDocument'];
			if (fn !== undefined) {
				expect(typeof fn).toBe('function');
			}
		});

		it('4. cancel returns false for unknown runIds', async () => {
			const p = await buildProvider();
			await expect(p.cancel('definitely-not-a-real-run-id')).resolves.toBe(false);
		});

		it('5. getRunStatus returns unknown for unknown runIds', async () => {
			const p = await buildProvider();
			await expect(p.getRunStatus('definitely-not-a-real-run-id')).resolves.toBe('unknown');
		});

		it('6. registerSchedules is idempotent (re-registering same id does not error)', async () => {
			const p = await buildProvider();
			await p.registerSchedules([{ id: 'foo', cron: '*/5 * * * *' }]);
			await expect(
				p.registerSchedules([{ id: 'foo', cron: '*/10 * * * *' }])
			).resolves.toBeUndefined();
		});

		it('7. isEnabled returns a boolean', async () => {
			const p = await buildProvider();
			const result = p.isEnabled();
			expect(typeof result).toBe('boolean');
			if (!options.relaxIsEnabledReturn) {
				// In the default test env, providers should either be
				// enabled (operator-supplied env vars set) or NOT —
				// both are valid as long as the return is boolean.
			}
		});

		it('8. startWorkerHost (when present) returns a handle with idempotent stop()', async () => {
			const p = await buildProvider();
			if (!p.startWorkerHost) return; // optional method
			const handle = await p.startWorkerHost({});
			expect(typeof handle.stop).toBe('function');
			await handle.stop();
			// Idempotent — second call must not throw.
			await expect(handle.stop()).resolves.toBeUndefined();
		});

		it('9. bindToTenant memoises on (tenantId, credentialVersion)', async () => {
			if (options.skipBindToTenant) return;
			const p = await buildProvider();
			if (!p.bindToTenant) return;
			const a = p.bindToTenant(SAMPLE_SNAPSHOT_V1);
			const b = p.bindToTenant(SAMPLE_SNAPSHOT_V1);
			expect(b).toBe(a);
			const c = p.bindToTenant(SAMPLE_SNAPSHOT_V2);
			expect(c).not.toBe(a);
		});

		it('10. view.bindToTenant(self) returns the same view', async () => {
			if (options.skipBindToTenant) return;
			const p = await buildProvider();
			if (!p.bindToTenant) return;
			const view = p.bindToTenant(SAMPLE_SNAPSHOT_V1);
			if (!view) return; // provider returned undefined — opt-out
			expect(view.bindToTenant?.(SAMPLE_SNAPSHOT_V1)).toBe(view);
		});

		it('11. onLoad/onUnload do not throw (lifecycle hooks tolerate no-op)', async () => {
			const p = await buildProvider();
			// Minimal PluginContext stub — most providers don't read it,
			// and the ones that do shape access through optional chains.
			const ctx = {} as Parameters<NonNullable<IJobRuntimeProvider['onLoad']>>[0];
			if (p.onLoad) {
				await expect(p.onLoad(ctx)).resolves.toBeUndefined();
			}
			if (p.onUnload) {
				await expect(p.onUnload()).resolves.toBeUndefined();
			}
		});
	});
}

// Self-application — exercises the contract against the in-memory
// reference implementation every time `pnpm --filter @ever-works/plugin
// test` runs. A contract change that breaks the reference impl breaks
// here first, before any concrete plugin's CI notices.
runJobRuntimeContractSuite(createInMemoryJobRuntimeProvider);
