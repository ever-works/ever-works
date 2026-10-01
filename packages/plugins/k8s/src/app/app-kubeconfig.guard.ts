/**
 * T11 — Kubeconfig guard (plan §6.1; spec FR-4, ACC-06-02, ACC-06-03).
 *
 * The refusal + address-pinning step that runs **in the worker, before `KubeConfig.loadFromString`**
 * (plan.md:910-938). Nothing here dials a cluster: it takes a kubeconfig string, refuses the shapes
 * §6.1 refuses, validates every address the server resolves to, and returns a rewritten YAML document
 * whose `server` is the **validated literal address** with the original host pinned as
 * `tls-server-name` — so the client never re-resolves the name and a later DNS answer cannot move the
 * connection (FR-4: "the connection is made to the address that was validated, never re-resolved").
 *
 * ## Order is part of the contract
 *
 * `assertSupportedKubeconfig` runs **before** any resolver call, so a kubeconfig that names an exec
 * plugin, an auth-provider, a token file, a certificate file, a proxy or `insecure-skip-tls-verify`
 * is refused without one DNS lookup — and therefore without one packet (ACC-06-02: "refused before
 * any connection"). `pinKubeconfigServer` calls it first, always.
 *
 * ## The deny table is a byte table, not a dotted-quad prefix test
 *
 * `::ffff:10.0.0.1` and `64:ff9b::a00:1` are the IPv4-mapped and NAT64 spellings of `10.0.0.1`. A
 * checker that only tests `10.`/`192.168.` in dotted-quad form passes both, so every address is
 * reduced to bytes and the mapped (`::ffff:0:0/96`) and NAT64 (`64:ff9b::/96`) forms are **re-checked
 * as the IPv4 address they carry** (plan.md:921-922). A hostname resolving to *any* address that fails
 * the policy is refused — never "pick the public one and ignore the rest" (the same rule
 * `safeFetchWithDnsPin` states for webhooks, `packages/plugin/src/helpers/ssrf-guard.ts`).
 *
 * ## Where this file sits relative to APW06-G20
 *
 * plan.md:923-934 (APW06-G20) says the classifier should be reachable from the plugin SDK as
 * `@ever-works/plugin/helpers/cluster-address-policy`. That module does not exist in this worktree,
 * and the six `k8s`-plugin files of this round are the only ones this task may touch — so the
 * classifier (`parsePrivateAllowlist`, `isPublicAddress`, `resolvePublicAddresses`), its deny tables
 * and the 10 s timeout live here and are **exported** for reuse. Moving them to the SDK later is a
 * re-export, not a rewrite; nothing in the signature set changes.
 *
 * Operators of self-hosted installations widen the policy through
 * `EVER_WORKS_APPS_CLUSTER_PRIVATE_ALLOWLIST` (FR-4: "Operators of self-hosted installations may
 * allow specific address ranges explicitly"); an allow-listed range overrides the deny table, an
 * entry that is not a CIDR is reported (`invalid`) and ignored (plan.md:929-930).
 */
import * as dns from 'node:dns';
import * as yaml from 'js-yaml';

import { K8sPluginError } from '../errors.js';
import { parseKubeconfig } from '../kubeconfig.parser.js';

/** Environment variable of plan §8.3 / APW06-G20: the operator's allow-list of private ranges. */
export const CLUSTER_PRIVATE_ALLOWLIST_ENV = 'EVER_WORKS_APPS_CLUSTER_PRIVATE_ALLOWLIST';

/** §6.1 step 2: the DNS lookup gets 10 s, injected so no spec touches a real resolver. */
export const KUBECONFIG_DNS_TIMEOUT_MS = 10_000;

/** §6.1 step 1: the selected user fields this guard refuses outright. */
export const KUBECONFIG_UNSUPPORTED_USER_FIELDS = [
	'exec',
	'auth-provider',
	'tokenFile',
	'client-certificate',
	'client-key'
] as const;

/** §6.1 step 1: the cluster fields this guard refuses outright — plus a missing `-data` sibling. */
export const KUBECONFIG_UNSUPPORTED_CLUSTER_FIELDS = ['certificate-authority', 'proxy-url'] as const;

