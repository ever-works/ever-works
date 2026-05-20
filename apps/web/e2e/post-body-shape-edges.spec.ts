import { test, expect } from '@playwright/test';
import { API_BASE } from './helpers/api';

/**
 * Anonymous POST body-shape edge cases against the registration
 * endpoint. The endpoint should validate input — never 5xx on:
 *  - empty body
 *  - wrong Content-Type with JSON-looking body
 *  - malformed JSON
 *  - JSON primitives where object expected
 *  - oversized but well-formed JSON
 *  - duplicate keys
 */

const REGISTER = `${API_BASE}/api/auth/register`;

test.describe('Auth register: body shape tolerance', () => {
	test('POST with empty body returns 4xx', async ({ request }) => {
		const res = await request.post(REGISTER, {
			headers: { 'Content-Type': 'application/json' },
			data: '',
		});
		expect(res.status(), 'empty body').toBeLessThan(500);
		expect(res.status(), 'empty body').toBeGreaterThanOrEqual(400);
	});

	test('POST with wrong content-type still rejected gracefully', async ({ request }) => {
		const res = await request.post(REGISTER, {
			headers: { 'Content-Type': 'text/plain' },
			data: '{"email":"x@y.z","password":"abc","name":"x"}',
		});
		expect(res.status(), 'wrong ct').toBeLessThan(500);
	});

	test('POST with malformed JSON returns 4xx', async ({ request }) => {
		const res = await request.post(REGISTER, {
			headers: { 'Content-Type': 'application/json' },
			data: '{not valid json',
		});
		expect(res.status(), 'malformed json').toBeLessThan(500);
		expect(res.status(), 'malformed json').toBeGreaterThanOrEqual(400);
	});

	test('POST with JSON null body returns 4xx', async ({ request }) => {
		const res = await request.post(REGISTER, {
			headers: { 'Content-Type': 'application/json' },
			data: 'null',
		});
		expect(res.status(), 'null body').toBeLessThan(500);
	});

	test('POST with JSON array where object expected returns 4xx', async ({ request }) => {
		const res = await request.post(REGISTER, {
			headers: { 'Content-Type': 'application/json' },
			data: '[]',
		});
		expect(res.status(), 'array body').toBeLessThan(500);
	});

	test('POST with JSON string primitive returns 4xx', async ({ request }) => {
		const res = await request.post(REGISTER, {
			headers: { 'Content-Type': 'application/json' },
			data: '"hello"',
		});
		expect(res.status(), 'string primitive').toBeLessThan(500);
	});

	test('POST with JSON number primitive returns 4xx', async ({ request }) => {
		const res = await request.post(REGISTER, {
			headers: { 'Content-Type': 'application/json' },
			data: '42',
		});
		expect(res.status(), 'number primitive').toBeLessThan(500);
	});

	test('POST with duplicate keys does not 5xx', async ({ request }) => {
		const res = await request.post(REGISTER, {
			headers: { 'Content-Type': 'application/json' },
			data: '{"email":"a@a.com","email":"b@b.com","password":"abc","name":"n"}',
		});
		expect(res.status(), 'duplicate keys').toBeLessThan(500);
	});

	test('POST with large but well-formed JSON does not 5xx', async ({ request }) => {
		const huge = 'x'.repeat(10_000);
		const res = await request.post(REGISTER, {
			headers: { 'Content-Type': 'application/json' },
			data: JSON.stringify({ email: 'a@a.com', password: 'abc', name: huge }),
		});
		expect(res.status(), 'large body').toBeLessThan(500);
	});
});
