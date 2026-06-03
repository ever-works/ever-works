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
            // Attack: a crafted tenant id must never be able to break out of the
            // `/tenants/{id}` path segment.
            expect(service.resolveCallerTenantContext('user-1', '../admin')).toBeNull();
            expect(service.resolveCallerTenantContext('user-1', 'a/b')).toBeNull();
            expect(service.resolveCallerTenantContext('user-1', 'a%2Fb')).toBeNull();
            expect(service.resolveCallerTenantContext('user-1', 'a\\b')).toBeNull();
        });
    });

    describe('getTenantEndpointPrefix', () => {
        it('returns `/tenants/<tenantId>`', () => {
            expect(service.getTenantEndpointPrefix({ tenantId: 'work_42' })).toBe(
                '/tenants/work_42',
            );
        });

        it('produces a per-caller prefix from a real (UUID-shaped) tenant id', () => {
            const ctx = service.resolveCallerTenantContext(
                'user-1',
                '11111111-2222-3333-4444-555555555555',
            )!;
            expect(service.getTenantEndpointPrefix(ctx)).toBe(
                '/tenants/11111111-2222-3333-4444-555555555555',
            );
        });

        it('two different callers get two different, non-overlapping prefixes', () => {
            const a = service.resolveCallerTenantContext('user-a', 'tenant-a')!;
            const b = service.resolveCallerTenantContext('user-b', 'tenant-b')!;
            const prefixA = service.getTenantEndpointPrefix(a);
            const prefixB = service.getTenantEndpointPrefix(b);
            expect(prefixA).toBe('/tenants/tenant-a');
            expect(prefixB).toBe('/tenants/tenant-b');
            expect(prefixA).not.toBe(prefixB);
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
