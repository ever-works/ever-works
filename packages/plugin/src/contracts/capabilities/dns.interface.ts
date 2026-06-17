import type { IPlugin } from '../plugin.interface.js';

/**
 * EW-734 / EW-735 — pluggable DNS providers.
 *
 * This is an **additive** capability contract. It is layered on top of the
 * existing concrete `CloudflareDnsProvider`
 * (`packages/agent/src/ever-works-providers/cloudflare-dns.provider.ts`)
 * without removing or renaming any of its existing methods — the concrete
 * class continues to expose `ensureWorkSubdomain` / `removeWorkSubdomain`
 * for the legacy `applyEverWorksSubdomain` code path while ALSO implementing
 * the smaller `IDnsOperations` ops surface that new code talks to.
 *
 * The interface is intentionally split in two:
 *
 *   - `IDnsOperations` — the **thin ops surface** (`ensureRecord`,
 *     `removeRecord`, `recordExists`, `rootDomain`). The existing concrete
 *     `CloudflareDnsProvider` implements this directly so new code paths
 *     (`SubdomainAllocator`) don't have to know whether the backend is a
 *     bundled core class or a future first-class plugin.
 *
 *   - `IDnsProvider` — `IPlugin & IDnsOperations`. The first-class plugin
 *     contract `@ever-works/cloudflare-dns` (EW-738) will implement. Not yet
 *     wired in this PR.
 *
 * Capability strings a DNS plugin manifest declares:
 *   - `dns-ensure-record` (required) — idempotent create/upsert
 *   - `dns-remove-record` (required) — idempotent delete
 *   - `dns-record-exists` (required) — uniqueness probe
 *   - `dns-root-domain`   (required) — exposes the zone's root domain
 *
 * Two operator modes (G4):
 *   - **Managed**: platform's own zone (`ever.works`) — operator env vars.
 *   - **Bring-your-own**: a user supplies their own Cloudflare token/zone
 *     for a custom apex/domain (encrypted plugin settings).
 *
 * See `docs/specs/features/cloudflare-dns-plugin/spec.md` §4.1.
 */
export type DnsRecordType = 'CNAME' | 'A';

export interface DnsRecordSnapshot {
	readonly id: string;
	readonly type: DnsRecordType;
	readonly name: string;
	readonly content: string;
	readonly proxied?: boolean;
	readonly ttl?: number;
}

export interface DnsEnsureRecordInput {
	/** Fully-qualified host, e.g. `ai-coding.ever.works`. */
	readonly host: string;
	/** Record type. CNAME for hostname targets, A for IP targets. */
	readonly type: DnsRecordType;
	/** Target — hostname for CNAME, IPv4 for A. */
	readonly target: string;
	/**
	 * Cloudflare orange-cloud / equivalent CDN proxy. Defaults are
	 * provider-specific — Cloudflare's managed `*.ever.works` records
	 * should default `true` (CF Universal SSL); custom-domain records
	 * usually default `false`.
	 */
	readonly proxied?: boolean;
	/** TTL in seconds. `1` for `auto`. Provider may clamp. */
	readonly ttl?: number;
}

export interface DnsRemoveRecordInput {
	readonly host: string;
	readonly type?: DnsRecordType;
}

/**
 * Minimal DNS ops surface — the contract `SubdomainAllocator` and the new
 * code paths depend on. Implemented by:
 *   - the existing `CloudflareDnsProvider` concrete class (additive — its
 *     legacy `ensureWorkSubdomain` / `removeWorkSubdomain` methods stay),
 *   - and the future `@ever-works/cloudflare-dns` plugin (EW-738).
 */
export interface IDnsOperations {
	/**
	 * Create or upsert a record mapping `host -> target`. Idempotent:
	 * an existing matching record is returned as-is; a drifted record is
	 * patched in place. Always returns the resulting record snapshot.
	 */
	ensureRecord(input: DnsEnsureRecordInput): Promise<DnsRecordSnapshot>;

	/** Remove a record. Idempotent — missing record is a no-op. */
	removeRecord(input: DnsRemoveRecordInput): Promise<void>;

	/**
	 * Cheap "is this host already claimed?" probe used by
	 * `SubdomainAllocator` to detect collisions before persisting.
	 * Returns `true` iff ANY record exists for `host` in the provider's
	 * zone — regardless of who owns it.
	 */
	recordExists(host: string): Promise<boolean>;

	/** Root domain managed by this provider — e.g. `'ever.works'`. */
	rootDomain(): string;
}

/**
 * Full DNS plugin interface — capability `dns`.
 *
 * Concrete implementations:
 * - **today**: `CloudflareDnsProvider` in `@ever-works/agent` is a plain
 *   class (NOT an `IPlugin`) wired via `EverWorksDnsService`. It satisfies
 *   `IDnsOperations` after EW-735 — that's enough for `SubdomainAllocator`.
 * - **EW-738**: `@ever-works/cloudflare-dns` plugin (managed + BYO modes,
 *   resolved through `PluginRegistryService`) will implement the full
 *   `IDnsProvider`.
 */
export interface IDnsProvider extends IPlugin, IDnsOperations {
	/** Backend name for facade identification (`'cloudflare'`, ...). */
	readonly providerName: string;
}

/**
 * Type guard for full DNS plugins. Capability strings mirror the storage /
 * vector-store precedent (`put-object`/`get-object`, etc.).
 */
export function isDnsProvider(plugin: IPlugin): plugin is IDnsProvider {
	return (
		plugin.capabilities.includes('dns-ensure-record') &&
		plugin.capabilities.includes('dns-remove-record')
	);
}
