import { test, expect } from '@playwright/test';
import { API_BASE } from './helpers/api';

/**
 * Proxy/Forwarded header tolerance. The platform sits behind a CDN/proxy
 * in production, so it must accept (or ignore) malformed X-Forwarded-*
 * and Forwarded headers without 5xx.
 */

const PROBES: Array<{ label: string; headers: Record<string, string> }> = [
	{ label: 'empty XFF', headers: { 'X-Forwarded-For': '' } },
	{ label: 'single XFF IP', headers: { 'X-Forwarded-For': '203.0.113.1' } },
	{ label: 'chained XFF IPs', headers: { 'X-Forwarded-For': '10.0.0.1, 203.0.113.1, 198.51.100.1' } },
	{ label: 'XFF with port', headers: { 'X-Forwarded-For': '203.0.113.1:8080' } },
	{ label: 'XFF IPv6', headers: { 'X-Forwarded-For': '2001:db8::1' } },
	{ label: 'malformed XFF', headers: { 'X-Forwarded-For': 'not-an-ip!!!' } },
	{ label: 'huge XFF (CRLF stripped)', headers: { 'X-Forwarded-For': '203.0.113.1, '.repeat(50) + '203.0.113.99' } },
	{ label: 'X-Forwarded-Proto http', headers: { 'X-Forwarded-Proto': 'http' } },
	{ label: 'X-Forwarded-Proto https', headers: { 'X-Forwarded-Proto': 'https' } },
	{ label: 'X-Forwarded-Proto malformed', headers: { 'X-Forwarded-Proto': 'gopher' } },
	{ label: 'X-Forwarded-Host', headers: { 'X-Forwarded-Host': 'attacker.example' } },
	{ label: 'RFC7239 Forwarded', headers: { Forwarded: 'for=203.0.113.1;proto=https;host=example.com' } },
	{ label: 'RFC7239 Forwarded malformed', headers: { Forwarded: 'not-a-valid-forwarded-header' } },
];

test.describe('Forwarded/X-Forwarded header tolerance', () => {
	for (const { label, headers } of PROBES) {
		test(`GET /api/health tolerates ${label}`, async ({ request }) => {
			const res = await request.get(`${API_BASE}/api/health`, { headers });
			expect(res.status(), label).toBeLessThan(500);
		});
	}
});
