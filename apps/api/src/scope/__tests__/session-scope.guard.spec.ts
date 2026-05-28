jest.mock('@ever-works/agent/database', () => ({}));
jest.mock('@ever-works/agent/entities', () => ({}));

import { ExecutionContext } from '@nestjs/common';
import { ScopeContextService } from '../scope-context.service';
import { SessionScopeGuard } from '../session-scope.guard';

/**
 * Helper: build a minimal ExecutionContext that the guard reads from.
 * `getType()` returns 'http' by default; `switchToHttp().getRequest()`
 * returns the `request` object we pass in.
 */
function makeContext(request: { user?: unknown }): ExecutionContext {
    return {
        getType: () => 'http',
        switchToHttp: () => ({
            getRequest: <T = unknown>(): T => request as T,
            getResponse: <T = unknown>(): T => ({}) as T,
            getNext: <T = unknown>(): T => ({}) as T,
        }),
    } as unknown as ExecutionContext;
}

type FindByIdResult = {
    tenantId?: string | null;
    lastScopeOrganizationId?: string | null;
} | null;

describe('SessionScopeGuard (EW-664 Phase 12)', () => {
    let scopeContext: ScopeContextService;
    let findById: jest.Mock<Promise<FindByIdResult>, [string]>;
    let guard: SessionScopeGuard;

    beforeEach(() => {
        scopeContext = new ScopeContextService();
        findById = jest.fn();
        const userRepository = { findById } as unknown as ConstructorParameters<
            typeof SessionScopeGuard
        >[1];
        guard = new SessionScopeGuard(scopeContext, userRepository);
    });

    it('returns true and makes no DB call for non-HTTP contexts', async () => {
        const nonHttp = { getType: () => 'rpc' } as unknown as ExecutionContext;
        await expect(guard.canActivate(nonHttp)).resolves.toBe(true);
        expect(findById).not.toHaveBeenCalled();
    });

    it('hydrates req.user.tenantId but does NOT change an already-resolved scope', async () => {
        // Slug-prefixed route: the middleware already resolved a scope.
        // The guard must still hydrate req.user.tenantId (so the
        // ownership guard can authorize) WITHOUT touching the scope.
        findById.mockResolvedValue({ tenantId: 't-mine', lastScopeOrganizationId: 'o-x' });
        const reqUser: { userId: string; tenantId?: string | null } = { userId: 'u-1' };
        const ctx = makeContext({ user: reqUser });

        const result = await scopeContext.runWith(
            { tenantId: 't-resolved', organizationId: 'o-resolved' },
            async () => {
                const allowed = await guard.canActivate(ctx);
                return { allowed, observed: scopeContext.getScope() };
            },
        );

        expect(result.allowed).toBe(true);
        // findById IS called now (hydration happens on slug routes too).
        expect(findById).toHaveBeenCalledWith('u-1');
        // req.user.tenantId hydrated from the DB row.
        expect(reqUser.tenantId).toBe('t-mine');
        // Scope left exactly as the middleware resolved it.
        expect(result.observed).toEqual({ tenantId: 't-resolved', organizationId: 'o-resolved' });
    });

    it('returns true and makes no DB call when request has no user', async () => {
        const ctx = makeContext({});
        const result = await scopeContext.runWith({ tenantId: null, organizationId: null }, () =>
            guard.canActivate(ctx),
        );
        expect(result).toBe(true);
        expect(findById).not.toHaveBeenCalled();
    });

    it('seeds { tenantId, organizationId } for a user with both set', async () => {
        findById.mockResolvedValue({ tenantId: 't-1', lastScopeOrganizationId: 'o-1' });
        const ctx = makeContext({ user: { userId: 'u-1' } });

        const observed = await scopeContext.runWith(
            { tenantId: null, organizationId: null },
            async () => {
                await guard.canActivate(ctx);
                return scopeContext.getScope();
            },
        );

        expect(findById).toHaveBeenCalledWith('u-1');
        expect(observed).toEqual({ tenantId: 't-1', organizationId: 'o-1' });
    });

    it('seeds { tenantId, organizationId: null } when lastScopeOrganizationId is null', async () => {
        findById.mockResolvedValue({ tenantId: 't-1', lastScopeOrganizationId: null });
        const ctx = makeContext({ user: { userId: 'u-1' } });

        const observed = await scopeContext.runWith(
            { tenantId: null, organizationId: null },
            async () => {
                await guard.canActivate(ctx);
                return scopeContext.getScope();
            },
        );

        expect(observed).toEqual({ tenantId: 't-1', organizationId: null });
    });

    it('does NOT seed (stays EMPTY) when the user has a null tenantId, but still hydrates req.user', async () => {
        findById.mockResolvedValue({ tenantId: null, lastScopeOrganizationId: null });
        const reqUser: { userId: string; tenantId?: string | null } = { userId: 'u-1' };
        const ctx = makeContext({ user: reqUser });

        const result = await scopeContext.runWith(
            { tenantId: null, organizationId: null },
            async () => {
                const allowed = await guard.canActivate(ctx);
                return { allowed, observed: scopeContext.getScope() };
            },
        );

        expect(findById).toHaveBeenCalledWith('u-1');
        expect(result.allowed).toBe(true);
        expect(result.observed).toEqual({ tenantId: null, organizationId: null });
        // Hydrated to null (defined, not undefined) so the ownership
        // guard sees a concrete value.
        expect(reqUser.tenantId).toBeNull();
    });

    it('hydrates req.user.tenantId on the legacy-route seed path too', async () => {
        findById.mockResolvedValue({ tenantId: 't-1', lastScopeOrganizationId: 'o-1' });
        const reqUser: { userId: string; tenantId?: string | null } = { userId: 'u-1' };
        const ctx = makeContext({ user: reqUser });

        await scopeContext.runWith({ tenantId: null, organizationId: null }, async () => {
            await guard.canActivate(ctx);
        });

        expect(reqUser.tenantId).toBe('t-1');
    });
});

