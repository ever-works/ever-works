jest.mock('@ever-works/agent/database', () => ({}));
jest.mock('@ever-works/agent/entities', () => ({}));

import { ExecutionContext, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ScopeContextService } from '../scope-context.service';
import { SessionScopeGuard } from '../session-scope.guard';

/**
 * Helper: build a minimal ExecutionContext that the guard reads from.
 * `getType()` returns 'http' by default; `switchToHttp().getRequest()`
 * returns the `request` object we pass in.
 */
function makeContext(request: {
    user?: unknown;
    headers?: Record<string, string | string[] | undefined>;
    fleetRunCredential?: unknown;
}): ExecutionContext {
    return {
        getType: () => 'http',
        switchToHttp: () => ({
            getRequest: <T = unknown>(): T => request as T,
            getResponse: <T = unknown>(): T => ({}) as T,
            getNext: <T = unknown>(): T => ({}) as T,
        }),
    } as unknown as ExecutionContext;
}

function makeGuard(
    scopeContext: ScopeContextService,
    userRepository: ConstructorParameters<typeof SessionScopeGuard>[1],
): SessionScopeGuard {
    const tenantForOrganization = (organizationId: string): string => {
        if (organizationId === 'o-mine') return 't-mine';
        if (organizationId === 'o-other') return 't-other';
        if (organizationId === 'o-resolved') return 't-resolved';
        return 't-1';
    };
    return new SessionScopeGuard(scopeContext, userRepository, {
        findById: jest.fn(async (organizationId: string) => ({
            id: organizationId,
            tenantId: tenantForOrganization(organizationId),
        })),
    } as never);
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
        guard = makeGuard(scopeContext, userRepository);
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

    it('treats a headerless unprefixed request as personal and never reads the mutable pointer', async () => {
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
        expect(observed).toEqual({ tenantId: 't-1', organizationId: null });
    });

    it('keeps explicit @personal personal even when another tab persisted an Organization', async () => {
        findById.mockResolvedValue({ tenantId: 't-1', lastScopeOrganizationId: 'o-yo' });
        const ctx = makeContext({
            user: { userId: 'u-1' },
            headers: { 'x-scope-slug': '@personal' },
        });

        const observed = await scopeContext.runWith(
            { tenantId: null, organizationId: null },
            async () => {
                await guard.canActivate(ctx);
                return scopeContext.getScope();
            },
        );

        expect(observed).toEqual({ tenantId: 't-1', organizationId: null });
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

    it('allows an invited Tenant member to use every Organization returned by the tenant-wide list', async () => {
        findById.mockResolvedValue({
            tenantId: 't-1',
            lastScopeOrganizationId: 'o-yo',
        });
        const organizationRepository = {
            findById: jest.fn().mockResolvedValue({ id: 'o-ever', tenantId: 't-1' }),
        };
        // The invitation was nominally for Yo. The roster is audit metadata;
        // users.tenantId grants access to every Organization listed in t-1.
        const membershipGuard = new SessionScopeGuard(
            scopeContext,
            { findById } as never,
            organizationRepository as never,
        );
        const ctx = makeContext({ user: { userId: 'u-1' } });

        await expect(
            scopeContext.runWith({ tenantId: 't-1', organizationId: 'o-ever' }, () =>
                membershipGuard.canActivate(ctx),
            ),
        ).resolves.toBe(true);
    });

    it('returns the opaque 404 when the Organization no longer exists', async () => {
        findById.mockResolvedValue({ tenantId: 't-1', lastScopeOrganizationId: 'o-yo' });
        const membershipGuard = new SessionScopeGuard(
            scopeContext,
            { findById } as never,
            { findById: jest.fn().mockResolvedValue(null) } as never,
        );
        const ctx = makeContext({ user: { userId: 'u-1' } });

        await expect(
            scopeContext.runWith({ tenantId: 't-1', organizationId: 'o-ever' }, () =>
                membershipGuard.canActivate(ctx),
            ),
        ).rejects.toMatchObject({
            constructor: NotFoundException,
            message: 'Organization not found',
        });
    });

    it('a revoked last-active membership never affects a headerless request: personal scope, no roster lookup', async () => {
        findById.mockResolvedValue({
            tenantId: 't-1',
            lastScopeOrganizationId: 'o-ever',
        });
        const organizationRepository = {
            findById: jest.fn().mockResolvedValue({ id: 'o-ever', tenantId: 't-1' }),
        };
        const organizationMembers = { findByOrgAndUser: jest.fn().mockResolvedValue(null) };
        const membershipGuard = new SessionScopeGuard(
            scopeContext,
            { findById } as never,
            organizationRepository as never,
        );
        const ctx = makeContext({ user: { userId: 'u-1' } });

        const observed = await scopeContext.runWith(
            { tenantId: null, organizationId: null },
            async () => {
                await membershipGuard.canActivate(ctx);
                return scopeContext.getScope();
            },
        );

        // The mutable pointer is a fresh-login navigation default only; it is
        // never read as request authority, so revocation cannot lock the user
        // out of their own personal scope and no Organization lookup happens.
        expect(observed).toEqual({ tenantId: 't-1', organizationId: null });
        expect(organizationRepository.findById).not.toHaveBeenCalled();
        expect(organizationMembers.findByOrgAndUser).not.toHaveBeenCalled();
    });

    it('keeps Tenant-owner access even though owners intentionally have no roster row', async () => {
        findById.mockResolvedValue({ tenantId: 't-1', lastScopeOrganizationId: 'o-ever' });
        const membershipGuard = new SessionScopeGuard(
            scopeContext,
            { findById } as never,
            { findById: jest.fn().mockResolvedValue({ id: 'o-ever', tenantId: 't-1' }) } as never,
        );
        const ctx = makeContext({ user: { userId: 'u-1' } });

        await expect(
            scopeContext.runWith({ tenantId: 't-1', organizationId: 'o-ever' }, () =>
                membershipGuard.canActivate(ctx),
            ),
        ).resolves.toBe(true);
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

    it('personal route: session guard seeds bare scope + hydrates user, ownership guard then allows', async () => {
        const scopeContext = new ScopeContextService();
        const findById = jest
            .fn()
            .mockResolvedValue({ tenantId: 't-1', lastScopeOrganizationId: 'o-1' });
        const sessionGuard = makeGuard(scopeContext, { findById } as never);
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
        expect(observed).toEqual({ tenantId: 't-1', organizationId: null });
    });

    it('slug route to OWN tenant: ownership guard allows after hydration', async () => {
        const scopeContext = new ScopeContextService();
        const findById = jest
            .fn()
            .mockResolvedValue({ tenantId: 't-mine', lastScopeOrganizationId: null });
        const sessionGuard = makeGuard(scopeContext, { findById } as never);
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
        const sessionGuard = makeGuard(scopeContext, { findById } as never);
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

/**
 * Self-build slice Z (EW-796) — a fleet-run credential pins the scope.
 *
 * The token carries the Organization the PLATFORM chose when it minted
 * it, taken from the job row. That is authorization, not a preference,
 * so it has to beat anything the caller can influence:
 *
 *   - a resolved slug pointing somewhere else is a 403, never a silent
 *     widening or a silent narrowing;
 *   - no slug at all does NOT fall back to personal scope — it seeds the
 *     bound Organization, so the MCP server does not have to send
 *     `x-scope-slug` at all for the tools to act in the right place;
 *   - a token bound to personal scope refuses an Organization slug.
 *
 * The Organization is still authorized the ordinary way
 * (`requireActiveOrganization`), so a token whose Organization has been
 * deleted or moved tenants gets the same opaque 404 as anyone else.
 */
describe('SessionScopeGuard — fleet-run credential (slice Z)', () => {
    let scopeContext: ScopeContextService;
    let findById: jest.Mock;
    let guard: SessionScopeGuard;

    const runCredential = {
        jobId: 'job-1',
        nodeId: 'node-1',
        runId: 'run-1',
        organizationId: 'o-mine',
    };

    beforeEach(() => {
        scopeContext = new ScopeContextService();
        findById = jest
            .fn()
            .mockResolvedValue({ tenantId: 't-mine', lastScopeOrganizationId: null });
        guard = makeGuard(scopeContext, { findById } as never);
    });

    it('seeds the bound Organization when no slug resolved a scope', async () => {
        const ctx = makeContext({ user: { userId: 'u-1' }, fleetRunCredential: runCredential });

        await scopeContext.runWith({ tenantId: null, organizationId: null }, async () => {
            await expect(guard.canActivate(ctx)).resolves.toBe(true);
            expect(scopeContext.getScope()).toEqual({
                tenantId: 't-mine',
                organizationId: 'o-mine',
            });
        });
    });

    it('accepts a slug that resolved the SAME Organization', async () => {
        const ctx = makeContext({ user: { userId: 'u-1' }, fleetRunCredential: runCredential });

        await scopeContext.runWith({ tenantId: 't-mine', organizationId: 'o-mine' }, async () => {
            await expect(guard.canActivate(ctx)).resolves.toBe(true);
            expect(scopeContext.getScope()).toEqual({
                tenantId: 't-mine',
                organizationId: 'o-mine',
            });
        });
    });

    it('REFUSES a slug that resolved a different Organization', async () => {
        const ctx = makeContext({ user: { userId: 'u-1' }, fleetRunCredential: runCredential });

        await scopeContext.runWith({ tenantId: 't-other', organizationId: 'o-other' }, async () => {
            await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
        });
    });

    it('refuses an Organization slug for a token bound to PERSONAL scope', async () => {
        const ctx = makeContext({
            user: { userId: 'u-1' },
            fleetRunCredential: { ...runCredential, organizationId: null },
        });

        await scopeContext.runWith({ tenantId: 't-mine', organizationId: 'o-mine' }, async () => {
            await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
        });
    });

    it('a personal-scope token with no slug behaves exactly like an unprefixed request', async () => {
        const ctx = makeContext({
            user: { userId: 'u-1' },
            fleetRunCredential: { ...runCredential, organizationId: null },
        });

        await scopeContext.runWith({ tenantId: null, organizationId: null }, async () => {
            await expect(guard.canActivate(ctx)).resolves.toBe(true);
            expect(scopeContext.getScope()).toEqual({ tenantId: 't-mine', organizationId: null });
        });
    });

    it('refuses an Organization-pinned token whose owner has no Tenant', async () => {
        findById.mockResolvedValue({ tenantId: null, lastScopeOrganizationId: null });
        const ctx = makeContext({ user: { userId: 'u-1' }, fleetRunCredential: runCredential });

        await scopeContext.runWith({ tenantId: null, organizationId: null }, async () => {
            await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
        });
    });

    it('still authorizes the bound Organization the ordinary way', async () => {
        // A token whose Organization belongs to somebody else's Tenant is
        // the same opaque 404 every other caller gets — the token pins the
        // scope, it does not exempt it from authorization.
        const ctx = makeContext({
            user: { userId: 'u-1' },
            fleetRunCredential: { ...runCredential, organizationId: 'o-other' },
        });

        await scopeContext.runWith({ tenantId: null, organizationId: null }, async () => {
            await expect(guard.canActivate(ctx)).rejects.toThrow(NotFoundException);
        });
    });

    it('changes nothing for a request with no run credential', async () => {
        const ctx = makeContext({ user: { userId: 'u-1' } });

        await scopeContext.runWith({ tenantId: null, organizationId: null }, async () => {
            await expect(guard.canActivate(ctx)).resolves.toBe(true);
            expect(scopeContext.getScope()).toEqual({ tenantId: 't-mine', organizationId: null });
        });
    });
});
