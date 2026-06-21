// EW-742 P5.1 (T35a) — INTEGRATION-level spec for the
// `getAvailableProvidersForTenant` 4-way resolver. Drives every branch
// in plan.md §10 P5.1 — flag OFF, flag ON + empty per-tenant, flag ON +
// subset, flag ON + superset (with silent drop) — plus edge cases
// around an empty global allow-list and identity-of-set ordering.
// Complements the existing service-level allow-list spec by
// concentrating on the resolver intersection logic + its env coupling.

jest.mock('@ever-works/agent/entities', () => ({
    TenantJobRuntimeConfig: class TenantJobRuntimeConfig {},
    TenantJobRuntimeAudit: class TenantJobRuntimeAudit {},
    TenantRuntimeProviderAllowlist: class TenantRuntimeProviderAllowlist {},
}));

jest.mock('@ever-works/agent/tasks', () => ({
    CredentialVersionService: class CredentialVersionService {},
}));

import { randomUUID } from 'node:crypto';
import type { CredentialVersionService } from '@ever-works/agent/tasks';
import type { TenantRuntimeProviderAllowlist as TenantRuntimeProviderAllowlistEntity } from '@ever-works/agent/entities';
import { TenantJobRuntimeService } from '../tenant-job-runtime.service';

type AllowlistRow = TenantRuntimeProviderAllowlistEntity & { createdAt: Date };

const PER_TENANT_GATING_ENV = 'EVER_WORKS_TENANT_RUNTIME_PER_TENANT_GATING';
const GLOBAL_ALLOWLIST_ENV = 'EVER_WORKS_TENANT_RUNTIME_ALLOWED_PROVIDERS';

function buildAllowlistRow(overrides: Partial<AllowlistRow> = {}): AllowlistRow {
    return {
        tenantId: 'tenant-1',
        providerId: 'trigger',
        createdBy: null,
        createdAt: new Date('2026-06-18T00:00:00.000Z'),
        ...overrides,
    } as AllowlistRow;
}

