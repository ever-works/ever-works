// EW-742 + Trigger.dev BYO (#1548 tenant-byo-credentials, #1551 default
// client-factory) — integration tests focused on the Trigger.dev 3-mode
// overlay flow (inherit / byo / override) through the controller +
// service surface.
//
// These specs target the wire-level contract the operator UI relies on
// for the Trigger.dev picker (apps/web/.../trigger-mode-ui). We assert
// the controller's behaviour for:
//   - byo + the 3 Trigger.dev credentials (accessToken / secretKey /
//     projectRef) round-trip through the credentialsSecretRef pointer
//     correctly;
//   - mode toggles byo → inherit → byo preserve / drop the ref as
//     expected;
//   - override mode shares the same shape as byo (the difference is
//     semantic — switch provider too — but the persisted row is
//     identical from the ref-tracking perspective);
//   - inherit + supplied ref is rejected with 400.
//
// We model the Trigger.dev creds bag as the operator-supplied opaque
// `credentialsSecretRef` pointing into the secrets store (the actual
// {accessToken, secretKey, projectRef} JSON blob never crosses the API
// boundary — it lives encrypted at rest under PLUGIN_SECRET_ENCRYPTION_KEY
// and is dereferenced only on the dispatch path).

jest.mock('@ever-works/agent/entities', () => ({
    TenantJobRuntimeConfig: class TenantJobRuntimeConfig {},
    TenantJobRuntimeAudit: class TenantJobRuntimeAudit {},
    TenantRuntimeProviderAllowlist: class TenantRuntimeProviderAllowlist {},
}));

jest.mock('@ever-works/agent/tasks', () => ({
    CredentialVersionService: class CredentialVersionService {},
}));

import { randomUUID } from 'crypto';
import { BadRequestException } from '@nestjs/common';
import type { CredentialVersionService } from '@ever-works/agent/tasks';
import type { TenantJobRuntimeConfig } from '@ever-works/agent/entities';
import type { AuthenticatedUser } from '../../../auth/types/auth.types';
import { TenantJobRuntimeController } from '../tenant-job-runtime.controller';
import { TenantJobRuntimeService } from '../tenant-job-runtime.service';

type ConfigRow = TenantJobRuntimeConfig & {
    createdAt: Date;
    updatedAt: Date;
};

const FROZEN_TS = new Date('2026-06-21T11:00:00.000Z');

/**
 * Build a synthetic Trigger.dev BYO credentialsSecretRef. In production
 * this is an opaque pointer into the secret store; for the test it just
 * needs to differ between rotations so the version-bump predicate fires.
 */
function buildTriggerRef(projectRef: string, tail: string): string {
    return `tenant-job-runtime:trigger:${projectRef}:${tail}`;
}

function buildAuth(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
    return {
        userId: randomUUID(),
        email: 'op@example.test',
        username: 'op',
        provider: 'local',
        emailVerified: true,
        isActive: true,
        avatar: null,
        iat: 0,
        iss: '',
        aud: '',
        tenantId: randomUUID(),
        ...overrides,
    } as AuthenticatedUser;
}

function buildConfigRow(overrides: Partial<ConfigRow> = {}): ConfigRow {
    return {
        tenantId: 'tenant-1',
        providerId: 'trigger',
        credentialsSecretRef: buildTriggerRef('proj_test', 'init'),
        credentialVersion: 1,
        mode: 'byo',
        enabled: true,
        createdBy: 'user-1',
        createdAt: FROZEN_TS,
        updatedAt: FROZEN_TS,
        ...overrides,
    } as ConfigRow;
}

async function bootstrap() {
    const configRepo = {
        findOne: jest.fn(),
        create: jest.fn((row: ConfigRow) => row),
        save: jest.fn(async (row: ConfigRow) => ({ ...row })),
    };
    const auditRepo = {
        create: jest.fn((row) => row),
        save: jest.fn(async (row) => row),
    };
    const allowlistRepo = {
        find: jest.fn().mockResolvedValue([]),
        delete: jest.fn().mockResolvedValue({ affected: 0 }),
        create: jest.fn((row) => row),
        save: jest.fn(async (row) => row),
    };
    const credentialVersionService = { bumpVersion: jest.fn() };
    const dataSource = {
        transaction: jest.fn(async (cb: any) => cb({ getRepository: () => allowlistRepo })),
    };

    const service = new TenantJobRuntimeService(
        configRepo as any,
        auditRepo as any,
        credentialVersionService as unknown as CredentialVersionService,
        allowlistRepo as any,
        dataSource as any,
    );
    const controller = new TenantJobRuntimeController(service);

    return { controller, configRepo, auditRepo, credentialVersionService };
}