/**
 * §6.1 step 3, IPv4 half — verbatim, in the order the plan lists them.
 * `224/4` + `240/4` cover `224.0.0.0`–`255.255.255.255`; the plan still spells the broadcast address
 * out, so it is kept as its own entry rather than folded into the two.
 */
export const KUBECONFIG_DENY_IPV4_CIDRS: readonly string[] = [
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
];

/**
 * §6.1 step 3, IPv6 half — verbatim. `::ffff:0:0/96` and `64:ff9b::/96` are listed here for
 * completeness but are decided by the IPv4 re-check (see {@link isPublicAddress}), which is what makes
 * their *public* embeddings (`::ffff:8.8.8.8`) usable.
 */
export const KUBECONFIG_DENY_IPV6_CIDRS: readonly string[] = [
	'::/128',
	'::1/128',
	'::ffff:0:0/96',
	'64:ff9b::/96',
	'100::/64',
	'2001:db8::/32',
	'fc00::/7',
	'fe80::/10',
	'ff00::/8'
];

/** One `dns.lookup(host, { all: true })` answer — the shape `node:dns` returns. */
export interface DnsLookupAddress {
	address: string;
	family: number;
}

/**
 * Resolver contract. Defaults to `dns.promises.lookup(host, { all: true })`; every spec injects its
 * own (hard rule: no spec performs real DNS or real network I/O).
 */
export type KubeconfigDnsResolver = (hostname: string) => Promise<readonly DnsLookupAddress[]>;

/** Result of parsing `EVER_WORKS_APPS_CLUSTER_PRIVATE_ALLOWLIST` (plan §6.1 / §8.3). */
export interface KubeconfigAddressAllowlist {
	/** The entries that parse as a CIDR (or a bare address, read as a /32 or /128). */
	cidrs: string[];
	/** The entries that do not — reported so the caller can log them, then ignored. */
	invalid: string[];
}

/** Options every entry point of this module shares. */
export interface ClusterAddressPolicyOptions {
	/** Operator allow-list; overrides the deny table (FR-4 last sentence). */
	allowlist?: readonly string[];
	/** Injected resolver. Defaults to the real `node:dns` lookup. */
	resolver?: KubeconfigDnsResolver;
	/** §6.1 step 2. Defaults to {@link KUBECONFIG_DNS_TIMEOUT_MS} (10 000). */
	timeoutMs?: number;
}

/** `pinKubeconfigServer` options — the §6.1 policy plus the context override `parseKubeconfig` takes. */
export interface PinKubeconfigOptions extends ClusterAddressPolicyOptions {
	context?: string;
}

/** What `assertSupportedKubeconfig` establishes about a kubeconfig — every field is post-refusal. */
export interface SupportedKubeconfig {
	currentContext: string;
	clusterName: string;
	userName: string;
	namespace?: string;
	/** The `server` exactly as the kubeconfig spelled it (hostname or IP literal). */
	server: string;
	/** The parsed `server`; `protocol === 'https:'` is guaranteed by this function. */
	serverUrl: URL;
	/** `parseKubeconfig`'s fingerprint of `server` + CA. */
	fingerprint: string;
	/** `certificate-authority-data` — guaranteed present and non-empty (no CA *file* is accepted). */
	caData: string;
}

/** Result of `pinKubeconfigServerDetailed` — the rewritten YAML plus what it was pinned to. */
export interface PinnedKubeconfig {
	/** The rewritten kubeconfig, ready for `KubeConfig.loadFromString`. */
	yaml: string;
	/** The original `server`. */
	server: string;
	/** The original host (`api.example.com`, `93.184.216.34`, `2606:4700::1111`). */
	host: string;
	/** `url.port` or `443`. */
	port: string;
	/** The validated address the `server` now names (the first public answer). */
	pinnedAddress: string;
	/** The host the certificate is verified against, when one is pinned. */
	tlsServerName?: string;
	clusterName: string;
	currentContext: string;
	/** Every validated public address the host resolved to. */
	addresses: string[];
}

// --- the allow-list ---------------------------------------------------------

/**
 * Parse `EVER_WORKS_APPS_CLUSTER_PRIVATE_ALLOWLIST` (comma- or whitespace-separated CIDRs, with bare
 * addresses read as `/32` / `/128`). Entries that do not parse land in `invalid` so the caller can log
 * them; they never widen the policy (plan.md:929-930).
 */
