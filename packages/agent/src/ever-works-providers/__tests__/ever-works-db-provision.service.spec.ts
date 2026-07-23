import { EverWorksDbProvisionService } from '../ever-works-db-provision.service';
import type { WorkRuntimeEnvService } from '../../services/work-runtime-env.service';

/**
 * Unit coverage for the shared-DB provision service that does NOT require a
 * live Postgres: the feature-gate short-circuit and the connection-string
 * validation branch (both return before any `pg` client is constructed).
 */
describe('EverWorksDbProvisionService', () => {
    const ORIGINAL_ENV = { ...process.env };
    let runtimeEnv: jest.Mocked<
        Pick<WorkRuntimeEnvService, 'getDatabaseUrl' | 'setDatabaseUrlIfNull'>
    >;
    let service: EverWorksDbProvisionService;

    beforeEach(() => {
        runtimeEnv = {
            getDatabaseUrl: jest.fn(),
            setDatabaseUrlIfNull: jest.fn(),
        } as never;
        service = new EverWorksDbProvisionService(runtimeEnv as unknown as WorkRuntimeEnvService);
    });

    afterEach(() => {
        process.env = { ...ORIGINAL_ENV };
    });

    describe('isReady / ensureDatabaseForWork gating', () => {
        it('is not ready and provisions nothing when the feature env is unset', async () => {
            delete process.env.DB_EVER_WORKS_SHARED_ENABLED;
            delete process.env.DB_EVER_WORKS_SHARED_ADMIN_URL;
            delete process.env.DB_EVER_WORKS_SHARED_HOST;

            expect(service.isReady()).toBe(false);
            await expect(service.ensureDatabaseForWork('work-1')).resolves.toBeNull();
            expect(runtimeEnv.getDatabaseUrl).not.toHaveBeenCalled();
        });

        it('is not ready when enabled but the admin URL / host are missing', () => {
            process.env.DB_EVER_WORKS_SHARED_ENABLED = 'true';
            delete process.env.DB_EVER_WORKS_SHARED_ADMIN_URL;
            delete process.env.DB_EVER_WORKS_SHARED_HOST;
            expect(service.isReady()).toBe(false);
        });
    });

    describe('testConnection validation', () => {
        it('rejects a non-postgres connection string without attempting a connection', async () => {
            const result = await service.testConnection('mysql://user:pw@host/db');
            expect(result.ok).toBe(false);
            expect(result.error).toMatch(/postgres/i);
        });
    });

    describe('resolveFromPluginSettings', () => {
        it('uses a work-scoped override connection string as-is (trimmed)', async () => {
            runtimeEnv.setDatabaseUrlIfNull.mockResolvedValue('postgresql://o:p@h/db');
            const url = await service.resolveFromPluginSettings('w1', {
                overrideConnectionString: '  postgresql://o:p@h/db  ',
            });
            expect(runtimeEnv.setDatabaseUrlIfNull).toHaveBeenCalledWith(
                'w1',
                'postgresql://o:p@h/db',
            );
            expect(url).toBe('postgresql://o:p@h/db');
        });

        it('returns null for custom mode with a blank connection string', async () => {
            await expect(
                service.resolveFromPluginSettings('w1', {
                    mode: 'custom',
                    customConnectionString: '   ',
                }),
            ).resolves.toBeNull();
            expect(runtimeEnv.setDatabaseUrlIfNull).not.toHaveBeenCalled();
        });

        it('falls back to the managed Ever Works DB by default (null when not wired)', async () => {
            delete process.env.DB_EVER_WORKS_SHARED_ENABLED;
            delete process.env.DB_EVER_WORKS_SHARED_ADMIN_URL;
            delete process.env.DB_EVER_WORKS_SHARED_HOST;
            await expect(service.resolveFromPluginSettings('w1', {})).resolves.toBeNull();
            await expect(
                service.resolveFromPluginSettings('w1', { mode: 'ever-works-db' }),
            ).resolves.toBeNull();
        });
    });
});
