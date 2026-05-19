import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Account deletion — pass 6. The platform may expose
 * `DELETE /api/account` or `POST /api/account/delete` for a user to
 * self-delete. We probe both, plus the danger-zone page; if no
 * endpoint exists, we skip — the test then records that this flow
 * still needs implementing.
 */

const DELETE_PATHS = [
    { method: 'DELETE', path: '/api/account' },
    { method: 'POST', path: '/api/account/delete' },
    { method: 'POST', path: '/api/auth/delete-account' },
    { method: 'DELETE', path: '/api/auth/profile' },
] as const;

test.describe('Account deletion — endpoint probe', () => {
    test('an account deletion endpoint exists and requires auth (or skip)', async ({ request }) => {
        // Important: call request.delete / request.post inline. Extracting
        // them into a variable loses the APIRequestContext `this` binding
        // and throws `TypeError: Cannot read properties of undefined` at
        // call time (Playwright 1.59.x routes through `this.fetch`).
        let found: { method: string; path: string; status: number } | null = null;
        for (const p of DELETE_PATHS) {
            const res =
                p.method === 'DELETE'
                    ? await request.delete(`${API_BASE}${p.path}`)
                    : await request.post(`${API_BASE}${p.path}`);
            if (res.status() !== 404 && res.status() !== 405) {
                found = { method: p.method, path: p.path, status: res.status() };
                break;
            }
        }
        if (!found) {
            test.skip(true, 'no account deletion endpoint exposed in this env');
        }
        // Unauthenticated MUST be 401 / 403 — anything else means the
        // deletion endpoint is reachable without auth, which is a
        // catastrophic boundary leak.
        expect([401, 403]).toContain(found!.status);
    });

    test('auth-gated delete with auth responds < 500 (best-effort smoke)', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        let found: { method: string; path: string; status: number } | null = null;
        for (const p of DELETE_PATHS) {
            const res =
                p.method === 'DELETE'
                    ? await request.delete(`${API_BASE}${p.path}`, {
                          headers: authedHeaders(u.access_token),
                      })
                    : await request.post(`${API_BASE}${p.path}`, {
                          headers: authedHeaders(u.access_token),
                          data: { password: u.password, confirm: u.email },
                      });
            if (res.status() !== 404 && res.status() !== 405) {
                found = { method: p.method, path: p.path, status: res.status() };
                break;
            }
        }
        if (!found) {
            test.skip(true, 'no account deletion endpoint exposed');
        }
        // Outcome may be 200/204 (deletion accepted), 400/422 (missing
        // confirmation), 403 (needs additional approval), 409 (has
        // pending exports). Never 5xx.
        expect(found!.status).toBeLessThan(500);
    });
});

test.describe('Account deletion — danger-zone UI page', () => {
    test('/en/settings/danger renders for an authenticated user', async ({ page }) => {
        await page.goto('/en/settings/danger', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1_500);
        // Page should not be a 5xx render; we accept a real danger-zone
        // page OR a redirect away from /danger (some builds gate it
        // behind a feature flag).
        const body = (
            await page
                .locator('body')
                .innerText()
                .catch(() => '')
        ).toLowerCase();
        // Common danger-zone affordances: "delete account", "danger
        // zone", or a destructive button.
        const looksDangerous =
            body.includes('delete') ||
            body.includes('danger') ||
            body.includes('remove') ||
            body.includes('destroy');
        // If the page didn't load, the body would be empty / contain
        // a 5xx string. We require non-empty.
        expect(body.length, 'danger-zone page rendered empty body').toBeGreaterThan(20);
        // Single assertion — earlier shape called test.skip first which
        // made the assertion dead code and let a missing-affordance
        // regression pass silently. Greptile P2 fix.
        expect(
            looksDangerous,
            'danger zone page exists but no destructive affordance copy found',
        ).toBe(true);
    });
});
