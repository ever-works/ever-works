import { test, expect } from '@playwright/test';
import { API_BASE } from './helpers/api';

/**
 * CORS preflight (OPTIONS) probes with edge-shape Origin headers. The
 * server should never 5xx and should not blanket-allow when the Origin
 * is obviously invalid (file://, null, empty, IP-shaped).
 */

const PUBLIC_ENDPOINTS = ['/api/health', '/api/works', '/.well-known/agent.json'];

const EDGE_ORIGINS = [
	'',
	'null',
	'file://',
	'http://localhost',
	'http://127.0.0.1',
	'https://attacker.example',
	'data:text/html,<script>alert(1)</script>',
	'chrome-extension://abcdef',
	'moz-extension://abcdef',
	'https://example.com.attacker.example', // subdomain-confusion shape
];

test.describe('CORS preflight: edge Origin tolerance', () => {
	for (const path of PUBLIC_ENDPOINTS) {
		for (const origin of EDGE_ORIGINS) {
			test(`OPTIONS ${path} with Origin="${origin}"`, async ({ request }) => {
				const res = await request.fetch(`${API_BASE}${path}`, {
					method: 'OPTIONS',
					headers: {
						Origin: origin,
						'Access-Control-Request-Method': 'GET',
					},
				});
				expect(res.status(), `${path} origin=${origin}`).toBeLessThan(500);
				const allow = res.headers()['access-control-allow-origin'];
				if (allow) {
					// If the server allows ANY origin (`*`), make sure it's not also sending credentials (would be a real misconfig).
					if (allow === '*') {
						const allowCreds = res.headers()['access-control-allow-credentials'];
						expect(allowCreds).not.toBe('true');
					}
				}
			});
		}
	}
});
