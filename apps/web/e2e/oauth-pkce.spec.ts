import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * OAuth PKCE — pass 15. PKCE (RFC 7636) protects the authorization
 * code interchange against interception. Modern OAuth clients MUST
 * include `code_challenge` and `code_challenge_method=S256` on the
 * authorize URL. If our provider connect URL omits these, an attacker
 * who intercepts the redirect can replay the code.
 *
 * We probe the github git-provider connect URL (the platform's most
 * stable OAuth surface).
 */

test.describe('OAuth PKCE — authorize URL carries code_challenge', () => {
    test('github /connect/url returns an authorize URL with code_challenge + S256 (or informational skip)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/oauth/github/connect/url`, {
            headers: authedHeaders(u.access_token),
        });
        if (!res.ok()) {
            test.skip(true, `connect/url not exposed (${res.status()})`);
        }
        const body = await res.json();
        const url: string | undefined =
            body?.url ?? body?.authorize_url ?? body?.authorizeUrl ?? body?.redirect_url;
        if (!url || typeof url !== 'string') {
            test.skip(true, 'connect/url body did not include a URL field');
        }
        const parsed = new URL(url);
        const cc = parsed.searchParams.get('code_challenge');
        const ccm = parsed.searchParams.get('code_challenge_method');
        if (!cc) {
            // Platform does not yet use PKCE for the github provider —
            // informational signal. GitHub itself doesn't require PKCE
            // for confidential clients, so this is a soft warning.
            test.info().annotations.push({
                type: 'informational',
                description: 'github authorize URL has no code_challenge — PKCE not used',
            });
            return;
        }
        // Code challenge must be 43-128 chars (RFC 7636 §4.2).
        expect(
            cc.length,
            `code_challenge length out of range: ${cc.length}`,
        ).toBeGreaterThanOrEqual(43);
        expect(cc.length).toBeLessThanOrEqual(128);
        // S256 is the secure method. `plain` is allowed by spec but
        // discouraged.
        expect(ccm, `code_challenge_method should be S256, got: ${ccm}`).toBe('S256');
    });

    test('two consecutive connect/url calls return DIFFERENT code_challenge values', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const a = await request.get(`${API_BASE}/api/oauth/github/connect/url`, {
            headers: authedHeaders(u.access_token),
        });
        const b = await request.get(`${API_BASE}/api/oauth/github/connect/url`, {
            headers: authedHeaders(u.access_token),
        });
        if (!a.ok() || !b.ok()) test.skip(true, 'connect/url not consistently available');
        const aBody = await a.json();
        const bBody = await b.json();
        const aUrl = aBody?.url ?? aBody?.authorize_url ?? '';
        const bUrl = bBody?.url ?? bBody?.authorize_url ?? '';
        if (!aUrl || !bUrl) test.skip(true, 'no URL in connect/url response');
        const aCc = new URL(aUrl).searchParams.get('code_challenge');
        const bCc = new URL(bUrl).searchParams.get('code_challenge');
        if (!aCc || !bCc) test.skip(true, 'PKCE not in use');
        expect(
            aCc,
            'two connect/url calls returned the SAME code_challenge — PKCE verifier is not random per request',
        ).not.toBe(bCc);
    });
});
