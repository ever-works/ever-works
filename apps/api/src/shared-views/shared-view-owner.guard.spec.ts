jest.mock('@ever-works/agent/database', () => ({
    OrganizationRepository: class OrganizationRepository {},
    TenantRepository: class TenantRepository {},
}));

import { ForbiddenException, NotFoundException, type ExecutionContext } from '@nestjs/common';
import {
    SHARED_VIEW_ACTOR_KEY,
    SharedViewOwnerGuard,
    SharedViewOwnerResolver,
} from './shared-view-owner.guard';

describe('SharedViewOwnerGuard', () => {
    type Req = {
        params?: Record<string, string>;
        user?: { userId?: string };
        [key: string]: unknown;
    };

    const ctx = (req: Req, type: 'http' | 'rpc' = 'http'): ExecutionContext =>
        ({
            getType: () => type,
            switchToHttp: () => ({ getRequest: () => req }),
        }) as unknown as ExecutionContext;

    function makeResolver(opts: { organization?: unknown; tenant?: unknown } = {}) {
        const organizations = {
            findById: jest
                .fn()
                .mockResolvedValue(
                    'organization' in opts
                        ? opts.organization
                        : { id: 'org-1', tenantId: 'tenant-1' },
                ),
        };
        const tenants = {
            findById: jest
                .fn()
                .mockResolvedValue(
                    'tenant' in opts ? opts.tenant : { id: 'tenant-1', ownerUserId: 'owner-1' },
                ),
        };
        const resolver = new SharedViewOwnerResolver(organizations as never, tenants as never);
        return { resolver, organizations, tenants };
    }

    it('admits the Tenant owner and leaves the resolved Workspace for the handler', async () => {
        const { resolver, tenants } = makeResolver();
        const guard = new SharedViewOwnerGuard(resolver);
        const req: Req = { params: { orgId: 'org-1' }, user: { userId: 'owner-1' } };

        await expect(guard.canActivate(ctx(req))).resolves.toBe(true);
        expect(tenants.findById).toHaveBeenCalledWith('tenant-1');
        expect(req[SHARED_VIEW_ACTOR_KEY]).toEqual({
            organizationId: 'org-1',
            tenantId: 'tenant-1',
            ownerUserId: 'owner-1',
        });
    });

    it('answers 404, never 403, to a member who is not the Tenant owner', async () => {
        const { resolver } = makeResolver();
        const guard = new SharedViewOwnerGuard(resolver);
        const attempt = guard.canActivate(
            ctx({ params: { orgId: 'org-1' }, user: { userId: 'member-2' } }),
        );
        await expect(attempt).rejects.toBeInstanceOf(NotFoundException);
        await expect(attempt).rejects.not.toBeInstanceOf(ForbiddenException);
    });

    it.each([
        ['a missing Workspace', { organization: null }],
        ['a Workspace with no Tenant', { organization: { id: 'org-1', tenantId: null } }],
        ['a Tenant that cannot be found', { tenant: null }],
    ])('fails closed with 404 on %s', async (_label, opts) => {
        const { resolver } = makeResolver(opts);
        const guard = new SharedViewOwnerGuard(resolver);
        await expect(
            guard.canActivate(ctx({ params: { orgId: 'org-1' }, user: { userId: 'owner-1' } })),
        ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('fails closed with 404 when the route carries no Workspace or no user', async () => {
        const { resolver, organizations } = makeResolver();
        const guard = new SharedViewOwnerGuard(resolver);
        await expect(
            guard.canActivate(ctx({ user: { userId: 'owner-1' } })),
        ).rejects.toBeInstanceOf(NotFoundException);
        await expect(guard.canActivate(ctx({ params: { orgId: 'org-1' } }))).rejects.toBeInstanceOf(
            NotFoundException,
        );
        expect(organizations.findById).not.toHaveBeenCalled();
    });

    it('skips non-HTTP contexts', async () => {
        const { resolver } = makeResolver();
        await expect(new SharedViewOwnerGuard(resolver).canActivate(ctx({}, 'rpc'))).resolves.toBe(
            true,
        );
    });
});
