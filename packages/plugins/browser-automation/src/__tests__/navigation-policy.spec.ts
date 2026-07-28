import { afterEach, describe, expect, it } from 'vitest';
import { BrowserNavigationBlockedError, type BrowserNavigationPolicy } from '@ever-works/plugin';
import {
	DEFAULT_TIMEOUT_MS,
	MAX_TIMEOUT_MS,
	MIN_TIMEOUT_MS,
	assertUrlAllowed,
	clampTimeout,
	classifyUrl,
	collectInvalidHostPatterns,
	isHostAllowed,
	isInternalHostname,
	normalizeHost,
	parseHostPattern,
	parseHostPatterns,
	redactUrl,
	resolveNavigationPolicy
} from '../navigation-policy.js';

function policy(overrides: Partial<BrowserNavigationPolicy> = {}): BrowserNavigationPolicy {
	return {
		allowedHosts: ['example.com'],
		subresourcePolicy: 'public-only',
		allowPrivateNetwork: false,
		timeoutMs: DEFAULT_TIMEOUT_MS,
		headless: true,
		...overrides
	};
}

/** DNS stub that never touches the network. */
const resolvesTo = (address: string, family = 4) => ({
	dnsResolver: async () => [{ address, family }]
});

const originalEnv = process.env.PLUGIN_BROWSER_AUTOMATION_ALLOWED_HOSTS;

afterEach(() => {
	if (originalEnv === undefined) {
		delete process.env.PLUGIN_BROWSER_AUTOMATION_ALLOWED_HOSTS;
	} else {
		process.env.PLUGIN_BROWSER_AUTOMATION_ALLOWED_HOSTS = originalEnv;
	}
});

describe('normalizeHost', () => {
	it('lowercases, unwraps IPv6 brackets and drops the FQDN trailing dot', () => {
		expect(normalizeHost('EXAMPLE.com.')).toBe('example.com');
		expect(normalizeHost('[::1]')).toBe('::1');
		expect(normalizeHost('  Example.COM..  ')).toBe('example.com');
	});
});

describe('parseHostPattern', () => {
	it('accepts bare hosts, subdomain wildcards, the bare wildcard and pinned ports', () => {
		expect(parseHostPattern('example.com')).toEqual({ host: 'example.com', port: null });
		expect(parseHostPattern('*.example.com')).toEqual({ host: '*.example.com', port: null });
		expect(parseHostPattern('*')).toEqual({ host: '*', port: null });
		expect(parseHostPattern('example.com:8443')).toEqual({ host: 'example.com', port: '8443' });
		expect(parseHostPattern('[::1]:8080')).toEqual({ host: '::1', port: '8080' });
	});

	it('refuses anything that is not a bare host pattern', () => {
		expect(parseHostPattern('https://example.com')).toBeNull();
		expect(parseHostPattern('example.com/path')).toBeNull();
		expect(parseHostPattern('user@example.com')).toBeNull();
		expect(parseHostPattern('example .com')).toBeNull();
		expect(parseHostPattern('')).toBeNull();
		expect(parseHostPattern('   ')).toBeNull();
	});

	it('refuses out-of-range and non-numeric ports', () => {
		expect(parseHostPattern('example.com:0')).toBeNull();
		expect(parseHostPattern('example.com:99999')).toBeNull();
		expect(parseHostPattern('example.com:abc')).toBeNull();
	});

	it('refuses wildcards that are not a whole host or a leading label', () => {
		expect(parseHostPattern('ex*ample.com')).toBeNull();
		expect(parseHostPattern('example.*')).toBeNull();
		// `*.` must not collapse into the everything-wildcard once the
		// trailing-dot normalizer has run.
		expect(parseHostPattern('*.')).toBeNull();
	});

	it('accepts a port-pinned bare wildcard', () => {
		expect(parseHostPattern('*:8080')).toEqual({ host: '*', port: '8080' });
		expect(isHostAllowed('anything.test', '8080', ['*:8080'])).toBe(true);
		expect(isHostAllowed('anything.test', '443', ['*:8080'])).toBe(false);
	});
});

