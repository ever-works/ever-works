import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { getAuthFromRequestMock, intlMock } = vi.hoisted(() => ({
    getAuthFromRequestMock: vi.fn(),
    intlMock: vi.fn(async (_request: unknown) => new Response(null, { status: 200 })),
}));

vi.mock('next-intl/middleware', () => ({ default: () => intlMock }));
vi.mock('./lib/auth', () => ({ getAuthFromRequest: getAuthFromRequestMock }));
// `ALLOWED_REDIRECT_URLS` is frozen into a const at module load, so stubbing the
// env var after import is a no-op — mock the module to model the deployed value.
vi.mock('./lib/constants', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./lib/constants')>()),
    ALLOWED_REDIRECT_URLS: ['app.ever.works', 'admin.ever.works'],
}));

import proxy from './proxy';

/**
 * The PRODUCTION shape of the ingress locale rewrite.
 *
 * The existing coverage in `proxy.unit.spec.ts` exercises this path with
 * `x-forwarded-host: 127.0.0.1`, which `ALLOWED_REDIRECT_URLS` allows by
 * DEFAULT. Production forwards a real public host that is only allowlisted
 * through the env var, and that is the configuration that broke:
 *
 *   - `7e1f58a44` (PR #2152) began absolutising next-intl's
 *     `x-middleware-rewrite` onto the *public* authority, port included, so
 *     Next saw a non-runtime origin, treated the rewrite as EXTERNAL and
 *     tried to PROXY it:
 *       `Failed to proxy https://app-stage.ever.works:3000/en/login`
 *       -> connect ETIMEDOUT <cloudflare-ip>:3000  -> HTTP 500
 *   - `14bd578a2` (PR #2219) dropped the bogus port, which only made the URL
 *     dialable: Next then emitted a redirect to `/en/login`, and the legacy
 *     `/<locale>/...` rule redirected straight back to `/login`
 *       -> ERR_TOO_MANY_REDIRECTS
 *   - `57d44302e` (PR #2227) pins the rewrite to the RUNTIME origin
 *     (`http://$HOSTNAME:$PORT`), which is what makes Next treat it as
 *     internal.
 *
 * Both outages are the same defect with different symptoms, so this asserts
 * the invariant that actually matters: behind ingress, on a real public host,
 * the locale rewrite must carry the runtime origin and never the public one.
 */
describe('ingress locale rewrite — production shape', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getAuthFromRequestMock.mockResolvedValue({ isAuthenticated: true, isExpired: false });
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('pins the rewrite to the runtime origin for a public forwarded host', async () => {
        vi.stubEnv('HOSTNAME', 'ever-works-web-76bbcb5d5f-h2m5m');
        vi.stubEnv('PORT', '3000');
        intlMock.mockResolvedValueOnce(
            new Response(null, {
                status: 200,
                headers: { 'x-middleware-rewrite': 'http://localhost:3000/en/login' },
            }),
        );

        const response = await proxy(
            new NextRequest('https://app.ever.works/login', {
                headers: {
                    host: 'app.ever.works',
                    'x-forwarded-host': 'app.ever.works',
                    'x-forwarded-proto': 'https',
                },
            }),
        );

        const rewrite = response.headers.get('x-middleware-rewrite');

        // The regression produced 'https://app.ever.works:3000/en/login' (500,
        // proxied to Cloudflare) and then 'https://app.ever.works/en/login'
        // (redirect loop). Both are the public authority; neither is internal.
        expect(rewrite).not.toContain('app.ever.works');
        expect(rewrite).toBe('http://ever-works-web-76bbcb5d5f-h2m5m:3000/en/login');
    });

    it('never emits a redirect for /login behind ingress', async () => {
        vi.stubEnv('HOSTNAME', 'ever-works-web-pod');
        vi.stubEnv('PORT', '3000');
        intlMock.mockResolvedValueOnce(
            new Response(null, {
                status: 200,
                headers: { 'x-middleware-rewrite': 'http://localhost:3000/en/login' },
            }),
        );

        const response = await proxy(
            new NextRequest('https://app.ever.works/login', {
                headers: {
                    host: 'app.ever.works',
                    'x-forwarded-host': 'app.ever.works',
                    'x-forwarded-proto': 'https',
                },
            }),
        );

        // ERR_TOO_MANY_REDIRECTS was `location: /login` on the /login request
        // itself. A rewrite is not a redirect: status must stay non-3xx here.
        expect(response.status).toBeLessThan(300);
        expect(response.headers.get('location')).toBeNull();
    });
});
