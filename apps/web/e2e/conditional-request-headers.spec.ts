import { test, expect } from '@playwright/test';
import { API_BASE } from './helpers/api';

/**
 * Conditional request semantics. The server should:
 *  - tolerate If-None-Match with any value (304 if matched, full response otherwise)
 *  - tolerate If-Modified-Since with HTTP-date and edge values
 *  - never 5xx on malformed conditional headers
 */

const PUBLIC_PATHS = ['/api/health', '/.well-known/agent.json'];

const IF_NONE_MATCH_VALUES = [
	'"never-matches"',
	'W/"weak-tag"',
	'*',
	'',
	'malformed-no-quotes',
];

const IF_MODIFIED_SINCE_VALUES = [
	'Wed, 21 Oct 2015 07:28:00 GMT',
	'Thu, 01 Jan 1970 00:00:00 GMT',
	'Mon, 31 Dec 2099 23:59:59 GMT',
	'not-a-date',
	'',
];

test.describe('Conditional: If-None-Match tolerance', () => {
	for (const path of PUBLIC_PATHS) {
		for (const value of IF_NONE_MATCH_VALUES) {
			test(`GET ${path} with If-None-Match="${value}"`, async ({ request }) => {
				const res = await request.get(`${API_BASE}${path}`, {
					headers: { 'If-None-Match': value },
				});
				expect(res.status(), `${path} ifn=${value}`).toBeLessThan(500);
			});
		}
	}
});

test.describe('Conditional: If-Modified-Since tolerance', () => {
	for (const path of PUBLIC_PATHS) {
		for (const value of IF_MODIFIED_SINCE_VALUES) {
			test(`GET ${path} with If-Modified-Since="${value}"`, async ({ request }) => {
				const res = await request.get(`${API_BASE}${path}`, {
					headers: { 'If-Modified-Since': value },
				});
				expect(res.status(), `${path} ims=${value}`).toBeLessThan(500);
			});
		}
	}
});
