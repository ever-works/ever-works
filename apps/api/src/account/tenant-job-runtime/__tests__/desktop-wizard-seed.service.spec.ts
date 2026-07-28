import { CredentialVersionService } from '@ever-works/agent/tasks';
import type { TenantJobRuntimeConfig } from '@ever-works/agent/entities';
import { config } from '../../../config/constants';
import { TenantJobRuntimeService } from '../tenant-job-runtime.service';

/**
 * A9 — the desktop install wizard's runtime choice is PERSISTED to
 * `tenant_job_runtime_config`.
 *
 * Before this, the wizard collected a runtime, wrote it into an env file, and
 * the platform never recorded it anywhere a human or an admin API could see.
 * The choice existed only as a string in a dotenv file on one laptop.
 *
 * The tests below pin the three things that make the lazy seed safe to run on
 * every deployment: it is INERT without the desktop env var, it NEVER
 * overwrites a row the tenant already has, and a failure degrades to the
 * pre-existing synthetic-inherit response instead of a 500.
 */

const TENANT = '11111111-2222-4333-8444-555555555555';
const ENV_KEY = 'EVER_WORKS_DESKTOP_JOB_RUNTIME';

type ConfigRow = TenantJobRuntimeConfig;

describe('TenantJobRuntimeService — desktop install wizard seed (A9)', () => {
    let service: TenantJobRuntimeService;
    let configRepo: { findOne: jest.Mock; create: jest.Mock; save: jest.Mock };
    let auditRepo: { create: jest.Mock; save: jest.Mock };
    const originalEnv = process.env[ENV_KEY];

    beforeEach(() => {
        configRepo = {
            findOne: jest.fn(),
            create: jest.fn((row) => row as ConfigRow),
            save: jest.fn(
                async (row) => ({ createdAt: null, updatedAt: null, ...row }) as ConfigRow,
            ),
        };
        auditRepo = {
            create: jest.fn((row) => row),
            save: jest.fn(async (row) => row),
        };
        service = new TenantJobRuntimeService(
            configRepo as never,
            auditRepo as never,
            { bumpVersion: jest.fn() } as unknown as CredentialVersionService,
            undefined as never,
            undefined as never,
        );
    });

    afterEach(() => {
        if (originalEnv === undefined) {
            delete process.env[ENV_KEY];
        } else {
            process.env[ENV_KEY] = originalEnv;
        }
        jest.restoreAllMocks();
    });

    describe('config.tenantJobRuntime.getDesktopWizardProviderId', () => {
        it('accepts both the plugin id and the bare provider id', () => {
            process.env[ENV_KEY] = 'job-runtime-bullmq';
            expect(config.tenantJobRuntime.getDesktopWizardProviderId()).toBe('bullmq');

            process.env[ENV_KEY] = 'pgboss';
            expect(config.tenantJobRuntime.getDesktopWizardProviderId()).toBe('pgboss');

            process.env[ENV_KEY] = '  JOB-RUNTIME-NODE  ';
            expect(config.tenantJobRuntime.getDesktopWizardProviderId()).toBe('node');
        });

        it('returns null for an unset value or an unknown runtime', () => {
            delete process.env[ENV_KEY];
            expect(config.tenantJobRuntime.getDesktopWizardProviderId()).toBeNull();

            process.env[ENV_KEY] = '   ';
            expect(config.tenantJobRuntime.getDesktopWizardProviderId()).toBeNull();

            // A typo must be a no-op, never a row with a bogus providerId.
            process.env[ENV_KEY] = 'job-runtime-bulmq';
            expect(config.tenantJobRuntime.getDesktopWizardProviderId()).toBeNull();
        });
    });

    describe('seedFromDesktopWizard', () => {
        it('writes the wizard choice as the tenant overlay row', async () => {
            process.env[ENV_KEY] = 'job-runtime-bullmq';

            const seeded = await service.seedFromDesktopWizard(TENANT);

            expect(seeded).not.toBeNull();
            expect(configRepo.save).toHaveBeenCalledTimes(1);
            expect(configRepo.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    tenantId: TENANT,
                    providerId: 'bullmq',
                    // `inherit`: the desktop's credentials come from the same
                    // env the API already reads, so we record the CHOICE
                    // without asserting a tenant credential pointer.
                    mode: 'inherit',
                    credentialsSecretRef: null,
                    enabled: true,
                    createdBy: null,
                }),
            );
        });

        it('leaves an audit trail attributing the row to the installer, not a user', async () => {
            process.env[ENV_KEY] = 'pgboss';

            await service.seedFromDesktopWizard(TENANT);

            expect(auditRepo.save).toHaveBeenCalledTimes(1);
            expect(auditRepo.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    tenantId: TENANT,
                    action: 'desktop_wizard_seed',
                    actorUserId: null,
                    before: null,
                }),
            );
        });

        it('does nothing at all on a deployment with no desktop wizard', async () => {
            delete process.env[ENV_KEY];

            expect(await service.seedFromDesktopWizard(TENANT)).toBeNull();
            expect(configRepo.save).not.toHaveBeenCalled();
            expect(auditRepo.save).not.toHaveBeenCalled();
        });

        it('never surfaces a write failure — the read path must not 500', async () => {
            process.env[ENV_KEY] = 'bullmq';
            configRepo.save.mockRejectedValueOnce(new Error('unique violation'));

            await expect(service.seedFromDesktopWizard(TENANT)).resolves.toBeNull();
        });
    });

    describe('getConfig materialises the choice lazily', () => {
        it('returns the seeded provider the first time a tenant reads its overlay', async () => {
            process.env[ENV_KEY] = 'job-runtime-node';
            configRepo.findOne.mockResolvedValue(null);

            const response = await service.getConfig(TENANT);

            expect(response.providerId).toBe('node');
            expect(response.mode).toBe('inherit');
            expect(response.tenantId).toBe(TENANT);
        });

        it('NEVER clobbers a runtime the tenant already chose in Settings', async () => {
            process.env[ENV_KEY] = 'bullmq';
            configRepo.findOne.mockResolvedValue({
                tenantId: TENANT,
                providerId: 'temporal',
                mode: 'override',
                credentialsSecretRef: 'inline:abcd',
                credentialVersion: 3,
                enabled: true,
                createdBy: 'user-1',
                createdAt: null,
                updatedAt: null,
            } as unknown as ConfigRow);

            const response = await service.getConfig(TENANT);

            expect(response.providerId).toBe('temporal');
            expect(configRepo.save).not.toHaveBeenCalled();
        });

        it('still returns the synthetic inherit default when there is nothing to seed', async () => {
            delete process.env[ENV_KEY];
            configRepo.findOne.mockResolvedValue(null);

            const response = await service.getConfig(TENANT);

            expect(response).toEqual(
                expect.objectContaining({ tenantId: TENANT, providerId: null, mode: 'inherit' }),
            );
        });

        it('falls back to the synthetic default when the seed write fails', async () => {
            process.env[ENV_KEY] = 'bullmq';
            configRepo.findOne.mockResolvedValue(null);
            configRepo.save.mockRejectedValueOnce(new Error('unique violation'));

            const response = await service.getConfig(TENANT);

            expect(response.providerId).toBeNull();
            expect(response.mode).toBe('inherit');
        });
    });
});
