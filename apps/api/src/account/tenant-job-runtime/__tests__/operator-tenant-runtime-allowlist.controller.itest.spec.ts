// EW-742 P5.1 (T35a) — INTEGRATION-level spec for the operator-scoped
// per-tenant runtime allow-list controller. Drives the controller →
// service → in-memory-repo path through `@nestjs/testing` so the route
// handler, DTO routing, audit emission and cross-tenant isolation are
// exercised end-to-end at the boundary the OpenAPI surface promises —
// without spinning the full NestJS HTTP listener or a real Postgres
// instance.
//
// Scope (vs. the existing service-level spec at
// `tenant-job-runtime-allowlist.service.spec.ts`):
//   - GET / PUT / DELETE wire-level behaviour through the controller
//   - Response shape conformance (tenantId echo, gating flag echo)
//   - Cross-tenant write isolation (operator action on tenant A leaves
//     tenant B's overlay untouched)
//   - Audit-row emission per mutation, including `tenantId` correctness
//   - Unknown-providerId path semantic on DELETE (404 NotFoundException,
//     no audit row written)
//   - PUT clears + re-populates atomically
//   - Idempotent DELETE returns 404 + no audit row
//
// The `IsPlatformAdminGuard` is exercised in its own spec
// (`apps/api/src/auth/guards/platform-admin.guard.spec.ts`); this file
// instantiates the controller directly so it does NOT need to thread a
// real guard through the NestJS DI graph.

jest.mock('@ever-works/agent/entities', () => ({
    TenantJobRuntimeConfig: class TenantJobRuntimeConfig {},
    TenantJobRuntimeAudit: class TenantJobRuntimeAudit {},
    TenantRuntimeProviderAllowlist: class TenantRuntimeProviderAllowlist {},
}));

jest.mock('@ever-works/agent/tasks', () => ({
    CredentialVersionService: class CredentialVersionService {},
}));

// The controller imports `AuthSessionGuard` from `../../auth` (barrel
// re-export of the entire auth module — auth.service, controllers,
// DTOs, etc.). Loading that chain pulls in `@ever-works/agent/database`
// which transitively imports `@src/config` via `database.config.ts` —
// jest's `moduleNameMapper` for `@src/...` only resolves files inside
// `apps/api/src/`, not files inside `packages/agent/`. We never
// exercise the real guard in this integration spec (its own dedicated
// spec at `apps/api/src/auth/guards/platform-admin.guard.spec.ts`
// covers that surface), so stubbing the barrel keeps the import graph
// shallow.
jest.mock('../../../auth', () => ({
    AuthSessionGuard: class AuthSessionGuard {
        canActivate() {
            return true;
        }
    },
}));
jest.mock('../../../auth/guards/platform-admin.guard', () => ({
    IsPlatformAdminGuard: class IsPlatformAdminGuard {
        canActivate() {
            return true;
        }
    },
}));
jest.mock('../../../auth/decorators/user.decorator', () => ({
    CurrentUser: () => () => undefined,
}));

import { randomUUID } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';
import type { CredentialVersionService } from '@ever-works/agent/tasks';
import type { TenantRuntimeProviderAllowlist as TenantRuntimeProviderAllowlistEntity } from '@ever-works/agent/entities';
import type { AuthenticatedUser } from '../../../auth/types/auth.types';
import { OperatorTenantRuntimeAllowlistController } from '../../../operator/tenant-runtime-allowlist/operator-tenant-runtime-allowlist.controller';
import { TenantJobRuntimeService } from '../tenant-job-runtime.service';

type AllowlistRow = TenantRuntimeProviderAllowlistEntity & { createdAt: Date };

const PER_TENANT_GATING_ENV = 'EVER_WORKS_TENANT_RUNTIME_PER_TENANT_GATING';
const GLOBAL_ALLOWLIST_ENV = 'EVER_WORKS_TENANT_RUNTIME_ALLOWED_PROVIDERS';

function buildAuth(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
    return {
        userId: 'operator-user-1',
        email: 'op@example.test',
        username: 'op',
        provider: 'local',
        emailVerified: true,
        isActive: true,
        avatar: null,
        iat: 0,
        iss: '',
        aud: '',
        ...overrides,
    } as AuthenticatedUser;
}

