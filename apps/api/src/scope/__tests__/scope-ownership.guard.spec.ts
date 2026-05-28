jest.mock('@ever-works/agent/database', () => ({}));
jest.mock('@ever-works/agent/entities', () => ({}));

import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { ScopeContextService } from '../scope-context.service';
import { ScopeOwnershipGuard } from '../scope-ownership.guard';

/**
 * Helper: build a minimal ExecutionContext that the guard reads from.
 * `getType()` returns 'http'; `switchToHttp().getRequest()` returns the
 * `request` object we pass in.
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

describe('ScopeOwnershipGuard (EW-659 Phase 7)', () => {
    let scopeContext: ScopeContextService;
    let guard: ScopeOwnershipGuard;

    beforeEach(() => {
        scopeContext = new ScopeContextService();
        guard = new ScopeOwnershipGuard(scopeContext);
    });

    it('allows non-HTTP execution contexts (RPC, WS, etc.)', () => {
        const nonHttp = { getType: () => 'rpc' } as unknown as ExecutionContext;
        expect(guard.canActivate(nonHttp)).toBe(true);
    });

    it('allows when scope is EMPTY (no slug was provided)', () => {
        const ctx = makeContext({ user: { userId: 'u-1', tenantId: 't-1' } });
        // ScopeContext.getScope() returns EMPTY by default outside runWith.
        expect(guard.canActivate(ctx)).toBe(true);
    });

    it('allows when request has no user (public route + resolved scope)', () => {
        const ctx = makeContext({});
        scopeContext.runWith({ tenantId: 't-1', organizationId: 'o-1' }, () => {
            expect(guard.canActivate(ctx)).toBe(true);
        });
    });

    it('allows when user.tenantId matches the resolved scope', () => {
        const ctx = makeContext({ user: { userId: 'u-1', tenantId: 't-1' } });
        scopeContext.runWith({ tenantId: 't-1', organizationId: 'o-1' }, () => {
            expect(guard.canActivate(ctx)).toBe(true);
        });
    });

    it('rejects (403) when user.tenantId is null but scope was resolved', () => {
        const ctx = makeContext({ user: { userId: 'u-1', tenantId: null } });
        scopeContext.runWith({ tenantId: 't-elsewhere', organizationId: 'o-x' }, () => {
            expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
        });
    });

    it('rejects (403) when user.tenantId differs from the resolved scope', () => {
        const ctx = makeContext({ user: { userId: 'u-1', tenantId: 't-mine' } });
        scopeContext.runWith({ tenantId: 't-other', organizationId: 'o-other' }, () => {
            expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
        });
    });

    it('allows the bare-Tenant scope (User slug resolution; organizationId is null)', () => {
        const ctx = makeContext({ user: { userId: 'u-1', tenantId: 't-1' } });
        scopeContext.runWith({ tenantId: 't-1', organizationId: null }, () => {
            expect(guard.canActivate(ctx)).toBe(true);
        });
    });
});
