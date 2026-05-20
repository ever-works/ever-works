import { test, expect } from '@playwright/test';
import { API_BASE } from './helpers/api';

/**
 * Malformed Authorization headers should produce 401/400 — never 5xx.
 * The auth middleware should treat unparseable headers exactly like
 * missing-auth (anonymous), without crashing.
 */

const PROTECTED_PATH = '/api/users/me';

const MALFORMED_AUTH_HEADERS = [
    '',
    'Bearer',
    'Bearer ',
    'bearer lowercase-scheme',
    'Bearer ' + 'a'.repeat(8192),
    'Bearer\ttab-separated',
    'Bearer x.y.z',
    'Basic dXNlcjpwYXNz',
    'Digest realm="x"',
    'Bearer null',
    'Bearer undefined',
    'Bearer ',
    'Bearer foo\nbar',
    'Token abc123',
    'Bearer ' + Array(20).fill('a').join('.'),
    'X-Auth-Custom-Scheme abc',
];

test.describe('API auth: malformed Authorization header handling', () => {
    for (const header of MALFORMED_AUTH_HEADERS) {
        const label = JSON.stringify(header.slice(0, 60));
        test(`Authorization=${label} returns 4xx not 5xx`, async ({ request }) => {
            const res = await request.get(`${API_BASE}${PROTECTED_PATH}`, {
                headers: { Authorization: header },
            });
            expect(res.status(), `auth header ${label}`).toBeLessThan(500);
            expect(res.status(), `auth header ${label}`).toBeGreaterThanOrEqual(400);
        });
    }
});
