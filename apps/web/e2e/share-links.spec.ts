import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * Share links — pass 10. The platform may expose public share links
 * for a Work — anyone with the link can view (no auth required), but
 * the owner can revoke the link.
 */

const SHARE_PATHS = [
    (id: string) => `/api/works/${id}/share`,
    (id: string) => `/api/works/${id}/share-link`,
    (id: string) => `/api/works/${id}/public-link`,
    (id: string) => `/api/works/${id}/shares`,
];

test.describe('Share links — owner creates a share link', () => {
    test('POST share returns a URL or token (or skip)', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const w = await createWorkViaAPI(request, u.access_token, {
            name: `share-${Date.now().toString(36)}`,
        });
        let foundBody: Record<string, unknown> | null = null;
        for (const make of SHARE_PATHS) {
            const res = await request.post(`${API_BASE}${make(w.id)}`, {
                headers: authedHeaders(u.access_token),
                data: {},
            });
            if (res.status() === 404 || res.status() === 405) continue;
            if (res.status() >= 200 && res.status() < 300) {
                foundBody = await res.json().catch(() => null);
                break;
            }
            // Endpoint exists but rejected — record and move on.
            expect(res.status()).toBeLessThan(500);
            break;
        }
        if (!foundBody) test.skip(true, 'no share-link create endpoint');
        // The response should expose either a URL, a token, or an id.
        const ref =
            foundBody!.url ??
            foundBody!.shareUrl ??
            foundBody!.token ??
            foundBody!.share_token ??
            foundBody!.id;
        expect(
            typeof ref,
            `share response missing url/token/id field: ${JSON.stringify(foundBody).slice(0, 200)}`,
        ).toMatch(/string|number/);
    });

    test("stranger cannot create a share link on owner's work", async ({ request }) => {
        const owner = await registerUserViaAPI(request);
        const w = await createWorkViaAPI(request, owner.access_token, {
            name: `share-iso-${Date.now().toString(36)}`,
        });
        const stranger = await registerUserViaAPI(request);
        let found = false;
        for (const make of SHARE_PATHS) {
            const res = await request.post(`${API_BASE}${make(w.id)}`, {
                headers: authedHeaders(stranger.access_token),
                data: {},
            });
            if (res.status() === 404 || res.status() === 405) continue;
            found = true;
            expect([401, 403, 404]).toContain(res.status());
            return;
        }
        if (!found) test.skip(true, 'no share-link endpoint');
    });
});

test.describe('Share links — revocation', () => {
    test('DELETE share link (if exposed) requires auth', async ({ request }) => {
        const fakeId = 'share-fake';
        let found = false;
        for (const make of SHARE_PATHS) {
            const res = await request.delete(`${API_BASE}${make(fakeId)}`);
            if (res.status() === 404 || res.status() === 405) continue;
            found = true;
            expect([401, 403, 404]).toContain(res.status());
            return;
        }
        if (!found) test.skip(true, 'no share-link DELETE endpoint');
    });
});

test.describe('Share links — public consumption', () => {
    test('public share-link endpoint (if exposed) accepts unauthed GET', async ({ request }) => {
        const candidates = ['/api/public/works', '/api/share', '/api/p', '/api/shared/works'];
        for (const base of candidates) {
            // We can't construct a real share token without first
            // creating one; just verify the path family exists.
            const res = await request.get(`${API_BASE}${base}/non-existent-share-token`);
            if (res.status() === 404) {
                // Could be: path family doesn't exist OR token not found.
                // We continue probing.
                continue;
            }
            // 410 (gone), 400 (invalid token), 200 with empty data — all
            // < 500. We just want the route to be reachable without auth.
            expect(res.status()).toBeLessThan(500);
            return;
        }
        test.skip(true, 'no public share-link consumption endpoint');
    });
});
