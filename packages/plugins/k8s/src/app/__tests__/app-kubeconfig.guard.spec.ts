/**
 * T11 — `app-kubeconfig.guard.ts` (plan §6.1; spec FR-4, ACC-06-02, ACC-06-03).
 *
 * Every clause of T11's `**Test**` line (tasks.md:190-197) has an `it` below whose title names it:
 *
 * - "`exec`, `auth-provider`, `tokenFile`, file certificate paths, `proxy-url`,
 *   `insecure-skip-tls-verify` and missing CA data each refused before any resolver or client call
 *   (ACC-06-02)"
 * - "every deny CIDR incl. `::ffff:10.0.0.1`, `64:ff9b::a00:1`"
 * - "a hostname resolving to one public + one private address is refused"
 * - "an operator allow-list range is accepted (ACC-06-03)"
 * - "DNS timeout 10 s"
 * - "resulting YAML has the IP server and original `tls-server-name`"
 * - "a mocked 307 from `/version` is not followed"
 *
 * plus T11's `**Done when**` line (tasks.md:196-197) — "a spec spying on the factory proves no code
 * path in `src/app/` calls `KubeConfig.loadFromString` without the guard" — in the last `describe`,
 * which reads the real tree and asserts a count so it cannot pass vacuously.
 *
 * **No spec here performs real DNS or real network I/O.** Every resolution goes through an injected
 * `KubeconfigDnsResolver`; the one test that exercises the real client hands it a mocked HTTP library,
 * so not a single socket is opened (`/version` is answered from a literal object).
 *
 * **What the mocked-307 test does and does not prove.** It proves the client built from the pinned
 * kubeconfig sends exactly one request — to the validated literal IP — and surfaces the 307 instead of
 * a success. It cannot prove that the *transport underneath the client* refuses to follow a redirect:
 * `@kubernetes/client-node` v1.4 calls `node-fetch` with no `redirect` option
 * (`node_modules/@kubernetes/client-node/dist/gen/http/isomorphic-fetch.js`, `send()`), and node-fetch
 * v2 defaults to `redirect: 'follow'` (`node-fetch/lib/index.js:1249`). The guard's contribution is
 * that the *first* request can never be moved by DNS and that any redirected address is one
 * `isPublicAddress` already refuses — this file asserts both halves, and the residual transport
 * question is recorded for T10/T14, which own the client.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as k8s from '@kubernetes/client-node';
import * as yaml from 'js-yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { K8sPluginError } from '../../errors';
import {
	CLUSTER_PRIVATE_ALLOWLIST_ENV,
	KUBECONFIG_DENY_IPV4_CIDRS,
	KUBECONFIG_DENY_IPV6_CIDRS,
	KUBECONFIG_DNS_TIMEOUT_MS,
	assertSupportedKubeconfig,
	isPublicAddress,
	parsePrivateAllowlist,
	pinKubeconfigServer,
	pinKubeconfigServerDetailed,
	readClusterPrivateAllowlist,
	resolvePublicAddresses,
	type DnsLookupAddress,
	type KubeconfigDnsResolver
} from '../app-kubeconfig.guard';

// --- fixtures ---------------------------------------------------------------

/** A syntactically valid, deliberately trivial CA blob: nothing here is decoded or dialled. */
const CA_DATA = Buffer.from('-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n').toString('base64');

interface KubeconfigFixture {
	server?: string;
	clusterName?: string;
	userName?: string;
	contextName?: string;
	/** Extra `cluster:` keys, written with the kubeconfig's own indentation. */
	clusterLines?: string[];
	/** Extra `user:` keys. */
	userLines?: string[];
	omitCaData?: boolean;
}

function makeKubeconfig(fixture: KubeconfigFixture = {}): string {
	const clusterName = fixture.clusterName ?? 'c1';
	const userName = fixture.userName ?? 'u1';
	const contextName = fixture.contextName ?? 'app';

	const lines = [
		'apiVersion: v1',
		'kind: Config',
		`current-context: ${contextName}`,
		'clusters:',
		`  - name: ${clusterName}`,
		'    cluster:',
		`      server: ${fixture.server ?? 'https://api.example.com:6443'}`
	];

	if (fixture.omitCaData !== true) {
		lines.push(`      certificate-authority-data: ${CA_DATA}`);
	}
	lines.push(...(fixture.clusterLines ?? []).map((line) => `      ${line}`));

	lines.push(
		'contexts:',
		`  - name: ${contextName}`,
		'    context:',
		`      cluster: ${clusterName}`,
		`      user: ${userName}`,
		'users:',
		`  - name: ${userName}`,
		'    user:',
		'      token: abc'
	);
	lines.push(...(fixture.userLines ?? []).map((line) => `      ${line}`));

	return `${lines.join('\n')}\n`;
}

/**
 * A two-context kubeconfig: the default context is a public cluster with a token user, the `locked`
 * context is a private cluster with another clean user, and a third, **unselected** user still carries
 * an exec plugin. Used for the context-selection cases.
 */