export function parsePrivateAllowlist(raw?: string | null): KubeconfigAddressAllowlist {
	const cidrs: string[] = [];
	const invalid: string[] = [];

	for (const token of String(raw ?? '').split(/[\s,]+/)) {
		const entry = token.trim();
		if (entry.length === 0) {
			continue;
		}
		if (parseCidr(entry) === null) {
			invalid.push(entry);
		} else {
			cidrs.push(entry);
		}
	}

	return { cidrs, invalid };
}

/**
 * Read the operator allow-list from this process's own environment (the `k8s` plugin never imports
 * agent config — plan.md:929-930). Logging `invalid` is the caller's job (plan §6.1, T14).
 */
export function readClusterPrivateAllowlist(
	env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env
): KubeconfigAddressAllowlist {
	return parsePrivateAllowlist(env?.[CLUSTER_PRIVATE_ALLOWLIST_ENV]);
}

// --- the classifier ---------------------------------------------------------

/**
 * §6.1 step 3. `true` when `ip` may be connected to: either it is outside every deny CIDR, or the
 * operator's allow-list covers it.
 *
 * Judgement order for one address:
 *
 * 1. an allow-list entry covers it → allowed (the operator's explicit decision wins);
 * 2. it is an IPv4-mapped (`::ffff:a.b.c.d`) or NAT64 (`64:ff9b::a.b.c.d`) address → judged **as the
 *    IPv4 address it carries**, so `::ffff:10.0.0.1` and `64:ff9b::a00:1` are refused like `10.0.0.1`
 *    while `::ffff:8.8.8.8` stays usable;
 * 3. otherwise the deny table of its own family decides.
 *
 * Anything that is not an IP address — including a hostname — is **refused** (`false`): this function
 * answers only the question it is named for, and a caller that wants a hostname resolved must go
 * through {@link resolvePublicAddresses}.
 */
export function isPublicAddress(ip: string, allowlist: readonly string[] = []): boolean {
	const address = parseAddress(ip);
	if (address === null) {
		return false;
	}
	return addressAllowed(address, allowlist ?? []);
}

/**
 * Resolve `host` and return every address it may be connected to (all of them — a single non-public
 * answer refuses the host), or throw.
 *
 * - `CLUSTER_ADDRESS_NOT_PUBLIC` — the host (or one of its addresses) fails {@link isPublicAddress}.
 * - `CLUSTER_UNREACHABLE`     — the lookup failed, timed out after `timeoutMs` (10 s by default), or
 *                               answered nothing. Kept distinct from the policy refusal so a timeout
 *                               is never reported to the owner as "your cluster is private".
 *
 * An IP literal is judged directly and the resolver is **not** called.
 */
export async function resolvePublicAddresses(
	host: string,
	options: ClusterAddressPolicyOptions = {}
): Promise<string[]> {
	const allowlist = options.allowlist ?? [];
	const timeoutMs = options.timeoutMs ?? KUBECONFIG_DNS_TIMEOUT_MS;
	const name = stripBrackets(String(host ?? '').trim()).replace(/\.$/, '');

	if (name.length === 0) {
		throw new K8sPluginError('CLUSTER_ADDRESS_NOT_PUBLIC', 'The cluster address is empty.');
	}

	if (parseAddress(name) !== null) {
		if (!isPublicAddress(name, allowlist)) {
			throw notPublicError(name, name);
		}
		return [name];
	}

	let answers: readonly DnsLookupAddress[];
	try {
		answers = await withTimeout(
			(options.resolver ?? defaultDnsResolver)(name),
			timeoutMs,
			() => new K8sPluginError('CLUSTER_UNREACHABLE', `DNS lookup for '${name}' timed out after ${timeoutMs} ms.`)
		);
	} catch (err) {
		if (err instanceof K8sPluginError) {
			throw err;
		}
		throw new K8sPluginError('CLUSTER_UNREACHABLE', `DNS lookup for '${name}' failed: ${errorMessage(err)}`);
	}

	if (!Array.isArray(answers) || answers.length === 0) {
		throw new K8sPluginError('CLUSTER_UNREACHABLE', `DNS lookup for '${name}' returned no addresses.`);
	}

	const resolved: string[] = [];
	for (const answer of answers) {
		const address = stripBrackets(String(answer?.address ?? '').trim());
		if (address.length === 0 || !isPublicAddress(address, allowlist)) {
			throw notPublicError(name, address);
		}
		if (!resolved.includes(address)) {
			resolved.push(address);
		}
	}

	return resolved;
}