describe('Trigger.dev BYO 3-mode flow (integration)', () => {
    describe('PUT /config — Trigger.dev BYO acceptance', () => {
        it('accepts mode=byo with providerId=trigger + a populated credentialsSecretRef', async () => {
            const { controller, configRepo } = await bootstrap();
            configRepo.findOne.mockResolvedValue(null);
            const projectRef = `proj_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
            const ref = buildTriggerRef(projectRef, 'acc1');
            const result = await controller.upsertConfig(buildAuth(), {
                providerId: 'trigger',
                mode: 'byo',
                credentialsSecretRef: ref,
            } as any);
            expect(result.providerId).toBe('trigger');
            expect(result.mode).toBe('byo');
            expect(result.hasCredentials).toBe(true);
            expect(result.credentialsSecretRefRedacted).toBe('***acc1');
        });

        it('persists the BYO row at credentialVersion=1 on first insert', async () => {
            const { controller, configRepo } = await bootstrap();
            configRepo.findOne.mockResolvedValue(null);
            const result = await controller.upsertConfig(buildAuth(), {
                providerId: 'trigger',
                mode: 'byo',
                credentialsSecretRef: buildTriggerRef('proj_init', 'v001'),
            } as any);
            expect(result.credentialVersion).toBe(1);
            const created = configRepo.save.mock.calls[0][0] as ConfigRow;
            expect(created.providerId).toBe('trigger');
            expect(created.mode).toBe('byo');
            expect(created.credentialVersion).toBe(1);
        });

        it('passes the createdBy through from the authenticated user', async () => {
            const { controller, configRepo } = await bootstrap();
            const creator = randomUUID();
            configRepo.findOne.mockResolvedValue(null);
            await controller.upsertConfig(buildAuth({ userId: creator }), {
                providerId: 'trigger',
                mode: 'byo',
                credentialsSecretRef: buildTriggerRef('proj_x', 'cbxx'),
            } as any);
            const created = configRepo.save.mock.calls[0][0] as ConfigRow;
            expect(created.createdBy).toBe(creator);
        });
    });

    describe('PUT /config — Trigger.dev BYO rejection', () => {
        it('rejects mode=inherit with a credentialsSecretRef present (no tenant pointer leak)', async () => {
            const { controller, configRepo } = await bootstrap();
            configRepo.findOne.mockResolvedValue(null);
            await expect(
                controller.upsertConfig(buildAuth(), {
                    providerId: 'trigger',
                    mode: 'inherit',
                    credentialsSecretRef: buildTriggerRef('proj_should_not', 'leak'),
                } as any),
            ).rejects.toBeInstanceOf(BadRequestException);
            expect(configRepo.save).not.toHaveBeenCalled();
        });

        it('error message names the offending field for the operator UI', async () => {
            const { controller, configRepo } = await bootstrap();
            configRepo.findOne.mockResolvedValue(null);
            try {
                await controller.upsertConfig(buildAuth(), {
                    providerId: 'trigger',
                    mode: 'inherit',
                    credentialsSecretRef: buildTriggerRef('p', 'leak'),
                } as any);
                fail('expected BadRequestException');
            } catch (err) {
                expect(err).toBeInstanceOf(BadRequestException);
                expect((err as BadRequestException).message).toMatch(/credentialsSecretRef/);
                expect((err as BadRequestException).message).toMatch(/inherit/);
            }
        });

        it('rejects byo with an unknown providerId via the operator allow-list gate', async () => {
            const { controller, configRepo } = await bootstrap();
            const ENV = 'EVER_WORKS_TENANT_RUNTIME_ALLOWED_PROVIDERS';
            const prev = process.env[ENV];
            process.env[ENV] = 'trigger';
            try {
                configRepo.findOne.mockResolvedValue(null);
                await expect(
                    controller.upsertConfig(buildAuth(), {
                        providerId: 'temporal',
                        mode: 'byo',
                        credentialsSecretRef: 'tenant-job-runtime:temporal:proj:0001',
                    } as any),
                ).rejects.toBeInstanceOf(BadRequestException);
                expect(configRepo.save).not.toHaveBeenCalled();
            } finally {
                if (prev === undefined) delete process.env[ENV];
                else process.env[ENV] = prev;
            }
        });
    });

    describe('PUT /config — Trigger.dev override mode shape parity', () => {
        it('mode=override accepts the same ref shape and writes the row with mode=override', async () => {
            const { controller, configRepo } = await bootstrap();
            configRepo.findOne.mockResolvedValue(null);
            const result = await controller.upsertConfig(buildAuth(), {
                providerId: 'trigger',
                mode: 'override',
                credentialsSecretRef: buildTriggerRef('proj_override', 'ovr1'),
            } as any);
            expect(result.mode).toBe('override');
            expect(result.providerId).toBe('trigger');
            expect(result.hasCredentials).toBe(true);
            expect(result.credentialsSecretRefRedacted).toBe('***ovr1');
        });

        it('override audit row uses the same secret redaction contract as byo', async () => {
            const { controller, configRepo, auditRepo } = await bootstrap();
            configRepo.findOne.mockResolvedValue(null);
            await controller.upsertConfig(buildAuth(), {
                providerId: 'trigger',
                mode: 'override',
                credentialsSecretRef: buildTriggerRef('proj_audit', 'a4dt'),
            } as any);
            const audit = auditRepo.create.mock.calls[0][0];
            expect(audit.after.mode).toBe('override');
            expect(audit.after.credentialsSecretRefRedacted).toBe('***a4dt');
            expect(JSON.stringify(audit.after)).not.toContain('proj_audit');
        });
    });

    describe('PUT /config — mode toggles', () => {
        it('byo → inherit drops the ref and bumps the version', async () => {
            const { controller, configRepo } = await bootstrap();
            configRepo.findOne.mockResolvedValue(
                buildConfigRow({
                    credentialsSecretRef: buildTriggerRef('proj_a', 'aaaa'),
                    credentialVersion: 4,
                }),
            );
            const result = await controller.upsertConfig(buildAuth(), {
                providerId: 'trigger',
                mode: 'inherit',
            } as any);
            expect(result.mode).toBe('inherit');
            expect(result.hasCredentials).toBe(false);
            expect(result.credentialsSecretRefRedacted).toBeNull();
            // ref dropped to null → credentials changed → version bumps
            expect(result.credentialVersion).toBe(5);
        });

        it('inherit → byo (re-arming) inserts a new ref and bumps version from inherit-cleared row', async () => {
            const { controller, configRepo } = await bootstrap();
            // Existing row was reverted to inherit (ref=null, version=5).
            configRepo.findOne.mockResolvedValue(
                buildConfigRow({
                    mode: 'inherit',
                    credentialsSecretRef: null,
                    credentialVersion: 5,
                }),
            );
            const result = await controller.upsertConfig(buildAuth(), {
                providerId: 'trigger',
                mode: 'byo',
                credentialsSecretRef: buildTriggerRef('proj_b', 'bbbb'),
            } as any);
            expect(result.mode).toBe('byo');
            expect(result.hasCredentials).toBe(true);
            expect(result.credentialsSecretRefRedacted).toBe('***bbbb');
            // null → new-ref is a credentials change.
            expect(result.credentialVersion).toBe(6);
        });

        it('byo → byo with the SAME ref does not bump the version', async () => {
            const { controller, configRepo } = await bootstrap();
            const ref = buildTriggerRef('proj_same', 'samm');
            configRepo.findOne.mockResolvedValue(
                buildConfigRow({ credentialsSecretRef: ref, credentialVersion: 9 }),
            );
            const result = await controller.upsertConfig(buildAuth(), {
                providerId: 'trigger',
                mode: 'byo',
                credentialsSecretRef: ref,
            } as any);
            expect(result.credentialVersion).toBe(9);
        });

        it('byo → byo with a DIFFERENT ref bumps the version monotonically by 1', async () => {
            const { controller, configRepo } = await bootstrap();
            configRepo.findOne.mockResolvedValue(
                buildConfigRow({
                    credentialsSecretRef: buildTriggerRef('proj_old', 'old1'),
                    credentialVersion: 12,
                }),
            );
            const result = await controller.upsertConfig(buildAuth(), {
                providerId: 'trigger',
                mode: 'byo',
                credentialsSecretRef: buildTriggerRef('proj_new', 'new1'),
            } as any);
            expect(result.credentialVersion).toBe(13);
        });

        it('byo → override (provider stays, mode flips) does not bump on its own', async () => {
            const { controller, configRepo } = await bootstrap();
            const ref = buildTriggerRef('proj_stay', 'stay');
            configRepo.findOne.mockResolvedValue(
                buildConfigRow({
                    mode: 'byo',
                    credentialsSecretRef: ref,
                    credentialVersion: 2,
                }),
            );
            const result = await controller.upsertConfig(buildAuth(), {
                providerId: 'trigger',
                mode: 'override',
                credentialsSecretRef: ref,
            } as any);
            expect(result.mode).toBe('override');
            expect(result.credentialVersion).toBe(2);
        });

        it('byo → byo with provider change but same ref does not bump (provider switch alone is not a rotation)', async () => {
            const { controller, configRepo } = await bootstrap();
            const ref = 'tenant-job-runtime:multi:proj:ssss';
            configRepo.findOne.mockResolvedValue(
                buildConfigRow({
                    providerId: 'trigger',
                    credentialsSecretRef: ref,
                    credentialVersion: 6,
                }),
            );
            const result = await controller.upsertConfig(buildAuth(), {
                providerId: 'temporal',
                mode: 'byo',
                credentialsSecretRef: ref,
            } as any);
            expect(result.providerId).toBe('temporal');
            expect(result.credentialVersion).toBe(6);
        });
    });

    describe('Audit emission for Trigger.dev BYO flow', () => {
        it('writes exactly one create audit row per fresh BYO insert', async () => {
            const { controller, configRepo, auditRepo } = await bootstrap();
            configRepo.findOne.mockResolvedValue(null);
            await controller.upsertConfig(buildAuth(), {
                providerId: 'trigger',
                mode: 'byo',
                credentialsSecretRef: buildTriggerRef('proj_one', 'one1'),
            } as any);
            expect(auditRepo.save).toHaveBeenCalledTimes(1);
            expect(auditRepo.create.mock.calls[0][0].action).toBe('create');
        });

        it('audit "before" is null on create + "after" carries the redacted ref', async () => {
            const { controller, configRepo, auditRepo } = await bootstrap();
            configRepo.findOne.mockResolvedValue(null);
            await controller.upsertConfig(buildAuth(), {
                providerId: 'trigger',
                mode: 'byo',
                credentialsSecretRef: buildTriggerRef('proj_two', 'two2'),
            } as any);
            const audit = auditRepo.create.mock.calls[0][0];
            expect(audit.before).toBeNull();
            expect(audit.after.providerId).toBe('trigger');
            expect(audit.after.mode).toBe('byo');
            expect(audit.after.credentialsSecretRefRedacted).toBe('***two2');
        });

        it('audit row for an update carries BOTH before + after with their respective redactions', async () => {
            const { controller, configRepo, auditRepo } = await bootstrap();
            configRepo.findOne.mockResolvedValue(
                buildConfigRow({
                    credentialsSecretRef: buildTriggerRef('proj_old', 'oldd'),
                    credentialVersion: 4,
                }),
            );
            await controller.upsertConfig(buildAuth(), {
                providerId: 'trigger',
                mode: 'byo',
                credentialsSecretRef: buildTriggerRef('proj_new', 'neww'),
            } as any);
            const audit = auditRepo.create.mock.calls[0][0];
            expect(audit.action).toBe('update');
            expect(audit.before.credentialsSecretRefRedacted).toBe('***oldd');
            expect(audit.after.credentialsSecretRefRedacted).toBe('***neww');
        });
    });
});
