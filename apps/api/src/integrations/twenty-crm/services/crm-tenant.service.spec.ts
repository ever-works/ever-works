import { CrmTenantService } from './crm-tenant.service';

describe('CrmTenantService', () => {
    let service: CrmTenantService;

    beforeEach(() => {
        service = new CrmTenantService();
        jest.spyOn((service as any).logger, 'debug').mockImplementation(() => undefined);
        jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);
    });

    describe('resolveTenantContext', () => {
        it('produces a `work_<workId>` tenantId when a workId is provided', () => {
            const ctx = service.resolveTenantContext('w-1', 'u-1');

            expect(ctx).toEqual({
                tenantId: 'work_w-1',
                workId: 'w-1',
                userId: 'u-1',
            });
        });

        it('falls back to the supplied globalTenantId when workId is absent', () => {
            const ctx = service.resolveTenantContext(undefined, 'u-1', 'tenant-x');

            expect(ctx.tenantId).toBe('tenant-x');
            expect(ctx.workId).toBeUndefined();
            expect(ctx.userId).toBe('u-1');
        });

        it('uses the `global_everworks` fallback when no workId or globalTenantId is provided', () => {
            const ctx = service.resolveTenantContext();

            expect(ctx).toEqual({
                tenantId: 'global_everworks',
                workId: undefined,
                userId: undefined,
            });
        });

        it('prefers workId over globalTenantId when both are provided', () => {
            const ctx = service.resolveTenantContext('w-1', undefined, 'tenant-x');
            expect(ctx.tenantId).toBe('work_w-1');
        });
    });

    describe('getTenantEndpointPrefix', () => {
        it('returns `/tenants/<tenantId>`', () => {
            expect(
                service.getTenantEndpointPrefix({ tenantId: 'work_42' }),
            ).toBe('/tenants/work_42');
        });
    });

    describe('validateTenantContext', () => {
        it('returns true when tenantId is set', () => {
            expect(service.validateTenantContext({ tenantId: 't-1' })).toBe(true);
        });

        it('returns false when tenantId is the empty string', () => {
            expect(service.validateTenantContext({ tenantId: '' })).toBe(false);
        });

        it('returns false when tenantId is undefined', () => {
            expect(
                service.validateTenantContext({ tenantId: undefined as any }),
            ).toBe(false);
        });
    });

    describe('getTenantConfig', () => {
        it('returns the tenant context as a plain config object', () => {
            const ctx = { tenantId: 't-1', workId: 'w-1', userId: 'u-1' };
            expect(service.getTenantConfig(ctx)).toEqual({
                tenantId: 't-1',
                workId: 'w-1',
                userId: 'u-1',
            });
        });

        it('preserves undefined optional fields', () => {
            const ctx = { tenantId: 't-1' };
            expect(service.getTenantConfig(ctx)).toEqual({
                tenantId: 't-1',
                workId: undefined,
                userId: undefined,
            });
        });
    });
});
