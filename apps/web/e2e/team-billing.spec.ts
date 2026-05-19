import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Team / per-org billing — pass 10. Multi-tenant builds expose billing
 * surfaces under /api/teams/:id/billing or /api/orgs/:id/billing. We
 * probe for them and verify only org admins / owners can access.
 */

const BILLING_PATHS = [
    '/api/teams',
    '/api/orgs',
    '/api/organizations',
    '/api/me/teams',
    '/api/me/organizations',
];

test.describe('Team listing — auth gate', () => {
    test('unauth GET teams/orgs → 401/403/404', async ({ request }) => {
        for (const path of BILLING_PATHS) {
            const res = await request.get(`${API_BASE}${path}`);
            if (res.status() === 404) continue;
            expect([401, 403]).toContain(res.status());
            return;
        }
        test.skip(true, 'no team/org endpoint exposed');
    });

    test('authed GET teams/orgs returns a list shape', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        for (const path of BILLING_PATHS) {
            const res = await request.get(`${API_BASE}${path}`, {
                headers: authedHeaders(u.access_token),
            });
            if (res.status() === 404) continue;
            expect(res.status()).toBeLessThan(500);
            if (res.status() === 200) {
                const body = await res.json();
                const arr = Array.isArray(body)
                    ? body
                    : (body?.teams ?? body?.organizations ?? body?.orgs ?? body?.data ?? []);
                expect(Array.isArray(arr)).toBe(true);
            }
            return;
        }
        test.skip(true, 'no team/org endpoint exposed');
    });
});

test.describe('Team billing — admin-only', () => {
    test('regular user cannot read billing of an unowned team', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        // Try the standard team-billing routes with a UUID we don't own.
        const fakeTeamId = '00000000-0000-0000-0000-000000000000';
        const candidates = [
            `/api/teams/${fakeTeamId}/billing`,
            `/api/orgs/${fakeTeamId}/billing`,
            `/api/organizations/${fakeTeamId}/billing`,
            `/api/teams/${fakeTeamId}/subscription`,
        ];
        let found = false;
        for (const path of candidates) {
            const res = await request.get(`${API_BASE}${path}`, {
                headers: authedHeaders(u.access_token),
            });
            if (res.status() === 404) continue;
            found = true;
            // 403 / 404 are both fine — both prevent the leak. 200 is the
            // bug we're guarding against.
            expect([401, 403, 404]).toContain(res.status());
            return;
        }
        if (!found) test.skip(true, 'no team-billing endpoint exposed');
    });
});

test.describe('Team invitations — auth gate', () => {
    test('listing team invitations requires auth', async ({ request }) => {
        const candidates = [
            '/api/teams/invitations',
            '/api/orgs/invitations',
            '/api/me/team-invitations',
        ];
        for (const path of candidates) {
            const res = await request.get(`${API_BASE}${path}`);
            if (res.status() === 404) continue;
            expect([401, 403]).toContain(res.status());
            return;
        }
        test.skip(true, 'no team-invitation endpoint exposed');
    });
});