function makeMultiContextKubeconfig(): string {
	return `${[
		'apiVersion: v1',
		'kind: Config',
		'current-context: app',
		'clusters:',
		'  - name: c1',
		'    cluster:',
		'      server: https://api.example.com:6443',
		`      certificate-authority-data: ${CA_DATA}`,
		'  - name: c2',
		'    cluster:',
		'      server: https://10.0.0.9:6443',
		`      certificate-authority-data: ${CA_DATA}`,
		'contexts:',
		'  - name: app',
		'    context:',
		'      cluster: c1',
		'      user: u1',
		'  - name: locked',
		'    context:',
		'      cluster: c2',
		'      user: u2',
		'users:',
		'  - name: u1',
		'    user:',
		'      token: abc',
		'  - name: u2',
		'    user:',
		'      token: def',
		'  - name: legacy',
		'    user:',
		'      exec: { command: aws, args: [eks, get-token] }'
	].join('\n')}\n`;
}

/** A resolver that answers with fixed addresses and never touches the network. */
function staticResolver(addresses: Array<string | DnsLookupAddress>): KubeconfigDnsResolver {
	return async () =>
		addresses.map((entry) =>
			typeof entry === 'string' ? { address: entry, family: entry.includes(':') ? 6 : 4 } : entry
		);
}

/** The selected cluster mapping of a (re)loaded kubeconfig document. */
function clusterBodyOf(kubeconfigYaml: string): Record<string, any> {
	const doc = yaml.load(kubeconfigYaml) as Record<string, any>;
	return doc.clusters[0].cluster;
}

function catchThrown(run: () => unknown): any {
	try {
		run();
	} catch (err) {
		return err;
	}
	throw new Error('expected the guard to refuse, but it did not');
}

function catchRejected(promise: Promise<unknown>): Promise<any> {
	return promise.then(
		() => {
			throw new Error('expected the guard to refuse, but it did not');
		},
		(err) => err
	);
}

// --- §6.1 step 1: the refusals ---------------------------------------------

interface RefusedShape {
	name: string;
	yaml: string;
	/** A fragment of the reason — the owner has to be told which field is the problem. */
	mentions: string;
}

const REFUSED_SHAPES: RefusedShape[] = [
	{
		name: 'an exec credential plugin',
		yaml: makeKubeconfig({ userLines: ['exec: { command: aws, args: [eks, get-token] }'] }),
		mentions: 'exec'
	},
	{
		name: 'a legacy auth-provider',
		yaml: makeKubeconfig({ userLines: ['auth-provider: { name: gcp }'] }),
		mentions: 'auth-provider'
	},
	{
		name: 'a tokenFile',
		yaml: makeKubeconfig({ userLines: ['tokenFile: /var/run/secrets/kubernetes.io/token'] }),
		mentions: 'tokenFile'
	},
	{
		name: 'a client-certificate file path',
		yaml: makeKubeconfig({ userLines: ['client-certificate: /home/owner/client.crt'] }),
		mentions: 'client-certificate'
	},
	{
		name: 'a client-key file path',
		yaml: makeKubeconfig({ userLines: ['client-key: /home/owner/client.key'] }),
		mentions: 'client-key'
	},
	{
		name: 'a certificate-authority file path',
		yaml: makeKubeconfig({ clusterLines: ['certificate-authority: /etc/kubernetes/ca.crt'] }),
		mentions: 'certificate-authority'
	},
	{
		name: 'insecure-skip-tls-verify',
		yaml: makeKubeconfig({ clusterLines: ['insecure-skip-tls-verify: true'] }),
		mentions: 'insecure-skip-tls-verify'
	},
	{
		name: 'a proxy-url',
		yaml: makeKubeconfig({ clusterLines: ['proxy-url: http://proxy.internal:3128'] }),
		mentions: 'proxy-url'
	},
	{
		name: 'a cluster without certificate-authority-data',
		yaml: makeKubeconfig({ omitCaData: true }),
		mentions: 'certificate-authority-data'
	}
];

describe('assertSupportedKubeconfig — the §6.1 step 1 refusals (ACC-06-02)', () => {
	for (const shape of REFUSED_SHAPES) {
		it(`refuses ${shape.name}`, () => {
			const err = catchThrown(() => assertSupportedKubeconfig(shape.yaml));

			expect(err).toBeInstanceOf(K8sPluginError);
			expect(err.code).toBe('KUBECONFIG_UNSUPPORTED');
			expect(err.message).toContain(shape.mentions);
		});
	}

	it('refuses a server that is not https (FR-4)', () => {
		const err = catchThrown(() =>
			assertSupportedKubeconfig(makeKubeconfig({ server: 'http://api.example.com:8080' }))
		);

		expect(err.code).toBe('KUBECONFIG_UNSUPPORTED');
		expect(err.message).toContain('https');
	});

	it('accepts a token/inline-certificate kubeconfig and reports the context, cluster and CA', () => {
		const supported = assertSupportedKubeconfig(makeKubeconfig());

		expect(supported.currentContext).toBe('app');
		expect(supported.clusterName).toBe('c1');
		expect(supported.userName).toBe('u1');
		expect(supported.serverUrl.protocol).toBe('https:');
		expect(supported.caData).toBe(CA_DATA);
		expect(supported.fingerprint).toHaveLength(16);
	});

	it('reads the selected context, not every context: an unrelated exec context stays usable', () => {
		expect(() => assertSupportedKubeconfig(makeMultiContextKubeconfig())).not.toThrow();
	});
});

