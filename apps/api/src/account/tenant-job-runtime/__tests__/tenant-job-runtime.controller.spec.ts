// EW-742 / EW-746 (P2.0) — controller + service tests for the
// tenant-job-runtime overlay admin API.
//
// We exercise the controller through the service against an in-memory
// repository stub so the spec covers the wire-level contract (auth gate,
// validation routing, audit emission, redaction) without spinning up
// TypeORM. Spec reference:
// `docs/specs/features/tenant-job-runtime-overlay/spec.md` (FR-7, FR-13).

jest.mock('@ever-works/agent/entities', () => ({
    // The test never persists rows, so we only need the class identities
    // for `@InjectRepository(...)` token lookups. Using plain classes here
    // matches the convention in
    // `apps/api/src/activity-log/activity-log.controller.spec.ts` —
    // mocking the entities barrel keeps the suite from pulling the full
    // TypeORM decorator graph at import time.
    TenantJobRuntimeConfig: class TenantJobRuntimeConfig {},
    TenantJobRuntimeAudit: class TenantJobRuntimeAudit {},
    // EW-752 P5.1 — referenced by the service constructor for the
    // allow-list overlay repo. Not exercised in this spec.
    TenantRuntimeProviderAllowlist: class TenantRuntimeProviderAllowlist {},
}));

jest.mock('@ever-works/agent/tasks', () => ({
    CredentialVersionService: class CredentialVersionService {},
}));

import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { CredentialVersionService } from '@ever-works/agent/tasks';
import type { TenantJobRuntimeConfig } from '@ever-works/agent/entities';
import type { AuthenticatedUser } from '../../../auth/types/auth.types';
import { BUNDLED_TENANT_JOB_RUNTIME_PROVIDERS } from '../../../config/constants';
import { TENANT_JOB_RUNTIME_PROVIDER_IDS } from '../dto/upsert-tenant-job-runtime.dto';
import { TenantJobRuntimeController } from '../tenant-job-runtime.controller';
import { TenantJobRuntimeService } from '../tenant-job-runtime.service';

type ConfigRow = TenantJobRuntimeConfig & {
    createdAt: Date;
    updatedAt: Date;
};

function buildConfigRow(overrides: Partial<ConfigRow> = {}): ConfigRow {
    const now = new Date('2026-06-18T12:00:00.000Z');
    return {
        tenantId: 'tenant-1',
        providerId: 'trigger',
        credentialsSecretRef: 'tenant-job-runtime:abc123:trigger:v1',
        credentialVersion: 1,
        mode: 'byo',
        enabled: true,
        createdBy: 'user-1',
        createdAt: now,
        updatedAt: now,
        ...overrides,
    } as ConfigRow;
}

function buildAuth(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
    return {
        userId: 'user-1',
        email: 'u@example.test',
        username: 'u',
        provider: 'local',
        emailVerified: true,
        isActive: true,
        avatar: null,
        iat: 0,
        iss: '',
        aud: '',
        tenantId: 'tenant-1',
        ...overrides,
    } as AuthenticatedUser;
}

