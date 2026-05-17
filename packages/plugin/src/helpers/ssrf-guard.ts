import { isIP } from 'node:net';

/**
 * Returns true if the given URL is safe to call from server-side delivery
 * code. Blocks private, loopback, link-local, and known cloud-metadata IPs
 * to mitigate SSRF (H-09 / H-10 / H-11 / M-23).
 *
 * Hostname-based URLs that resolve to private addresses are NOT detected
 * here — DNS resolution must be re-checked at call time inside the HTTP
 * client, with re-resolution after redirects. This helper covers the
 * literal-IP cases and the obvious metadata hostnames.
 *
 * Originally lived in `@ever-works/agent/utils/ssrf-guard.ts`; promoted to
 * the shared plugin package so content-extractor / source-validation
 * plugins can reach it. The agent copy now re-exports from here.
 */
export function isSafeWebhookUrl(rawUrl: string): boolean {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return false;
	}

	if (url.protocol !== 'https:' && url.protocol !== 'http:') {
		return false;
	}

	let host = url.hostname.toLowerCase();
	// Node's URL parser keeps the square brackets around literal IPv6 hosts.
	if (host.startsWith('[') && host.endsWith(']')) {
		host = host.slice(1, -1);
	}

	if (CLOUD_METADATA_HOSTNAMES.has(host)) {
		return false;
	}

	const ipKind = isIP(host);
	if (ipKind === 4 && isPrivateIPv4(host)) return false;
	if (ipKind === 6 && isPrivateIPv6(host)) return false;

	return true;
}

const CLOUD_METADATA_HOSTNAMES = new Set(['metadata.google.internal', 'metadata.goog']);

function isPrivateIPv4(ip: string): boolean {
	const parts = ip.split('.').map((p) => Number(p));
	if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return false;
	const [a, b] = parts;
	if (a === 10) return true;
	if (a === 127) return true;
	if (a === 0) return true;
	if (a === 169 && b === 254) return true;
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 168) return true;
	if (a === 192 && b === 0 && parts[2] === 0) return true;
	if (a === 100 && b >= 64 && b <= 127) return true;
	if (a >= 224) return true;
	return false;
}

function isPrivateIPv6(ip: string): boolean {
	const lower = ip.toLowerCase();
	if (lower === '::1' || lower === '::') return true;
	if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
	if (lower.startsWith('fe80')) return true;
	if (lower.startsWith('::ffff:')) {
		const v4 = lower.slice('::ffff:'.length);
		if (isIP(v4) === 4) return isPrivateIPv4(v4);
	}
	return false;
}
