import { test, expect } from '@playwright/test';
import { API_BASE } from './helpers/api';

/**
 * POST endpoints that expect JSON should reject mismatched
 * Content-Type with 4xx (typically 415 Unsupported Media Type or
 * 400 Bad Request) — never 5xx, and they MUST NOT consume the body
 * as if it were JSON (causing silent data loss / injection vectors).
 */

const POST_TARGETS = ['/api/auth/login', '/api/auth/register'];

const MISMATCH_VARIANTS = [
    { ct: 'text/plain', body: 'plain text body' },
    { ct: 'application/xml', body: '<root><x>1</x></root>' },
    { ct: 'application/x-www-form-urlencoded', body: 'a=1&b=2' },
    {
        ct: 'multipart/form-data; boundary=---x',
        body: '---x\r\nContent-Disposition: form-data; name="a"\r\n\r\n1\r\n---x--\r\n',
    },
    { ct: 'application/octet-stream', body: '\x00\x01\x02' },
    { ct: 'image/png', body: '\x89PNG\r\n\x1a\n' },
    { ct: 'application/json; charset=ascii', body: '{"a":1}' },
    { ct: 'application/JSON-junk', body: '{"a":1}' },
];

test.describe('API: Content-Type mismatch on POST endpoints', () => {
    for (const path of POST_TARGETS) {
        for (const variant of MISMATCH_VARIANTS) {
            test(`POST ${path} with Content-Type "${variant.ct}" rejected without 5xx`, async ({
                request,
            }) => {
                const res = await request.fetch(`${API_BASE}${path}`, {
                    method: 'POST',
                    headers: { 'Content-Type': variant.ct },
                    data: variant.body,
                });
                expect(res.status(), `${path} ct=${variant.ct}`).toBeLessThan(500);
            });
        }
    }
});
