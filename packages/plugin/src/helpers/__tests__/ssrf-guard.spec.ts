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
