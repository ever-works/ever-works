import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	isPrivateIPv4,
	isPrivateIPv6,
	isSafeWebhookUrl,
	safeFetchWithDnsPin,
	SsrfBlockedError,
	type DnsLookupAddress,
	type DnsResolver
} from '../ssrf-guard.js';

describe('isSafeWebhookUrl', () => {
	it('accepts a plain HTTPS URL with a hostname', () => {
		expect(isSafeWebhookUrl('https://hooks.example.com/incoming')).toBe(true);
	});

	it('rejects malformed URLs', () => {
		expect(isSafeWebhookUrl('not a url')).toBe(false);
		expect(isSafeWebhookUrl('javascript:alert(1)')).toBe(false);
		expect(isSafeWebhookUrl('file:///etc/passwd')).toBe(false);
	});

	it('rejects cloud metadata hostnames', () => {
		expect(isSafeWebhookUrl('http://metadata.google.internal/')).toBe(false);
		expect(isSafeWebhookUrl('http://metadata.goog/')).toBe(false);
	});

	it('rejects the fully-qualified (trailing-dot) spelling of a metadata hostname', () => {
		expect(isSafeWebhookUrl('http://metadata.google.internal./')).toBe(false);
		expect(isSafeWebhookUrl('http://METADATA.goog../')).toBe(false);
		expect(isSafeWebhookUrl('http://instance-data./latest')).toBe(false);
		expect(isSafeWebhookUrl('https://hooks.example.com./incoming')).toBe(true);
	});

	it('rejects the benchmarking and documentation IPv4 ranges', () => {
		for (const ip of ['198.18.0.1', '198.19.255.254', '192.0.2.10', '198.51.100.7', '203.0.113.9']) {
			expect(isSafeWebhookUrl(`https://${ip}/x`)).toBe(false);
			expect(isPrivateIPv4(ip)).toBe(true);
		}
		for (const ip of ['198.17.255.255', '198.20.0.1', '192.0.3.1', '198.51.101.1', '203.0.114.1']) {
			expect(isPrivateIPv4(ip)).toBe(false);
		}
		// The same ranges embedded in an IPv6 literal.
		expect(isSafeWebhookUrl('https://[::ffff:198.18.0.1]/x')).toBe(false);
	});

	it('rejects literal private IPv4', () => {
		expect(isSafeWebhookUrl('https://127.0.0.1/x')).toBe(false);
		expect(isSafeWebhookUrl('https://169.254.169.254/latest/meta-data')).toBe(false);
	});

	it('rejects literal private IPv6', () => {
		expect(isSafeWebhookUrl('https://[::1]/x')).toBe(false);
		expect(isSafeWebhookUrl('https://[fc00::1]/x')).toBe(false);
	});
});

describe('isPrivateIPv4 / isPrivateIPv6 (exported predicates)', () => {
	it('treats RFC1918 and loopback as private', () => {
		expect(isPrivateIPv4('10.0.0.1')).toBe(true);
		expect(isPrivateIPv4('172.16.0.1')).toBe(true);
		expect(isPrivateIPv4('192.168.0.1')).toBe(true);
		expect(isPrivateIPv4('127.0.0.1')).toBe(true);
	});

	it('treats cloud-metadata 169.254.169.254 as private', () => {
		expect(isPrivateIPv4('169.254.169.254')).toBe(true);
	});

	it('treats CGNAT (100.64/10) as private', () => {
		expect(isPrivateIPv4('100.64.0.1')).toBe(true);
		expect(isPrivateIPv4('100.127.255.254')).toBe(true);
	});

	it('treats multicast/reserved (>=224) as private', () => {
		expect(isPrivateIPv4('224.0.0.1')).toBe(true);
		expect(isPrivateIPv4('255.255.255.255')).toBe(true);
	});

	it('allows ordinary public IPv4', () => {
		expect(isPrivateIPv4('8.8.8.8')).toBe(false);
		expect(isPrivateIPv4('1.1.1.1')).toBe(false);
	});

	it('rejects malformed IPv4 strings', () => {
		expect(isPrivateIPv4('not-an-ip')).toBe(false);
		expect(isPrivateIPv4('1.2.3')).toBe(false);
	});

	it('treats loopback and ULA IPv6 as private', () => {
		expect(isPrivateIPv6('::1')).toBe(true);
		expect(isPrivateIPv6('::')).toBe(true);
		expect(isPrivateIPv6('fc00::1')).toBe(true);
		expect(isPrivateIPv6('fd12:3456::1')).toBe(true);
		expect(isPrivateIPv6('fe80::1')).toBe(true);
	});

	it('unwraps IPv4-mapped IPv6 and applies IPv4 predicate', () => {
		expect(isPrivateIPv6('::ffff:127.0.0.1')).toBe(true);
		expect(isPrivateIPv6('::ffff:169.254.169.254')).toBe(true);
		expect(isPrivateIPv6('::ffff:8.8.8.8')).toBe(false);
	});

	it('allows ordinary public IPv6', () => {
		expect(isPrivateIPv6('2606:4700:4700::1111')).toBe(false);
	});
});

