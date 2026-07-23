import { EverWorksDbProvisionService } from '../ever-works-db-provision.service';
import type { WorkRuntimeEnvService } from '../../services/work-runtime-env.service';

/**
 * Unit coverage for the shared-DB provision service that does NOT require a
 * live Postgres: the feature-gate short-circuit and the connection-string
 * validation branch (both return before any `pg` client is constructed).
 */
describe('EverWorksDbProvisionService', () => {
    const ORIGINAL_ENV = { ...process.env };
    let runtimeEnv: jest.Mocked<Pick<WorkRuntimeEnvService, 'getDatabaseUrl'>>;
    let service: EverWorksDbProvisionService;

    beforeEach(() => {
        runtimeEnv = { getDatabaseUrl: jest.fn() } as never;
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
});
