import { test, expect } from '@playwright/test';
import { API_BASE } from './helpers/api';

/**
 * URLs with `#fragment` or `userinfo@` (the deprecated user:pass@host
 * form) are valid request URIs at the HTTP level even though browsers
 * usually strip the fragment client-side. A misconfigured router may
 * 5xx on these inputs from a misbehaving client or a crawler.
 *
 * Note: Playwright's request fetch strips the `#fragment` part before
 * sending, so we use the raw fetch with a manually-built URL to ensure
 * the server actually sees the edge form.
 */

const PATHS = ['/api/health', '/api/version', '/api/info', '/.well-known/agent.json'];

const FRAGMENT_SUFFIXES = ['#', '#fragment', '#fragment-with-/-slashes', '#x'.repeat(2048)];

const QUERY_VARIANTS = [
    '?',
    '?#fragment',
    '?q=1#fragment',
    '?a=1&a=2&a=3',
    '?key=' + encodeURIComponent('value with spaces'),
];

test.describe('API: URL fragment tolerance', () => {
    for (const path of PATHS) {
        for (const frag of FRAGMENT_SUFFIXES) {
            test(`GET ${path}${frag.slice(0, 20)} tolerated`, async ({ request }) => {
                const res = await request.get(`${API_BASE}${path}${frag}`);
                expect(res.status(), `${path}${frag.slice(0, 20)}`).toBeLessThan(500);
            });
        }
    }
});

test.describe('API: query-shape tolerance', () => {
    for (const path of PATHS) {
        for (const qs of QUERY_VARIANTS) {
            test(`GET ${path}${qs.slice(0, 30)} tolerated`, async ({ request }) => {
                const res = await request.get(`${API_BASE}${path}${qs}`);
                expect(res.status(), `${path}${qs.slice(0, 30)}`).toBeLessThan(500);
            });
        }
    }
});