describe('pinKubeconfigServer — every refusal happens before any resolver or client call (ACC-06-02)', () => {
	const spies: Array<{ mockRestore: () => void }> = [];

	afterEach(() => {
		while (spies.length > 0) {
			spies.pop()?.mockRestore();
		}
	});

	it('refuses all nine shapes without a single DNS lookup or a constructed client', async () => {
		const resolver = vi.fn(async () => {
			throw new Error('the resolver must not be reached for an unsupported kubeconfig');
		});
		const loadSpy = vi.spyOn(k8s.KubeConfig.prototype, 'loadFromString');
		spies.push(loadSpy);

		for (const shape of REFUSED_SHAPES) {
			const err = await catchRejected(pinKubeconfigServer(shape.yaml, { resolver }));

			expect(err.code, shape.name).toBe('KUBECONFIG_UNSUPPORTED');
		}

		expect(resolver).not.toHaveBeenCalled();
		expect(loadSpy).not.toHaveBeenCalled();
	});

	it('never constructs a client itself, even for a supported kubeconfig (control for the spy)', async () => {
		const loadSpy = vi.spyOn(k8s.KubeConfig.prototype, 'loadFromString');
		spies.push(loadSpy);

		const pinned = await pinKubeconfigServer(makeKubeconfig(), { resolver: staticResolver(['93.184.216.34']) });
		expect(loadSpy).not.toHaveBeenCalled();

		// …and the spy does see the load when a caller performs it, so the assertion above is not vacuous.
		new k8s.KubeConfig().loadFromString(pinned);
		expect(loadSpy).toHaveBeenCalledTimes(1);
	});
});

// --- §6.1 step 3: the deny table and the allow-list -------------------------