describe('parseHostPatterns / collectInvalidHostPatterns', () => {
	it('accepts arrays and comma/newline-separated strings', () => {
		expect(parseHostPatterns(['Example.com', '*.EXAMPLE.org'])).toEqual(['example.com', '*.example.org']);
		expect(parseHostPatterns('example.com, *.example.org\nother.test')).toEqual([
			'example.com',
			'*.example.org',
			'other.test'
		]);
	});

	it('drops invalid entries instead of widening them, and reports them separately', () => {
		expect(parseHostPatterns(['example.com', 'https://evil.test'])).toEqual(['example.com']);
		expect(collectInvalidHostPatterns(['example.com', 'https://evil.test'])).toEqual(['https://evil.test']);
	});

	it('returns an empty list for unusable input', () => {
		expect(parseHostPatterns(undefined)).toEqual([]);
		expect(parseHostPatterns(42)).toEqual([]);
		expect(parseHostPatterns({})).toEqual([]);
	});
});

describe('isHostAllowed', () => {
	it('matches exact hosts only — no implicit subdomain widening', () => {
		expect(isHostAllowed('example.com', '443', ['example.com'])).toBe(true);
		expect(isHostAllowed('sub.example.com', '443', ['example.com'])).toBe(false);
	});

	it('matches subdomains under *. but never the apex', () => {
		expect(isHostAllowed('sub.example.com', '443', ['*.example.com'])).toBe(true);
		expect(isHostAllowed('deep.sub.example.com', '443', ['*.example.com'])).toBe(true);
		expect(isHostAllowed('example.com', '443', ['*.example.com'])).toBe(false);
	});

	it('does not let a lookalike suffix sneak past the wildcard', () => {
		expect(isHostAllowed('notexample.com', '443', ['*.example.com'])).toBe(false);
		expect(isHostAllowed('example.com.evil.test', '443', ['*.example.com'])).toBe(false);
	});

	it('honours a pinned port and ignores port when unpinned', () => {
		expect(isHostAllowed('example.com', '8443', ['example.com:8443'])).toBe(true);
		expect(isHostAllowed('example.com', '443', ['example.com:8443'])).toBe(false);
		expect(isHostAllowed('example.com', '8443', ['example.com'])).toBe(true);
	});
});

describe('isInternalHostname', () => {
	it.each([
		'localhost',
		'LOCALHOST',
		'localhost.',
		'localhost.localdomain',
		'ip6-localhost',
		'api.localhost',
		'printer.local',
		'db.internal',
		'router.home.arpa',
		'wiki.intranet'
	])('treats %s as internal', (host) => {
		expect(isInternalHostname(host)).toBe(true);
	});

	it.each(['example.com', 'localhost.example.com', 'local.example.com', 'internal.example.com'])(
		'treats %s as external',
		(host) => {
			expect(isInternalHostname(host)).toBe(false);
		}
	);
});

describe('clampTimeout', () => {
	it('clamps into the supported band and falls back on nonsense', () => {
		expect(clampTimeout(5_000)).toBe(5_000);
		expect(clampTimeout(1)).toBe(MIN_TIMEOUT_MS);
		expect(clampTimeout(10_000_000)).toBe(MAX_TIMEOUT_MS);
		expect(clampTimeout('nope')).toBe(DEFAULT_TIMEOUT_MS);
		expect(clampTimeout(undefined, 7_000)).toBe(7_000);
		expect(clampTimeout(-5, 7_000)).toBe(7_000);
	});
});

