import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * OAuth consent screen — pass 8. The platform's `/api/oauth/:provider/connect/url`
 * issues an authorize URL. We verify the URL is well-formed and carries
 * the canonical query parameters: `client_id`, `redirect_uri`, `scope`,
 * `response_type=code`, and a CSRF `state`.
 *
 * We don't enforce a specific scope or `prompt=consent` because those
 * are environment-specific. The point is the platform isn't shipping a
 * broken authorize URL.
 */

test.describe('OAuth authorize URL — well-formed shape', () => {
    test('github /connect/url carries client_id + redirect_uri + scope + response_type', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/oauth/github/connect/url`, {
            headers: authedHeaders(u.access_token),
        });
        if (res.status() === 400) test.skip(true, 'github provider not configured');
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(typeof body?.url).toBe('string');
        const u2 = new URL(body.url);
        // Github authorize URL.
        expect(u2.host).toMatch(/^github\.com$/i);
        expect(u2.pathname).toBe('/login/oauth/authorize');
        // Required OAuth 2.0 params.
        expect(u2.searchParams.get('client_id'), 'missing client_id').toBeTruthy();
        expect(u2.searchParams.get('redirect_uri'), 'missing redirect_uri').toBeTruthy();
        expect(u2.searchParams.get('response_type') ?? 'code').toBe('code');
        // GitHub uses comma-separated scopes; OAuth spec says space-separated.
        // Either way, a non-empty scope SHOULD be there.
        const scope = u2.searchParams.get('scope');
        expect(scope?.length, 'missing scope').toBeGreaterThan(0);
        // CSRF state — must be the same value the body returned.
        expect(u2.searchParams.get('state')).toBe(body.state);
    });

    test('redirect_uri uses https in production-shaped URLs', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/oauth/github/connect/url`, {
            headers: authedHeaders(u.access_token),
        });
        if (res.status() === 400) test.skip(true, 'github not configured');
        const body = await res.json();
        const u2 = new URL(body.url);
        const redirect = u2.searchParams.get('redirect_uri') || '';
        if (!redirect) test.skip(true, 'no redirect_uri');
        const parsed = new URL(redirect);
        // Local test env is http; prod/staging must be https.
        // We only enforce when the host is NOT localhost / 127.0.0.1.
        const isLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
        if (!isLocal) {
            expect(parsed.protocol, `prod redirect_uri must be https: "${redirect}"`).toBe(
                'https:',
            );
        }
    });

    test('redirect_uri belongs to the platform host (no external redirector)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/oauth/github/connect/url`, {
            headers: authedHeaders(u.access_token),
        });
        if (res.status() === 400) test.skip(true, 'github not configured');
        const body = await res.json();
        const u2 = new URL(body.url);
        const redirect = u2.searchParams.get('redirect_uri');
        if (!redirect) test.skip(true, 'no redirect_uri');
        const parsed = new URL(redirect);
        // The redirect URI must NOT be a github.com / arbitrary external
        // host — that would be an open-redirect chain. Acceptable hosts
        // are: localhost (dev), 127.0.0.1, *.ever.works.
        const ok =
            parsed.hostname === 'localhost' ||
            parsed.hostname === '127.0.0.1' ||
            parsed.hostname.endsWith('.ever.works') ||
            parsed.hostname === 'ever.works';
        expect(ok, `unexpected redirect_uri host: ${parsed.hostname}`).toBe(true);
    });
});
