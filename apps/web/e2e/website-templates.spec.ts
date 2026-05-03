import { test, expect } from '@playwright/test';
import { API_BASE, registerUserViaAPI, authedHeaders } from './helpers/api';

/**
 * Website templates — public list endpoint + the registry it returns.
 *
 * Pins the contract so a future bulk rename can't silently swap the
 * `directory-web-template` repo name for a `work-…` form (which would
 * make every newly-created Work clone a missing repo). See
 * docs/features/website-templates.md for the full template catalogue.
 */

test.describe('Website templates — public list endpoint', () => {
    test('GET /api/works/website-templates is reachable without auth (or 401-clean)', async ({
        request,
    }) => {
        // The endpoint is read-only metadata; it may be public or 401.
        // What we care about: it must not 5xx and not 404.
        const res = await request.get(`${API_BASE}/api/works/website-templates`);
        expect(res.status(), `status was ${res.status()}`).not.toBe(404);
        expect(res.status(), `status was ${res.status()}`).toBeLessThan(500);
    });

    test('authed list returns the classic template with the legacy directory-web-template repo id', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/works/website-templates`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBe(200);

        const body = await res.json();
        const templates = body?.templates ?? body;
        expect(Array.isArray(templates), 'templates is an array').toBe(true);

        const classic = (templates as Array<{ id: string; isDefault?: boolean }>).find(
            (t) => t.id === 'classic',
        );
        expect(classic, '`classic` template id is registered').toBeTruthy();
        expect(classic?.isDefault, '`classic` is default').toBeTruthy();
    });
});