describe('resolveNavigationPolicy', () => {
	it('is DEFAULT-DENY: no configuration means an empty allowlist', () => {
		delete process.env.PLUGIN_BROWSER_AUTOMATION_ALLOWED_HOSTS;
		expect(resolveNavigationPolicy().allowedHosts).toEqual([]);
		expect(resolveNavigationPolicy({}).allowedHosts).toEqual([]);
	});

	it('is headless by default and only an explicit false turns it off', () => {
		expect(resolveNavigationPolicy({}).headless).toBe(true);
		expect(resolveNavigationPolicy({ headless: true }).headless).toBe(true);
		expect(resolveNavigationPolicy({ headless: 'no' }).headless).toBe(true);
		expect(resolveNavigationPolicy({ headless: false }).headless).toBe(false);
	});

	it('reads the deployment env allowlist when settings carry none', () => {
		process.env.PLUGIN_BROWSER_AUTOMATION_ALLOWED_HOSTS = 'env.example.com, *.env.example.org';
		expect(resolveNavigationPolicy().allowedHosts).toEqual(['env.example.com', '*.env.example.org']);
	});

	it('merges per-session extra hosts and de-duplicates', () => {
		const resolved = resolveNavigationPolicy(
			{ allowedHosts: ['example.com'] },
			{
				extraAllowedHosts: ['example.com', 'extra.test']
			}
		);
		expect(resolved.allowedHosts).toEqual(['example.com', 'extra.test']);
	});

	it('DROPS the bare "*" entry when private-network access is enabled', () => {
		const resolved = resolveNavigationPolicy({
			allowedHosts: ['*', 'internal.test'],
			allowPrivateNetwork: true
		});
		expect(resolved.allowedHosts).toEqual(['internal.test']);
		expect(resolved.allowPrivateNetwork).toBe(true);
	});

	it('keeps "*" when private-network access is off', () => {
		expect(resolveNavigationPolicy({ allowedHosts: ['*'] }).allowedHosts).toEqual(['*']);
	});

	it('clamps the timeout and lets the session spec override settings', () => {
		expect(resolveNavigationPolicy({ timeoutMs: 999_999 }).timeoutMs).toBe(MAX_TIMEOUT_MS);
		expect(resolveNavigationPolicy({ timeoutMs: 5_000 }, { timeoutMs: 9_000 }).timeoutMs).toBe(9_000);
	});

	it('defaults the sub-resource policy to public-only', () => {
		expect(resolveNavigationPolicy({}).subresourcePolicy).toBe('public-only');
		expect(resolveNavigationPolicy({ subresourcePolicy: 'allowlist' }).subresourcePolicy).toBe('allowlist');
		expect(resolveNavigationPolicy({ subresourcePolicy: 'anything-else' }).subresourcePolicy).toBe('public-only');
	});
});