describe('TenantJobRuntimeService.getAvailableProvidersForTenant — resolver intersection (integration, EW-742 P5.1 T35a)', () => {
    let service: TenantJobRuntimeService;
    let allowlistRepo: { find: jest.Mock };
    let store: AllowlistRow[];

    const originalGating = process.env[PER_TENANT_GATING_ENV];
    const originalGlobal = process.env[GLOBAL_ALLOWLIST_ENV];

    beforeEach(() => {
        store = [];
        const configRepo = { findOne: jest.fn(), create: jest.fn(), save: jest.fn() };
        const auditRepo = { create: jest.fn((r) => r), save: jest.fn(async (r) => r) };
        allowlistRepo = {
            find: jest.fn(async ({ where }: { where: { tenantId: string } }) =>
                store
                    .filter((r) => r.tenantId === where.tenantId)
                    .slice()
                    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
            ),
        } as any;
        const dataSource = { transaction: jest.fn() };
        const credentialVersionService = {
            bumpVersion: jest.fn(),
        } as unknown as CredentialVersionService;

        service = new TenantJobRuntimeService(
            configRepo as any,
            auditRepo as any,
            credentialVersionService,
            allowlistRepo as any,
            dataSource as any,
        );
    });

    afterEach(() => {
        if (originalGating === undefined) {
            delete process.env[PER_TENANT_GATING_ENV];
        } else {
            process.env[PER_TENANT_GATING_ENV] = originalGating;
        }
        if (originalGlobal === undefined) {
            delete process.env[GLOBAL_ALLOWLIST_ENV];
        } else {
            process.env[GLOBAL_ALLOWLIST_ENV] = originalGlobal;
        }
    });

    // ─── State 1: gating flag OFF ──────────────────────────────────────

    describe('flag OFF', () => {
        it('returns the global list even when per-tenant rows would narrow it', async () => {
            process.env[PER_TENANT_GATING_ENV] = 'false';
            process.env[GLOBAL_ALLOWLIST_ENV] = 'trigger,temporal,bullmq';
            const tenantId = randomUUID();
            store.push(buildAllowlistRow({ tenantId, providerId: 'trigger' }));

            const result = await service.getAvailableProvidersForTenant(tenantId);

            expect(result).toEqual(['trigger', 'temporal', 'bullmq']);
            // When the flag is OFF, the resolver short-circuits before
            // hitting the per-tenant repo — a hot read path optimization.
            expect(allowlistRepo.find).not.toHaveBeenCalled();
        });

        it('falls back to the bundled providers when the env var is unset (and ignores per-tenant)', async () => {
            delete process.env[PER_TENANT_GATING_ENV];
            delete process.env[GLOBAL_ALLOWLIST_ENV];
            const tenantId = randomUUID();
            store.push(buildAllowlistRow({ tenantId, providerId: 'trigger' }));

            const result = await service.getAvailableProvidersForTenant(tenantId);

            // All 5 bundled providers, no narrowing.
            expect(result).toEqual(['trigger', 'temporal', 'bullmq', 'pgboss', 'inngest']);
        });
    });

    // ─── State 2: flag ON + empty per-tenant ───────────────────────────

    describe('flag ON, tenant has no per-tenant rows (inherit default)', () => {
        it('returns the global list verbatim', async () => {
            process.env[PER_TENANT_GATING_ENV] = 'true';
            process.env[GLOBAL_ALLOWLIST_ENV] = 'trigger,temporal,bullmq';

            const result = await service.getAvailableProvidersForTenant(randomUUID());

            expect(result).toEqual(['trigger', 'temporal', 'bullmq']);
            // The resolver DID hit the per-tenant repo (proves it reached
            // the gated branch), but found no rows.
            expect(allowlistRepo.find).toHaveBeenCalledTimes(1);
        });
    });

    // ─── State 3: flag ON + per-tenant ⊆ global ────────────────────────

    describe('flag ON, per-tenant is a strict subset of global', () => {
        it('returns the intersection in GLOBAL order (not per-tenant insertion order)', async () => {
            process.env[PER_TENANT_GATING_ENV] = 'true';
            // Global declared as: trigger → temporal → bullmq → pgboss
            process.env[GLOBAL_ALLOWLIST_ENV] = 'trigger,temporal,bullmq,pgboss';
            const tenantId = randomUUID();
            // Per-tenant in REVERSE order: pgboss → trigger
            store.push(
                buildAllowlistRow({
                    tenantId,
                    providerId: 'pgboss',
                    createdAt: new Date('2026-06-18T00:00:01.000Z'),
                }),
                buildAllowlistRow({
                    tenantId,
                    providerId: 'trigger',
                    createdAt: new Date('2026-06-18T00:00:02.000Z'),
                }),
            );

            const result = await service.getAvailableProvidersForTenant(tenantId);

            // Global order wins.
            expect(result).toEqual(['trigger', 'pgboss']);
        });

        it('returns a single-element intersection when per-tenant has 1 row', async () => {
            process.env[PER_TENANT_GATING_ENV] = 'true';
            process.env[GLOBAL_ALLOWLIST_ENV] = 'trigger,temporal,bullmq';
            const tenantId = randomUUID();
            store.push(buildAllowlistRow({ tenantId, providerId: 'temporal' }));

            const result = await service.getAvailableProvidersForTenant(tenantId);
            expect(result).toEqual(['temporal']);
        });
    });

    // ─── State 4: flag ON + per-tenant ⊄ global (silent drop) ──────────

    describe('flag ON, per-tenant contains an entry NOT in global (global is upper bound)', () => {
        it('silently drops the out-of-global entry', async () => {
            process.env[PER_TENANT_GATING_ENV] = 'true';
            process.env[GLOBAL_ALLOWLIST_ENV] = 'trigger';
            const tenantId = randomUUID();
            store.push(
                buildAllowlistRow({
                    tenantId,
                    providerId: 'trigger',
                    createdAt: new Date('2026-06-18T00:00:01.000Z'),
                }),
                buildAllowlistRow({
                    tenantId,
                    providerId: 'temporal',
                    createdAt: new Date('2026-06-18T00:00:02.000Z'),
                }),
            );

            const result = await service.getAvailableProvidersForTenant(tenantId);
            // temporal silently dropped.
            expect(result).toEqual(['trigger']);
        });

        it('returns [] when every per-tenant entry is outside the global list', async () => {
            process.env[PER_TENANT_GATING_ENV] = 'true';
            process.env[GLOBAL_ALLOWLIST_ENV] = 'trigger';
            const tenantId = randomUUID();
            store.push(
                buildAllowlistRow({
                    tenantId,
                    providerId: 'temporal',
                    createdAt: new Date('2026-06-18T00:00:01.000Z'),
                }),
                buildAllowlistRow({
                    tenantId,
                    providerId: 'bullmq',
                    createdAt: new Date('2026-06-18T00:00:02.000Z'),
                }),
            );

            const result = await service.getAvailableProvidersForTenant(tenantId);
            // Operator shrunk the global to 'trigger' but the tenant
            // overlay still references retired providers — they're
            // dropped and the tenant ends up with NOTHING. Operators
            // either re-populate the overlay or accept the empty state.
            expect(result).toEqual([]);
        });
    });

    // ─── State 5: operator typo / unknown ids ──────────────────────────

    describe('operator declares only unknown providerIds (typo / removed runtime)', () => {
        // The config layer fails OPEN here on purpose — if the operator
        // submitted only unknown ids (typo, retired provider) we fall
        // back to the bundled defaults so a single env-var slip doesn't
        // strand every tenant. The resolver inherits that behaviour
        // because it reads through `config.tenantJobRuntime.getAllowedProviders`.
        it('falls back to the full bundled list when every operator id is unknown (flag OFF)', async () => {
            delete process.env[PER_TENANT_GATING_ENV];
            process.env[GLOBAL_ALLOWLIST_ENV] = 'not-a-real-runtime,another-typo';
            const tenantId = randomUUID();
            store.push(buildAllowlistRow({ tenantId, providerId: 'trigger' }));

            const result = await service.getAvailableProvidersForTenant(tenantId);

            // Bundled fallback wins — flag OFF returns the unfiltered
            // bundled list and the per-tenant overlay is ignored.
            expect(result).toEqual(['trigger', 'temporal', 'bullmq', 'pgboss', 'inngest']);
        });

        it('intersects the bundled fallback with per-tenant rows when flag is ON', async () => {
            process.env[PER_TENANT_GATING_ENV] = 'true';
            process.env[GLOBAL_ALLOWLIST_ENV] = 'not-a-real-runtime';
            const tenantId = randomUUID();
            store.push(
                buildAllowlistRow({
                    tenantId,
                    providerId: 'temporal',
                    createdAt: new Date('2026-06-18T00:00:01.000Z'),
                }),
            );

            const result = await service.getAvailableProvidersForTenant(tenantId);

            // Bundled fallback (5 providers) ∩ per-tenant (temporal) →
            // [temporal]. Proves the resolver still applies the
            // per-tenant narrowing even when the operator env var was
            // effectively a no-op.
            expect(result).toEqual(['temporal']);
        });
    });

    // ─── Cross-tenant isolation in resolver path ───────────────────────

    describe('cross-tenant isolation', () => {
        it('resolver for tenant A does not see tenant B per-tenant rows', async () => {
            process.env[PER_TENANT_GATING_ENV] = 'true';
            process.env[GLOBAL_ALLOWLIST_ENV] = 'trigger,temporal,bullmq';
            const tenantA = randomUUID();
            const tenantB = randomUUID();
            store.push(
                buildAllowlistRow({ tenantId: tenantA, providerId: 'trigger' }),
                buildAllowlistRow({ tenantId: tenantB, providerId: 'bullmq' }),
            );

            const a = await service.getAvailableProvidersForTenant(tenantA);
            const b = await service.getAvailableProvidersForTenant(tenantB);

            expect(a).toEqual(['trigger']);
            expect(b).toEqual(['bullmq']);
        });
    });

    // ─── Identity / preservation properties ────────────────────────────

    describe('preservation properties', () => {
        it('returns a NEW array (no mutation of the underlying global list)', async () => {
            process.env[PER_TENANT_GATING_ENV] = 'false';
            process.env[GLOBAL_ALLOWLIST_ENV] = 'trigger,temporal';
            const first = await service.getAvailableProvidersForTenant(randomUUID());
            const second = await service.getAvailableProvidersForTenant(randomUUID());
            // Independent array references — mutation of the first must
            // not leak into the second call.
            (first as string[]).push('mutated');
            expect(second).toEqual(['trigger', 'temporal']);
        });

        it('reading the same tenant twice in a row is stable (read-after-read)', async () => {
            process.env[PER_TENANT_GATING_ENV] = 'true';
            process.env[GLOBAL_ALLOWLIST_ENV] = 'trigger,temporal,bullmq';
            const tenantId = randomUUID();
            store.push(buildAllowlistRow({ tenantId, providerId: 'temporal' }));

            const a = await service.getAvailableProvidersForTenant(tenantId);
            const b = await service.getAvailableProvidersForTenant(tenantId);
            expect(a).toEqual(b);
        });
    });
});
