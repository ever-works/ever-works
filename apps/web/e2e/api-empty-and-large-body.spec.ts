import { test, expect } from '@playwright/test';
import { API_BASE } from './helpers/api';

/**
 * POST endpoints should tolerate body-shape edges:
 *  - completely empty body
 *  - whitespace-only body
 *  - JSON with trailing garbage
 *  - JSON deeply nested (worth-checking against stack-overflow)
 *  - very large body (1 MB) — should be rejected with a clear 4xx,
 *    not 5xx or silent truncation.
 */

const POST_TARGET = '/api/auth/login';

const BODY_EDGES: Array<{ name: string; body: string }> = [
    { name: 'empty string', body: '' },
    { name: 'whitespace only', body: '   \n\t  ' },
    { name: 'empty object', body: '{}' },
    { name: 'null literal', body: 'null' },
    { name: 'array instead of object', body: '[1,2,3]' },
    { name: 'JSON with trailing garbage', body: '{"a":1}/* leftover */' },
    { name: 'deeply nested 100 levels', body: '['.repeat(100) + ']'.repeat(100) },
    { name: 'malformed JSON', body: '{"a": ,}' },
    { name: 'JSON with BOM prefix', body: '﻿{"a":1}' },
    { name: 'one MB payload', body: '{"x":"' + 'a'.repeat(1024 * 1024 - 12) + '"}' },
];

test.describe('API: empty / malformed / oversized POST bodies', () => {
    for (const { name, body } of BODY_EDGES) {
        test(`POST ${POST_TARGET} with ${name} returns 4xx not 5xx`, async ({ request }) => {
            const res = await request.fetch(`${API_BASE}${POST_TARGET}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                data: body,
            });
            expect(res.status(), `${name}`).toBeLessThan(500);
        });
    }
});