// --- the guard --------------------------------------------------------------

/**
 * §6.1 step 1 (and the `https:` half of step 2): refuse everything the guard does not support, then
 * hand back the resolved context/cluster/user. **No I/O**: no resolver, no client, no file.
 *
 * Refused with `KUBECONFIG_UNSUPPORTED`, in this order (the plan's order — the first match is the
 * reason the owner sees):
 *
 * 1. user `exec` — an arbitrary local command;
 * 2. user `auth-provider` — the legacy plugin protocol;
 * 3. user `tokenFile` — a local file read;
 * 4. user `client-certificate` / `client-key` — local file reads (inline `-data` stays supported);
 * 5. cluster `certificate-authority` — a local file read (inline `-data` is required instead);
 * 6. cluster `insecure-skip-tls-verify: true` — verification is never skipped (FR-4);
 * 7. cluster `proxy-url` — a connection the platform did not choose;
 * 8. cluster without `certificate-authority-data` — nothing to verify the server against;
 * 9. a `server` that is not `https:`.
 *
 * A field is refused on **presence** (`exec`, `auth-provider`, `insecure-skip-tls-verify`) or on a
 * non-empty value (the path/URL fields, where an empty string is not a file and not a proxy).
 */
export function assertSupportedKubeconfig(kubeconfigYaml: string, contextOverride?: string): SupportedKubeconfig {
	const doc = loadKubeconfigDocument(kubeconfigYaml);

	const reason = unsupportedKubeconfigReason(doc, contextOverride);
	if (reason !== null) {
		throw new K8sPluginError('KUBECONFIG_UNSUPPORTED', reason);
	}

	// Reused rather than re-implemented: this is the established parser of the plugin, and its
	// INVALID_YAML / MISSING_CONTEXT / MISSING_CLUSTER / MISSING_USER codes stay the owner's.
	const parsed = parseKubeconfig(kubeconfigYaml, contextOverride);
	const serverUrl = parseServerUrl(parsed.server);

	return {
		currentContext: parsed.currentContext,
		clusterName: parsed.clusterName,
		userName: parsed.userName,
		namespace: parsed.namespace,
		server: parsed.server,
		serverUrl,
		fingerprint: parsed.fingerprint,
		caData: parsed.clusterCa ?? ''
	};
}

/**
 * §6.1 steps 1-3 in one call: assert, resolve, pin. Returns the **rewritten YAML** (step 4) — the
 * string a caller hands to `KubeConfig.loadFromString` instead of the owner's original.
 *
 * Two call forms are accepted because two callers exist: `pinKubeconfigServer(yaml, resolver)` (T11's
 * signature) and `pinKubeconfigServer(yaml, { allowlist, resolver?, timeoutMs? })` (T14's, plan
 * §6.1 / tasks.md:1110).
 */
export async function pinKubeconfigServer(
	kubeconfigYaml: string,
	resolverOrOptions?: KubeconfigDnsResolver | PinKubeconfigOptions,
	contextOverride?: string
): Promise<string> {
	return (await pinKubeconfigServerDetailed(kubeconfigYaml, resolverOrOptions, contextOverride)).yaml;
}

