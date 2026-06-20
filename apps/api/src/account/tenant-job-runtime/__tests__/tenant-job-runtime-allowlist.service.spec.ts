// EW-752 P5.1 (T35a + T35b) — service-level spec for the per-tenant
// runtime provider allow-list overlay. Mirrors the
// `tenant-job-runtime.controller.spec.ts` posture: mock the entities
// barrel + tasks module so the service can be constructed directly with
// in-memory stubs, and never touch the real TypeORM decorator graph.
//
// Scope:
//   - `listTenantAllowlist`, `replaceTenantAllowlist`,
//     `deleteTenantAllowlistEntry`, `getAvailableProvidersForTenant`
//   - resolver intersection semantics under the
//     `EVER_WORKS_TENANT_RUNTIME_PER_TENANT_GATING` flag
//   - audit-emission contract for each mutation

jest.mock('@ever-works/agent/entities', () => ({
    TenantJobRuntimeConfig: class TenantJobRuntimeConfig {},
    TenantJobRuntimeAudit: class TenantJobRuntimeAudit {},
    TenantRuntimeProviderAllowlist: class TenantRuntimeProviderAllowlist {},
}));

jest.mock('@ever-works/agent/tasks', () => ({
    CredentialVersionService: class CredentialVersionService {},
}));

import { BadRequestException } from '@nestjs/common';
import type { CredentialVersionService } from '@ever-works/agent/tasks';
import type {
    TenantRuntimeProviderAllowlist as TenantRuntimeProviderAllowlistEntity,
} from '@ever-works/agent/entities';
import { TenantJobRuntimeService } from '../tenant-job-runtime.service';

type AllowlistRow = TenantRuntimeProviderAllowlistEntity & { createdAt: Date };

const PER_TENANT_GATING_ENV = 'EVER_WORKS_TENANT_RUNTIME_PER_TENANT_GATING';
const GLOBAL_ALLOWLIST_ENV = 'EVER_WORKS_TENANT_RUNTIME_ALLOWED_PROVIDERS';

function buildAllowlistRow(overrides: Partial<AllowlistRow> = {}): AllowlistRow {
    return {
        tenantId: 'tenant-1',
        providerId: 'trigger',
        createdBy: 'user-1',
        createdAt: new Date('2026-06-18T00:00:00.000Z'),
        ...overrides,
    } as AllowlistRow;
}

