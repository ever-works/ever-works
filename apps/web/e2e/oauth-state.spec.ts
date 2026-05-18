import { test, expect } from '@playwright/test';
import { API_BASE } from './helpers/api';

/**
 * OAuth state cookie ↔ URL contract — regression coverage for the bug
 * introduced by C-03 batch 3 where the API server-minted state on
 * `/api/oauth/:p/url` without surfacing it to the web tier, so the web's
 * own `oauth_state` cookie never matched the value the OAuth provider
 * echoed back on the callback. Every Google/GitHub sign-in then failed
 * the web's state check with "Invalid authorization state."
 *
 * Contract this suite pins:
 *   1. `GET /api/oauth/:p/url` returns `{ url, state }`.
 *   2. The `state` query parameter in `url` equals the response `state`.
 *   3. The Set-Cookie header sets `ew_oauth_state=<state>` so a direct
 *      caller (CLI, future tooling) hitting the API callback can also
 *      validate it.
 *
 * The web mirror (its own `oauth_state` cookie) is covered by the
 * companion vitest spec on `connectProvider` — testing that part needs
 * Next runtime mocks the Playwright runner doesn't have.
 */

const PROVIDERS = ['github', 'google'] as const;

/**
 * Treat the response as "credentials not provisioned in this environment"
 * ONLY when it is a 400 carrying a known "client id/secret not configured"
 * or "Unsupported OAuth provider" message. Anything else — non-deterministic
 * 5xx, network errors, any 400 that doesn't match these signals — is treated
 * as a real failure so the suite catches regressions in the URL endpoint
 * itself (the exact contract this file exists to defend).
 */
async function isProviderUnconfigured(
    res: import('@playwright/test').APIResponse,
): Promise<boolean> {
    if (res.status() !== 400) return false;
    let body: unknown;
    try {
        body = await res.json();
    } catch {
        return false;
    }
    const message =
        typeof body === 'object' && body !== null && 'message' in body
            ? String((body as { message: unknown }).message ?? '')
            : '';
    return (
        /client (id|secret) is not configured/i.test(message) ||
        /unsupported oauth provider/i.test(message)
    );
}

for (const providerId of PROVIDERS) {
    test.describe(`OAuth ${providerId} URL contract (C-03 state round-trip)`, () => {
        test(`GET /api/oauth/${providerId}/url returns url + state and the URL embeds the same state`, async ({
            request,
        }) => {
            const res = await request.get(`${API_BASE}/api/oauth/${providerId}/url`);
            if (await isProviderUnconfigured(res)) {
                test.skip(true, `${providerId} OAuth client id/secret not configured; skipping`);
            }
            expect(res.status(), `status was ${res.status()}`).toBe(200);

            const body = await res.json();
            expect(typeof body.url, 'response has a string url').toBe('string');
            expect(typeof body.state, 'response has a string state').toBe('string');
            expect(body.state.length, 'state is a non-trivial nonce').toBeGreaterThan(20);

            // The OAuth URL must embed the same state value the body returns.
            const urlState = new URL(body.url).searchParams.get('state');
            expect(urlState, 'state in OAuth URL matches state in response body').toBe(body.state);

            // Set-Cookie carries `ew_oauth_state=<state>` for callers that
            // hit the API callback directly.
            const setCookie = res.headers()['set-cookie'];
            expect(setCookie, 'response sets ew_oauth_state cookie').toBeTruthy();
            expect(String(setCookie)).toContain(`ew_oauth_state=${body.state}`);
            expect(String(setCookie)).toContain('HttpOnly');
        });

        test(`two calls to /api/oauth/${providerId}/url return distinct state nonces`, async ({
            request,
        }) => {
            const a = await request.get(`${API_BASE}/api/oauth/${providerId}/url`);
            const b = await request.get(`${API_BASE}/api/oauth/${providerId}/url`);
            if ((await isProviderUnconfigured(a)) || (await isProviderUnconfigured(b))) {
                test.skip(true, `${providerId} OAuth client id/secret not configured; skipping`);
            }
            expect(a.status(), `first call status was ${a.status()}`).toBe(200);
            expect(b.status(), `second call status was ${b.status()}`).toBe(200);
            const ja = await a.json();
            const jb = await b.json();
            expect(ja.state).not.toEqual(jb.state);
        });
    });
}
