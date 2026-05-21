import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * Invitation token single-use — pass 20 (re-pinned after EW-632 close-out).
 *
 * Invitations are issued via `POST /api/works/:workId/invitations` and
 * return a tokenised `claimUrl` ONCE at creation. The token is then
 * consumed via the public claim flow under `/api/claim/*`:
 *
 *   - GET  /api/claim/preview?token=...  (PUBLIC, throttled — does NOT consume)
 *   - POST /api/claim/accept             (authenticated, consumes)
 *
 * Earlier revisions of this spec probed `/api/works/invitations/:token/accept`
 * defensively and skipped on 404. The real endpoints exist (PR #687,
 * EW-600) so we now assert rather than skip.
 */

interface InvitationCreatePayload {
    email: string;
    role: 'manager' | 'editor' | 'viewer';
}

/**
 * Extract the raw token out of a created invitation response.
 *
 * The API embeds the token in `claimUrl` (returned ONCE) — we never
 * see the raw token field directly. Parse it out of the URL.
 */
function extractClaimToken(body: unknown): string | null {
    const claimUrl =
        (body as { claimUrl?: string })?.claimUrl ??
        (body as { invitation?: { claimUrl?: string } })?.invitation?.claimUrl ??
        null;
    if (!claimUrl) return null;
    const match = claimUrl.match(/\/claim\/([^/?#]+)/);
    return match?.[1] ?? null;
}

test.describe('Invitation tokens — consumed once', () => {
    test('issuing an invitation returns a claim URL with a token', async ({ request }) => {
        const owner = await registerUserViaAPI(request);
        const tag = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const w = await createWorkViaAPI(request, owner.access_token, {
            name: `invite-${tag}`,
            slug: `invite-${tag}`,
        });

        const payload: InvitationCreatePayload = {
            email: `invitee-${tag}@test.local`,
            role: 'editor',
        };
        const invite = await request.post(`${API_BASE}/api/works/${w.id}/invitations`, {
            headers: authedHeaders(owner.access_token),
            data: payload,
        });

        // Endpoint exists (EW-600 shipped 2026-05-11), so this MUST succeed
        // for a fresh owner-on-own-work request.
        expect(
            invite.status(),
            `expected invitation create to succeed, got ${invite.status()}`,
        ).toBeGreaterThanOrEqual(200);
        expect(invite.status()).toBeLessThan(300);

        const body = await invite.json();
        const token = extractClaimToken(body);
        expect(token, 'no token-shaped field on invitation response').toBeTruthy();
        expect(token!.length, 'token suspiciously short').toBeGreaterThanOrEqual(32);
    });

    test('claim preview does NOT consume the token', async ({ request }) => {
        const owner = await registerUserViaAPI(request);
        const tag = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const w = await createWorkViaAPI(request, owner.access_token, {
            name: `invite-prev-${tag}`,
            slug: `invite-prev-${tag}`,
        });

        const invite = await request.post(`${API_BASE}/api/works/${w.id}/invitations`, {
            headers: authedHeaders(owner.access_token),
            data: { email: `invitee-${tag}@test.local`, role: 'editor' },
        });
        expect(invite.ok(), `invitation create failed: ${invite.status()}`).toBe(true);
        const token = extractClaimToken(await invite.json());
        expect(token).toBeTruthy();

        // Preview is public and idempotent — calling it twice must succeed
        // both times and report the same role.
        const preview1 = await request.get(
            `${API_BASE}/api/claim/preview?token=${encodeURIComponent(token!)}`,
        );
        expect(preview1.status(), 'first preview must succeed').toBe(200);
        const preview1Body = await preview1.json();
        expect(preview1Body.role).toBe('editor');

        const preview2 = await request.get(
            `${API_BASE}/api/claim/preview?token=${encodeURIComponent(token!)}`,
        );
        expect(preview2.status(), 'second preview must still succeed (preview is read-only)').toBe(
            200,
        );
    });

    test('accepting an invitation twice returns 4xx on the second call', async ({ request }) => {
        const owner = await registerUserViaAPI(request);
        const invitee = await registerUserViaAPI(request);
        const tag = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const w = await createWorkViaAPI(request, owner.access_token, {
            name: `invite-2x-${tag}`,
            slug: `invite-2x-${tag}`,
        });

        const invite = await request.post(`${API_BASE}/api/works/${w.id}/invitations`, {
            headers: authedHeaders(owner.access_token),
            data: { email: invitee.email, role: 'editor' },
        });
        expect(invite.ok(), `invitation create failed: ${invite.status()}`).toBe(true);
        const token = extractClaimToken(await invite.json());
        expect(token, 'no token in invitation response').toBeTruthy();

        // First accept: must succeed (creates a WorkMember row for the
        // invitee with role=editor).
        const accept1 = await request.post(`${API_BASE}/api/claim/accept`, {
            headers: authedHeaders(invitee.access_token),
            data: { token },
        });
        expect(
            accept1.status(),
            `first accept must succeed, got ${accept1.status()}`,
        ).toBeGreaterThanOrEqual(200);
        expect(accept1.status()).toBeLessThan(300);

        // Second accept with the same token: must fail with a 4xx (token
        // already consumed; no silent dup-member, no 5xx).
        const accept2 = await request.post(`${API_BASE}/api/claim/accept`, {
            headers: authedHeaders(invitee.access_token),
            data: { token },
        });
        expect(
            accept2.status(),
            `second accept returned ${accept2.status()} — token may not be single-use`,
        ).toBeGreaterThanOrEqual(400);
        expect(accept2.status()).toBeLessThan(500);
    });
});
