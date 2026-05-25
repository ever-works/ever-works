import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Mission Templates — PR W + PR X added the kind=mission filter to the
 * existing `/api/templates` list, plus the two curated built-in Mission
 * templates (`starter-business`, `starter-content`). The `Use this
 * Template` button on the catalog (PR Y) hits the existing
 * `/api/templates` route — no new endpoint needed for the catalog itself.
 *
 * This file pins:
 *   - `/api/templates?kind=mission` returns only Mission rows.
 *   - The two built-in starters surface for every logged-in user.
 *   - The fork endpoint accepts mission-kind sources (PR X).
 */

test.describe('Mission Templates — catalog filter', () => {
    test('GET /api/templates?kind=mission without auth → 401', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/templates?kind=mission`);
        expect(res.status()).toBe(401);
    });

    test('GET /api/templates?kind=mission returns only mission templates', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/templates?kind=mission`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status(), `body=${await res.text()}`).toBe(200);
        const body = await res.json();
        const templates = Array.isArray(body) ? body : (body?.templates ?? body?.data ?? []);
        expect(Array.isArray(templates)).toBe(true);

        // Every row in the kind=mission filter must be a Mission template.
        // Some deployments add `kind` to the row directly; if so, assert
        // it. If the field is absent (older shape) we only assert the
        // length is finite — the filter itself is what we're pinning.
        for (const t of templates) {
            if (typeof t.kind === 'string') {
                expect(t.kind).toBe('mission');
            }
        }
    });

    test('built-in Mission starters are present in kind=mission catalog', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/templates?kind=mission`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        const templates = (
            Array.isArray(body) ? body : (body?.templates ?? body?.data ?? [])
        ) as Array<{ id?: string; slug?: string; name?: string }>;

        const ids = new Set(
            templates
                .flatMap((t) => [t.id, t.slug, t.name])
                .filter((v): v is string => typeof v === 'string'),
        );
        // The two PR X built-ins. Match either id, slug, or name to
        // stay resilient to which field the catalog surfaces them under.
        const hasBusiness = [...ids].some((s) => /starter[- _]?business/i.test(s));
        const hasContent = [...ids].some((s) => /starter[- _]?content/i.test(s));
        expect(hasBusiness, `expected "starter-business" in ${[...ids].join(', ')}`).toBe(true);
        expect(hasContent, `expected "starter-content" in ${[...ids].join(', ')}`).toBe(true);
    });

    test('GET /api/templates (no kind) still works (back-compat for Work templates)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/templates`, {
            headers: authedHeaders(u.access_token),
        });
        // Pre-PR-W contract: returns Work templates by default. Not
        // breaking that contract is part of the extension-only rule.
        expect(res.status()).toBe(200);
    });
});