describe('safeFetchWithDnsPin', () => {
	const fetchSpy = vi.spyOn(globalThis, 'fetch');

	afterEach(() => {
		fetchSpy.mockReset();
	});

	const publicResolver: DnsResolver = async () => [
		{ address: '93.184.216.34', family: 4 } satisfies DnsLookupAddress
	];

	const loopbackResolver: DnsResolver = async () => [{ address: '127.0.0.1', family: 4 } satisfies DnsLookupAddress];

	const mixedResolver: DnsResolver = async () => [
		{ address: '93.184.216.34', family: 4 } satisfies DnsLookupAddress,
		{ address: '127.0.0.1', family: 4 } satisfies DnsLookupAddress
	];

	const metadataResolver: DnsResolver = async () => [
		{ address: '169.254.169.254', family: 4 } satisfies DnsLookupAddress
	];

	const emptyResolver: DnsResolver = async () => [];

	const failingResolver: DnsResolver = async () => {
		throw new Error('ENOTFOUND example.invalid');
	};

	it('passes through to fetch when all resolved IPs are public', async () => {
		fetchSpy.mockResolvedValue(new Response('ok', { status: 200 }));
		const res = await safeFetchWithDnsPin(
			'https://api.example.com/webhook',
			{ method: 'POST' },
			{ dnsResolver: publicResolver }
		);
		expect(res.status).toBe(200);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(fetchSpy.mock.calls[0][0]).toBe('https://api.example.com/webhook');
	});

	it('rejects when the hostname resolves only to a loopback IP', async () => {
		await expect(
			safeFetchWithDnsPin('https://rebind.example.com/x', undefined, {
				dnsResolver: loopbackResolver
			})
		).rejects.toBeInstanceOf(SsrfBlockedError);
		await expect(
			safeFetchWithDnsPin('https://rebind.example.com/x', undefined, {
				dnsResolver: loopbackResolver
			})
		).rejects.toMatchObject({ code: 'dns_private_ip' });
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('rejects when ANY resolved IP is private, even if others are public', async () => {
		// No "pick the public one" shortcut: Happy Eyeballs / round-robin could
		// still land the actual connect on the private address.
		await expect(
			safeFetchWithDnsPin('https://mixed.example.com/x', undefined, {
				dnsResolver: mixedResolver
			})
		).rejects.toMatchObject({ code: 'dns_private_ip' });
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('rejects when the hostname resolves to the cloud-metadata IP', async () => {
		await expect(
			safeFetchWithDnsPin('https://imds-rebind.example.com/', undefined, {
				dnsResolver: metadataResolver
			})
		).rejects.toMatchObject({ code: 'dns_private_ip' });
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('rejects literal 169.254.169.254 via the lexical guard before DNS', async () => {
		await expect(
			safeFetchWithDnsPin('http://169.254.169.254/latest/meta-data', undefined, {
				dnsResolver: publicResolver // never called
			})
		).rejects.toMatchObject({ code: 'lexical_blocked' });
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('rejects when DNS resolution fails', async () => {
		await expect(
			safeFetchWithDnsPin('https://nope.example.invalid/x', undefined, {
				dnsResolver: failingResolver
			})
		).rejects.toMatchObject({ code: 'dns_lookup_failed' });
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('rejects when DNS resolution returns no addresses', async () => {
		await expect(
			safeFetchWithDnsPin('https://empty.example.com/x', undefined, {
				dnsResolver: emptyResolver
			})
		).rejects.toMatchObject({ code: 'dns_no_results' });
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('rejects malformed / non-HTTP URLs via the lexical guard', async () => {
		await expect(
			safeFetchWithDnsPin('javascript:alert(1)', undefined, {
				dnsResolver: publicResolver
			})
		).rejects.toMatchObject({ code: 'lexical_blocked' });
		await expect(
			safeFetchWithDnsPin('file:///etc/passwd', undefined, {
				dnsResolver: publicResolver
			})
		).rejects.toMatchObject({ code: 'lexical_blocked' });
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('skips DNS resolution for literal public IPs (lexical guard already accepted them)', async () => {
		fetchSpy.mockResolvedValue(new Response('ok', { status: 200 }));
		const resolver = vi.fn<DnsResolver>(async () => [{ address: '8.8.8.8', family: 4 } satisfies DnsLookupAddress]);
		const res = await safeFetchWithDnsPin('https://8.8.8.8/health', undefined, { dnsResolver: resolver });
		expect(res.status).toBe(200);
		expect(resolver).not.toHaveBeenCalled();
	});
});

describe('IPv6 forms that embed an IPv4 address (review of #2769)', () => {
	it.each([
		// IPv4-mapped, dotted and in the hex spelling the URL parser normalizes to.
		'::ffff:169.254.169.254',
		'::ffff:a9fe:a9fe',
		'::ffff:127.0.0.1',
		'::ffff:7f00:1',
		'::FFFF:10.0.0.1',
		// IPv4-translated (RFC 2765).
		'::ffff:0:127.0.0.1',
		// IPv4-compatible (deprecated, still parsed by stacks).
		'::127.0.0.1',
		'::a9fe:a9fe',
		// NAT64 well-known prefix (RFC 6052).
		'64:ff9b::169.254.169.254',
		'64:ff9b::7f00:1',
		// 6to4 (RFC 3056).
		'2002:a9fe:a9fe::1',
		'2002:7f00:1::',
		'2002:c0a8:101::1',
		// Teredo: client IPv4 is the last 32 bits inverted (127.0.0.1 ⇒ 80ff:fffe).
		'2001:0:4136:e378:8000:63bf:80ff:fffe'
	])('treats %s as private', (ip) => {
		expect(isPrivateIPv6(ip)).toBe(true);
	});

	it.each(['::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::1', '2606:4700:4700::1111'])(
		'leaves the public address %s alone',
		(ip) => {
			expect(isPrivateIPv6(ip)).toBe(false);
		}
	);

	it.each(['ff02::1', 'fec0::1', '2001:db8::1', '64:ff9b:1::a', 'fe80::1%eth0'])(
		'treats the non-routable block of %s as private',
		(ip) => {
			expect(isPrivateIPv6(ip)).toBe(true);
		}
	);

	it.each([
		'http://[::ffff:169.254.169.254]/latest/meta-data/',
		'http://[::ffff:127.0.0.1]:6379/',
		'http://[::127.0.0.1]/',
		'http://[64:ff9b::169.254.169.254]/',
		'http://[2002:a9fe:a9fe::]/',
		'http://[::ffff:0:10.0.0.1]/'
	])('isSafeWebhookUrl refuses %s (normalized by the URL parser first)', (url) => {
		expect(isSafeWebhookUrl(url)).toBe(false);
	});

	it('safeFetchWithDnsPin refuses a name resolving to an IPv4-mapped metadata address', async () => {
		const resolver: DnsResolver = async () => [{ address: '::ffff:a9fe:a9fe', family: 6 }];
		await expect(
			safeFetchWithDnsPin('https://rebind.example.com/', undefined, { dnsResolver: resolver })
		).rejects.toBeInstanceOf(SsrfBlockedError);
	});
});