/** {@link pinKubeconfigServer} with the pinned address and context kept, for logging and records. */
export async function pinKubeconfigServerDetailed(
	kubeconfigYaml: string,
	resolverOrOptions?: KubeconfigDnsResolver | PinKubeconfigOptions,
	contextOverride?: string
): Promise<PinnedKubeconfig> {
	const options = normalizePinOptions(resolverOrOptions);
	const context = options.context ?? contextOverride;

	// Step 1 first, always: ACC-06-02 is about *this* ordering.
	const supported = assertSupportedKubeconfig(kubeconfigYaml, context);

	// Step 2 + 3: `server` is https (asserted above); the host is an IP literal or resolved once.
	const url = supported.serverUrl;
	const host = stripBrackets(url.hostname);
	const port = url.port || '443';
	const addresses = await resolvePublicAddresses(host, {
		allowlist: options.allowlist,
		resolver: options.resolver,
		timeoutMs: options.timeoutMs
	});

	const pinnedAddress = addresses[0];
	if (!pinnedAddress) {
		throw new K8sPluginError('CLUSTER_UNREACHABLE', `No usable address for cluster '${supported.clusterName}'.`);
	}

	// Step 4: the in-memory rewrite. The client connects to the validated literal address; the
	// certificate is still verified against the name the operator published.
	const doc = loadKubeconfigDocument(kubeconfigYaml);
	const cluster = findClusterBody(doc, supported.clusterName);
	if (cluster === null) {
		throw new K8sPluginError('MISSING_CLUSTER', `kubeconfig has no cluster named '${supported.clusterName}'`);
	}

	const existingTlsServerName = nonEmptyString(cluster['tls-server-name']);
	const tlsServerName = existingTlsServerName ?? (parseAddress(host) === null ? host : undefined);

	cluster.server = `https://${formatHostForUrl(pinnedAddress)}:${port}${serverPath(url.pathname)}`;
	if (tlsServerName !== undefined) {
		cluster['tls-server-name'] = tlsServerName;
	}

	return {
		// `lineWidth: -1` keeps the base64 CA data on one line; `noRefs` never emits an anchor into a
		// document a second parser has to follow. Comments and anchors of the original are not kept —
		// the client only reads the mapping.
		yaml: yaml.dump(doc, { lineWidth: -1, noRefs: true }),
		server: supported.server,
		host,
		port,
		pinnedAddress,
		tlsServerName,
		clusterName: supported.clusterName,
		currentContext: supported.currentContext,
		addresses
	};
}

// --- the deny table, as bytes ----------------------------------------------

interface ParsedAddress {
	family: 4 | 6;
	bytes: Uint8Array;
}

interface ParsedCidr {
	family: 4 | 6;
	bytes: Uint8Array;
	prefix: number;
}

function addressAllowed(address: ParsedAddress, allowlist: readonly string[]): boolean {
	if (matchesAny(address, allowlist)) {
		return true;
	}

	// §6.1: mapped / NAT64 addresses carry an IPv4 address — judge them as that address.
	const embedded = embeddedIpv4(address);
	if (embedded !== null) {
		return addressAllowed({ family: 4, bytes: embedded }, allowlist);
	}

	return !matchesAny(address, address.family === 4 ? KUBECONFIG_DENY_IPV4_CIDRS : KUBECONFIG_DENY_IPV6_CIDRS);
}

function matchesAny(address: ParsedAddress, cidrs: readonly string[]): boolean {
	for (const entry of cidrs ?? []) {
		const cidr = parseCidr(entry);
		if (cidr !== null && cidr.family === address.family && cidrContains(cidr, address)) {
			return true;
		}
	}
	return false;
}

function cidrContains(cidr: ParsedCidr, address: ParsedAddress): boolean {
	let bits = cidr.prefix;
	for (let octet = 0; octet < address.bytes.length && bits > 0; octet++) {
		const taken = Math.min(8, bits);
		const mask = taken === 8 ? 0xff : (0xff << (8 - taken)) & 0xff;
		if ((address.bytes[octet] & mask) !== (cidr.bytes[octet] & mask)) {
			return false;
		}
		bits -= taken;
	}
	return true;
}

/**
 * The IPv4 address an IPv4-mapped (`::ffff:a.b.c.d`) or NAT64 (`64:ff9b::a.b.c.d`) address carries,
 * or `null` for every other address. This is the one place the two special prefixes are recognised;
 * the deny tables never have to test them.
 */
