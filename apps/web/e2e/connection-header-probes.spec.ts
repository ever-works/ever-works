import { test, expect } from '@playwright/test';
import { API_BASE } from './helpers/api';

/**
 * Connection / Upgrade / hop-by-hop header tolerance on public
 * endpoints. The server should never 5xx when a client sends
 * unusual hop-by-hop directives, and should never leak the
 * Server / X-Powered-By framework name (basic hardening).
 */

const PUBLIC_PATHS = ['/api/health', '/.well-known/agent.json', '/api/version'];

test.describe('Connection / hop-by-hop tolerance', () => {
	for (const path of PUBLIC_PATHS) {
		test(`GET ${path} with Connection: close`, async ({ request }) => {
			const res = await request.get(`${API_BASE}${path}`, {
				headers: { Connection: 'close' },
			});
			expect(res.status(), `${path} conn=close`).toBeLessThan(500);
		});

		test(`GET ${path} with Connection: keep-alive`, async ({ request }) => {
			const res = await request.get(`${API_BASE}${path}`, {
				headers: { Connection: 'keep-alive' },
			});
			expect(res.status(), `${path} conn=keep-alive`).toBeLessThan(500);
		});

		test(`GET ${path} with Upgrade: TLS/1.3`, async ({ request }) => {
			const res = await request.get(`${API_BASE}${path}`, {
				headers: { Upgrade: 'TLS/1.3' },
			});
			expect(res.status(), `${path} upgrade`).toBeLessThan(500);
		});

		test(`GET ${path} with TE: trailers`, async ({ request }) => {
			const res = await request.get(`${API_BASE}${path}`, {
				headers: { TE: 'trailers' },
			});
			expect(res.status(), `${path} te`).toBeLessThan(500);
		});

		test(`GET ${path} does not leak X-Powered-By`, async ({ request }) => {
			const res = await request.get(`${API_BASE}${path}`);
			const poweredBy = res.headers()['x-powered-by'];
			// Either absent, or masked to something non-identifying.
			if (poweredBy) {
				expect(poweredBy.toLowerCase(), `x-powered-by on ${path}`).not.toMatch(
					/express|nest|node|nginx/i,
				);
			}
		});
	}
});
