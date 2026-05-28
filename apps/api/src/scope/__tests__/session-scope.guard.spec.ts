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

    it('returns true and makes no DB call when a scope is already set', async () => {
        const ctx = makeContext({ user: { userId: 'u-1' } });
        const result = await scopeContext.runWith(
            { tenantId: 't-resolved', organizationId: 'o-resolved' },
            async () => {
                const allowed = await guard.canActivate(ctx);
                return { allowed, observed: scopeContext.getScope() };
            },
        );
        expect(result.allowed).toBe(true);
        expect(findById).not.toHaveBeenCalled();
        // Scope untouched.
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

    it('does NOT seed (stays EMPTY) when the user has a null tenantId', async () => {
        findById.mockResolvedValue({ tenantId: null, lastScopeOrganizationId: null });
        const ctx = makeContext({ user: { userId: 'u-1' } });

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
    });
});
