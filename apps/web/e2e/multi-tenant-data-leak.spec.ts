import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * Multi-tenant data-leak — pass 15. Listing endpoints with `?owner=`,
 * `?tenant=`, `?org_id=` query params must NOT honour them to leak
 * other tenants' rows. The server-side row-level isolation should be
 * authoritative and silently ignore (or 4xx) attacker-controlled
 * tenant scoping.
 */

const LEAK_PARAMS = ['owner', 'ownerId', 'owner_id', 'tenant', 'tenantId', 'orgId', 'org_id'];

test.describe('Multi-tenant — attacker-controlled scope params do not leak rows', () => {
    test("alice and bob each own a private work; bob cannot see alice's via ?owner=", async ({
        request,
    }) => {
        const alice = await registerUserViaAPI(request);
        const bob = await registerUserViaAPI(request);
        // Alice creates a work.
        const aliceWork = await createWorkViaAPI(request, alice.access_token, {
            name: `alice-secret-${Date.now().toString(36)}`,
            slug: `alice-secret-${Date.now().toString(36)}`,
        });
        // Bob lists works WITH a tenant-scope param pointing at Alice.
        for (const param of LEAK_PARAMS) {
            const url = `${API_BASE}/api/works?${param}=${encodeURIComponent(alice.user.id)}`;
            const res = await request.get(url, {
                headers: authedHeaders(bob.access_token),
            });
            // Either silently scoped to Bob's rows (200 with empty/Bob-only
            // list) or 4xx rejecting the param. NEVER 200 with Alice's row.
            if (res.ok()) {
                const body = await res.json();
                const arr: Array<{ id?: string; userId?: string; ownerId?: string }> =
                    Array.isArray(body) ? body : (body?.data ?? body?.works ?? []);
                const leaked = arr.some((w) => w.id === aliceWork.id);
                expect(
                    leaked,
                    `${param}=${alice.user.id} leaked Alice's work ${aliceWork.id} to Bob`,
                ).toBe(false);
            } else {
                // 4xx rejection is fine.
                expect(res.status()).toBeLessThan(500);
            }
        }
    });

    test('GET /api/works/<aliceWorkId> returns 401/403/404 for Bob', async ({ request }) => {
        const alice = await registerUserViaAPI(request);
        const bob = await registerUserViaAPI(request);
        const aliceWork = await createWorkViaAPI(request, alice.access_token, {
            name: `cross-tenant-${Date.now().toString(36)}`,
            slug: `cross-tenant-${Date.now().toString(36)}`,
        });
        const res = await request.get(`${API_BASE}/api/works/${aliceWork.id}`, {
            headers: authedHeaders(bob.access_token),
        });
        expect([401, 403, 404]).toContain(res.status());
    });
});