describe('isPublicAddress — the deny table of plan §6.1 (ACC-06-03)', () => {
	it('is exactly the table the plan lists, IPv4 and IPv6', () => {
		expect(KUBECONFIG_DENY_IPV4_CIDRS).toEqual([
			'0.0.0.0/8',
			'10.0.0.0/8',
			'100.64.0.0/10',
			'127.0.0.0/8',
			'169.254.0.0/16',
			'172.16.0.0/12',
			'192.0.0.0/24',
			'192.0.2.0/24',
			'192.88.99.0/24',
			'192.168.0.0/16',
			'198.18.0.0/15',
			'198.51.100.0/24',
			'203.0.113.0/24',
			'224.0.0.0/4',
			'240.0.0.0/4',
			'255.255.255.255/32'
		]);
		expect(KUBECONFIG_DENY_IPV6_CIDRS).toEqual([
			'::/128',
			'::1/128',
			'::ffff:0:0/96',
			'64:ff9b::/96',
			'100::/64',
			'2001:db8::/32',
			'fc00::/7',
			'fe80::/10',
			'ff00::/8'
		]);
	});

	const IPV4_CASES: Array<[string, boolean, string]> = [
		['0.0.0.0', false, '0.0.0.0/8'],
		['0.255.255.255', false, '0.0.0.0/8'],
		['1.0.0.1', true, 'just outside 0.0.0.0/8'],
		['10.0.0.1', false, '10.0.0.0/8'],
		['10.255.255.255', false, '10.0.0.0/8'],
		['9.255.255.255', true, 'just outside 10.0.0.0/8'],
		['11.0.0.1', true, 'just outside 10.0.0.0/8'],
		['100.64.0.0', false, '100.64.0.0/10'],
		['100.127.255.255', false, '100.64.0.0/10'],
		['100.63.255.255', true, 'just outside 100.64.0.0/10'],
		['100.128.0.1', true, 'just outside 100.64.0.0/10'],
		['127.0.0.1', false, '127.0.0.0/8 (loopback)'],
		['126.255.255.255', true, 'just outside 127.0.0.0/8'],
		['128.0.0.1', true, 'just outside 127.0.0.0/8'],
		['169.254.169.254', false, '169.254.0.0/16 (link-local metadata)'],
		['169.253.255.255', true, 'just outside 169.254.0.0/16'],
		['169.255.0.1', true, 'just outside 169.254.0.0/16'],
		['172.16.0.1', false, '172.16.0.0/12'],
		['172.31.255.255', false, '172.16.0.0/12'],
		['172.15.255.255', true, 'just outside 172.16.0.0/12'],
		['172.32.0.1', true, 'just outside 172.16.0.0/12'],
		['192.0.0.1', false, '192.0.0.0/24'],
		['192.0.1.1', true, 'just outside 192.0.0.0/24'],
		['192.0.2.1', false, '192.0.2.0/24 (TEST-NET-1)'],
		['192.0.3.1', true, 'just outside 192.0.2.0/24'],
		['192.88.99.1', false, '192.88.99.0/24 (6to4 relay anycast)'],
		['192.88.98.255', true, 'just outside 192.88.99.0/24'],
		['192.88.100.1', true, 'just outside 192.88.99.0/24'],
		['192.168.1.1', false, '192.168.0.0/16'],
		['192.167.255.255', true, 'just outside 192.168.0.0/16'],
		['192.169.0.1', true, 'just outside 192.168.0.0/16'],
		['198.18.0.1', false, '198.18.0.0/15 (benchmarking)'],
		['198.19.255.255', false, '198.18.0.0/15'],
		['198.17.255.255', true, 'just outside 198.18.0.0/15'],
		['198.20.0.1', true, 'just outside 198.18.0.0/15'],
		['198.51.100.1', false, '198.51.100.0/24 (TEST-NET-2)'],
		['198.51.99.255', true, 'just outside 198.51.100.0/24'],
		['198.51.101.1', true, 'just outside 198.51.100.0/24'],
		['203.0.113.1', false, '203.0.113.0/24 (TEST-NET-3)'],
		['203.0.112.255', true, 'just outside 203.0.113.0/24'],
		['203.0.114.1', true, 'just outside 203.0.113.0/24'],
		['223.255.255.255', true, 'just below 224.0.0.0/4'],
		['224.0.0.1', false, '224.0.0.0/4 (multicast)'],
		['239.255.255.255', false, '224.0.0.0/4'],
		['240.0.0.1', false, '240.0.0.0/4 (reserved)'],
		['255.255.255.254', false, '240.0.0.0/4'],
		['255.255.255.255', false, '255.255.255.255/32 (broadcast)'],
		['8.8.8.8', true, 'public'],
		['93.184.216.34', true, 'public']
	];

	it('denies every IPv4 range of §6.1 and accepts the address just outside each one', () => {
		for (const [address, expected, why] of IPV4_CASES) {
			expect(isPublicAddress(address), `${address} (${why})`).toBe(expected);
		}
	});

	const IPV6_CASES: Array<[string, boolean, string]> = [
		['::', false, '::/128'],
		['::1', false, '::1/128'],
		['0:0:0:0:0:0:0:1', false, '::1/128, uncompressed'],
		['::0.0.0.1', false, '::1/128, dotted spelling'],
		['100::1', false, '100::/64 (discard-only)'],
		['2001:db8::1', false, '2001:db8::/32 (documentation)'],
		['2001:db9::1', true, 'just outside 2001:db8::/32'],
		['fc00::1', false, 'fc00::/7 (unique local)'],
		['fd12:3456:789a::1', false, 'fc00::/7'],
		['fbff:ffff:ffff::1', true, 'just outside fc00::/7'],
		['fe80::1', false, 'fe80::/10 (link-local)'],
		['febf:ffff::1', false, 'fe80::/10, upper end'],
		['fe7f:ffff::1', true, 'just below fe80::/10'],
		['fec0::1', true, 'above fe80::/10 and outside fc00::/7 (deprecated site-local)'],
		['ff02::1', false, 'ff00::/8 (multicast)'],
		['ffff::1', false, 'ff00::/8'],
		['2606:4700:4700::1111', true, 'public'],
		['2001:4860:4860::8888', true, 'public']
	];

	it('denies every IPv6 range of §6.1 and accepts the address just outside each one', () => {
		for (const [address, expected, why] of IPV6_CASES) {
			expect(isPublicAddress(address), `${address} (${why})`).toBe(expected);
		}
	});

	const MAPPED_AND_NAT64: Array<[string, boolean, string]> = [
		['::ffff:10.0.0.1', false, 'IPv4-mapped 10.0.0.1'],
		['::ffff:a00:1', false, 'IPv4-mapped 10.0.0.1, hexadecimal'],
		['::ffff:0a00:0001', false, 'IPv4-mapped 10.0.0.1, zero-padded hexadecimal'],
		['::ffff:192.168.1.1', false, 'IPv4-mapped 192.168.1.1'],
		['::ffff:172.16.0.1', false, 'IPv4-mapped 172.16.0.1'],
		['::ffff:169.254.169.254', false, 'IPv4-mapped link-local metadata address'],
		['::ffff:127.0.0.1', false, 'IPv4-mapped loopback'],
		['::ffff:0.0.0.0', false, 'IPv4-mapped 0.0.0.0/8'],
		['::ffff:224.0.0.1', false, 'IPv4-mapped multicast'],
		['64:ff9b::a00:1', false, 'NAT64 10.0.0.1'],
		['64:ff9b::10.0.0.1', false, 'NAT64 10.0.0.1, dotted'],
		['64:ff9b::7f00:1', false, 'NAT64 127.0.0.1'],
		['64:ff9b::c0a8:101', false, 'NAT64 192.168.1.1'],
		['64:ff9b::a9fe:a9fe', false, 'NAT64 169.254.169.254'],
		['::ffff:8.8.8.8', true, 'IPv4-mapped public address'],
		['64:ff9b::808:808', true, 'NAT64 public address']
	];

	it('re-checks the IPv4 address a mapped (::ffff:0:0/96) or NAT64 (64:ff9b::/96) form carries', () => {
		for (const [address, expected, why] of MAPPED_AND_NAT64) {
			expect(isPublicAddress(address), `${address} (${why})`).toBe(expected);
		}
	});

	it('refuses anything that is not an address rather than passing it through', () => {
		expect(isPublicAddress('')).toBe(false);
		expect(isPublicAddress('api.example.com')).toBe(false);
		expect(isPublicAddress('10.0.0.1/8')).toBe(false);
		expect(isPublicAddress('10.0.0.256')).toBe(false);
		expect(isPublicAddress('999.1.1.1')).toBe(false);
		expect(isPublicAddress('::ffff:10.0.0.1:6443')).toBe(false);
		expect(isPublicAddress('2606:4700:4700::1111%eth0')).toBe(true);
		expect(isPublicAddress('[2606:4700:4700::1111]')).toBe(true);
	});

	it('accepts an operator allow-list range and refuses the same address without it (ACC-06-03)', () => {
		expect(isPublicAddress('10.20.30.40')).toBe(false);
		expect(isPublicAddress('10.20.30.40', ['10.0.0.0/8'])).toBe(true);
		expect(isPublicAddress('10.20.30.40', ['192.168.0.0/16'])).toBe(false);
		expect(isPublicAddress('10.20.30.40', ['10.20.30.40'])).toBe(true);
		expect(isPublicAddress('192.168.1.1', ['192.168.0.0/16'])).toBe(true);
		expect(isPublicAddress('fd12:3456::1', ['fd12:3456::/32'])).toBe(true);
		expect(isPublicAddress('fd12:3456::1', ['fd00::/8'])).toBe(true);
		expect(isPublicAddress('::ffff:10.0.0.1', ['10.0.0.0/8'])).toBe(true);
		expect(isPublicAddress('64:ff9b::a00:1', ['10.0.0.0/8'])).toBe(true);
		expect(isPublicAddress('93.184.216.34', ['nonsense'])).toBe(true);
	});
});

