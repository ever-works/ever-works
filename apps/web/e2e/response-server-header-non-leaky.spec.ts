import { test, expect } from '@playwright/test';
import { API_BASE } from './helpers/api';

/**
 * Response Server / X-Powered-By headers must not leak software
 * version strings. They can be absent (best) or generic — but
 * not e.g. `nginx/1.25.3` or `Express` or `Next.js/14.2.5`.
 *
 * Versioned Server headers are a free vulnerability scanner for
 * attackers — they let CVE matching skip the recon phase.
 */

const PUBLIC_PATHS = ['/', '/api/health', '/api/version', '/.well-known/agent.json'];

// Patterns that indicate a version leak in a response header.
const LEAKY_PATTERNS = [
    /nginx\/[\d.]+/i,
    /apache\/[\d.]+/i,
    /express/i,
    /next\.?js/i,
    /node\.?js/i,
    /iis\/[\d.]+/i,
    /openresty/i,
    /cherrypy/i,
    /gunicorn/i,
    /werkzeug/i,
    /uwsgi/i,
];

test.describe('Response headers: no software version leakage', () => {
    for (const path of PUBLIC_PATHS) {
        test(`GET ${path} Server header is not version-leaky`, async ({ request }) => {
            const res = await request.get(`${API_BASE}${path}`);
            expect(res.status(), path).toBeLessThan(500);
            const headers = res.headers();
            const server = headers['server'];
            if (server) {
                for (const pat of LEAKY_PATTERNS) {
                    expect(server, `Server header on ${path}`).not.toMatch(pat);
                }
            }
        });

        test(`GET ${path} X-Powered-By is not present or not version-leaky`, async ({
            request,
        }) => {
            const res = await request.get(`${API_BASE}${path}`);
            const headers = res.headers();
            const xpb = headers['x-powered-by'];
            if (xpb) {
                for (const pat of LEAKY_PATTERNS) {
                    expect(xpb, `X-Powered-By on ${path}`).not.toMatch(pat);
                }
            }
        });
    }
});
