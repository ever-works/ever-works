import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Email template render — pass 10. Admins may preview transactional
 * email templates via an endpoint. We probe candidate paths and
 * verify auth gate + that template render output looks like HTML and
 * doesn't surface raw {{handlebars}} markers (= unresolved variables).
 */

const PREVIEW_PATHS = [
    '/api/admin/emails/preview',
    '/api/admin/email-templates/preview',
    '/api/emails/preview',
    '/api/mail/preview',
    '/api/internal/email-preview',
];

test.describe('Email templates — preview endpoint', () => {
    test('preview endpoint (if exposed) requires auth + admin', async ({ request }) => {
        let found: { path: string; status: number } | null = null;
        for (const path of PREVIEW_PATHS) {
            const res = await request.post(`${API_BASE}${path}`, {
                data: { template: 'welcome', vars: {} },
            });
            if (res.status() === 404 || res.status() === 405) continue;
            found = { path, status: res.status() };
            break;
        }
        if (!found) test.skip(true, 'no email-preview endpoint exposed');
        // Must be unauthenticated-rejected.
        expect([401, 403]).toContain(found!.status);
    });

    test('regular user cannot preview admin email templates', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        let found = false;
        for (const path of PREVIEW_PATHS) {
            const res = await request.post(`${API_BASE}${path}`, {
                headers: authedHeaders(u.access_token),
                data: { template: 'welcome', vars: {} },
            });
            if (res.status() === 404 || res.status() === 405) continue;
            found = true;
            // Regular (non-admin) user must NOT get 200.
            expect([401, 403]).toContain(res.status());
            return;
        }
        if (!found) test.skip(true, 'no email-preview endpoint');
    });

    test('preview response (if accessible) renders without unresolved {{vars}}', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        let body: string | null = null;
        for (const path of PREVIEW_PATHS) {
            const res = await request.post(`${API_BASE}${path}`, {
                headers: authedHeaders(u.access_token),
                data: { template: 'welcome', vars: { name: 'E2E' } },
            });
            if (res.status() !== 200) continue;
            body = await res.text();
            break;
        }
        if (!body) test.skip(true, 'no email-preview accessible to regular user');
        // Unresolved Handlebars / Mustache markers would surface as
        // {{var}} in the body — that's a template-engine bug.
        const unresolved = body!.match(/\{\{[^}]+\}\}/g) || [];
        expect(unresolved.length, `unresolved template vars: ${unresolved.join(', ')}`).toBe(0);
    });
});
