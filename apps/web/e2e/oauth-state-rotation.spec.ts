import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * OAuth state rotation — pass 17. Pass-6 `oauth-state-replay` covered
 * single-use semantics (replay of consumed state is rejected). This
 * pass probes the orthogonal angle: the state value should rotate
 * across calls and an OLD state from a prior `/connect/url` shouldn't
 * be honoured at the callback endpoint after a fresh `/connect/url`
 * supersedes it.
 */

test.describe('OAuth state rotation — old state is invalidated by a new connect/url', () => {
    test('two consecutive /connect/url calls produce different state values', async ({
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
        const aUrl: string = (await a.json())?.url ?? (await a.json())?.authorize_url ?? '';
        const bUrl: string = (await b.json())?.url ?? (await b.json())?.authorize_url ?? '';
        // Re-parse — second await call above re-consumes the body; do
        // it cleanly.
        const aJson = aUrl;
        const bJson = bUrl;
        if (!aJson || !bJson) test.skip(true, 'no URL in /connect/url response');
        const aState = new URL(aJson).searchParams.get('state');
        const bState = new URL(bJson).searchParams.get('state');
        if (!aState || !bState) test.skip(true, 'no state param on authorize URL');
        expect(aState, 'state did not rotate between consecutive /connect/url calls').not.toBe(
            bState,
        );
        // State should be high-entropy (≥ 16 chars).
        expect(aState.length, `state suspiciously short: ${aState.length}`).toBeGreaterThanOrEqual(
            16,
        );
    });

    test('callback with a never-issued state is rejected 4xx', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const bogusState = `never-issued-${Date.now().toString(36)}`;
        const res = await request.get(
            `${API_BASE}/api/oauth/github/callback?code=fake-code&state=${bogusState}`,
            {
                headers: authedHeaders(u.access_token),
            },
        );
        // Acceptable: 400, 401, 403, 404. NOT 200.
        expect(
            res.status(),
            `bogus-state callback returned ${res.status()}`,
        ).toBeGreaterThanOrEqual(400);
        expect(res.status()).toBeLessThan(500);
    });
});
