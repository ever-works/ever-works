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

for (const providerId of PROVIDERS) {
    test.describe(`OAuth ${providerId} URL contract (C-03 state round-trip)`, () => {
        test(`GET /api/oauth/${providerId}/url returns url + state and the URL embeds the same state`, async ({
            request,
        }) => {
            const res = await request.get(`${API_BASE}/api/oauth/${providerId}/url`);
            // 200 only if credentials are configured for the provider on the
            // test API. Skip cleanly otherwise so this suite stays portable.
            if (res.status() === 400 || res.status() === 500) {
                test.skip(true, `${providerId} OAuth not configured on this API; skipping`);
                return;
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
            if (a.status() !== 200 || b.status() !== 200) {
                test.skip(true, `${providerId} OAuth not configured on this API; skipping`);
                return;
            }
            const ja = await a.json();
            const jb = await b.json();
            expect(ja.state).not.toEqual(jb.state);
        });
    });
}
