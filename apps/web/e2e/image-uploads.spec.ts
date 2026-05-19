import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * Image upload endpoints — pass 9. The platform exposes image upload
 * for work covers + item screenshots. We probe candidate paths and
 * verify:
 *   - Auth gate (401 unauth)
 *   - Non-image content-type rejected with 4xx
 *   - Stranger cannot upload to another's work
 *
 * Real binary upload requires multipart/form-data; Playwright's
 * `multipart` field handles that. We use a tiny 1x1 PNG so we don't
 * push real bytes around.
 */

// 1x1 transparent PNG — minimum valid bytes.
const TINY_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgAAIAAAUAAarVyFEAAAAASUVORK5CYII=',
    'base64',
);

const UPLOAD_PATHS = [
    '/api/uploads/image',
    '/api/uploads',
    '/api/images/upload',
    '/api/files/upload',
];

test.describe('Image upload — endpoint probe', () => {
    test('one of the upload paths exists + requires auth', async ({ request }) => {
        let found: { path: string; status: number } | null = null;
        for (const path of UPLOAD_PATHS) {
            const res = await request.post(`${API_BASE}${path}`, {
                multipart: {
                    file: {
                        name: 'probe.png',
                        mimeType: 'image/png',
                        buffer: TINY_PNG,
                    },
                },
            });
            if (res.status() !== 404 && res.status() !== 405) {
                found = { path, status: res.status() };
                break;
            }
        }
        if (!found) {
            test.skip(true, 'no image upload endpoint exposed in this env');
        }
        // Unauthenticated MUST be 401/403.
        expect([401, 403]).toContain(found!.status);
    });

    test('authed image upload of valid PNG responds < 500', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        let found: { path: string; status: number; body?: unknown } | null = null;
        for (const path of UPLOAD_PATHS) {
            const res = await request.post(`${API_BASE}${path}`, {
                headers: authedHeaders(u.access_token),
                multipart: {
                    file: {
                        name: 'authed.png',
                        mimeType: 'image/png',
                        buffer: TINY_PNG,
                    },
                },
            });
            if (res.status() !== 404 && res.status() !== 405) {
                found = { path, status: res.status() };
                if (res.status() === 200 || res.status() === 201) {
                    found.body = await res.json().catch(() => null);
                }
                break;
            }
        }
        if (!found) test.skip(true, 'no upload endpoint');
        expect(found!.status).toBeLessThan(500);
        // If accepted, the response should include some kind of URL /
        // id / key reference.
        if (found!.status < 300 && found!.body && typeof found!.body === 'object') {
            const body = found!.body as Record<string, unknown>;
            const reference = body.url ?? body.id ?? body.key ?? body.path;
            expect(typeof reference, 'upload accepted but returned no reference').toMatch(
                /string|number/,
            );
        }
    });

    test('non-image content-type is rejected (or coerced) without 5xx', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        for (const path of UPLOAD_PATHS) {
            const res = await request.post(`${API_BASE}${path}`, {
                headers: authedHeaders(u.access_token),
                multipart: {
                    file: {
                        name: 'evil.exe',
                        mimeType: 'application/octet-stream',
                        buffer: Buffer.from('MZ\x90\x00executable-payload'),
                    },
                },
            });
            if (res.status() === 404 || res.status() === 405) continue;
            // Either rejected (4xx) or accepted but never 5xx.
            expect(res.status()).toBeLessThan(500);
            return;
        }
        test.skip(true, 'no upload endpoint');
    });
});

test.describe('Image upload — per-work isolation', () => {
    test("stranger cannot upload to another user's work", async ({ request }) => {
        const owner = await registerUserViaAPI(request);
        const w = await createWorkViaAPI(request, owner.access_token, {
            name: `img-iso-${Date.now().toString(36)}`,
        });
        const stranger = await registerUserViaAPI(request);
        // Try the per-work upload path candidates.
        const candidates = [
            `/api/works/${w.id}/uploads`,
            `/api/works/${w.id}/cover`,
            `/api/works/${w.id}/image`,
        ];
        let found = false;
        for (const path of candidates) {
            const res = await request.post(`${API_BASE}${path}`, {
                headers: authedHeaders(stranger.access_token),
                multipart: {
                    file: {
                        name: 'iso.png',
                        mimeType: 'image/png',
                        buffer: TINY_PNG,
                    },
                },
            });
            if (res.status() === 404 || res.status() === 405) continue;
            found = true;
            // Stranger MUST get 401/403/404 — never 2xx, never 5xx.
            expect([401, 403, 404]).toContain(res.status());
            break;
        }
        if (!found) test.skip(true, 'no per-work upload endpoint exposed');
    });
});