describe('TenantJobRuntimeService — per-tenant allow-list (P5.1 T35a)', () => {
    let service: TenantJobRuntimeService;
    let configRepo: { findOne: jest.Mock; create: jest.Mock; save: jest.Mock };
    let auditRepo: { create: jest.Mock; save: jest.Mock };
    let allowlistRepo: { find: jest.Mock; delete: jest.Mock; create: jest.Mock; save: jest.Mock };
    let dataSource: {
        transaction: jest.Mock;
    };
    let credentialVersionService: jest.Mocked<Pick<CredentialVersionService, 'bumpVersion'>>;

    // In-memory backing store for the allow-list repo — `find` reads
    // from here, the transaction runs delete + insert against the same
    // array. Keeps the spec close to real semantics without spinning
    // SQLite.
    let store: AllowlistRow[];

    const originalGating = process.env[PER_TENANT_GATING_ENV];
    const originalGlobal = process.env[GLOBAL_ALLOWLIST_ENV];

    beforeEach(() => {
        store = [];
        configRepo = {
            findOne: jest.fn(),
            create: jest.fn((row) => row),
            save: jest.fn((row) => row),
        };
        auditRepo = {
            create: jest.fn((row) => row),
            save: jest.fn((row) => row),
        };
        allowlistRepo = {
            find: jest.fn(async ({ where }: { where: { tenantId: string } }) =>
                store
                    .filter((r) => r.tenantId === where.tenantId)
                    .slice()
                    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
            ),
            delete: jest.fn(async (criteria: Partial<AllowlistRow>) => {
                const before = store.length;
                store = store.filter((r) => {
                    if (criteria.tenantId && r.tenantId !== criteria.tenantId) return true;
                    if (criteria.providerId && r.providerId !== criteria.providerId) return true;
                    return false;
                });
                return { affected: before - store.length };
            }),
            create: jest.fn((row: Partial<AllowlistRow>) => ({
                createdAt: new Date(),
                createdBy: row.createdBy ?? null,
                ...row,
            })),
            save: jest.fn(async (rows: AllowlistRow | AllowlistRow[]) => {
                const arr = Array.isArray(rows) ? rows : [rows];
                for (const r of arr) store.push(r);
                return arr;
            }),
        };
        dataSource = {
            transaction: jest.fn(async (cb: (manager: unknown) => Promise<void>) => {
                // Hand the same allowlistRepo back when the service asks
                // the manager for the entity-scoped repo. This keeps the
                // delete-then-insert running against the shared store.
                const manager = {
                    getRepository: () => allowlistRepo,
                };
                return cb(manager);
            }),
        };
        credentialVersionService = { bumpVersion: jest.fn() } as any;

        service = new TenantJobRuntimeService(
            configRepo as any,
            auditRepo as any,
            credentialVersionService as unknown as CredentialVersionService,
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

    // ─── listTenantAllowlist ───────────────────────────────────────────

    describe('listTenantAllowlist', () => {
        it('returns [] when no rows exist for the tenant', async () => {
            const result = await service.listTenantAllowlist('tenant-1');
            expect(result).toEqual([]);
        });

        it('returns providerIds in insertion order when 3 rows exist', async () => {
            store.push(
                buildAllowlistRow({
                    providerId: 'trigger',
                    createdAt: new Date('2026-06-18T00:00:01.000Z'),
                }),
                buildAllowlistRow({
                    providerId: 'temporal',
                    createdAt: new Date('2026-06-18T00:00:02.000Z'),
                }),
                buildAllowlistRow({
                    providerId: 'bullmq',
                    createdAt: new Date('2026-06-18T00:00:03.000Z'),
                }),
            );
            const result = await service.listTenantAllowlist('tenant-1');
            expect(result).toEqual(['trigger', 'temporal', 'bullmq']);
        });
    });

    // ─── replaceTenantAllowlist ────────────────────────────────────────

    describe('replaceTenantAllowlist', () => {
        it('writes the new set + emits an operator_allowlist_change audit row', async () => {
            const result = await service.replaceTenantAllowlist(
                'tenant-1',
                ['trigger', 'temporal'],
                'user-1',
            );
            expect(result).toEqual(['trigger', 'temporal']);
            expect(store.map((r) => r.providerId)).toEqual(['trigger', 'temporal']);

            const auditPayload = auditRepo.create.mock.calls[0][0];
            expect(auditPayload.action).toBe('operator_allowlist_change');
            expect(auditPayload.tenantId).toBe('tenant-1');
            expect(auditPayload.actorUserId).toBe('user-1');
            expect(auditPayload.before).toEqual({ providerIds: [] });
            expect(auditPayload.after).toEqual({ providerIds: ['trigger', 'temporal'] });
        });

        it('clears the overlay when called with [] and emits an audit row', async () => {
            store.push(
                buildAllowlistRow({
                    providerId: 'trigger',
                    createdAt: new Date('2026-06-18T00:00:01.000Z'),
                }),
            );

            const result = await service.replaceTenantAllowlist('tenant-1', [], 'user-1');
            expect(result).toEqual([]);
            expect(store).toHaveLength(0);

            const auditPayload = auditRepo.create.mock.calls[0][0];
            expect(auditPayload.before).toEqual({ providerIds: ['trigger'] });
            expect(auditPayload.after).toEqual({ providerIds: [] });
        });

        it('throws BadRequestException on an unknown providerId — defensive re-validation', async () => {
            await expect(
                service.replaceTenantAllowlist('tenant-1', ['not-a-real-runtime' as any], 'user-1'),
            ).rejects.toBeInstanceOf(BadRequestException);
            // Nothing was written and no audit row was emitted.
            expect(store).toHaveLength(0);
            expect(auditRepo.save).not.toHaveBeenCalled();
        });
    });

    // ─── deleteTenantAllowlistEntry ────────────────────────────────────

    describe('deleteTenantAllowlistEntry', () => {
        it('returns true when a row existed + emits an audit row', async () => {
            store.push(
                buildAllowlistRow({
                    providerId: 'trigger',
                    createdAt: new Date('2026-06-18T00:00:01.000Z'),
                }),
            );

            const removed = await service.deleteTenantAllowlistEntry(
                'tenant-1',
                'trigger',
                'user-1',
            );
            expect(removed).toBe(true);
            expect(store).toHaveLength(0);

            const auditPayload = auditRepo.create.mock.calls[0][0];
            expect(auditPayload.action).toBe('operator_allowlist_change');
            expect(auditPayload.before).toEqual({ providerIds: ['trigger'] });
            expect(auditPayload.after).toEqual({ providerIds: [] });
        });

        it('returns false when no row matched + does NOT emit an audit row', async () => {
            const removed = await service.deleteTenantAllowlistEntry(
                'tenant-1',
                'trigger',
                'user-1',
            );
            expect(removed).toBe(false);
            expect(auditRepo.create).not.toHaveBeenCalled();
            expect(auditRepo.save).not.toHaveBeenCalled();
        });
    });

    // ─── getAvailableProvidersForTenant — resolver intersection ────────

    describe('getAvailableProvidersForTenant', () => {
        it('returns the global list when the gating flag is OFF (ignores per-tenant rows)', async () => {
            delete process.env[PER_TENANT_GATING_ENV];
            process.env[GLOBAL_ALLOWLIST_ENV] = 'trigger,temporal,bullmq';
            // Populate per-tenant rows that would NARROW the list if the
            // flag were on — to prove the flag-off branch ignores them.
            store.push(
                buildAllowlistRow({ providerId: 'trigger' }),
            );

            const result = await service.getAvailableProvidersForTenant('tenant-1');
            expect(result).toEqual(['trigger', 'temporal', 'bullmq']);
        });

        it('returns the global list when the flag is ON + tenant has no rows (inherit default)', async () => {
            process.env[PER_TENANT_GATING_ENV] = 'true';
            process.env[GLOBAL_ALLOWLIST_ENV] = 'trigger,temporal,bullmq';

            const result = await service.getAvailableProvidersForTenant('tenant-1');
            expect(result).toEqual(['trigger', 'temporal', 'bullmq']);
        });

        it('returns global ∩ per-tenant in GLOBAL ORDER when both populated', async () => {
            process.env[PER_TENANT_GATING_ENV] = 'true';
            // Global order: trigger, temporal, bullmq, pgboss
            process.env[GLOBAL_ALLOWLIST_ENV] = 'trigger,temporal,bullmq,pgboss';
            // Per-tenant: bullmq + trigger (different order than global).
            // Result must preserve GLOBAL's order, not per-tenant's.
            store.push(
                buildAllowlistRow({
                    providerId: 'bullmq',
                    createdAt: new Date('2026-06-18T00:00:01.000Z'),
                }),
                buildAllowlistRow({
                    providerId: 'trigger',
                    createdAt: new Date('2026-06-18T00:00:02.000Z'),
                }),
            );

            const result = await service.getAvailableProvidersForTenant('tenant-1');
            expect(result).toEqual(['trigger', 'bullmq']);
        });

        it('silently drops per-tenant entries that are NOT in the global list', async () => {
            process.env[PER_TENANT_GATING_ENV] = 'true';
            // Global: trigger only.
            process.env[GLOBAL_ALLOWLIST_ENV] = 'trigger';
            // Per-tenant: trigger + temporal — temporal NOT in global.
            store.push(
                buildAllowlistRow({
                    providerId: 'trigger',
                    createdAt: new Date('2026-06-18T00:00:01.000Z'),
                }),
                buildAllowlistRow({
                    providerId: 'temporal',
                    createdAt: new Date('2026-06-18T00:00:02.000Z'),
                }),
            );

            const result = await service.getAvailableProvidersForTenant('tenant-1');
            // temporal silently dropped because global is the upper bound.
            expect(result).toEqual(['trigger']);
        });
    });
});
