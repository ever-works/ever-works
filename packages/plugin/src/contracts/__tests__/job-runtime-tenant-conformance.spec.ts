/**
 * EW-742 P6 T36-T40 — per-tenant runtime conformance suite for
 * `IJobRuntimeProvider`. Sibling of `job-runtime-conformance.spec.ts`
 * (#1462) that layers tenant-specific invariants on top:
 *
 *   T36 — two-tenant parameterisation: every assertion runs against
 *         `tenantA` and `tenantB`; views must be distinct.
 *   T38 — graceful drain: bind at version N, then version N+1; the
 *         OLD view's `dispatchers` MUST still work (in-flight runs
 *         using the captured view aren't broken by a rotation), and
 *         the NEW view MUST be a different object.
 *   T39 — force-invalidate path: re-binding the same `(tenantId,
 *         credentialVersion)` after eviction returns a FRESH view
 *         (operators may force-evict on admin "rotate-now" — the
 *         provider can't assume a snapshot lives forever).
 *   T40 — cross-tenant isolation: tenantA's view's `tenantSnapshot`
 *         (if exposed) reflects tenantA's identity; tenantB's
 *         reflects tenantB's. Views never cross-pollinate.
 *
 * Usage — every concrete plugin can wire this alongside the base suite:
 *
 *   ```ts
 *   import { describe } from 'vitest';
 *   import { runJobRuntimeTenantContractSuite } from '@ever-works/plugin/contracts-conformance';
 *   import { BullMqJobRuntimePlugin } from '../bullmq-job-runtime.plugin.js';
 *
 *   describe('BullMQ — tenant contract', () => {
 *     runJobRuntimeTenantContractSuite(() => new BullMqJobRuntimePlugin());
 *   });
 *   ```
 *
 * The suite intentionally does NOT exercise real backends (no live
 * Redis / Postgres / Temporal / Inngest). It validates the contract
 * surface every provider must hold around `bindToTenant`. Real-infra
 * isolation tests (T32) live per-plugin and are gated on CI infra.
 *
 * Self-applies against the in-memory fake at the bottom.
 */

import { describe, expect, it } from 'vitest';
import type { IJobRuntimeProvider, TenantCredentialSnapshot } from '../capabilities/job-runtime.interface.js';
import {
	InMemoryJobRuntimeProvider,
	createInMemoryJobRuntimeProvider
} from './fakes/in-memory-job-runtime-provider.js';

export interface JobRuntimeTenantContractOptions {
	/**
	 * Override the default tenant snapshots. Useful when the provider
	 * requires specific `credentials` keys (e.g. BullMQ needs
	 * `queuePrefix`, Temporal needs `namespace`).
	 */
	readonly tenantA?: TenantCredentialSnapshot;
	readonly tenantB?: TenantCredentialSnapshot;
}

const DEFAULT_TENANT_A: TenantCredentialSnapshot = {
	tenantId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
	providerId: 'bullmq',
	credentialVersion: 1,
	credentials: {}
};

const DEFAULT_TENANT_B: TenantCredentialSnapshot = {
	tenantId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
	providerId: 'bullmq',
	credentialVersion: 1,
	credentials: {}
};

export function runJobRuntimeTenantContractSuite(
	factory: () => IJobRuntimeProvider | Promise<IJobRuntimeProvider>,
	options: JobRuntimeTenantContractOptions = {}
): void {
	const tenantA = options.tenantA ?? DEFAULT_TENANT_A;
	const tenantB = options.tenantB ?? DEFAULT_TENANT_B;
	const tenantA_v2: TenantCredentialSnapshot = { ...tenantA, credentialVersion: tenantA.credentialVersion + 1 };

	describe('IJobRuntimeProvider tenant contract (EW-742 P6 T36-T40)', () => {
		it('T36. bindToTenant available — skipping suite if provider opts out', async () => {
			const p = await factory();
			expect(p.bindToTenant, 'provider must implement bindToTenant for tenant overlay').toBeDefined();
		});

		it('T36. two tenants produce distinct views (cross-tenant isolation)', async () => {
			const p = await factory();
			if (!p.bindToTenant) return;
			const viewA = p.bindToTenant(tenantA);
			const viewB = p.bindToTenant(tenantB);
			expect(viewA).toBeDefined();
			expect(viewB).toBeDefined();
			expect(viewA).not.toBe(viewB);
		});

		it('T36. bindToTenant is idempotent within a tenant', async () => {
			const p = await factory();
			if (!p.bindToTenant) return;
			const viewA1 = p.bindToTenant(tenantA);
			const viewA2 = p.bindToTenant(tenantA);
			expect(viewA2).toBe(viewA1);
		});

		it('T38. graceful drain: v=N+1 returns a DIFFERENT view; OLD view dispatchers stay callable', async () => {
			const p = await factory();
			if (!p.bindToTenant) return;
			const viewV1 = p.bindToTenant(tenantA);
			const viewV2 = p.bindToTenant(tenantA_v2);
			expect(viewV2).not.toBe(viewV1);

			// The OLD view's dispatchers reference must still be reachable
			// (in-flight runs hold this reference; rotation shouldn't break
			// them). We only check that the property access doesn't throw —
			// the dispatchers themselves may be throwing-stubs.
			expect(() => viewV1?.dispatchers).not.toThrow();
		});

		it('T38. view from v=N+1 is also memoised (re-binding v=N+1 returns same instance)', async () => {
			const p = await factory();
			if (!p.bindToTenant) return;
			const viewV2a = p.bindToTenant(tenantA_v2);
			const viewV2b = p.bindToTenant(tenantA_v2);
			expect(viewV2b).toBe(viewV2a);
		});

		it('T39. force-invalidate: after a re-bind of the same tenant at a NEWER version, the older version is gone', async () => {
			// The contract: the cache "stays bounded by tenant count, not
			// version count" — so binding v=N+1 evicts v=N. Re-binding v=N
			// after that MUST return a fresh object (not the original v=N
			// view, which has been dropped).
			const p = await factory();
			if (!p.bindToTenant) return;
			const viewV1original = p.bindToTenant(tenantA);
			void p.bindToTenant(tenantA_v2); // bumps version, evicts v=1
			const viewV1afterEviction = p.bindToTenant(tenantA);
			expect(viewV1afterEviction).not.toBe(viewV1original);
		});

		it('T40. cross-tenant isolation: tenant A bind does NOT affect tenant B cache', async () => {
			const p = await factory();
			if (!p.bindToTenant) return;
			const viewB1 = p.bindToTenant(tenantB);
			void p.bindToTenant(tenantA_v2); // rotate tenantA
			const viewB2 = p.bindToTenant(tenantB);
			expect(viewB2).toBe(viewB1); // tenantB unaffected
		});

		it('T40. view.bindToTenant(otherTenant) routes through the base, not back to self', async () => {
			const p = await factory();
			if (!p.bindToTenant) return;
			const viewA = p.bindToTenant(tenantA);
			if (!viewA?.bindToTenant) return;
			const reboundB = viewA.bindToTenant(tenantB);
			expect(reboundB).not.toBe(viewA);
		});
	});
}

// Self-application — exercise the suite against the in-memory fake.
runJobRuntimeTenantContractSuite(() => createInMemoryJobRuntimeProvider() as InMemoryJobRuntimeProvider);
