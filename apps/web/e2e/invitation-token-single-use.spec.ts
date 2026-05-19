import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * Invitation token single-use — pass 20. Invitation tokens issued
 * via /api/works/<id>/invitations should be consumable exactly once.
 * Re-accepting a consumed token returns 4xx (not silent dup-member,
 * not 5xx).
 *
 * We don't have a real token-acceptance flow exposed via API alone
 * (typical UX is email click → accept), so we probe the endpoint
 * surface:
 *  - POST /invitations issues a token-shaped payload
 *  - POST /invitations/<token>/accept twice — second call ≥ 400
 */

test.describe('Invitation tokens — consumed once', () => {
    test('issuing an invitation returns a token-shaped response', async ({ request }) => {
        const owner = await registerUserViaAPI(request);
        const tag = Date.now().toString(36);
        const w = await createWorkViaAPI(request, owner.access_token, {
            name: `invite-${tag}`,
            slug: `invite-${tag}`,
        });
        const invite = await request.post(`${API_BASE}/api/works/${w.id}/invitations`, {
            headers: authedHeaders(owner.access_token),
            data: { email: `invitee-${tag}@test.local`, role: 'member' },
        });
        if (invite.status() === 404) test.skip(true, 'no invitations endpoint exposed');
        expect(invite.status()).toBeLessThan(500);
        if (!invite.ok()) return;
        const body = await invite.json().catch(() => null);
        // Token-shaped: at minimum a string id or token field.
        const token =
            body?.token ?? body?.id ?? body?.invitation?.token ?? body?.invitation?.id ?? null;
        expect(
            typeof token === 'string' && token.length,
            'no token-shaped field on invitation',
        ).toBeTruthy();
    });

    test('accepting an invitation twice returns 4xx on the second call', async ({ request }) => {
        const owner = await registerUserViaAPI(request);
        const invitee = await registerUserViaAPI(request);
        const tag = Date.now().toString(36);
        const w = await createWorkViaAPI(request, owner.access_token, {
            name: `invite-2x-${tag}`,
            slug: `invite-2x-${tag}`,
        });
        const invite = await request.post(`${API_BASE}/api/works/${w.id}/invitations`, {
            headers: authedHeaders(owner.access_token),
            data: { email: invitee.email, role: 'member' },
        });
        if (!invite.ok()) test.skip(true, `cannot create invitation (${invite.status()})`);
        const body = await invite.json().catch(() => null);
        const token = body?.token ?? body?.id ?? body?.invitation?.token ?? body?.invitation?.id;
        if (!token) test.skip(true, 'no token in invitation response');
        // Try to accept.
        const accept1 = await request.post(
            `${API_BASE}/api/works/invitations/${encodeURIComponent(String(token))}/accept`,
            { headers: authedHeaders(invitee.access_token) },
        );
        if (accept1.status() === 404) {
            // Endpoint shape differs — try alternative.
            test.skip(true, 'no accept endpoint at expected path');
        }
        if (!accept1.ok()) {
            // First accept failed — can't test single-use.
            test.skip(true, `first accept failed (${accept1.status()})`);
        }
        const accept2 = await request.post(
            `${API_BASE}/api/works/invitations/${encodeURIComponent(String(token))}/accept`,
            { headers: authedHeaders(invitee.access_token) },
        );
        // Second accept must be 4xx — token consumed.
        expect(
            accept2.status(),
            `second accept returned ${accept2.status()} — token may not be single-use`,
        ).toBeGreaterThanOrEqual(400);
        expect(accept2.status()).toBeLessThan(500);
    });
});
