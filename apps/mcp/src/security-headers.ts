// Security: baseline security-response headers for the MCP HTTP transport.
// apps/api gets these from helmet(), but helmet is NOT a dependency of this
// app and the MCP server intentionally stays dependency-light — so the
// equivalent headers are set manually here. The values mirror helmet@8
// defaults, with a stricter CSP because this transport only ever serves
// JSON-RPC/JSON responses (no HTML, scripts, or embeddable resources).
const SECURITY_HEADERS: ReadonlyArray<readonly [string, string]> = [
	// JSON-only endpoint: nothing may be loaded, framed, or embedded.
	['Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'"],
	['Cross-Origin-Opener-Policy', 'same-origin'],
	['Cross-Origin-Resource-Policy', 'same-origin'],
	['Origin-Agent-Cluster', '?1'],
	['Referrer-Policy', 'no-referrer'],
	// Ignored by browsers on plain-HTTP (local dev) connections, effective
	// behind TLS in deployed environments — same behavior as helmet().
	['Strict-Transport-Security', 'max-age=31536000; includeSubDomains'],
	['X-Content-Type-Options', 'nosniff'],
	['X-DNS-Prefetch-Control', 'off'],
	['X-Download-Options', 'noopen'],
	['X-Frame-Options', 'DENY'],
	['X-Permitted-Cross-Domain-Policies', 'none'],
	// Disables the legacy XSS auditor, which itself enabled exfiltration
	// side-channels in old browsers — helmet@8 default.
	['X-XSS-Protection', '0']
];

// Minimal structural types so this module needs no express/@types import.
interface SecurityHeadersResponse {
	setHeader(name: string, value: string): unknown;
	removeHeader(name: string): unknown;
}

/**
 * Express-compatible middleware that stamps baseline security headers on
 * every response of the MCP HTTP transport and strips the `X-Powered-By`
 * fingerprint header that express adds by default.
 */
export function securityHeaders() {
	return (_req: unknown, res: SecurityHeadersResponse, next: () => void): void => {
		for (const [name, value] of SECURITY_HEADERS) {
			res.setHeader(name, value);
		}
		res.removeHeader('X-Powered-By');
		next();
	};
}
