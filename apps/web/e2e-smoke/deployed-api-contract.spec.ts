import { expect, test } from '@playwright/test';

/**
 * Does the deployed API actually serve the paths the deployed web app asks for?
 *
 * The web reaches the API through `API_URL`, which `apps/web/src/lib/constants.ts`
 * normalises to always end in `/api`:
 *
 *     export const API_URL = apiUrl.endsWith('/api') ? apiUrl : `${apiUrl}/api`;
 *
 * so every `serverFetch('/x')` becomes `<api>/api/x`. A controller declared
 * without the `api/` prefix still registers, still answers on its own path, and
 * still passes every unit test — it is simply unreachable from the product.
 *
 * That is not hypothetical. On 2026-08-09 `TermsController` was `@Controller('terms')`
 * and `AdminUsageController` was `@Controller('admin/usage')`; both answered
 * fine on their own paths and 404'd on the path the web used. Registration was
 * impossible in production while every health check stayed green.
 *
 * The distinction that makes this test work:
 *
 *   404 → the route does not exist where the product looks for it. FAIL.
 *   401 → the route exists and its auth guard fired. PASS.
 *
 * A 401 is a success here; we are testing routing, not authorisation.
 */

const API = process.env.SMOKE_API_URL || 'http://localhost:3100';

/**
 * Critical GET routes, written exactly as the web requests them: `/api` +
 * the path passed to `serverFetch`.
 *
 * Curated rather than derived from source on purpose. Nest answers 404 for a
 * path that exists but has no handler for the METHOD, so probing every
 * `serverFetch` call with GET would fail on POST-only routes and teach everyone
 * to ignore this test. The exhaustive check on the prefix convention lives in
 * `apps/api/src/terms/terms.controller.spec.ts`, where it is free and complete.
 */
const CRITICAL_GET_ROUTES: ReadonlyArray<{ path: string; why: string }> = [
    { path: '/api/terms/required', why: 'signup cannot render its consent without this' },
    { path: '/api/version', why: 'deploy verification depends on it' },
    { path: '/api/health/ready', why: 'readiness probe' },
    { path: '/api/plugins', why: 'plugin registry — an empty registry silently breaks chat' },
    { path: '/api/works', why: 'core domain listing' },
    { path: '/api/agents', why: 'agents surface' },
    { path: '/api/agents/templates', why: 'agent creation flow' },
    { path: '/api/auth/profile', why: 'every authenticated page reads it' },
    { path: '/api/activity-log', why: 'dashboard feed' },
    { path: '/api/admin/usage', why: 'admin usage page (regressed 2026-08-09)' },
    { path: '/api/billing/overview', why: 'billing surface' },
    { path: '/api/credits/balance', why: 'credits surface' },
    { path: '/api/notifications', why: 'notification bell' },
    { path: '/api/organizations', why: 'org switcher' },
];

test.describe('deployed API route contract', () => {
    for (const { path, why } of CRITICAL_GET_ROUTES) {
        test(`${path} is routed (${why})`, async ({ request }) => {
            const response = await request.get(`${API}${path}`, { failOnStatusCode: false });

            expect(
                response.status(),
                `${API}${path} returned 404 — the route is not served where the web app asks for it. ` +
                    `Check the controller's @Controller() prefix: this app has no setGlobalPrefix, ` +
                    `so every controller must declare 'api/...' itself.`,
            ).not.toBe(404);

            // 5xx means routed but broken, which is also not a healthy deploy.
            expect(response.status(), `${API}${path} returned ${response.status()}`).toBeLessThan(
                500,
            );
        });
    }

    test('the terms endpoint returns real, usable documents', async ({ request }) => {
        // Routing alone is not enough: an empty list disables the signup
        // checkbox just as effectively as a 404 does.
        const response = await request.get(`${API}/api/terms/required`, {
            failOnStatusCode: false,
        });
        expect(response.ok()).toBeTruthy();

        const documents = (await response.json()) as Array<Record<string, unknown>>;
        expect(Array.isArray(documents)).toBeTruthy();
        expect(
            documents.length,
            'no required documents published — the register form will disable its consent checkbox',
        ).toBeGreaterThan(0);

        // Each document must carry the identity the acceptance is pinned to.
        for (const doc of documents) {
            expect(doc).toHaveProperty('documentId');
            expect(doc).toHaveProperty('version');
            expect(doc).toHaveProperty('sha256');
            expect(String(doc.sha256)).toMatch(/^[a-f0-9]{64}$/);
        }
    });
});