describe('parsePrivateAllowlist / readClusterPrivateAllowlist (§6.1, §8.3)', () => {
	it('splits on commas and whitespace and reports the entries that are not CIDRs', () => {
		expect(parsePrivateAllowlist(' 10.0.0.0/8, 192.168.0.0/16\n2001:db8::/32 not-a-cidr 300.1.1.1/8 ')).toEqual({
			cidrs: ['10.0.0.0/8', '192.168.0.0/16', '2001:db8::/32'],
			invalid: ['not-a-cidr', '300.1.1.1/8']
		});
	});

	it('reads a bare address as a single address and an empty variable as nothing at all', () => {
		expect(parsePrivateAllowlist('10.20.30.40')).toEqual({ cidrs: ['10.20.30.40'], invalid: [] });
		expect(parsePrivateAllowlist(undefined)).toEqual({ cidrs: [], invalid: [] });
		expect(parsePrivateAllowlist('')).toEqual({ cidrs: [], invalid: [] });
		expect(parsePrivateAllowlist('[fd12:3456::]/32')).toEqual({ cidrs: ['[fd12:3456::]/32'], invalid: [] });
	});

	it(`reads ${CLUSTER_PRIVATE_ALLOWLIST_ENV} from the process environment`, () => {
		const parsed = readClusterPrivateAllowlist({ [CLUSTER_PRIVATE_ALLOWLIST_ENV]: '10.0.0.0/8, bogus' });

		expect(parsed).toEqual({ cidrs: ['10.0.0.0/8'], invalid: ['bogus'] });
	});
});

// --- §6.1 steps 2-3: resolution --------------------------------------------