function embeddedIpv4(address: ParsedAddress): Uint8Array | null {
	if (address.family !== 6) {
		return null;
	}

	const bytes = address.bytes;
	const mapped =
		bytes[0] === 0 &&
		bytes[1] === 0 &&
		bytes[2] === 0 &&
		bytes[3] === 0 &&
		bytes[4] === 0 &&
		bytes[5] === 0 &&
		bytes[6] === 0 &&
		bytes[7] === 0 &&
		bytes[8] === 0 &&
		bytes[9] === 0 &&
		bytes[10] === 0xff &&
		bytes[11] === 0xff;
	const nat64 =
		bytes[0] === 0x00 &&
		bytes[1] === 0x64 &&
		bytes[2] === 0xff &&
		bytes[3] === 0x9b &&
		bytes[4] === 0 &&
		bytes[5] === 0 &&
		bytes[6] === 0 &&
		bytes[7] === 0 &&
		bytes[8] === 0 &&
		bytes[9] === 0 &&
		bytes[10] === 0 &&
		bytes[11] === 0;

	if (!mapped && !nat64) {
		return null;
	}

	return bytes.slice(12, 16);
}

function parseCidr(raw: string): ParsedCidr | null {
	const text = stripBrackets(String(raw ?? '').trim());
	if (text.length === 0) {
		return null;
	}

	const slash = text.lastIndexOf('/');
	const addressPart = slash === -1 ? text : text.slice(0, slash);
	const prefixPart = slash === -1 ? null : text.slice(slash + 1).trim();
	const address = parseAddress(addressPart);
	if (address === null) {
		return null;
	}

	const width = address.family === 4 ? 32 : 128;
	if (prefixPart === null || prefixPart.length === 0) {
		return { family: address.family, bytes: address.bytes, prefix: width };
	}
	if (!/^\d+$/.test(prefixPart)) {
		return null;
	}

	const prefix = Number(prefixPart);
	if (!Number.isSafeInteger(prefix) || prefix < 0 || prefix > width) {
		return null;
	}

	return { family: address.family, bytes: address.bytes, prefix };
}

function parseAddress(raw: string): ParsedAddress | null {
	const text = stripBrackets(String(raw ?? '').trim());
	if (text.length === 0) {
		return null;
	}

	if (text.includes(':')) {
		const bytes = parseIpv6Bytes(text);
		return bytes === null ? null : { family: 6, bytes };
	}

	const bytes = parseIpv4Bytes(text);
	return bytes === null ? null : { family: 4, bytes };
}

/** Strict dotted quad: four decimal octets, nothing else (a leading zero is still decimal). */
function parseIpv4Bytes(text: string): Uint8Array | null {
	const parts = text.split('.');
	if (parts.length !== 4) {
		return null;
	}

	const bytes = new Uint8Array(4);
	for (let index = 0; index < 4; index++) {
		const part = parts[index];
		if (!/^\d{1,3}$/.test(part)) {
			return null;
		}
		const value = Number(part);
		if (value > 255) {
			return null;
		}
		bytes[index] = value;
	}
	return bytes;
}

/** RFC 4291 text form, including `::` compression, a zone id and a trailing dotted quad. */
function parseIpv6Bytes(text: string): Uint8Array | null {
	const zoneIndex = text.indexOf('%');
	const withoutZone = zoneIndex === -1 ? text : text.slice(0, zoneIndex);
	if (withoutZone.length === 0) {
		return null;
	}

	const halves = withoutZone.split('::');
	if (halves.length > 2) {
		return null;
	}

	const head = splitIpv6Groups(halves[0]);
	const tail = halves.length === 2 ? splitIpv6Groups(halves[1]) : null;
	if (head === null || tail === null) {
		return null;
	}

	if (halves.length === 1) {
		return head.length === 8 ? groupsToBytes(head) : null;
	}

	// `::` stands for at least one zero group, so the two halves must leave room for it.
	if (head.length + tail.length > 7) {
		return null;
	}

	const groups = [...head, ...new Array<number>(8 - head.length - tail.length).fill(0), ...tail];
	return groupsToBytes(groups);
}

