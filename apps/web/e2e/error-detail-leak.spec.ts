import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Error detail leak — pass 16. When the API returns 5xx (or even 4xx
 * for an unexpected error), the response body must NOT include
 * stack traces, file paths, or database driver error codes verbatim.
 * Production-shaped error responses look like `{statusCode, message,
 * error}` — leaking internal detail aids attackers in fingerprinting
 * the stack.
 *
 * We deliberately trigger error paths by sending malformed payloads
 * and check the response bodies for leak markers.
 */

const LEAK_MARKERS = [
    /at\s+\w+\.\w+\s*\([^)]*:\d+:\d+\)/, // stack frame "at Foo.bar (/path/file.ts:12:34)"
    /\/(?:home|usr|opt|app)\/[^\s"']+\.(?:ts|js|tsx)/, // unix absolute paths to source files
    /[A-Z]:\\[^\s"']+\.(?:ts|js|tsx)/, // windows absolute paths to source files
    /node_modules\/[^\s"']+\.(?:ts|js|cjs|mjs)/, // node_modules paths
    /ER_(?:[A-Z_]+)/, // MySQL error codes (ER_DUP_ENTRY etc.)
    /SQLITE_(?:[A-Z_]+)/, // SQLite error codes
    /pg_(?:[a-z_]+):/, // Postgres error codes (e.g. pg_unique_violation)
    /Error: connect ECONNREFUSED/, // raw Node ECONNREFUSED
];

function leaks(body: string): RegExpMatchArray | null {
    for (const re of LEAK_MARKERS) {
        const m = body.match(re);
        if (m) return m;
    }
    return null;
}

test.describe('Error responses — no stack/path/DB-code leakage', () => {
    test('POST /api/works with malformed JSON body returns a clean error envelope', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.post(`${API_BASE}/api/works`, {
            headers: {
                ...authedHeaders(u.access_token),
                'Content-Type': 'application/json',
            },
            data: 'this is not json {{{ broken',
        });
        const body = await res.text();
        const leak = leaks(body);
        expect(
            leak,
            `malformed-body error response leaked internal detail: "${leak?.[0]}"`,
        ).toBeNull();
    });

    test('GET /api/works/<bogus-uuid> returns a clean error envelope', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/works/not-a-real-uuid-or-id-12345`, {
            headers: authedHeaders(u.access_token),
        });
        const body = await res.text();
        const leak = leaks(body);
        expect(leak, `bogus-id error response leaked: "${leak?.[0]}"`).toBeNull();
    });

    test('POST /api/works with extreme nested payload does not leak internals', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        // Deeply nested object that some JSON parsers reject.
        let nested: unknown = 1;
        for (let i = 0; i < 200; i++) nested = { x: nested };
        const res = await request.post(`${API_BASE}/api/works`, {
            headers: authedHeaders(u.access_token),
            data: { name: 'deep', slug: 'deep', extras: nested },
        });
        const body = await res.text();
        const leak = leaks(body);
        expect(leak, `nested-payload error response leaked: "${leak?.[0]}"`).toBeNull();
    });
});