describe('resolvePublicAddresses — DNS, the 10 s timeout and mixed answers (ACC-06-03)', () => {
	it('refuses a hostname that resolves to one public and one private address', async () => {
		const publicThenPrivate = staticResolver(['93.184.216.34', '10.0.0.5']);
		const privateThenPublic = staticResolver(['10.0.0.5', '93.184.216.34']);

		await expect(resolvePublicAddresses('api.example.com', { resolver: publicThenPrivate })).rejects.toMatchObject({
			code: 'CLUSTER_ADDRESS_NOT_PUBLIC',
			message: expect.stringContaining('10.0.0.5')
		});
		await expect(resolvePublicAddresses('api.example.com', { resolver: privateThenPublic })).rejects.toMatchObject({
			code: 'CLUSTER_ADDRESS_NOT_PUBLIC',
			message: expect.stringContaining('10.0.0.5')
		});
	});

	it('refuses a hostname whose only answer is a mapped or NAT64 private address', async () => {
		await expect(
			resolvePublicAddresses('api.example.com', { resolver: staticResolver(['::ffff:10.0.0.5']) })
		).rejects.toMatchObject({ code: 'CLUSTER_ADDRESS_NOT_PUBLIC' });
		await expect(
			resolvePublicAddresses('api.example.com', { resolver: staticResolver(['64:ff9b::a00:1']) })
		).rejects.toMatchObject({ code: 'CLUSTER_ADDRESS_NOT_PUBLIC' });
	});

	it('accepts a hostname whose answers are all public, and de-duplicates them', async () => {
		const resolver = staticResolver(['93.184.216.34', '2606:4700:4700::1111', '93.184.216.34']);

		await expect(resolvePublicAddresses('api.example.com', { resolver })).resolves.toEqual([
			'93.184.216.34',
			'2606:4700:4700::1111'
		]);
	});

	it('accepts a private answer when the operator allow-list covers it, and refuses it otherwise', async () => {
		const resolver = staticResolver(['10.20.30.40']);

		await expect(resolvePublicAddresses('api.internal', { resolver })).rejects.toMatchObject({
			code: 'CLUSTER_ADDRESS_NOT_PUBLIC',
			message: expect.stringContaining(CLUSTER_PRIVATE_ALLOWLIST_ENV)
		});
		await expect(resolvePublicAddresses('api.internal', { resolver, allowlist: ['10.0.0.0/8'] })).resolves.toEqual([
			'10.20.30.40'
		]);
	});

	it('checks an IP literal directly, without calling the resolver', async () => {
		const resolver = vi.fn(async () => {
			throw new Error('the resolver must not be called for an IP literal');
		});

		await expect(resolvePublicAddresses('93.184.216.34', { resolver })).resolves.toEqual(['93.184.216.34']);
		await expect(resolvePublicAddresses('[2606:4700:4700::1111]', { resolver })).resolves.toEqual([
			'2606:4700:4700::1111'
		]);
		await expect(resolvePublicAddresses('10.0.0.1', { resolver })).rejects.toMatchObject({
			code: 'CLUSTER_ADDRESS_NOT_PUBLIC'
		});
		expect(resolver).not.toHaveBeenCalled();
	});

	it('times out after 10 s by default (KUBECONFIG_DNS_TIMEOUT_MS)', async () => {
		vi.useFakeTimers();
		try {
			expect(KUBECONFIG_DNS_TIMEOUT_MS).toBe(10_000);

			// A resolver that never answers: without the timeout the worker waits forever.
			const resolver = vi.fn(() => new Promise<DnsLookupAddress[]>(() => undefined));
			const pending = resolvePublicAddresses('api.example.com', { resolver });
			const refused = expect(pending).rejects.toMatchObject({
				code: 'CLUSTER_UNREACHABLE',
				message: expect.stringContaining('10000 ms')
			});

			await vi.advanceTimersByTimeAsync(KUBECONFIG_DNS_TIMEOUT_MS);
			await refused;

			expect(resolver).toHaveBeenCalledWith('api.example.com');
		} finally {
			vi.useRealTimers();
		}
	});

	it('honours an injected timeoutMs', async () => {
		vi.useFakeTimers();
		try {
			const resolver = vi.fn(() => new Promise<DnsLookupAddress[]>(() => undefined));
			const pending = resolvePublicAddresses('api.example.com', { resolver, timeoutMs: 250 });
			const refused = expect(pending).rejects.toMatchObject({
				code: 'CLUSTER_UNREACHABLE',
				message: expect.stringContaining('250 ms')
			});

			await vi.advanceTimersByTimeAsync(250);
			await refused;
		} finally {
			vi.useRealTimers();
		}
	});

	it('reports a failing or empty lookup as unreachable, never as a policy refusal', async () => {
		await expect(
			resolvePublicAddresses('api.example.com', {
				resolver: async () => {
					throw new Error('getaddrinfo ENOTFOUND api.example.com');
				}
			})
		).rejects.toMatchObject({ code: 'CLUSTER_UNREACHABLE', message: expect.stringContaining('ENOTFOUND') });

		await expect(resolvePublicAddresses('api.example.com', { resolver: async () => [] })).rejects.toMatchObject({
			code: 'CLUSTER_UNREACHABLE'
		});
	});
});

// --- §6.1 step 4: the rewrite ----------------------------------------------

