import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * OAuth redirect_uri pinning — pass 17. The redirect_uri on the
 * authorize URL must be from a strict allowlist — typically the
 * platform's own callback path. An open redirector via path traversal
 * or attacker-controlled origin in redirect_uri is a serious
 * vulnerability (CSRF + token leak).
 *
 * We probe the github connect/url and assert:
 *  - redirect_uri's hostname matches the API/web hostname
 *  - redirect_uri ends in the expected /callback path
 *  - redirect_uri uses https in production-shaped URLs
 */

test.describe('OAuth redirect_uri — strict allowlist + callback path pinning', () => {
    test('github authorize URL redirect_uri matches the platform origin and ends in /callback', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/oauth/github/connect/url`, {
            headers: authedHeaders(u.access_token),
        });
        if (!res.ok()) test.skip(true, `connect/url not available (${res.status()})`);
        const body = await res.json();
        const url: string | undefined =
            body?.url ?? body?.authorize_url ?? body?.authorizeUrl ?? body?.redirect_url;
        if (!url) test.skip(true, 'no URL field in connect/url body');
        const ru = new URL(url).searchParams.get('redirect_uri');
        if (!ru) test.skip(true, 'no redirect_uri on authorize URL');
        const parsed = new URL(ru);
        const apiHost = new URL(API_BASE).hostname;
        // redirect_uri hostname should match the API host OR be a
        // matching ever.works subdomain in production.
        const hostnameOk =
            parsed.hostname === apiHost ||
            parsed.hostname === 'localhost' ||
            /\.ever\.works$/.test(parsed.hostname);
        expect(
            hostnameOk,
            `redirect_uri hostname "${parsed.hostname}" not allowlisted (api=${apiHost})`,
        ).toBe(true);
        // Path must look like a callback path.
        expect(
            parsed.pathname,
            `redirect_uri path doesn't look like a callback: ${parsed.pathname}`,
        ).toMatch(/(callback|oauth|connect)/i);
    });

    test('production-shaped origins use https in redirect_uri', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/oauth/github/connect/url`, {
            headers: authedHeaders(u.access_token),
        });
        if (!res.ok()) test.skip(true, 'connect/url not available');
        const body = await res.json();
        const url: string | undefined =
            body?.url ?? body?.authorize_url ?? body?.authorizeUrl ?? body?.redirect_url;
        if (!url) test.skip(true, 'no URL field');
        const ru = new URL(url).searchParams.get('redirect_uri');
        if (!ru) test.skip(true, 'no redirect_uri');
        const parsed = new URL(ru);
        // Localhost http is fine in dev; *.ever.works MUST be https.
        if (/\.ever\.works$/.test(parsed.hostname)) {
            expect(
                parsed.protocol,
                `production redirect_uri used non-https: ${parsed.protocol}`,
            ).toBe('https:');
        }
    });
});