/**
 * Integration: run SessionScopeGuard THEN ScopeOwnershipGuard in the
 * same ALS frame, the way the global guard chain does. This is the
 * exact gap Codex + Greptile flagged on PR #1074 — the two guards
 * passed in isolation but 403'd together because req.user.tenantId
 * was never hydrated. (We import ScopeOwnershipGuard here to prove the
 * pipeline now authorizes correctly.)
 */
describe('SessionScopeGuard + ScopeOwnershipGuard pipeline (EW-664 regression)', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ScopeOwnershipGuard } = require('../scope-ownership.guard');

    function makeHttpContext(request: { user?: unknown }): ExecutionContext {
        return {
            getType: () => 'http',
            switchToHttp: () => ({
                getRequest: <T = unknown>(): T => request as T,
                getResponse: <T = unknown>(): T => ({}) as T,
                getNext: <T = unknown>(): T => ({}) as T,
            }),
        } as unknown as ExecutionContext;
    }

    it('legacy route: session guard seeds scope + hydrates user, ownership guard then allows', async () => {
        const scopeContext = new ScopeContextService();
        const findById = jest
            .fn()
            .mockResolvedValue({ tenantId: 't-1', lastScopeOrganizationId: 'o-1' });
        const sessionGuard = new SessionScopeGuard(scopeContext, { findById } as never);
        const ownershipGuard = new ScopeOwnershipGuard(scopeContext);

        const reqUser: { userId: string; tenantId?: string | null } = { userId: 'u-1' };
        const ctx = makeHttpContext({ user: reqUser });

        const { allowed, observed } = await scopeContext.runWith(
            { tenantId: null, organizationId: null },
            async () => {
                const a = await sessionGuard.canActivate(ctx);
                const b = ownershipGuard.canActivate(ctx);
                // Capture the scope INSIDE the runWith frame — outside it
                // the ALS store is gone and getScope() reverts to EMPTY.
                return { allowed: a && b, observed: scopeContext.getScope() };
            },
        );

        // Before the fix this threw 403 in ownershipGuard.
        expect(allowed).toBe(true);
        expect(observed).toEqual({ tenantId: 't-1', organizationId: 'o-1' });
    });

    it('slug route to OWN tenant: ownership guard allows after hydration', async () => {
        const scopeContext = new ScopeContextService();
        const findById = jest
            .fn()
            .mockResolvedValue({ tenantId: 't-mine', lastScopeOrganizationId: null });
        const sessionGuard = new SessionScopeGuard(scopeContext, { findById } as never);
        const ownershipGuard = new ScopeOwnershipGuard(scopeContext);
        const ctx = makeHttpContext({ user: { userId: 'u-1' } });

        const allowed = await scopeContext.runWith(
            { tenantId: 't-mine', organizationId: 'o-mine' },
            async () => {
                const a = await sessionGuard.canActivate(ctx);
                const b = ownershipGuard.canActivate(ctx);
                return a && b;
            },
        );

        expect(allowed).toBe(true);
    });

    it('slug route to ANOTHER tenant: ownership guard still 403s after hydration', async () => {
        const scopeContext = new ScopeContextService();
        const findById = jest
            .fn()
            .mockResolvedValue({ tenantId: 't-mine', lastScopeOrganizationId: null });
        const sessionGuard = new SessionScopeGuard(scopeContext, { findById } as never);
        const ownershipGuard = new ScopeOwnershipGuard(scopeContext);
        const ctx = makeHttpContext({ user: { userId: 'u-1' } });

        await expect(
            scopeContext.runWith({ tenantId: 't-OTHER', organizationId: 'o-other' }, async () => {
                await sessionGuard.canActivate(ctx);
                return ownershipGuard.canActivate(ctx);
            }),
        ).rejects.toThrow();
    });
});