describe('pinKubeconfigServer — the rewritten YAML (plan §6.1 step 4)', () => {
	it('writes the validated IP as the server and the original host as tls-server-name', async () => {
		const pinned = await pinKubeconfigServerDetailed(makeKubeconfig(), {
			resolver: staticResolver(['93.184.216.34'])
		});

		expect(pinned.server).toBe('https://api.example.com:6443');
		expect(pinned.host).toBe('api.example.com');
		expect(pinned.port).toBe('6443');
		expect(pinned.pinnedAddress).toBe('93.184.216.34');
		expect(pinned.tlsServerName).toBe('api.example.com');

		const cluster = clusterBodyOf(pinned.yaml);
		expect(cluster.server).toBe('https://93.184.216.34:6443');
		expect(cluster['tls-server-name']).toBe('api.example.com');
		expect(cluster['certificate-authority-data']).toBe(CA_DATA);
		expect(JSON.stringify(yaml.load(pinned.yaml))).toContain('abc');
	});

	it('produces YAML the real client loads: server, tls-server-name, CA and user survive the rewrite', async () => {
		const pinned = await pinKubeconfigServer(makeKubeconfig(), { resolver: staticResolver(['93.184.216.34']) });
		const kc = new k8s.KubeConfig();
		kc.loadFromString(pinned);

		const cluster = kc.getCurrentCluster();
		expect(cluster?.server).toBe('https://93.184.216.34:6443');
		expect(cluster?.tlsServerName).toBe('api.example.com');
		expect(cluster?.caData).toBe(CA_DATA);
		expect(kc.getCurrentUser()?.token).toBe('abc');
	});

	it('keeps a tls-server-name the kubeconfig already carried', async () => {
		const pinned = await pinKubeconfigServerDetailed(
			makeKubeconfig({ clusterLines: ['tls-server-name: ingress.example.com'] }),
			{ resolver: staticResolver(['93.184.216.34']) }
		);

		expect(pinned.tlsServerName).toBe('ingress.example.com');
		expect(clusterBodyOf(pinned.yaml)['tls-server-name']).toBe('ingress.example.com');
	});

	it('rewrites an IP-literal server without inventing a tls-server-name, and never resolves it', async () => {
		const resolver = vi.fn(async () => {
			throw new Error('the resolver must not be called for an IP literal');
		});
		const pinned = await pinKubeconfigServerDetailed(makeKubeconfig({ server: 'https://93.184.216.34:6443' }), {
			resolver
		});

		expect(resolver).not.toHaveBeenCalled();
		expect(pinned.tlsServerName).toBeUndefined();
		expect(clusterBodyOf(pinned.yaml).server).toBe('https://93.184.216.34:6443');
		expect(clusterBodyOf(pinned.yaml)['tls-server-name']).toBeUndefined();
	});

	it('brackets an IPv6 pinned address and defaults the port to 443', async () => {
		const pinned = await pinKubeconfigServerDetailed(makeKubeconfig({ server: 'https://api.example.com/' }), {
			resolver: staticResolver(['2606:4700:4700::1111'])
		});

		expect(clusterBodyOf(pinned.yaml).server).toBe('https://[2606:4700:4700::1111]:443');
		expect(clusterBodyOf(pinned.yaml)['tls-server-name']).toBe('api.example.com');
	});

	it('preserves a base path in the server URL', async () => {
		const pinned = await pinKubeconfigServerDetailed(makeKubeconfig({ server: 'https://api.example.com/k8s' }), {
			resolver: staticResolver(['93.184.216.34'])
		});

		expect(clusterBodyOf(pinned.yaml).server).toBe('https://93.184.216.34:443/k8s');
	});

	it('accepts both call forms: a bare resolver and an options object', async () => {
		const withResolver = await pinKubeconfigServer(makeKubeconfig(), staticResolver(['93.184.216.34']));
		const withOptions = await pinKubeconfigServer(makeKubeconfig(), {
			resolver: staticResolver(['93.184.216.34'])
		});

		expect(withResolver).toBe(withOptions);
	});

	it('accepts a private server when the operator allow-list covers it (ACC-06-03)', async () => {
		const fixture = makeKubeconfig({ server: 'https://api.internal:6443' });
		const resolver = staticResolver(['10.20.30.40']);

		await expect(pinKubeconfigServer(fixture, { resolver })).rejects.toMatchObject({
			code: 'CLUSTER_ADDRESS_NOT_PUBLIC'
		});

		const pinned = await pinKubeconfigServer(fixture, { resolver, allowlist: ['10.0.0.0/8'] });
		expect(clusterBodyOf(pinned).server).toBe('https://10.20.30.40:6443');
	});

	it('honours a context override and refuses the cluster that context selects', async () => {
		const doc = makeMultiContextKubeconfig();

		const pinned = await pinKubeconfigServer(doc, {
			resolver: staticResolver(['93.184.216.34'])
		});
		expect(clusterBodyOf(pinned).server).toBe('https://93.184.216.34:6443');

		await expect(
			pinKubeconfigServer(doc, { resolver: staticResolver(['93.184.216.34']), context: 'locked' })
		).rejects.toMatchObject({ code: 'CLUSTER_ADDRESS_NOT_PUBLIC' });
	});
});

// --- §6.1 step 4: redirects -------------------------------------------------

describe('a mocked 307 from /version is not followed (plan §6.1 step 4)', () => {
	it('sends exactly one request — to the validated IP — and surfaces the 307', async () => {
		const pinned = await pinKubeconfigServerDetailed(makeKubeconfig(), {
			resolver: staticResolver(['93.184.216.34'])
		});
		const kc = new k8s.KubeConfig();
		kc.loadFromString(pinned.yaml);

		const cluster = kc.getCurrentCluster();
		expect(cluster?.server).toBe('https://93.184.216.34:6443');

		// The transport is mocked: no socket, no DNS, no redirect of its own.
		const requests: string[] = [];
		const httpApi = k8s.wrapHttpLibrary({
			async send(request: { getUrl(): string }) {
				requests.push(request.getUrl());
				return new k8s.ResponseContext(
					307,
					{ location: 'https://169.254.169.254/version' },
					{ text: async () => '', binary: async () => Buffer.alloc(0) }
				);
			}
		});
		const api = new k8s.VersionApi(
			k8s.createConfiguration({
				baseServer: new k8s.ServerConfiguration(cluster?.server ?? '', {}),
				authMethods: { default: kc },
				httpApi
			})
		);

		await expect(api.getCode()).rejects.toMatchObject({ code: 307 });

		expect(requests).toEqual(['https://93.184.216.34:6443/version']);
		expect(requests.filter((url) => url.includes('169.254.169.254'))).toEqual([]);
		// …and the address the 307 points at is one this guard refuses, so a transport that did follow
		// it would be leaving a policy the platform already stated.
		expect(isPublicAddress('169.254.169.254')).toBe(false);
	});
});

