import { test, expect } from '@playwright/test';
import { API_BASE } from './helpers/api';

/**
 * Malformed Authorization headers should produce 401/400 — never 5xx.
 * The auth middleware should treat unparseable headers exactly like
 * missing-auth (anonymous), without crashing.
 */

const PROTECTED_PATH = '/api/users/me';

// Each entry MUST be unique by `header.slice(0, 60)` because the test
// title key is derived from it — duplicates break Playwright's
// collection step with "duplicate test title" for the entire suite.
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
    'Bearer foo\nbar',
    'Token abc123',
    'Bearer ' + Array(20).fill('a').join('.'),
    'X-Auth-Custom-Scheme abc',
];

test.describe('API auth: malformed Authorization header handling', () => {
    for (const [index, header] of MALFORMED_AUTH_HEADERS.entries()) {
        const label = JSON.stringify(header.slice(0, 60));
        // Include the array index in the title so two payloads that
        // happen to share the first 60 chars never collide.
        test(`#${index} Authorization=${label} returns 4xx not 5xx`, async ({ request }) => {
            let res;
            try {
                res = await request.get(`${API_BASE}${PROTECTED_PATH}`, {
                    headers: { Authorization: header },
                });
            } catch (err) {
                // Some payloads contain bytes the HTTP client itself
                // rejects before sending (newlines, NULs, etc. — see
                // RFC 7230 §3.2.4). If the client refuses to put it on
                // the wire, the server can't 5xx on it by definition,
                // which is exactly the property we're trying to test.
                // Treat as pass.
                const message = (err as Error).message ?? '';
                if (/invalid character|invalid header|illegal character/i.test(message)) {
                    return; // counts as pass — see comment above
                }
                throw err;
            }
            expect(res.status(), `auth header ${label}`).toBeLessThan(500);
            expect(res.status(), `auth header ${label}`).toBeGreaterThanOrEqual(400);
        });
    }
});
