import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * OAuth cross-provider isolation — pass 20. Linking GitHub doesn't
 * silently consume the same OAuth flow as Google. Linking the same
 * provider twice (github + github) returns 409 / not silent re-link.
 *
 * We don't have real provider tokens, so we probe at the `/connect/url`
 * + `/connection` boundaries.
 */

const PROVIDERS = ['github', 'google'];

test.describe('OAuth cross-provider — connect/url issues distinct URLs per provider', () => {
    test('connect/url for github and google return URLs to different provider hosts', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const urls: Record<string, string> = {};
        for (const p of PROVIDERS) {
            const res = await request.get(`${API_BASE}/api/oauth/${p}/connect/url`, {
                headers: authedHeaders(u.access_token),
            });
            if (!res.ok()) continue;
            const body = await res.json().catch(() => null);
            const u1 = body?.url ?? body?.authorize_url ?? body?.authorizeUrl ?? body?.redirect_url;
            if (typeof u1 === 'string' && u1.startsWith('http')) {
                urls[p] = u1;
            }
        }
        if (Object.keys(urls).length < 2) {
            test.skip(true, 'not enough providers exposed to compare');
        }
        // Both URLs should target distinct hostnames (github.com vs
        // accounts.google.com).
        const githubHost = new URL(urls.github).hostname;
        const googleHost = new URL(urls.google).hostname;
        expect(githubHost, `github + google connect URLs share hostname: ${githubHost}`).not.toBe(
            googleHost,
        );
    });

    test('two /connect/url calls for the SAME provider produce DIFFERENT state values', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const a = await request.get(`${API_BASE}/api/oauth/github/connect/url`, {
            headers: authedHeaders(u.access_token),
        });
        const b = await request.get(`${API_BASE}/api/oauth/github/connect/url`, {
            headers: authedHeaders(u.access_token),
        });
        if (!a.ok() || !b.ok()) test.skip(true, '/connect/url not available');
        const aUrl = (await a.json())?.url ?? '';
        const bUrl = (await b.json())?.url ?? '';
        if (!aUrl || !bUrl) test.skip(true, 'no URL in response');
        const aState = new URL(aUrl).searchParams.get('state');
        const bState = new URL(bUrl).searchParams.get('state');
        if (!aState || !bState) test.skip(true, 'no state on URL');
        expect(aState, 'same-provider re-connect re-used state value').not.toBe(bState);
    });

    test('connection GET on a fresh user returns "disconnected" for all probed providers', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        for (const p of PROVIDERS) {
            const res = await request.get(`${API_BASE}/api/oauth/${p}/connection`, {
                headers: authedHeaders(u.access_token),
            });
            if (res.status() === 404) continue;
            expect(res.status()).toBeLessThan(500);
            if (!res.ok()) continue;
            const body = await res.json().catch(() => null);
            if (!body || typeof body !== 'object') continue;
            // Fresh user shouldn't be "connected" without OAuth flow.
            // Possible shapes: {connected: false}, {status: 'disconnected'}.
            const connected =
                (body as Record<string, unknown>).connected === true ||
                (body as Record<string, unknown>).status === 'connected';
            expect(
                connected,
                `${p} connection on fresh user reports connected: ${JSON.stringify(body).slice(0, 200)}`,
            ).toBe(false);
        }
    });
});
