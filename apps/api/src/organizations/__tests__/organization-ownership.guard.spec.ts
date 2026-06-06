// Mock the agent database + entities barrels so importing the guard (which
// pulls in OrganizationMembershipService) doesn't drag in the full TypeORM
// DataSource graph. Same pattern as organization-membership.service.spec.ts.
jest.mock('@ever-works/agent/database', () => ({}));
jest.mock('@ever-works/agent/entities', () => ({}));

import { NotFoundException, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { OrganizationOwnershipGuard } from '../guards/organization-ownership.guard';

/**
 * Unit tests for the fail-closed object-level guard (EW-711 / audit C2).
 * Contract under test:
 *   - delegates to OrganizationMembershipService.ensureMember / ensureAdmin
 *     (so it inherits the 404-not-403 existence-leak contract);
 *   - `@OrgAdmin()` metadata routes to the write-side `ensureAdmin` seam;
 *   - resolves `orgId` from the path param or the `?orgId` query param;
 *   - fails CLOSED (404, no service call) on a missing orgId or user;
 *   - skips non-HTTP contexts.
 */
describe('OrganizationOwnershipGuard', () => {
    type Req = {
        params?: Record<string, string>;
        query?: Record<string, unknown>;
        user?: { userId?: string };
    };

    function makeCtx(req: Req, type: 'http' | 'rpc' = 'http'): ExecutionContext {
        return {
            getType: () => type,
            switchToHttp: () => ({ getRequest: () => req }),
            getHandler: () => function handler() {},
            getClass: () => class Ctrl {},
        } as unknown as ExecutionContext;
    }

    function makeGuard(opts: {
        admin?: boolean;
        ensureMember?: jest.Mock;
        ensureAdmin?: jest.Mock;
    }) {
        const ensureMember = opts.ensureMember ?? jest.fn().mockResolvedValue({ id: 'o-1' });
        const ensureAdmin = opts.ensureAdmin ?? jest.fn().mockResolvedValue({ id: 'o-1' });
        const membership = { ensureMember, ensureAdmin };
        const reflector = {
            getAllAndOverride: jest.fn().mockReturnValue(opts.admin),
        } as unknown as Reflector;
        const guard = new OrganizationOwnershipGuard(membership as never, reflector);
        return { guard, ensureMember, ensureAdmin };
    }

    it('authorizes a member route via ensureMember(orgId, userId)', async () => {
        const { guard, ensureMember, ensureAdmin } = makeGuard({ admin: false });
        const ctx = makeCtx({ params: { orgId: 'o-1' }, user: { userId: 'u-1' } });
        await expect(guard.canActivate(ctx)).resolves.toBe(true);
        expect(ensureMember).toHaveBeenCalledWith('o-1', 'u-1');
        expect(ensureAdmin).not.toHaveBeenCalled();
    });

    it('routes @OrgAdmin writes to ensureAdmin(orgId, userId)', async () => {
        const { guard, ensureMember, ensureAdmin } = makeGuard({ admin: true });
        const ctx = makeCtx({ params: { orgId: 'o-1' }, user: { userId: 'u-1' } });
        await expect(guard.canActivate(ctx)).resolves.toBe(true);
        expect(ensureAdmin).toHaveBeenCalledWith('o-1', 'u-1');
        expect(ensureMember).not.toHaveBeenCalled();
    });

    it('resolves orgId from the ?orgId query param when no path param is present', async () => {
        const { guard, ensureMember } = makeGuard({});
        const ctx = makeCtx({ query: { orgId: 'o-q' }, user: { userId: 'u-1' } });
        await expect(guard.canActivate(ctx)).resolves.toBe(true);
        expect(ensureMember).toHaveBeenCalledWith('o-q', 'u-1');
    });

    it('fails closed (404) when orgId is missing — without calling the service', async () => {
        const { guard, ensureMember, ensureAdmin } = makeGuard({});
        const ctx = makeCtx({ user: { userId: 'u-1' } });
        await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(NotFoundException);
        expect(ensureMember).not.toHaveBeenCalled();
        expect(ensureAdmin).not.toHaveBeenCalled();
    });

    it('fails closed (404) when there is no authenticated user', async () => {
        const { guard, ensureMember } = makeGuard({});
        const ctx = makeCtx({ params: { orgId: 'o-1' } });
        await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(NotFoundException);
        expect(ensureMember).not.toHaveBeenCalled();
    });

    it('propagates the service 404 on cross-tenant access (no existence leak)', async () => {
        const ensureMember = jest
            .fn()
            .mockRejectedValue(new NotFoundException('Organization victim not found'));
        const { guard } = makeGuard({ admin: false, ensureMember });
        const ctx = makeCtx({ params: { orgId: 'victim' }, user: { userId: 'attacker' } });
        await expect(guard.canActivate(ctx)).rejects.toMatchObject({
            message: 'Organization victim not found',
        });
    });

    it('skips non-HTTP execution contexts', async () => {
        const { guard, ensureMember } = makeGuard({});
        const ctx = makeCtx({}, 'rpc');
        await expect(guard.canActivate(ctx)).resolves.toBe(true);
        expect(ensureMember).not.toHaveBeenCalled();
    });
});