// --- the Done-when source scan ---------------------------------------------

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
const SRC_DIR = fileURLToPath(new URL('../..', import.meta.url));

interface SourceFile {
	path: string;
	content: string;
}

function readTypeScriptSources(dir: string): SourceFile[] {
	const files: SourceFile[] = [];

	const walk = (current: string): void => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const full = join(current, entry.name);
			if (entry.isDirectory()) {
				walk(full);
				continue;
			}
			if (!entry.name.endsWith('.ts')) {
				continue;
			}
			files.push({
				path: relative(dir, full).split(sep).join('/'),
				content: readFileSync(full, 'utf8')
			});
		}
	};

	walk(dir);
	return files;
}

/** Every way a kubeconfig reaches the client library. */
const KUBECONFIG_LOAD_CALL = /\.\s*loadFrom(?:String|File|Default|Cluster|Options)\s*\(/;

/**
 * A file counts as guarded when it names the guard module or one of its entry points — importing
 * `pinKubeconfigServer` / `assertSupportedKubeconfig` (directly or through a re-export) is the way
 * T14 wires the App cluster path.
 */
const KUBECONFIG_GUARD_REFERENCE = /app-kubeconfig\.guard|pinKubeconfigServer|assertSupportedKubeconfig/;

function unguardedKubeconfigLoads(files: SourceFile[]): string[] {
	return files
		.filter((file) => KUBECONFIG_LOAD_CALL.test(file.content) && !KUBECONFIG_GUARD_REFERENCE.test(file.content))
		.map((file) => file.path);
}

describe('no file under src/app loads a kubeconfig without going through the guard (T11 Done-when)', () => {
	it('reads the real tree and finds every load guarded', () => {
		const files = readTypeScriptSources(APP_DIR);
		const paths = files.map((file) => file.path);

		// Vacuity checks: this spec must really have read the App sources — a scan that reads nothing
		// must never pass.
		expect(files.length).toBeGreaterThanOrEqual(8);
		expect(files.every((file) => file.content.length > 0)).toBe(true);
		expect(paths).toContain('app-kubeconfig.guard.ts');
		expect(paths).toContain('app-rollout.ts');
		expect(paths).toContain('__tests__/app-kubeconfig.guard.spec.ts');
		// …and the file-matching rule must have seen a real load call, or "no unguarded load" is unproven.
		expect(files.filter((file) => KUBECONFIG_LOAD_CALL.test(file.content)).map((file) => file.path)).toContain(
			'__tests__/app-kubeconfig.guard.spec.ts'
		);

		expect(unguardedKubeconfigLoads(files)).toEqual([]);
	});

	it('flags an unguarded load and accepts a guarded one (control)', () => {
		const sample = (path: string, content: string): SourceFile => ({ path, content });

		expect(
			unguardedKubeconfigLoads([
				sample('app-bad.ts', 'const kc = new KubeConfig();\nkc.loadFromString(yaml);\n'),
				sample('app-also-bad.ts', 'const kc = new KubeConfig();\nkc.loadFromFile(path);\n'),
				sample(
					'app-good.ts',
					"import { pinKubeconfigServer } from './app-kubeconfig.guard.js';\nconst kc = new KubeConfig();\nkc.loadFromString(await pinKubeconfigServer(yaml, resolver));\n"
				),
				sample(
					'app-good-reexport.ts',
					"import { assertSupportedKubeconfig } from './guarded.js';\nkc.loadFromString(assertSupportedKubeconfig(yaml) && yaml);\n"
				),
				sample('app-unrelated.ts', 'export const answer = 42;\n')
			])
		).toEqual(['app-bad.ts', 'app-also-bad.ts']);
	});

	it('finds no new unguarded loader anywhere else in src/ either', () => {
		const files = readTypeScriptSources(SRC_DIR);

		// Vacuity: the whole-tree scan really read the package sources.
		expect(files.length).toBeGreaterThanOrEqual(10);
		expect(files.map((file) => file.path)).toContain('k8s-api.service.ts');

		// Two call sites exist today and both belong to other tasks of this round: the plugin's own
		// client factory (`k8s-api.service.ts`, T10/T14 — this task must not modify it) and the opt-in
		// E2E harness gated by `KUBECONFIG_E2E_PATH`. Everything else must go through the guard.
		const documented = ['k8s-api.service.ts', '__tests__/e2e/cluster.e2e.spec.ts'];
		expect(unguardedKubeconfigLoads(files).filter((path) => !documented.includes(path))).toEqual([]);
	});
});
