import { describe, it, expect, vi } from 'vitest';
import { securityHeaders } from '../src/security-headers.js';

// Security: the MCP HTTP transport has no helmet dependency, so baseline
// security headers are stamped manually by securityHeaders() in
// src/security-headers.ts (wired up in main.http.ts). These tests pin the
// exact header set so a refactor cannot silently drop one.
describe('securityHeaders', () => {
	function runMiddleware() {
		const headers = new Map<string, string>();
		const removed: string[] = [];
		const res = {
			setHeader: (name: string, value: string) => {
				headers.set(name, value);
			},
			removeHeader: (name: string) => {
				removed.push(name);
			}
		};
		const next = vi.fn();
		securityHeaders()({}, res, next);
		return { headers, removed, next };
	}

	it('sets the baseline security headers on the response', () => {
		const { headers } = runMiddleware();

		expect(headers.get('Content-Security-Policy')).toBe("default-src 'none'; frame-ancestors 'none'");
		expect(headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
		expect(headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
		expect(headers.get('Origin-Agent-Cluster')).toBe('?1');
		expect(headers.get('Referrer-Policy')).toBe('no-referrer');
		expect(headers.get('Strict-Transport-Security')).toBe('max-age=31536000; includeSubDomains');
		expect(headers.get('X-Content-Type-Options')).toBe('nosniff');
		expect(headers.get('X-DNS-Prefetch-Control')).toBe('off');
		expect(headers.get('X-Download-Options')).toBe('noopen');
		expect(headers.get('X-Frame-Options')).toBe('DENY');
		expect(headers.get('X-Permitted-Cross-Domain-Policies')).toBe('none');
		expect(headers.get('X-XSS-Protection')).toBe('0');
	});

	it('removes the X-Powered-By fingerprint header', () => {
		const { removed } = runMiddleware();
		expect(removed).toContain('X-Powered-By');
	});

	it('calls next() exactly once so the request continues', () => {
		const { next } = runMiddleware();
		expect(next).toHaveBeenCalledTimes(1);
	});
});