describe('classifyUrl', () => {
	it('allows an allowlisted public host', () => {
		const verdict = classifyUrl('https://example.com/page', policy(), 'document');
		expect(verdict).toMatchObject({ allowed: true, host: 'example.com', dnsCheckRequired: true });
	});

	it('refuses an unparseable URL', () => {
		expect(classifyUrl('not a url', policy(), 'document')).toMatchObject({
			allowed: false,
			reason: 'invalid_url'
		});
	});

	it.each(['file:///etc/passwd', 'data:text/html,<h1>x</h1>', 'ftp://example.com/x', 'javascript:alert(1)'])(
		'refuses non-HTTP scheme %s',
		(url) => {
			expect(classifyUrl(url, policy({ allowedHosts: ['*'] }), 'document')).toMatchObject({
				allowed: false,
				reason: 'scheme_blocked'
			});
		}
	);

	it('refuses URLs carrying embedded credentials (the allowed.com@evil.tld trick)', () => {
		expect(
			classifyUrl('https://example.com@evil.test/', policy({ allowedHosts: ['*'] }), 'document')
		).toMatchObject({ allowed: false, reason: 'credentials_in_url' });
	});

	it('refuses an off-allowlist host', () => {
		expect(classifyUrl('https://evil.test/', policy(), 'document')).toMatchObject({
			allowed: false,
			reason: 'not_allowlisted'
		});
	});

	it('refuses EVERYTHING when the allowlist is empty (default-deny)', () => {
		expect(classifyUrl('https://example.com/', policy({ allowedHosts: [] }), 'document')).toMatchObject({
			allowed: false,
			reason: 'not_allowlisted'
		});
	});

	// ── SSRF refusals ───────────────────────────────────────────────
	it.each([
		['http://127.0.0.1:8080/admin', 'loopback'],
		['http://localhost:3000/', 'localhost'],
		['http://10.1.2.3/', 'RFC1918 10/8'],
		['http://192.168.1.1/', 'RFC1918 192.168/16'],
		['http://172.16.0.9/', 'RFC1918 172.16/12'],
		['http://169.254.169.254/latest/meta-data/', 'cloud metadata IMDS'],
		['http://metadata.google.internal/computeMetadata/v1/', 'GCP metadata alias'],
		['http://[::1]:9000/', 'IPv6 loopback'],
		['http://[fd00::1]/', 'IPv6 unique-local'],
		['http://[fe82::1]/', 'IPv6 link-local beyond fe80'],
		['http://0.0.0.0/', 'unspecified'],
		['http://100.64.0.1/', 'CGNAT']
	])('refuses %s (%s) even with a wildcard allowlist', (url) => {
		expect(classifyUrl(url, policy({ allowedHosts: ['*'] }), 'document')).toMatchObject({
			allowed: false,
			reason: 'private_address'
		});
	});

	it('refuses the trailing-dot form of a metadata hostname', () => {
		expect(
			classifyUrl(
				'http://metadata.google.internal./computeMetadata/v1/',
				policy({ allowedHosts: ['*'] }),
				'document'
			)
		).toMatchObject({ allowed: false, reason: 'private_address' });
	});

	it('lets an explicitly-listed internal host through only when allowPrivateNetwork is on', () => {
		const locked = policy({ allowedHosts: ['10.1.2.3'] });
		expect(classifyUrl('http://10.1.2.3/', locked, 'document')).toMatchObject({
			allowed: false,
			reason: 'private_address'
		});

		const opened = policy({ allowedHosts: ['10.1.2.3'], allowPrivateNetwork: true });
		expect(classifyUrl('http://10.1.2.3/', opened, 'document')).toMatchObject({ allowed: true });
		// Literal IPs skip the DNS re-check — there is no name to rebind.
		expect(classifyUrl('http://10.1.2.3/', opened, 'document')).toMatchObject({ dnsCheckRequired: false });
	});

	it('still refuses an UNLISTED internal host when allowPrivateNetwork is on', () => {
		const opened = policy({ allowedHosts: ['10.1.2.3'], allowPrivateNetwork: true });
		expect(classifyUrl('http://10.9.9.9/', opened, 'document')).toMatchObject({
			allowed: false,
			reason: 'not_allowlisted'
		});
	});

	describe('sub-resources', () => {
		it('public-only lets any PUBLIC host load assets', () => {
			expect(classifyUrl('https://cdn.other.test/app.js', policy(), 'subresource')).toMatchObject({
				allowed: true
			});
		});

		it('public-only still refuses INTERNAL asset targets', () => {
			expect(classifyUrl('http://127.0.0.1:9200/_cat/indices', policy(), 'subresource')).toMatchObject({
				allowed: false,
				reason: 'private_address'
			});
		});

		it('public-only refuses internal assets even when allowPrivateNetwork is on', () => {
			const opened = policy({ allowedHosts: ['10.1.2.3'], allowPrivateNetwork: true });
			expect(classifyUrl('http://10.1.2.3/asset.js', opened, 'subresource')).toMatchObject({
				allowed: false,
				reason: 'private_address'
			});
		});

		it('allowlist mode constrains assets to the same allowlist', () => {
			const strict = policy({ subresourcePolicy: 'allowlist' });
			expect(classifyUrl('https://cdn.other.test/app.js', strict, 'subresource')).toMatchObject({
				allowed: false,
				reason: 'not_allowlisted'
			});
			expect(classifyUrl('https://example.com/app.js', strict, 'subresource')).toMatchObject({ allowed: true });
		});
	});
});

describe('redactUrl', () => {
	it('strips embedded credentials so they never reach a log or an error', () => {
		expect(redactUrl('https://user:secret@example.com/path')).toBe('https://example.com/path');
		expect(redactUrl('https://user:secret@example.com/path')).not.toContain('secret');
	});

	it('truncates unparseable input instead of throwing', () => {
		expect(redactUrl('not a url')).toBe('not a url');
		expect(redactUrl('x'.repeat(1000))).toHaveLength(256);
	});
});