describe('OperatorTenantRuntimeAllowlistController — integration (EW-742 P5.1 T35a)', () => {
    let controller: OperatorTenantRuntimeAllowlistController;
    let service: TenantJobRuntimeService;
    let auditRepo: { create: jest.Mock; save: jest.Mock };
    let allowlistRepo: {
        find: jest.Mock;
        delete: jest.Mock;
        create: jest.Mock;
        save: jest.Mock;
    };
    let dataSource: { transaction: jest.Mock };

    // Shared in-memory store backing the allow-list repo. Reset per test.
    let store: AllowlistRow[];

    const originalGating = process.env[PER_TENANT_GATING_ENV];
    const originalGlobal = process.env[GLOBAL_ALLOWLIST_ENV];

    beforeEach(() => {
        store = [];

        const configRepo = {
            findOne: jest.fn(),
            create: jest.fn((row) => row),
            save: jest.fn((row) => row),
        };
        auditRepo = {
            create: jest.fn((row) => row),
            save: jest.fn(async (row) => row),
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
                const manager = { getRepository: () => allowlistRepo };
                return cb(manager);
            }),
        };
        const credentialVersionService = {
            bumpVersion: jest.fn(),
        } as unknown as jest.Mocked<Pick<CredentialVersionService, 'bumpVersion'>>;

        service = new TenantJobRuntimeService(
            configRepo as any,
            auditRepo as any,
            credentialVersionService as unknown as CredentialVersionService,
            allowlistRepo as any,
            dataSource as any,
        );
        controller = new OperatorTenantRuntimeAllowlistController(service);
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

    // ─── GET /api/operator/tenants/:tenantId/runtime-allowlist ──────────

    describe('GET — list per-tenant allow-list rows', () => {
        it('returns an empty list + the gating flag for a tenant with no overlay rows', async () => {
            delete process.env[PER_TENANT_GATING_ENV];
            const tenantId = randomUUID();

            const result = await controller.list(tenantId);

            expect(result).toEqual({
                tenantId,
                providerIds: [],
                perTenantGatingEnabled: false,
            });
            expect(allowlistRepo.find).toHaveBeenCalledWith({
                where: { tenantId },
                order: { createdAt: 'ASC' },
            });
        });

        it('returns providerIds in insertion order when the tenant has 3 rows', async () => {
            const tenantId = randomUUID();
            store.push(
                {
                    tenantId,
                    providerId: 'trigger',
                    createdBy: null,
                    createdAt: new Date('2026-06-18T00:00:01.000Z'),
                } as AllowlistRow,
                {
                    tenantId,
                    providerId: 'temporal',
                    createdBy: null,
                    createdAt: new Date('2026-06-18T00:00:02.000Z'),
                } as AllowlistRow,
                {
                    tenantId,
                    providerId: 'bullmq',
                    createdBy: null,
                    createdAt: new Date('2026-06-18T00:00:03.000Z'),
                } as AllowlistRow,
            );

            const result = await controller.list(tenantId);

            expect(result.providerIds).toEqual(['trigger', 'temporal', 'bullmq']);
            expect(result.tenantId).toBe(tenantId);
        });

        it('echoes perTenantGatingEnabled=true when the env flag is on', async () => {
            process.env[PER_TENANT_GATING_ENV] = 'true';
            const result = await controller.list(randomUUID());
            expect(result.perTenantGatingEnabled).toBe(true);
        });

        it('echoes perTenantGatingEnabled=false when the env flag is off', async () => {
            process.env[PER_TENANT_GATING_ENV] = 'false';
            const result = await controller.list(randomUUID());
            expect(result.perTenantGatingEnabled).toBe(false);
        });

        it('does NOT leak rows from a different tenant', async () => {
            const tenantA = randomUUID();
            const tenantB = randomUUID();
            store.push(
                {
                    tenantId: tenantA,
                    providerId: 'trigger',
                    createdBy: null,
                    createdAt: new Date('2026-06-18T00:00:01.000Z'),
                } as AllowlistRow,
                {
                    tenantId: tenantB,
                    providerId: 'temporal',
                    createdBy: null,
                    createdAt: new Date('2026-06-18T00:00:02.000Z'),
                } as AllowlistRow,
            );

            const a = await controller.list(tenantA);
            const b = await controller.list(tenantB);

            expect(a.providerIds).toEqual(['trigger']);
            expect(b.providerIds).toEqual(['temporal']);
        });

        it('silently drops a legacy row whose providerId is no longer in the static enum', async () => {
            const tenantId = randomUUID();
            store.push(
                {
                    tenantId,
                    providerId: 'trigger',
                    createdBy: null,
                    createdAt: new Date('2026-06-18T00:00:01.000Z'),
                } as AllowlistRow,
                {
                    tenantId,
                    providerId: 'retired-provider' as any,
                    createdBy: null,
                    createdAt: new Date('2026-06-18T00:00:02.000Z'),
                } as AllowlistRow,
            );

            const result = await controller.list(tenantId);

            // The retired provider id is silently filtered — matches the
            // resolver's "global is the upper bound" semantic.
            expect(result.providerIds).toEqual(['trigger']);
        });
    });

    // ─── PUT /api/operator/tenants/:tenantId/runtime-allowlist ──────────

    describe('PUT — replace per-tenant allow-list atomically', () => {
        it('persists the supplied providerIds in order + echoes them back', async () => {
            const tenantId = randomUUID();
            const auth = buildAuth();

            const result = await controller.replace(
                tenantId,
                { providerIds: ['trigger', 'temporal'] } as any,
                auth,
            );

            expect(result.tenantId).toBe(tenantId);
            expect(result.providerIds).toEqual(['trigger', 'temporal']);
            expect(store.map((r) => r.providerId)).toEqual(['trigger', 'temporal']);
            // Single atomic transaction — DataSource.transaction called once.
            expect(dataSource.transaction).toHaveBeenCalledTimes(1);
        });

        it('records who replaced the list via the actorUserId on the audit row', async () => {
            const tenantId = randomUUID();
            const auth = buildAuth({ userId: 'op-bob' });

            await controller.replace(tenantId, { providerIds: ['trigger'] } as any, auth);

            const payload = auditRepo.create.mock.calls[0][0];
            expect(payload.action).toBe('operator_allowlist_change');
            expect(payload.actorUserId).toBe('op-bob');
            expect(payload.tenantId).toBe(tenantId);
            expect(payload.before).toEqual({ providerIds: [] });
            expect(payload.after).toEqual({ providerIds: ['trigger'] });
        });

        it('an empty providerIds array clears the per-tenant overlay (tenant falls back to inherit)', async () => {
            const tenantId = randomUUID();
            store.push(
                {
                    tenantId,
                    providerId: 'trigger',
                    createdBy: null,
                    createdAt: new Date('2026-06-18T00:00:01.000Z'),
                } as AllowlistRow,
                {
                    tenantId,
                    providerId: 'bullmq',
                    createdBy: null,
                    createdAt: new Date('2026-06-18T00:00:02.000Z'),
                } as AllowlistRow,
            );

            const result = await controller.replace(
                tenantId,
                { providerIds: [] } as any,
                buildAuth(),
            );

            expect(result.providerIds).toEqual([]);
            expect(store.filter((r) => r.tenantId === tenantId)).toHaveLength(0);

            const payload = auditRepo.create.mock.calls[0][0];
            expect(payload.before).toEqual({ providerIds: ['trigger', 'bullmq'] });
            expect(payload.after).toEqual({ providerIds: [] });
        });

        it('atomically replaces an existing row set (delete-then-insert in one txn)', async () => {
            const tenantId = randomUUID();
            store.push(
                {
                    tenantId,
                    providerId: 'trigger',
                    createdBy: null,
                    createdAt: new Date('2026-06-18T00:00:01.000Z'),
                } as AllowlistRow,
                {
                    tenantId,
                    providerId: 'temporal',
                    createdBy: null,
                    createdAt: new Date('2026-06-18T00:00:02.000Z'),
                } as AllowlistRow,
            );

            const result = await controller.replace(
                tenantId,
                { providerIds: ['bullmq', 'pgboss', 'inngest'] } as any,
                buildAuth(),
            );

            expect(result.providerIds).toEqual(['bullmq', 'pgboss', 'inngest']);
            // The two prior rows were removed; the three new rows replaced them.
            expect(store.filter((r) => r.tenantId === tenantId).map((r) => r.providerId)).toEqual([
                'bullmq',
                'pgboss',
                'inngest',
            ]);
            // Still a single transaction (not delete-commit + insert-commit).
            expect(dataSource.transaction).toHaveBeenCalledTimes(1);
        });

        it('cross-tenant safety — a replace on tenant A does NOT touch tenant B rows', async () => {
            const tenantA = randomUUID();
            const tenantB = randomUUID();
            store.push(
                {
                    tenantId: tenantA,
                    providerId: 'trigger',
                    createdBy: null,
                    createdAt: new Date('2026-06-18T00:00:01.000Z'),
                } as AllowlistRow,
                {
                    tenantId: tenantB,
                    providerId: 'temporal',
                    createdBy: null,
                    createdAt: new Date('2026-06-18T00:00:02.000Z'),
                } as AllowlistRow,
                {
                    tenantId: tenantB,
                    providerId: 'bullmq',
                    createdBy: null,
                    createdAt: new Date('2026-06-18T00:00:03.000Z'),
                } as AllowlistRow,
            );

            await controller.replace(
                tenantA,
                { providerIds: ['inngest', 'pgboss'] } as any,
                buildAuth(),
            );

            // Tenant A flipped to the new set.
            expect(store.filter((r) => r.tenantId === tenantA).map((r) => r.providerId)).toEqual([
                'inngest',
                'pgboss',
            ]);
            // Tenant B unchanged — same 2 rows, in the same order.
            expect(store.filter((r) => r.tenantId === tenantB).map((r) => r.providerId)).toEqual([
                'temporal',
                'bullmq',
            ]);
            // Audit row tagged with tenant A, not tenant B.
            const payload = auditRepo.create.mock.calls[0][0];
            expect(payload.tenantId).toBe(tenantA);
        });

        it('passes the actor userId through to the per-row `createdBy` column', async () => {
            const tenantId = randomUUID();
            await controller.replace(
                tenantId,
                { providerIds: ['trigger'] } as any,
                buildAuth({ userId: 'op-alice' }),
            );

            const row = store.find((r) => r.tenantId === tenantId);
            expect(row?.createdBy).toBe('op-alice');
        });

        it('writes the audit row AFTER the transaction commits (single audit row per mutation)', async () => {
            const tenantId = randomUUID();
            await controller.replace(
                tenantId,
                { providerIds: ['trigger', 'temporal'] } as any,
                buildAuth(),
            );
            expect(auditRepo.create).toHaveBeenCalledTimes(1);
            expect(auditRepo.save).toHaveBeenCalledTimes(1);
        });
    });

    // ─── DELETE /api/operator/tenants/:tenantId/runtime-allowlist/:providerId

    describe('DELETE — remove a single per-tenant entry', () => {
        it('removes the row + returns the remaining list', async () => {
            const tenantId = randomUUID();
            store.push(
                {
                    tenantId,
                    providerId: 'trigger',
                    createdBy: null,
                    createdAt: new Date('2026-06-18T00:00:01.000Z'),
                } as AllowlistRow,
                {
                    tenantId,
                    providerId: 'temporal',
                    createdBy: null,
                    createdAt: new Date('2026-06-18T00:00:02.000Z'),
                } as AllowlistRow,
            );

            const result = await controller.removeEntry(tenantId, 'trigger', buildAuth());

            expect(result.providerIds).toEqual(['temporal']);
            expect(store.map((r) => r.providerId)).toEqual(['temporal']);
        });

        it('emits an operator_allowlist_change audit row recording before/after', async () => {
            const tenantId = randomUUID();
            store.push(
                {
                    tenantId,
                    providerId: 'trigger',
                    createdBy: null,
                    createdAt: new Date('2026-06-18T00:00:01.000Z'),
                } as AllowlistRow,
                {
                    tenantId,
                    providerId: 'temporal',
                    createdBy: null,
                    createdAt: new Date('2026-06-18T00:00:02.000Z'),
                } as AllowlistRow,
            );

            await controller.removeEntry(tenantId, 'temporal', buildAuth({ userId: 'op-eve' }));

            const payload = auditRepo.create.mock.calls[0][0];
            expect(payload.action).toBe('operator_allowlist_change');
            expect(payload.tenantId).toBe(tenantId);
            expect(payload.actorUserId).toBe('op-eve');
            expect(payload.before).toEqual({ providerIds: ['trigger', 'temporal'] });
            expect(payload.after).toEqual({ providerIds: ['trigger'] });
        });

        it('404s when the providerId is not in the per-tenant overlay (no audit row)', async () => {
            const tenantId = randomUUID();
            await expect(
                controller.removeEntry(tenantId, 'trigger', buildAuth()),
            ).rejects.toBeInstanceOf(NotFoundException);
            expect(auditRepo.create).not.toHaveBeenCalled();
            expect(auditRepo.save).not.toHaveBeenCalled();
        });

        it('404s when the providerId is not a known runtime id (defensive layer)', async () => {
            const tenantId = randomUUID();
            // Path-param value is rejected at the controller before any
            // service call (and definitely before any DELETE against the
            // store). Matches the DTO's `IsIn` posture on PUT.
            await expect(
                controller.removeEntry(tenantId, 'not-a-real-runtime', buildAuth()),
            ).rejects.toBeInstanceOf(NotFoundException);
            expect(allowlistRepo.delete).not.toHaveBeenCalled();
        });

        it('does NOT touch another tenant when deleting the same providerId for tenant A', async () => {
            const tenantA = randomUUID();
            const tenantB = randomUUID();
            store.push(
                {
                    tenantId: tenantA,
                    providerId: 'trigger',
                    createdBy: null,
                    createdAt: new Date('2026-06-18T00:00:01.000Z'),
                } as AllowlistRow,
                {
                    tenantId: tenantB,
                    providerId: 'trigger',
                    createdBy: null,
                    createdAt: new Date('2026-06-18T00:00:02.000Z'),
                } as AllowlistRow,
            );

            await controller.removeEntry(tenantA, 'trigger', buildAuth());

            expect(store.filter((r) => r.tenantId === tenantA)).toHaveLength(0);
            expect(store.filter((r) => r.tenantId === tenantB)).toHaveLength(1);
        });

        it('echoes the gating flag on the post-delete response', async () => {
            process.env[PER_TENANT_GATING_ENV] = 'true';
            const tenantId = randomUUID();
            store.push({
                tenantId,
                providerId: 'trigger',
                createdBy: null,
                createdAt: new Date('2026-06-18T00:00:01.000Z'),
            } as AllowlistRow);

            const result = await controller.removeEntry(tenantId, 'trigger', buildAuth());

            expect(result.perTenantGatingEnabled).toBe(true);
            expect(result.providerIds).toEqual([]);
        });
    });

    // ─── End-to-end happy path: PUT then GET then DELETE ────────────────

    describe('end-to-end operator flow', () => {
        it('PUT → GET reflects the new state; DELETE → GET reflects the row removal', async () => {
            const tenantId = randomUUID();
            const auth = buildAuth();

            // Initially empty.
            expect((await controller.list(tenantId)).providerIds).toEqual([]);

            // Replace with 3 providers.
            await controller.replace(
                tenantId,
                { providerIds: ['trigger', 'temporal', 'bullmq'] } as any,
                auth,
            );
            const afterPut = await controller.list(tenantId);
            expect(afterPut.providerIds).toEqual(['trigger', 'temporal', 'bullmq']);

            // Remove the middle one.
            await controller.removeEntry(tenantId, 'temporal', auth);
            const afterDelete = await controller.list(tenantId);
            expect(afterDelete.providerIds).toEqual(['trigger', 'bullmq']);

            // Two audit rows total: one for PUT, one for DELETE. The GET
            // calls do NOT emit audit rows.
            expect(auditRepo.create).toHaveBeenCalledTimes(2);
            expect(auditRepo.create.mock.calls.every((c) => c[0].tenantId === tenantId)).toBe(true);
        });
    });
});
