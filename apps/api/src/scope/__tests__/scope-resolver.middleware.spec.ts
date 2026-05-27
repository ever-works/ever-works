// Mock the agent database barrel to avoid pulling in the full TypeORM
// DataSource graph. Same pattern as the other scope/* tests.
jest.mock('@ever-works/agent/database', () => ({}));
jest.mock('@ever-works/agent/entities', () => ({}));

import { NotFoundException } from '@nestjs/common';
import { ScopeContextService } from '../scope-context.service';
import { ScopeResolverMiddleware } from '../scope-resolver.middleware';

// Loose-shape mocks for the minimal Express interface the middleware
// actually consumes — matches the `MiddlewareRequest` / `NextFn` types
// inside the middleware itself.
type FakeRequest = {
    params: Record<string, string | undefined>;
    headers: Record<string, string | string[] | undefined>;
};
type NextFunction = (err?: unknown) => void;

describe('ScopeResolverMiddleware (EW-659 Phase 7)', () => {
    let scopeContext: ScopeContextService;
    let userRepository: { findBySlug: jest.Mock };
    let organizationRepository: { findBySlug: jest.Mock };
    let middleware: ScopeResolverMiddleware;

    beforeEach(() => {
        scopeContext = new ScopeContextService();
        userRepository = { findBySlug: jest.fn().mockResolvedValue(null) };
        organizationRepository = { findBySlug: jest.fn().mockResolvedValue(null) };
        middleware = new ScopeResolverMiddleware(
            scopeContext,
            userRepository as never,
            organizationRepository as never,
        );
    });

    /**
     * Helper: drive the middleware once and capture the scope visible
     * to the `next()` callback (which is what the controller will see).
     */
    async function runWithCapture(
        req: Partial<FakeRequest>,
    ): Promise<{ scope: ReturnType<ScopeContextService['getScope']>; nextCalled: boolean }> {
        let captured = scopeContext.getScope();
        let nextCalled = false;
        const next: NextFunction = () => {
            captured = scopeContext.getScope();
            nextCalled = true;
        };
        await middleware.use(req as FakeRequest, {}, next);
        return { scope: captured, nextCalled };
    }

    describe('empty / missing slug', () => {
        it('passes through with EMPTY_SCOPE when no slug param or header', async () => {
            const { scope, nextCalled } = await runWithCapture({
                params: {},
                headers: {},
            });

            expect(nextCalled).toBe(true);
            expect(scope).toEqual({ tenantId: null, organizationId: null });
            expect(organizationRepository.findBySlug).not.toHaveBeenCalled();
            expect(userRepository.findBySlug).not.toHaveBeenCalled();
        });

        it('treats whitespace-only slug as missing (EMPTY_SCOPE pass-through)', async () => {
            const { scope, nextCalled } = await runWithCapture({
                params: { slug: '   ' },
                headers: { 'x-scope-slug': '\t' },
            });

            expect(nextCalled).toBe(true);
            expect(scope).toEqual({ tenantId: null, organizationId: null });
            expect(organizationRepository.findBySlug).not.toHaveBeenCalled();
        });
    });

    describe('Organization slug', () => {
        it('resolves :slug param to { tenantId, organizationId } for an Org hit', async () => {
            organizationRepository.findBySlug.mockResolvedValueOnce({
                id: 'o-1',
                tenantId: 't-1',
                slug: 'acme',
            });

            const { scope, nextCalled } = await runWithCapture({
                params: { slug: 'acme' },
                headers: {},
            });

            expect(nextCalled).toBe(true);
            expect(scope).toEqual({ tenantId: 't-1', organizationId: 'o-1' });
            expect(organizationRepository.findBySlug).toHaveBeenCalledWith('acme');
            // Short-circuited: User lookup is never reached on Org hit.
            expect(userRepository.findBySlug).not.toHaveBeenCalled();
        });

        it('resolves X-Scope-Slug header when no URL :slug present', async () => {
            organizationRepository.findBySlug.mockResolvedValueOnce({
                id: 'o-2',
                tenantId: 't-2',
                slug: 'evilcorp',
            });

            const { scope } = await runWithCapture({
                params: {},
                headers: { 'x-scope-slug': 'evilcorp' },
            });

            expect(scope).toEqual({ tenantId: 't-2', organizationId: 'o-2' });
        });

        it('handles array-valued X-Scope-Slug from upstream proxies (Greptile P2)', async () => {
            organizationRepository.findBySlug.mockResolvedValueOnce({
                id: 'o-3',
                tenantId: 't-3',
                slug: 'acme',
            });

            const { scope } = await runWithCapture({
                params: {},
                headers: { 'x-scope-slug': ['acme', 'evilcorp'] },
            });

            // First non-empty entry wins; silently dropping the
            // array would let an attacker bypass scope resolution by
            // sending two values.
            expect(organizationRepository.findBySlug).toHaveBeenCalledWith('acme');
            expect(scope).toEqual({ tenantId: 't-3', organizationId: 'o-3' });
        });

        it('URL :slug param takes precedence over X-Scope-Slug header', async () => {
            organizationRepository.findBySlug.mockResolvedValueOnce({
                id: 'o-from-param',
                tenantId: 't-from-param',
                slug: 'acme',
            });

            const { scope } = await runWithCapture({
                params: { slug: 'acme' },
                headers: { 'x-scope-slug': 'evilcorp' },
            });

            expect(organizationRepository.findBySlug).toHaveBeenCalledWith('acme');
            expect(scope.organizationId).toBe('o-from-param');
        });
    });

    describe('User slug (bare-Tenant)', () => {
        it('falls back to UserRepository.findBySlug when Org lookup misses', async () => {
            // Org miss; User hit with a Tenant.
            userRepository.findBySlug.mockResolvedValueOnce({
                id: 'u-1',
                slug: 'alice',
                tenantId: 't-alice',
            });

            const { scope } = await runWithCapture({
                params: { slug: 'alice' },
                headers: {},
            });

            expect(scope).toEqual({ tenantId: 't-alice', organizationId: null });
        });

        it('returns tenantId=null on User hit who has no Tenant yet (effectively EMPTY)', async () => {
            userRepository.findBySlug.mockResolvedValueOnce({
                id: 'u-2',
                slug: 'bob',
                tenantId: null,
            });

            const { scope } = await runWithCapture({
                params: { slug: 'bob' },
                headers: {},
            });

            expect(scope).toEqual({ tenantId: null, organizationId: null });
        });
    });

    describe('404', () => {
        it('throws NotFoundException when neither Org nor User matches the slug', async () => {
            // Both lookups already return null via the beforeEach default.
            await expect(
                middleware.use(
                    { params: { slug: 'nobody' }, headers: {} } as FakeRequest,
                    {},
                    (() => {}) as NextFunction,
                ),
            ).rejects.toBeInstanceOf(NotFoundException);
            expect(organizationRepository.findBySlug).toHaveBeenCalledWith('nobody');
            expect(userRepository.findBySlug).toHaveBeenCalledWith('nobody');
        });
    });

    describe('scope isolation across async next()', () => {
        it('propagates scope through awaited work inside next()', async () => {
            organizationRepository.findBySlug.mockResolvedValueOnce({
                id: 'o-1',
                tenantId: 't-1',
                slug: 'acme',
            });

            let observed: ReturnType<ScopeContextService['getScope']> | null = null;
            const next: NextFunction = async () => {
                await new Promise((resolve) => setImmediate(resolve));
                observed = scopeContext.getScope();
            };

            await middleware.use(
                { params: { slug: 'acme' }, headers: {} } as FakeRequest,
                {},
                next,
            );
            // The middleware doesn't await next(), so the assertion has to
            // wait one tick for the async next() body to settle.
            await new Promise((resolve) => setImmediate(resolve));

            expect(observed).toEqual({ tenantId: 't-1', organizationId: 'o-1' });
        });

        it('outside the runWith boundary, scope reverts to EMPTY_SCOPE', async () => {
            organizationRepository.findBySlug.mockResolvedValueOnce({
                id: 'o-1',
                tenantId: 't-1',
                slug: 'acme',
            });

            await middleware.use(
                { params: { slug: 'acme' }, headers: {} } as FakeRequest,
                {},
                (() => {}) as NextFunction,
            );
            // Once next() returned, we're back outside the ALS frame.
            expect(scopeContext.getScope()).toEqual({ tenantId: null, organizationId: null });
        });
    });
});
