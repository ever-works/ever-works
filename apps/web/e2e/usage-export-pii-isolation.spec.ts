import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * Usage-export PII isolation — pass 16. Usage exports (CSV / JSON)
 * scoped to a single user / work must NEVER include another tenant's
 * email addresses or user IDs verbatim. Alice triggers an export,
 * Bob's email must not appear in the bytes.
 *
 * Pass-10 `audit-export-sanitization` covered secret-pattern
 * scrubbing. This pass focuses specifically on cross-tenant ID/email
 * isolation on the usage-export surface.
 */

const USAGE_EXPORT_PATHS = [
    '/api/works/__WORK_ID__/usage/export',
    '/api/account/usage/export',
    '/api/usage/export',
];

test.describe("Usage exports — never leak another tenant's identifiers", () => {
    test("Alice's usage export does not contain Bob's email or user id", async ({ request }) => {
        const alice = await registerUserViaAPI(request);
        const bob = await registerUserViaAPI(request);
        const aliceWork = await createWorkViaAPI(request, alice.access_token, {
            name: `usage-${Date.now().toString(36)}`,
            slug: `usage-${Date.now().toString(36)}`,
        });
        let probed = false;
        let foundLeak: string | null = null;
        for (const tpl of USAGE_EXPORT_PATHS) {
            const path = tpl.replace('__WORK_ID__', aliceWork.id);
            const res = await request.get(`${API_BASE}${path}`, {
                headers: authedHeaders(alice.access_token),
            });
            if (res.status() === 404) continue;
            probed = true;
            if (!res.ok()) continue;
            const text = await res.text();
            // Cross-tenant leak signal: Bob's email or user.id verbatim.
            if (text.includes(bob.email)) {
                foundLeak = `bob.email leaked in ${path}`;
                break;
            }
            if (bob.user.id && text.includes(bob.user.id)) {
                foundLeak = `bob.user.id leaked in ${path}`;
                break;
            }
        }
        if (!probed) test.skip(true, 'no usage-export endpoint exposed');
        expect(foundLeak, `cross-tenant PII leak: ${foundLeak}`).toBeNull();
    });

    test("Bob cannot pull Alice's usage export by workId", async ({ request }) => {
        const alice = await registerUserViaAPI(request);
        const bob = await registerUserViaAPI(request);
        const aliceWork = await createWorkViaAPI(request, alice.access_token, {
            name: `usage-iso-${Date.now().toString(36)}`,
            slug: `usage-iso-${Date.now().toString(36)}`,
        });
        const res = await request.get(`${API_BASE}/api/works/${aliceWork.id}/usage/export`, {
            headers: authedHeaders(bob.access_token),
        });
        if (res.status() === 404) {
            test.skip(true, '/api/works/<id>/usage/export not exposed');
        }
        // Must NOT return Alice's data to Bob.
        expect([401, 403, 404]).toContain(res.status());
    });
});
