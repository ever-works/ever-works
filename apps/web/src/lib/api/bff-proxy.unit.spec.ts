import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { API_SCOPE_HEADER, BROWSER_WORKSPACE_SCOPE_HEADER } from '../workspace-scope';

const getAuthAccessCookie = vi.fn<() => Promise<string | undefined>>();
vi.mock('@/lib/auth/cookies', () => ({
    getAuthAccessCookie: () => getAuthAccessCookie(),
}));

const { bffProxy } = await import('./bff-proxy');
type ScopedBffRequest = import('./bff-proxy').ScopedBffRequest;

const PUBLIC_ORIGIN = 'https://app.example';

/** Typed so `handler.mock.calls[0]` keeps its argument types. */
const makeHandler = () =>
    vi.fn<(scoped: ScopedBffRequest, context: unknown) => Promise<Response>>(async () =>
        NextResponse.json({ ok: true }),
    );

/**
 * Built the way a real Next server sees a request: the request URL is the
 * SERVER's own address, which is never the browser's. See bff-scope.unit.spec.ts
 * — an earlier guard compared the two and rejected every real call.
 */
function req(selector?: string): NextRequest {
    const headers = new Headers();
    if (selector !== undefined) headers.set(BROWSER_WORKSPACE_SCOPE_HEADER, selector);
    return new NextRequest(new Request('http://0.0.0.0:3000/api/thing', { headers }));
}

describe('bffProxy', () => {
    const previous = process.env.NEXT_PUBLIC_WEB_URL;

    beforeEach(() => {
        process.env.NEXT_PUBLIC_WEB_URL = PUBLIC_ORIGIN;
        getAuthAccessCookie.mockResolvedValue('fake-jwt');
    });

    afterEach(() => {
        if (previous === undefined) delete process.env.NEXT_PUBLIC_WEB_URL;
        else process.env.NEXT_PUBLIC_WEB_URL = previous;
        vi.clearAllMocks();
    });

    it('forwards the workspace scope without the route asking — the whole point', async () => {
        const handler = makeHandler();
        const route = bffProxy(handler);

        await route(req('org:ever'), undefined);

        const { headers } = handler.mock.calls[0][0];
        expect(headers.get(API_SCOPE_HEADER)).toBe('ever');
        expect(headers.get('authorization')).toBe('Bearer fake-jwt');
        // The browser-facing selector must never reach the platform.
        expect(headers.get(BROWSER_WORKSPACE_SCOPE_HEADER)).toBeNull();
    });

    it('fails closed with 400 when the selector is missing, and never runs the handler', async () => {
        const handler = makeHandler();

        const res = await bffProxy(handler)(req(), undefined);

        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toEqual({ error: 'Invalid workspace scope' });
        expect(handler).not.toHaveBeenCalled();
    });

    it('fails closed on a malformed selector too', async () => {
        const handler = makeHandler();

        const res = await bffProxy(handler)(req('org:Not A Slug'), undefined);

        expect(res.status).toBe(400);
        expect(handler).not.toHaveBeenCalled();
    });

    it('refuses an unauthenticated request before touching the scope', async () => {
        getAuthAccessCookie.mockResolvedValue(undefined);
        const handler = makeHandler();

        // No selector either — auth must be decided first, so this is 401 not 400.
        const res = await bffProxy(handler)(req(), undefined);

        expect(res.status).toBe(401);
        expect(handler).not.toHaveBeenCalled();
    });

    it('lets a route soften the unauthenticated response without losing the scope default', async () => {
        getAuthAccessCookie.mockResolvedValue(undefined);
        const handler = makeHandler();

        const res = await bffProxy(handler, {
            onUnauthorized: () => NextResponse.json([], { status: 200 }),
        })(req('org:ever'), undefined);

        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toEqual([]);
    });

    it('passes the route context (params) straight through', async () => {
        const handler = makeHandler();
        const context = { params: Promise.resolve({ id: 'work-1' }) };

        await bffProxy<typeof context>(handler)(req('personal'), context);

        expect(handler.mock.calls[0][1]).toBe(context);
        expect(handler.mock.calls[0][0].headers.get(API_SCOPE_HEADER)).toBe('@personal');
    });

    describe('the opt-out', () => {
        it('forwards no scope header when a route declares scope: none', async () => {
            const handler = makeHandler();

            await bffProxy(handler, {
                scope: 'none',
                reason: 'Global catalogue; the handler ignores the Organization.',
            })(req(), undefined);

            const { headers } = handler.mock.calls[0][0];
            expect(headers.get(API_SCOPE_HEADER)).toBeNull();
            expect(headers.get('authorization')).toBe('Bearer fake-jwt');
        });

        it('refuses to build an unexplained opt-out, at module load', () => {
            // A silent exemption is indistinguishable from an oversight, which is
            // exactly how the defects this wrapper exists to prevent survived
            // review. Make it impossible to add one without saying why.
            expect(() => bffProxy(async () => NextResponse.json({}), { scope: 'none' })).toThrow(
                /requires a `reason`/,
            );
            expect(() =>
                bffProxy(async () => NextResponse.json({}), { scope: 'none', reason: '   ' }),
            ).toThrow(/requires a `reason`/);
        });
    });
});
