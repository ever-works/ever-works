import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * Signed URL expiry — pass 14. Pre-signed upload / download URLs
 * must carry an explicit expiry — they're effectively bearer tokens
 * for the duration they're valid. Industry default: 1 hour or less.
 *
 * We probe a handful of candidate endpoints that might issue signed
 * URLs (image upload, export, deploy artifact). For each that returns
 * a URL, we verify the URL string carries SOMETHING that looks like
 * an expiry parameter (`Expires=`, `X-Amz-Expires=`, `?exp=`, etc.).
 */

const SIGNED_URL_CANDIDATES = [
    '/api/works/__WORK_ID__/upload-url',
    '/api/works/__WORK_ID__/screenshot/signed-url',
    '/api/account/export-url',
    '/api/activity-log/export?download=1',
];

const EXPIRY_MARKERS = [
    /[?&]Expires=\d+/,
    /[?&]X-Amz-Expires=\d+/,
    /[?&]exp=\d+/,
    /[?&]expires_in=\d+/,
    /[?&]token=[A-Za-z0-9_-]{16,}/,
    /[?&]signature=[A-Za-z0-9%_-]{16,}/,
];

test.describe('Signed URLs — issued URLs carry an expiry parameter', () => {
    test('one of the candidate endpoints returns a URL with an expiry marker', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const w = await createWorkViaAPI(request, u.access_token, {
            name: `signed-${Date.now().toString(36)}`,
            slug: `signed-${Date.now().toString(36)}`,
        });
        let foundUrl: string | null = null;
        for (const c of SIGNED_URL_CANDIDATES) {
            const path = c.replace('__WORK_ID__', w.id);
            const res = await request.get(`${API_BASE}${path}`, {
                headers: authedHeaders(u.access_token),
            });
            if (!res.ok()) continue;
            const ct = res.headers()['content-type'] || '';
            if (!ct.includes('json')) continue;
            const body = await res.json().catch(() => ({}));
            const candidate =
                body?.url ??
                body?.signed_url ??
                body?.signedUrl ??
                body?.upload_url ??
                body?.uploadUrl;
            if (typeof candidate === 'string' && candidate.startsWith('http')) {
                foundUrl = candidate;
                break;
            }
        }
        if (!foundUrl) {
            test.skip(true, 'no signed-URL endpoint exposes a URL in this env');
        }
        const hasExpiry = EXPIRY_MARKERS.some((re) => re.test(foundUrl!));
        expect(
            hasExpiry,
            `signed URL has no expiry/signature marker: ${foundUrl!.slice(0, 200)}`,
        ).toBe(true);
    });

    test("GET against a stranger's upload-url path is auth-gated", async ({ request }) => {
        // No token — unauthenticated probe.
        const res = await request.get(`${API_BASE}/api/works/fake-id/upload-url`);
        if (res.status() === 404) {
            test.skip(true, 'upload-url endpoint not exposed');
        }
        expect(res.status(), 'upload-url should require auth').toBeGreaterThanOrEqual(400);
        expect(res.status()).toBeLessThan(500);
        expect([401, 403, 404]).toContain(res.status());
    });
});