function splitIpv6Groups(part: string): number[] | null {
	if (part.length === 0) {
		return [];
	}

	const groups: number[] = [];
	const pieces = part.split(':');
	for (let index = 0; index < pieces.length; index++) {
		const piece = pieces[index];
		if (piece.length === 0) {
			return null;
		}

		if (piece.includes('.')) {
			// The dotted quad is only legal as the last piece, and stands for two groups.
			if (index !== pieces.length - 1) {
				return null;
			}
			const quad = parseIpv4Bytes(piece);
			if (quad === null) {
				return null;
			}
			groups.push((quad[0] << 8) | quad[1], (quad[2] << 8) | quad[3]);
			continue;
		}

		if (!/^[0-9a-f]{1,4}$/.test(piece)) {
			return null;
		}
		groups.push(parseInt(piece, 16));
	}

	return groups;
}

function groupsToBytes(groups: number[]): Uint8Array {
	const bytes = new Uint8Array(16);
	for (let index = 0; index < 8; index++) {
		bytes[index * 2] = (groups[index] >> 8) & 0xff;
		bytes[index * 2 + 1] = groups[index] & 0xff;
	}
	return bytes;
}

// --- kubeconfig document helpers -------------------------------------------

type YamlMapping = Record<string, unknown>;

function loadKubeconfigDocument(input: string): YamlMapping {
	if (!input || input.trim().length === 0) {
		throw new K8sPluginError('INVALID_YAML', 'kubeconfig is empty');
	}

	let doc: unknown;
	try {
		doc = yaml.load(input);
	} catch (err) {
		throw new K8sPluginError('INVALID_YAML', `kubeconfig YAML is invalid: ${errorMessage(err)}`);
	}

	if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
		throw new K8sPluginError('INVALID_YAML', 'kubeconfig must be a YAML mapping at the root');
	}

	return doc as YamlMapping;
}

function unsupportedKubeconfigReason(doc: YamlMapping, contextOverride?: string): string | null {
	const contextName = (contextOverride?.trim() || asString(doc['current-context']) || '').trim();
	const contexts = asArray(doc.contexts);
	const selectedContext =
		contextName.length > 0 ? contexts.find((entry) => asString(entry?.name) === contextName) : undefined;
	const contextBody = asRecord(selectedContext?.context);

	const users = asArray(doc.users);
	const clusters = asArray(doc.clusters);
	const selectedUserName = asString(contextBody?.user);
	const selectedClusterName = asString(contextBody?.cluster);

	// Fail closed: when the selected context (or either of its two entries) cannot be identified, every
	// user and cluster in the document is scanned, so an unresolvable context can never *hide* an exec
	// plugin. A resolvable context is scanned exactly as §6.1 words it — "the selected user", "the
	// cluster" — which keeps a multi-context kubeconfig with an unrelated exec context usable.
	const selectedUsers =
		selectedUserName.length > 0 ? users.filter((entry) => asString(entry?.name) === selectedUserName) : [];
	const selectedClusters =
		selectedClusterName.length > 0 ? clusters.filter((entry) => asString(entry?.name) === selectedClusterName) : [];

	for (const entry of selectedUsers.length > 0 ? selectedUsers : users) {
		const user = asRecord(entry?.user) ?? {};
		const name = asString(entry?.name) || 'unknown';

		if (user.exec !== undefined) {
			return `kubeconfig user '${name}' uses an exec credential plugin ('exec'), which App Works refuse: the plugin would run an arbitrary local command. Use a token or an inline certificate instead.`;
		}
		if (user['auth-provider'] !== undefined) {
			return `kubeconfig user '${name}' uses the legacy 'auth-provider' credential plugin, which App Works refuse. Use a token or an inline certificate instead.`;
		}
		if (nonEmptyString(user.tokenFile) !== undefined) {
			return `kubeconfig user '${name}' reads its token from a local file ('tokenFile'), which App Works refuse: the worker has no such file. Paste the token itself instead.`;
		}
		if (nonEmptyString(user['client-certificate']) !== undefined) {
			return `kubeconfig user '${name}' points at a certificate file ('client-certificate'), which App Works refuse: the worker has no such file. Use 'client-certificate-data' instead.`;
		}
		if (nonEmptyString(user['client-key']) !== undefined) {
			return `kubeconfig user '${name}' points at a key file ('client-key'), which App Works refuse: the worker has no such file. Use 'client-key-data' instead.`;
		}
	}

	for (const entry of selectedClusters.length > 0 ? selectedClusters : clusters) {
		const cluster = asRecord(entry?.cluster) ?? {};
		const name = asString(entry?.name) || 'unknown';

		if (nonEmptyString(cluster['certificate-authority']) !== undefined) {
			return `kubeconfig cluster '${name}' points at a certificate-authority file, which App Works refuse: the worker has no such file. Use 'certificate-authority-data' instead.`;
		}
		if (cluster['insecure-skip-tls-verify'] === true) {
			return `kubeconfig cluster '${name}' sets insecure-skip-tls-verify: true, and App Works never skip certificate verification.`;
		}
		if (nonEmptyString(cluster['proxy-url']) !== undefined) {
			return `kubeconfig cluster '${name}' sets proxy-url ('${truncate(nonEmptyString(cluster['proxy-url']) ?? '', 120)}'), which App Works refuse: the connection must go to the cluster address itself.`;
		}
		if (nonEmptyString(cluster['certificate-authority-data']) === undefined) {
			return `kubeconfig cluster '${name}' has no certificate-authority-data, so the cluster certificate cannot be verified. Add the cluster's CA to the kubeconfig.`;
		}
	}

	return null;
}

