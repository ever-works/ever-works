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

    describe('resolveCallerTenantContext (per-caller tenant isolation)', () => {
        it('derives the context from the authenticated user’s real tenantId', () => {
            const ctx = service.resolveCallerTenantContext('user-1', 'tenant-abc');
            expect(ctx).toEqual({ tenantId: 'tenant-abc', userId: 'user-1' });
        });

        it('fails closed (returns null) when the caller has no Tenant (null)', () => {
            expect(service.resolveCallerTenantContext('user-1', null)).toBeNull();
        });

        it('fails closed (returns null) when tenantId is undefined or empty', () => {
            expect(service.resolveCallerTenantContext('user-1', undefined)).toBeNull();
            expect(service.resolveCallerTenantContext('user-1', '')).toBeNull();
        });

        it('rejects a malformed tenant id carrying path-traversal metacharacters', () => {
            // Attack: a crafted tenant id must never be usable as a traversal
            // vector or an injection into the credential-map lookup / logs.
            expect(service.resolveCallerTenantContext('user-1', '../admin')).toBeNull();
            expect(service.resolveCallerTenantContext('user-1', 'a/b')).toBeNull();
            expect(service.resolveCallerTenantContext('user-1', 'a%2Fb')).toBeNull();
            expect(service.resolveCallerTenantContext('user-1', 'a\\b')).toBeNull();
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
            expect(service.validateTenantContext({ tenantId: undefined as any })).toBe(false);
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