describe('assertUrlAllowed', () => {
	it('resolves for an allowlisted host that resolves to a public address', async () => {
		await expect(
			assertUrlAllowed('https://example.com/', policy(), 'document', resolvesTo('93.184.216.34'))
		).resolves.toBeUndefined();
	});

	it('throws BrowserNavigationBlockedError with a stable code for a lexical refusal', async () => {
		await expect(
			assertUrlAllowed('https://evil.test/', policy(), 'document', resolvesTo('93.184.216.34'))
		).rejects.toMatchObject({ name: 'BrowserNavigationBlockedError', code: 'not_allowlisted' });
	});

	// ── the SSRF-refusal test the capability exists for ─────────────
	it('refuses an allowlisted hostname that RESOLVES to a private address (DNS rebinding)', async () => {
		const rebinding = policy({ allowedHosts: ['*'] });
		await expect(
			assertUrlAllowed('https://rebind.example.test/', rebinding, 'document', resolvesTo('127.0.0.1'))
		).rejects.toMatchObject({ name: 'BrowserNavigationBlockedError', code: 'dns_private_ip' });
	});

	it('refuses when the metadata IP hides behind an allowlisted name', async () => {
		await expect(
			assertUrlAllowed('https://example.com/', policy(), 'document', resolvesTo('169.254.169.254'))
		).rejects.toMatchObject({ code: 'dns_private_ip' });
	});

	it('refuses when ANY resolved address is private, not just the first', async () => {
		await expect(
			assertUrlAllowed('https://example.com/', policy(), 'document', {
				dnsResolver: async () => [
					{ address: '93.184.216.34', family: 4 },
					{ address: '10.0.0.7', family: 4 }
				]
			})
		).rejects.toMatchObject({ code: 'dns_private_ip' });
	});

	it('refuses a private IPv6 resolution', async () => {
		await expect(
			assertUrlAllowed('https://example.com/', policy(), 'document', resolvesTo('::1', 6))
		).rejects.toMatchObject({ code: 'dns_private_ip' });
	});

	it('classifies by the ADDRESS, not the reported family (a lying stub cannot skip the check)', async () => {
		await expect(
			assertUrlAllowed('https://example.com/', policy(), 'document', resolvesTo('127.0.0.1', 6))
		).rejects.toMatchObject({ code: 'dns_private_ip' });
	});

	it('fails CLOSED when DNS lookup throws', async () => {
		await expect(
			assertUrlAllowed('https://example.com/', policy(), 'document', {
				dnsResolver: async () => {
					throw new Error('ENOTFOUND');
				}
			})
		).rejects.toMatchObject({ code: 'dns_lookup_failed' });
	});

	it('fails CLOSED when DNS returns nothing', async () => {
		await expect(
			assertUrlAllowed('https://example.com/', policy(), 'document', { dnsResolver: async () => [] })
		).rejects.toMatchObject({ code: 'dns_lookup_failed' });
	});

	it('fails CLOSED on an unparseable resolved address', async () => {
		await expect(
			assertUrlAllowed('https://example.com/', policy(), 'document', resolvesTo('not-an-ip'))
		).rejects.toMatchObject({ code: 'dns_private_ip' });
	});

	it('skips the DNS round-trip for literal IPs', async () => {
		let calls = 0;
		await assertUrlAllowed('https://93.184.216.34/', policy({ allowedHosts: ['93.184.216.34'] }), 'document', {
			dnsResolver: async () => {
				calls += 1;
				return [{ address: '93.184.216.34', family: 4 }];
			}
		});
		expect(calls).toBe(0);
	});

	it('redacts credentials out of the thrown error', async () => {
		const error = await assertUrlAllowed('https://user:secret@evil.test/', policy(), 'document').catch(
			(err: unknown) => err as BrowserNavigationBlockedError
		);
		expect(error).toBeInstanceOf(BrowserNavigationBlockedError);
		expect(error.url).not.toContain('secret');
		expect(error.message).not.toContain('secret');
	});
});