function parseServerUrl(server: string): URL {
	let url: URL;
	try {
		url = new URL(server);
	} catch {
		throw new K8sPluginError(
			'KUBECONFIG_UNSUPPORTED',
			`kubeconfig server '${truncate(server, 120)}' is not a valid URL.`
		);
	}

	if (url.protocol !== 'https:') {
		throw new K8sPluginError(
			'KUBECONFIG_UNSUPPORTED',
			`kubeconfig server must use https (got '${truncate(url.protocol, 12)}//'). Plain http is refused.`
		);
	}
	if (stripBrackets(url.hostname).length === 0) {
		throw new K8sPluginError('KUBECONFIG_UNSUPPORTED', 'kubeconfig server has no host.');
	}

	return url;
}

function findClusterBody(doc: YamlMapping, clusterName: string): YamlMapping | null {
	for (const entry of asArray(doc.clusters)) {
		if (asString(entry?.name) === clusterName) {
			return asRecord(entry?.cluster);
		}
	}
	return null;
}

// --- small shared helpers ---------------------------------------------------

const defaultDnsResolver: KubeconfigDnsResolver = (hostname) => dns.promises.lookup(hostname, { all: true });

function normalizePinOptions(resolverOrOptions?: KubeconfigDnsResolver | PinKubeconfigOptions): PinKubeconfigOptions {
	if (resolverOrOptions === undefined || resolverOrOptions === null) {
		return {};
	}
	return typeof resolverOrOptions === 'function' ? { resolver: resolverOrOptions } : resolverOrOptions;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => Error): Promise<T> {
	const effective = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : KUBECONFIG_DNS_TIMEOUT_MS;

	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(onTimeout()), effective);
		// Never hold the worker's event loop open on a DNS answer that is not coming.
		(timer as { unref?: () => void }).unref?.();

		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			}
		);
	});
}

function notPublicError(host: string, address: string): K8sPluginError {
	const target = address.length > 0 ? address : host;
	return new K8sPluginError(
		'CLUSTER_ADDRESS_NOT_PUBLIC',
		`'${host}' resolves to ${target}, which is not a public address. App Works connect only to public cluster addresses; an operator of a self-hosted installation can allow a private range with ${CLUSTER_PRIVATE_ALLOWLIST_ENV}.`
	);
}

function formatHostForUrl(address: string): string {
	return address.includes(':') ? `[${address}]` : address;
}

/** The base path of the original server URL, preserved (a proxy in front of the API server uses one). */
function serverPath(pathname: string): string {
	if (!pathname || pathname === '/') {
		return '';
	}
	return pathname.replace(/\/+$/, '');
}

function stripBrackets(value: string): string {
	return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
}

function truncate(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function asRecord(value: unknown): YamlMapping | null {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as YamlMapping) : null;
}

function asArray(value: unknown): YamlMapping[] {
	return Array.isArray(value) ? (value.filter((entry) => asRecord(entry) !== null) as YamlMapping[]) : [];
}

function asString(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

/** A string that is present and not blank — an empty path is not a file and an empty URL is not a proxy. */
function nonEmptyString(value: unknown): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}
