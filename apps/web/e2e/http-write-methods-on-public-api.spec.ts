import { test, expect } from '@playwright/test';
import { API_BASE } from './helpers/api';

/**
 * Write-method probes against read-only public API endpoints. Anonymous
 * PUT/PATCH/DELETE on a read-only resource should respond with a 4xx
 * (typically 401, 403, 404, or 405) — never 5xx. A 5xx would mean an
 * unhandled exception in the framework's method-rejection path.
 */

const READ_ONLY_PUBLIC_PATHS = [
	'/api/health',
	'/api/version',
	'/api/info',
	'/api/works',
	'/api/auth/providers',
	'/.well-known/agent.json',
];

const NON_GET_METHODS: Array<'PUT' | 'PATCH' | 'DELETE'> = ['PUT', 'PATCH', 'DELETE'];

test.describe('Public API: write-method rejection shape', () => {
	for (const path of READ_ONLY_PUBLIC_PATHS) {
		for (const method of NON_GET_METHODS) {
			test(`${method} ${path} returns 4xx, not 5xx`, async ({ request }) => {
				const res = await request.fetch(`${API_BASE}${path}`, { method });
				expect(res.status(), `${method} ${path}`).toBeLessThan(500);
				expect(res.status(), `${method} ${path}`).toBeGreaterThanOrEqual(400);
			});
		}
	}
});
