import { test, expect } from '@playwright/test';
import { API_BASE } from './helpers/api';

/**
 * JSON responses should either declare `charset=utf-8` explicitly in
 * Content-Type, or omit charset entirely (per RFC 8259, JSON is
 * always UTF-8 and an explicit charset is technically redundant).
 * What they MUST NOT do is declare a different charset, which would
 * cause clients to mis-decode the body.
 */

const JSON_PATHS = [
    '/api/health',
    '/api/version',
    '/api/info',
    '/api/works',
    '/.well-known/agent.json',
];

test.describe('API JSON responses: charset declaration', () => {
    for (const path of JSON_PATHS) {
        test(`${path} Content-Type charset is utf-8 or omitted`, async ({ request }) => {
            const res = await request.get(`${API_BASE}${path}`);
            const ct = (res.headers()['content-type'] || '').toLowerCase();
            if (!ct.includes('application/json')) return;
            const charsetMatch = ct.match(/charset\s*=\s*([^;\s]+)/);
            if (!charsetMatch) return; // omitting charset is acceptable per RFC 8259
            expect(charsetMatch[1], `charset for ${path}`).toMatch(/^("?)utf-?8\1$/);
        });
    }
});