describe('TenantJobRuntimeController', () => {
    let controller: TenantJobRuntimeController;
    let service: TenantJobRuntimeService;
    let configRepo: {
        findOne: jest.Mock;
        create: jest.Mock;
        save: jest.Mock;
    };
    let auditRepo: {
        create: jest.Mock;
        save: jest.Mock;
    };
    let credentialVersionService: jest.Mocked<Pick<CredentialVersionService, 'bumpVersion'>>;

    beforeEach(() => {
        configRepo = {
            findOne: jest.fn(),
            create: jest.fn((row) => row as ConfigRow),
            save: jest.fn((row) => row as ConfigRow),
        };
        auditRepo = {
            create: jest.fn((row) => row),
            save: jest.fn((row) => row),
        };
        credentialVersionService = {
            bumpVersion: jest.fn(),
        } as any;

        service = new TenantJobRuntimeService(
            configRepo as any,
            auditRepo as any,
            credentialVersionService as unknown as CredentialVersionService,
            // EW-752 P5.1 — these specs don't exercise the per-tenant
            // allow-list overlay or the boot writer, so allowlistRepo +
            // dataSource are stubbed as `undefined`. The new methods
            // (`listTenantAllowlist`, `replaceTenantAllowlist`,
            // `deleteTenantAllowlistEntry`,
            // `getAvailableProvidersForTenant`) have their own dedicated
            // spec at `tenant-job-runtime-allowlist.service.spec.ts`.
            undefined as any,
            undefined as any,
        );
        controller = new TenantJobRuntimeController(service);
    });

    // ─── Auth gate (every endpoint) ────────────────────────────────

    describe('tenant gate', () => {
        it('refuses with 403 when the caller has no Tenant (null tenantId)', async () => {
            const auth = buildAuth({ tenantId: null });
            await expect(controller.getConfig(auth)).rejects.toBeInstanceOf(ForbiddenException);
            await expect(
                controller.upsertConfig(auth, {
                    providerId: 'trigger',
                    mode: 'inherit',
                } as any),
            ).rejects.toBeInstanceOf(ForbiddenException);
            await expect(controller.rotateCredential(auth)).rejects.toBeInstanceOf(
                ForbiddenException,
            );
            await expect(controller.forceInvalidate(auth)).rejects.toBeInstanceOf(
                ForbiddenException,
            );
            await expect(controller.revertToInherit(auth)).rejects.toBeInstanceOf(
                ForbiddenException,
            );
        });

        it('refuses with 403 when tenantId is undefined (not yet hydrated)', async () => {
            const auth = buildAuth({ tenantId: undefined });
            await expect(controller.getConfig(auth)).rejects.toBeInstanceOf(ForbiddenException);
        });
    });

    // ─── GET ───────────────────────────────────────────────────────

    describe('GET /api/account/job-runtime/config', () => {
        it('returns the synthetic inherit default when no row exists (FR-7 NULL-safe)', async () => {
            configRepo.findOne.mockResolvedValue(null);
            const result = await controller.getConfig(buildAuth());
            expect(result).toEqual({
                tenantId: 'tenant-1',
                providerId: null,
                mode: 'inherit',
                hasCredentials: false,
                credentialsSecretRefRedacted: null,
                credentialVersion: null,
                enabled: true,
                createdBy: null,
                createdAt: null,
                updatedAt: null,
            });
        });

        it('redacts the credentials ref to the last 4 chars', async () => {
            configRepo.findOne.mockResolvedValue(
                buildConfigRow({
                    credentialsSecretRef: 'tenant-job-runtime:abc123:trigger:abcd1234',
                }),
            );
            const result = await controller.getConfig(buildAuth());
            expect(result.hasCredentials).toBe(true);
            expect(result.credentialsSecretRefRedacted).toBe('***1234');
            // The full ref MUST NOT leak anywhere on the response.
            expect(JSON.stringify(result)).not.toContain('abc123');
        });
    });

    // ─── PUT ───────────────────────────────────────────────────────

    describe('PUT /api/account/job-runtime/config', () => {
        it('400s when mode = inherit and credentialsSecretRef is supplied', async () => {
            await expect(
                controller.upsertConfig(buildAuth(), {
                    providerId: 'trigger',
                    mode: 'inherit',
                    credentialsSecretRef: 'tenant-job-runtime:should-not-be-here',
                } as any),
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('creates a fresh row at version 1 + emits a "create" audit row', async () => {
            configRepo.findOne.mockResolvedValue(null);
            configRepo.save.mockImplementation(async (row) => ({ ...row }));

            const result = await controller.upsertConfig(buildAuth(), {
                providerId: 'trigger',
                mode: 'byo',
                credentialsSecretRef: 'tenant-job-runtime:new-ref-abcd',
                enabled: true,
            } as any);

            expect(result.mode).toBe('byo');
            expect(result.providerId).toBe('trigger');
            expect(result.credentialVersion).toBe(1);
            expect(result.hasCredentials).toBe(true);
            expect(result.credentialsSecretRefRedacted).toBe('***abcd');

            const auditPayload = auditRepo.create.mock.calls[0][0];
            expect(auditPayload.action).toBe('create');
            expect(auditPayload.tenantId).toBe('tenant-1');
            expect(auditPayload.actorUserId).toBe('user-1');
            expect(auditPayload.before).toBeNull();
            // Secret MUST be redacted in the audit row too.
            expect(JSON.stringify(auditPayload.after)).not.toContain('new-ref-abcd');
            expect(auditPayload.after.credentialsSecretRefRedacted).toBe('***abcd');
        });

        it('bumps credentialVersion when credentialsSecretRef changes (rotation semantic)', async () => {
            const existing = buildConfigRow({
                credentialsSecretRef: 'old-ref-xxxx',
                credentialVersion: 3,
            });
            configRepo.findOne.mockResolvedValue(existing);
            configRepo.save.mockImplementation(async (row) => ({ ...row }));

            const result = await controller.upsertConfig(buildAuth(), {
                providerId: 'trigger',
                mode: 'byo',
                credentialsSecretRef: 'new-ref-yyyy',
            } as any);

            expect(result.credentialVersion).toBe(4);
            const auditPayload = auditRepo.create.mock.calls[0][0];
            expect(auditPayload.action).toBe('update');
            expect(auditPayload.before.credentialsSecretRefRedacted).toBe('***xxxx');
            expect(auditPayload.after.credentialsSecretRefRedacted).toBe('***yyyy');
        });

        it('does NOT bump credentialVersion when only providerId changes', async () => {
            const existing = buildConfigRow({
                providerId: 'trigger',
                credentialsSecretRef: 'same-ref-zzzz',
                credentialVersion: 5,
            });
            configRepo.findOne.mockResolvedValue(existing);
            configRepo.save.mockImplementation(async (row) => ({ ...row }));

            const result = await controller.upsertConfig(buildAuth(), {
                providerId: 'temporal',
                mode: 'override',
                credentialsSecretRef: 'same-ref-zzzz',
            } as any);

            expect(result.providerId).toBe('temporal');
            expect(result.credentialVersion).toBe(5);
        });
    });

    // ─── rotate ────────────────────────────────────────────────────

    describe('POST /api/account/job-runtime/rotate', () => {
        it('404s when no overlay row exists (inherit cannot be rotated)', async () => {
            configRepo.findOne.mockResolvedValue(null);
            await expect(controller.rotateCredential(buildAuth())).rejects.toBeInstanceOf(
                NotFoundException,
            );
            expect(credentialVersionService.bumpVersion).not.toHaveBeenCalled();
        });

        it('delegates to CredentialVersionService.bumpVersion + emits "rotate" audit', async () => {
            configRepo.findOne.mockResolvedValue(buildConfigRow({ credentialVersion: 7 }));
            credentialVersionService.bumpVersion.mockResolvedValue(8);

            const result = await controller.rotateCredential(buildAuth());

            expect(result).toEqual({ credentialVersion: 8 });
            expect(credentialVersionService.bumpVersion).toHaveBeenCalledWith('tenant-1');
            const auditPayload = auditRepo.create.mock.calls[0][0];
            expect(auditPayload.action).toBe('rotate');
            expect(auditPayload.credentialVersion).toBe(8);
        });
    });

    // ─── force-invalidate ──────────────────────────────────────────

    describe('POST /api/account/job-runtime/force-invalidate', () => {
        it('404s when no overlay row exists', async () => {
            configRepo.findOne.mockResolvedValue(null);
            await expect(controller.forceInvalidate(buildAuth())).rejects.toBeInstanceOf(
                NotFoundException,
            );
        });

        it('bumps credentialVersion + emits a "force_invalidate" audit row', async () => {
            configRepo.findOne.mockResolvedValue(buildConfigRow({ credentialVersion: 9 }));
            credentialVersionService.bumpVersion.mockResolvedValue(10);

            const result = await controller.forceInvalidate(buildAuth());

            expect(result).toEqual({ credentialVersion: 10 });
            const auditPayload = auditRepo.create.mock.calls[0][0];
            expect(auditPayload.action).toBe('force_invalidate');
            expect(auditPayload.credentialVersion).toBe(10);
        });
    });

    // ─── DELETE ────────────────────────────────────────────────────

    describe('DELETE /api/account/job-runtime/config', () => {
        it('reverts an existing row to inherit + bumps credentialVersion + emits "delete"', async () => {
            const existing = buildConfigRow({
                mode: 'byo',
                providerId: 'trigger',
                credentialsSecretRef: 'old-ref-pppp',
                credentialVersion: 4,
            });
            configRepo.findOne.mockResolvedValue(existing);
            configRepo.save.mockImplementation(async (row) => ({ ...row }));

            const result = await controller.revertToInherit(buildAuth());

            expect(result.mode).toBe('inherit');
            expect(result.hasCredentials).toBe(false);
            expect(result.credentialsSecretRefRedacted).toBeNull();
            expect(result.credentialVersion).toBe(5);
            // Row kept (history preserved per plan.md §4); only fields blanked.
            expect(configRepo.save).toHaveBeenCalled();
            const auditPayload = auditRepo.create.mock.calls[0][0];
            expect(auditPayload.action).toBe('delete');
            expect(auditPayload.before.credentialsSecretRefRedacted).toBe('***pppp');
            expect(auditPayload.after.credentialsSecretRefRedacted).toBeNull();
        });

        it('is idempotent — returns the synthetic default when no row exists', async () => {
            configRepo.findOne.mockResolvedValue(null);
            const result = await controller.revertToInherit(buildAuth());
            expect(result.mode).toBe('inherit');
            expect(result.hasCredentials).toBe(false);
            // No mutation when there's nothing to revert.
            expect(configRepo.save).not.toHaveBeenCalled();
            expect(auditRepo.save).not.toHaveBeenCalled();
        });
    });

    // ─── EW-742 P5 (T33-T35) ─ available providers + allow-list gating ──

    describe('GET /api/account/job-runtime/available-providers (P5 T34)', () => {
        const ENV_KEY = 'EVER_WORKS_TENANT_RUNTIME_ALLOWED_PROVIDERS';
        const ORIGINAL_VALUE = process.env[ENV_KEY];

        afterEach(() => {
            if (ORIGINAL_VALUE === undefined) {
                delete process.env[ENV_KEY];
            } else {
                process.env[ENV_KEY] = ORIGINAL_VALUE;
            }
        });

        it('returns ALL bundled providers when env is unset (fail-open default)', () => {
            delete process.env[ENV_KEY];
            const result = controller.getAvailableProviders(buildAuth());
            expect(result.providers).toEqual([
                'trigger',
                'temporal',
                'bullmq',
                'pgboss',
                'inngest',
            ]);
        });

        it('returns the operator-restricted subset, preserving order', () => {
            process.env[ENV_KEY] = 'temporal,trigger';
            const result = controller.getAvailableProviders(buildAuth());
            expect(result.providers).toEqual(['temporal', 'trigger']);
        });

        it('refuses with 403 when caller has no Tenant', () => {
            delete process.env[ENV_KEY];
            expect(() => controller.getAvailableProviders(buildAuth({ tenantId: null }))).toThrow(
                ForbiddenException,
            );
        });
    });

    describe('PUT /api/account/job-runtime/config — operator allow-list gating (P5 T34)', () => {
        const ENV_KEY = 'EVER_WORKS_TENANT_RUNTIME_ALLOWED_PROVIDERS';
        const ORIGINAL_VALUE = process.env[ENV_KEY];

        afterEach(() => {
            if (ORIGINAL_VALUE === undefined) {
                delete process.env[ENV_KEY];
            } else {
                process.env[ENV_KEY] = ORIGINAL_VALUE;
            }
        });

        it('400s when the submitted provider is excluded by the operator allow-list', async () => {
            process.env[ENV_KEY] = 'trigger,temporal';
            configRepo.findOne.mockResolvedValue(null);
            await expect(
                controller.upsertConfig(buildAuth(), {
                    providerId: 'inngest',
                    mode: 'byo',
                    credentialsSecretRef: 'tenant-job-runtime:abc:inngest:v1',
                } as any),
            ).rejects.toBeInstanceOf(BadRequestException);
            expect(configRepo.save).not.toHaveBeenCalled();
            expect(auditRepo.save).not.toHaveBeenCalled();
        });

        it('error message names the offending provider', async () => {
            process.env[ENV_KEY] = 'trigger';
            configRepo.findOne.mockResolvedValue(null);
            try {
                await controller.upsertConfig(buildAuth(), {
                    providerId: 'inngest',
                    mode: 'byo',
                    credentialsSecretRef: 'tenant-job-runtime:abc:inngest:v1',
                } as any);
                fail('expected BadRequestException');
            } catch (err) {
                expect(err).toBeInstanceOf(BadRequestException);
                const response = (err as BadRequestException).getResponse() as { message: string };
                expect(response.message).toMatch(/inngest/);
                expect(response.message).toMatch(/disabled/i);
            }
        });

        it('allows allowed providers through to upsert', async () => {
            process.env[ENV_KEY] = 'trigger,temporal';
            configRepo.findOne.mockResolvedValue(null);
            configRepo.save.mockImplementation(async (row) => ({ ...row }));
            const result = await controller.upsertConfig(buildAuth(), {
                providerId: 'temporal',
                mode: 'byo',
                credentialsSecretRef: 'tenant-job-runtime:abc:temporal:v1',
            } as any);
            expect(result.providerId).toBe('temporal');
        });

        it('skips the allow-list check when mode = inherit (provider is irrelevant)', async () => {
            // Operator restricted to `trigger` but caller submits `inngest` +
            // mode=inherit. Inherit mode disregards providerId; the gate should
            // not block this submission.
            process.env[ENV_KEY] = 'trigger';
            configRepo.findOne.mockResolvedValue(null);
            configRepo.save.mockImplementation(async (row) => ({ ...row }));
            const result = await controller.upsertConfig(buildAuth(), {
                providerId: 'inngest',
                mode: 'inherit',
            } as any);
            expect(result.mode).toBe('inherit');
        });
    });

    describe('drift gate (P5)', () => {
        it('BUNDLED_TENANT_JOB_RUNTIME_PROVIDERS matches TENANT_JOB_RUNTIME_PROVIDER_IDS', () => {
            // Two source-of-truth lists by design (apps/api/src/config keeps
            // zero feature imports); this test prevents silent divergence
            // when a new provider is added to one but not the other.
            expect([...BUNDLED_TENANT_JOB_RUNTIME_PROVIDERS]).toEqual([
                ...TENANT_JOB_RUNTIME_PROVIDER_IDS,
            ]);
        });
    });

    describe('Audit operatorAllowedProviders snapshot (P5 T35)', () => {
        const ENV_KEY = 'EVER_WORKS_TENANT_RUNTIME_ALLOWED_PROVIDERS';
        const ORIGINAL_VALUE = process.env[ENV_KEY];

        afterEach(() => {
            if (ORIGINAL_VALUE === undefined) {
                delete process.env[ENV_KEY];
            } else {
                process.env[ENV_KEY] = ORIGINAL_VALUE;
            }
        });

        it('attaches operatorAllowedProviders to the after snapshot on create', async () => {
            process.env[ENV_KEY] = 'trigger,temporal';
            configRepo.findOne.mockResolvedValue(null);
            configRepo.save.mockImplementation(async (row) => ({ ...row }));

            await controller.upsertConfig(buildAuth(), {
                providerId: 'trigger',
                mode: 'byo',
                credentialsSecretRef: 'tenant-job-runtime:new-ref-abcd',
            } as any);

            const auditPayload = auditRepo.create.mock.calls[0][0];
            expect(auditPayload.before).toBeNull();
            expect(auditPayload.after.operatorAllowedProviders).toEqual(['trigger', 'temporal']);
        });

        it('attaches operatorAllowedProviders to BOTH before and after on update', async () => {
            process.env[ENV_KEY] = 'trigger,bullmq';
            const existing = buildConfigRow({
                credentialsSecretRef: 'old-ref-xxxx',
                credentialVersion: 3,
            });
            configRepo.findOne.mockResolvedValue(existing);
            configRepo.save.mockImplementation(async (row) => ({ ...row }));

            await controller.upsertConfig(buildAuth(), {
                providerId: 'trigger',
                mode: 'byo',
                credentialsSecretRef: 'new-ref-yyyy',
            } as any);

            const auditPayload = auditRepo.create.mock.calls[0][0];
            expect(auditPayload.before.operatorAllowedProviders).toEqual(['trigger', 'bullmq']);
            expect(auditPayload.after.operatorAllowedProviders).toEqual(['trigger', 'bullmq']);
        });

        it('attaches the full bundled list when env is unset', async () => {
            delete process.env[ENV_KEY];
            configRepo.findOne.mockResolvedValue(null);
            configRepo.save.mockImplementation(async (row) => ({ ...row }));

            await controller.upsertConfig(buildAuth(), {
                providerId: 'trigger',
                mode: 'byo',
                credentialsSecretRef: 'tenant-job-runtime:new-ref-abcd',
            } as any);

            const auditPayload = auditRepo.create.mock.calls[0][0];
            expect(auditPayload.after.operatorAllowedProviders).toEqual([
                'trigger',
                'temporal',
                'bullmq',
                'pgboss',
                'inngest',
            ]);
        });
    });
});
