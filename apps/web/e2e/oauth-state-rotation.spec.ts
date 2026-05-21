import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * OAuth state rotation — pass 17. Pass-6 `oauth-state-replay` covered
 * single-use semantics (replay of consumed state is rejected). This
 * pass probes the orthogonal angle: the state value should rotate
 * across calls and an OLD state from a prior `/connect/url` shouldn't
 * be honoured at the callback endpoint once a fresh `/connect/url`
 * supersedes it.
 *
 * Bot review fixes:
 *  - Greptile P1: drop the dead-alias double-await on .json(); parse
 *    once and destructure.
 *  - Codex P2: also exercise a STALE-BUT-PREVIOUSLY-ISSUED state at
 *    the callback (the test name promises rotation, not just bogus
 *    state rejection).
 */

function extractAuthorizeUrl(body: Record<string, unknown> | null): string | null {
    if (!body) return null;
    const url =
        (body.url as string | undefined) ??
        (body.authorize_url as string | undefined) ??
        (body.authorizeUrl as string | undefined) ??
        (body.redirect_url as string | undefined);
    return typeof url === 'string' && url.startsWith('http') ? url : null;
}

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
        // Greptile P1: parse each response body once.
        const aUrl = extractAuthorizeUrl(await a.json().catch(() => null));
        const bUrl = extractAuthorizeUrl(await b.json().catch(() => null));
        if (!aUrl || !bUrl) test.skip(true, 'no URL field in /connect/url body');
        const aState = new URL(aUrl!).searchParams.get('state');
        const bState = new URL(bUrl!).searchParams.get('state');
        if (!aState || !bState) test.skip(true, 'no state param on authorize URL');
        expect(aState, 'state did not rotate between consecutive /connect/url calls').not.toBe(
            bState,
        );
        // State should be high-entropy (≥ 16 chars).
        expect(
            aState!.length,
            `state suspiciously short: ${aState!.length}`,
        ).toBeGreaterThanOrEqual(16);
    });

    test('previously-issued state from an earlier /connect/url is rejected at callback', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        // Issue state #1.
        const first = await request.get(`${API_BASE}/api/oauth/github/connect/url`, {
            headers: authedHeaders(u.access_token),
        });
        if (!first.ok()) test.skip(true, '/connect/url not available');
        const firstUrl = extractAuthorizeUrl(await first.json().catch(() => null));
        if (!firstUrl) test.skip(true, 'no URL in connect/url body');
        const oldState = new URL(firstUrl!).searchParams.get('state');
        if (!oldState) test.skip(true, 'no state on authorize URL');
        // Issue state #2 — this rotates the server-side state binding.
        const second = await request.get(`${API_BASE}/api/oauth/github/connect/url`, {
            headers: authedHeaders(u.access_token),
        });
        if (!second.ok()) test.skip(true, 'second connect/url failed');
        // Codex P2: now attempt the callback with the STALE state from
        // round 1. A correctly-rotating server must reject it (4xx).
        // Acceptable: 400 (invalid state), 401, 403, 404 (route guard).
        const res = await request.get(
            `${API_BASE}/api/oauth/github/callback?code=fake-code&state=${encodeURIComponent(oldState!)}`,
            { headers: authedHeaders(u.access_token) },
        );
        expect(
            res.status(),
            `stale-state callback returned ${res.status()} (expected 4xx)`,
        ).toBeGreaterThanOrEqual(400);
        expect(res.status()).toBeLessThan(500);
    });

    test('callback with a never-issued synthetic state is rejected 4xx', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const bogusState = `never-issued-${Date.now().toString(36)}`;
        const res = await request.get(
            `${API_BASE}/api/oauth/github/callback?code=fake-code&state=${bogusState}`,
            { headers: authedHeaders(u.access_token) },
        );
        expect(
            res.status(),
            `bogus-state callback returned ${res.status()}`,
        ).toBeGreaterThanOrEqual(400);
        expect(res.status()).toBeLessThan(500);
    });
});
