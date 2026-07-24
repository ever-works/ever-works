import { Injectable, Logger } from '@nestjs/common';
import type {
    DnsEnsureRecordInput,
    DnsRecordSnapshot as DnsRecordSnapshotContract,
    DnsRecordType,
    DnsRemoveRecordInput,
    IDnsOperations,
} from '@ever-works/plugin';

/**
 * EW-617 G5 — Cloudflare DNS provider for `*.ever.works`.
 *
 * Creates a CNAME record pointing `{slug}.ever.works` at the k8s-works
 * cluster ingress load balancer when an Ever Works pipeline deploys a
 * Work, and tears it down on Work delete. Operates against the
 * Cloudflare v4 REST API with a scoped API token (DNS:Edit on the
 * `ever.works` zone only).
 *
 * Configuration (operator runbook):
 *
 *   CLOUDFLARE_API_TOKEN          # scoped token, DNS:Edit on the zone
 *   CLOUDFLARE_ZONE_ID            # `ever.works` zone id
 *   EVER_WORKS_DOMAIN             # defaults to `ever.works`
 *   EVER_WORKS_DEPLOY_LB_HOSTNAME # CNAME target — the k8s-works ingress LB
 *
 * The provider intentionally has no @nestjs/axios dependency — it uses
 * the global `fetch` (Node 22+) so it can be tested with `fetch` mocks
 * and stays small.
 */

/**
 * Cloudflare Tunnel targets (`<tunnel-uuid>.cfargotunnel.com`) are NOT
 * real public DNS names — they only resolve through Cloudflare's proxy.
 * An unproxied ("grey cloud") CNAME at one resolves to an unroutable
 * placeholder address, so the hostname is dead on the public internet.
 *
 * Verified against the live `ever.works` zone: an unproxied CNAME to the
 * tunnel resolved to `fd10:aec2:5dae::` and every request failed to
 * connect; flipping the same record to proxied resolved to Cloudflare
 * edge IPs and reached the origin. Every working tunnel-backed record in
 * that zone is proxied.
 *
 * So proxying is derived from the target rather than configured: tunnel
 * targets MUST be proxied, and anything else (a real LB hostname or A
 * record) keeps the previous unproxied default.
 */
export function requiresProxy(targetHostname: string): boolean {
    return /(^|\.)cfargotunnel\.com$/i.test((targetHostname ?? '').trim());
}

export interface CloudflareDnsConfig {
    apiToken: string;
    zoneId: string;
    /** e.g. 'ever.works' — used to validate target names + log. */
    rootDomain: string;
    /** Hostname the CNAME points at (k8s-works ingress LB). */
    targetHostname: string;
    /** Optional base URL override (tests, staging mirror). */
    apiBaseUrl?: string;
}

export interface DnsRecordSnapshot {
    id: string;
    /**
     * Historically `'CNAME'`-only (the original EW-617 G5 managed flow
     * only ever created CNAMEs). Widened to A/CNAME in EW-735 so the
     * new `IDnsOperations.ensureRecord` path can return the same shape
     * for k8s A-record targets without forking the snapshot type.
     */
    type: 'CNAME' | 'A';
    name: string;
    content: string;
}

export class CloudflareDnsError extends Error {
    constructor(
        message: string,
        readonly status: number,
        readonly errors: unknown,
    ) {
        super(message);
        this.name = 'CloudflareDnsError';
    }
}

/**
 * Pure (testable) Cloudflare client. Construct with a config; tests pass
 * a custom `fetch` impl via the second arg.
 */
export class CloudflareDnsProvider implements IDnsOperations {
    private readonly logger = new Logger(CloudflareDnsProvider.name);
    private readonly baseUrl: string;

    constructor(
        private readonly config: CloudflareDnsConfig,
        private readonly fetchImpl: typeof fetch = fetch,
    ) {
        this.baseUrl = (config.apiBaseUrl ?? 'https://api.cloudflare.com/client/v4').replace(
            /\/$/,
            '',
        );
    }

    /**
     * Ensure a CNAME record exists pointing `<slug>.<rootDomain>` at
     * the configured target hostname. Idempotent: if a matching CNAME
     * already exists, returns it; if a stale record (different target)
     * exists, updates it in place. Always returns a snapshot for the
     * caller to log / persist.
     */
    async ensureWorkSubdomain(slug: string): Promise<DnsRecordSnapshot> {
        this.assertSlug(slug);
        const fqdn = `${slug}.${this.config.rootDomain}`;
        const target = this.config.targetHostname;
        const proxied = requiresProxy(target);

        const existing = await this.findRecord(fqdn);
        if (existing) {
            if (existing.content === target && existing.type === 'CNAME') {
                this.logger.log(`CloudflareDns CNAME already in sync ${fqdn} -> ${target}`);
                return existing;
            }
            // Drifted record: same name, different content/type. Update.
            const updated = await this.patchRecord(existing.id, {
                type: 'CNAME',
                name: fqdn,
                content: target,
                proxied,
                ttl: 1, // 1 == 'auto' per Cloudflare docs
            });
            this.logger.log(
                `CloudflareDns CNAME updated ${fqdn}: was ${existing.content} now ${target}`,
            );
            return updated;
        }

        const created = await this.createRecord({
            type: 'CNAME',
            name: fqdn,
            content: target,
            proxied,
            ttl: 1,
        });
        this.logger.log(`CloudflareDns CNAME created ${fqdn} -> ${target}`);
        return created;
    }

    /** Remove the CNAME for a Work — no-op if it never existed. */
    async removeWorkSubdomain(slug: string): Promise<void> {
        this.assertSlug(slug);
        const fqdn = `${slug}.${this.config.rootDomain}`;
        const existing = await this.findRecord(fqdn);
        if (!existing) {
            return;
        }
        await this.deleteRecord(existing.id);
        this.logger.log(`CloudflareDns CNAME deleted ${fqdn}`);
    }

    // EW-735 — IDnsOperations contract ---------------------------------------
    //
    // Thin host-keyed surface that `SubdomainAllocator` + future code paths
    // talk to. ADDITIVE — the legacy `ensureWorkSubdomain` / `removeWorkSubdomain`
    // methods above stay unchanged and the existing call sites
    // (`EverWorksDnsService.ensureWorkSubdomain` → `applyEverWorksSubdomain`)
    // keep behaving bit-for-bit.

    /**
     * Idempotent create-or-update for any host the caller specifies.
     * Generalizes `ensureWorkSubdomain` (which is restricted to slug-shaped
     * hosts under the managed `rootDomain`) to arbitrary hosts + A/CNAME.
     */
    async ensureRecord(input: DnsEnsureRecordInput): Promise<DnsRecordSnapshotContract> {
        // Augment low: normalize once and use the normalized form everywhere
        // so a host that passes validation only after trim/lowercase doesn't
        // miss an existing record (lookup) or get sent verbatim to Cloudflare.
        const host = this.normalizeHost(input.host);
        const proxied = input.proxied ?? false;
        const ttl = input.ttl ?? 1;
        const existing = await this.findRecord(host, input.type);
        if (existing) {
            if (existing.content === input.target && existing.type === input.type) {
                this.logger.log(
                    `CloudflareDns ${input.type} already in sync ${host} -> ${input.target}`,
                );
                return existing as DnsRecordSnapshotContract;
            }
            const updated = await this.patchAnyRecord(existing.id, {
                type: input.type,
                name: host,
                content: input.target,
                proxied,
                ttl,
            });
            this.logger.log(
                `CloudflareDns ${input.type} updated ${host}: was ${existing.content} now ${input.target}`,
            );
            return updated;
        }
        const created = await this.createAnyRecord({
            type: input.type,
            name: host,
            content: input.target,
            proxied,
            ttl,
        });
        this.logger.log(`CloudflareDns ${input.type} created ${host} -> ${input.target}`);
        return created;
    }

    /**
     * Idempotent delete for any host. No-op when the record does not exist.
     * When `input.type` is omitted, probes BOTH CNAME and A so a caller that
     * doesn't know the original record type still removes it (Augment low).
     */
    async removeRecord(input: DnsRemoveRecordInput): Promise<void> {
        const host = this.normalizeHost(input.host);
        const typesToProbe: DnsRecordType[] = input.type ? [input.type] : ['CNAME', 'A'];
        for (const type of typesToProbe) {
            const existing = await this.findRecord(host, type);
            if (existing) {
                await this.deleteRecord(existing.id);
                this.logger.log(
                    `CloudflareDns ${existing.type} deleted ${host} (id=${existing.id})`,
                );
            }
        }
    }

    /**
     * Uniqueness probe — `true` iff any A/CNAME record exists for `host` in
     * the managed zone, regardless of who owns it. Used by
     * `SubdomainAllocator` to detect collisions before persisting a claim.
     */
    async recordExists(host: string): Promise<boolean> {
        const normalized = this.normalizeHost(host);
        // Probe CNAME first (the common case for managed subdomains), then A.
        const cname = await this.findRecord(normalized, 'CNAME');
        if (cname) return true;
        const a = await this.findRecord(normalized, 'A');
        return a !== null;
    }

    /** Zone root domain managed by this provider (e.g. `'ever.works'`). */
    rootDomain(): string {
        return this.config.rootDomain;
    }

    // Internal helpers ------------------------------------------------------

    private assertSlug(slug: string): void {
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
            throw new Error(`Invalid slug for Cloudflare DNS: ${slug}`);
        }
    }

    /**
     * EW-735 — validate + normalize an arbitrary FQDN. Stricter than
     * `assertSlug` because the host may contain dots (label.label.tld). Each
     * label follows the same slug-shaped rule as `assertSlug`. Returns the
     * trim/lowercased form so callers can use it verbatim in Cloudflare
     * API payloads and lookups (Augment low — previously the validator
     * normalized but the caller used the raw input).
     */
    private normalizeHost(host: string): string {
        const trimmed = (host ?? '').trim().toLowerCase();
        if (trimmed.length === 0 || trimmed.length > 253) {
            throw new Error(`Invalid host for Cloudflare DNS: ${host}`);
        }
        const labelRe = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
        for (const label of trimmed.split('.')) {
            if (!labelRe.test(label) || label.length > 63) {
                throw new Error(`Invalid host for Cloudflare DNS: ${host}`);
            }
        }
        return trimmed;
    }

    private async findRecord(
        name: string,
        type: DnsRecordType = 'CNAME',
    ): Promise<DnsRecordSnapshot | null> {
        const url = new URL(`${this.baseUrl}/zones/${this.config.zoneId}/dns_records`);
        url.searchParams.set('name', name);
        url.searchParams.set('type', type);
        const json = await this.request<{
            result: (DnsRecordSnapshot & { type: DnsRecordType })[];
        }>(url.toString(), { method: 'GET' });
        return (json.result[0] ?? null) as DnsRecordSnapshot | null;
    }

    private async createAnyRecord(payload: {
        type: DnsRecordType;
        name: string;
        content: string;
        proxied: boolean;
        ttl: number;
    }): Promise<DnsRecordSnapshotContract> {
        const json = await this.request<{ result: DnsRecordSnapshotContract }>(
            `${this.baseUrl}/zones/${this.config.zoneId}/dns_records`,
            { method: 'POST', body: JSON.stringify(payload) },
        );
        return json.result;
    }

    private async patchAnyRecord(
        id: string,
        payload: {
            type: DnsRecordType;
            name: string;
            content: string;
            proxied: boolean;
            ttl: number;
        },
    ): Promise<DnsRecordSnapshotContract> {
        const json = await this.request<{ result: DnsRecordSnapshotContract }>(
            `${this.baseUrl}/zones/${this.config.zoneId}/dns_records/${id}`,
            { method: 'PUT', body: JSON.stringify(payload) },
        );
        return json.result;
    }

    private async createRecord(payload: {
        type: 'CNAME';
        name: string;
        content: string;
        proxied: boolean;
        ttl: number;
    }): Promise<DnsRecordSnapshot> {
        const json = await this.request<{ result: DnsRecordSnapshot }>(
            `${this.baseUrl}/zones/${this.config.zoneId}/dns_records`,
            { method: 'POST', body: JSON.stringify(payload) },
        );
        return json.result;
    }

    private async patchRecord(
        id: string,
        payload: {
            type: 'CNAME';
            name: string;
            content: string;
            proxied: boolean;
            ttl: number;
        },
    ): Promise<DnsRecordSnapshot> {
        const json = await this.request<{ result: DnsRecordSnapshot }>(
            `${this.baseUrl}/zones/${this.config.zoneId}/dns_records/${id}`,
            { method: 'PUT', body: JSON.stringify(payload) },
        );
        return json.result;
    }

    private async deleteRecord(id: string): Promise<void> {
        await this.request(`${this.baseUrl}/zones/${this.config.zoneId}/dns_records/${id}`, {
            method: 'DELETE',
        });
    }

    private async request<T = unknown>(url: string, init: RequestInit): Promise<T> {
        const response = await this.fetchImpl(url, {
            ...init,
            headers: {
                Authorization: `Bearer ${this.config.apiToken}`,
                'Content-Type': 'application/json',
                ...(init.headers ?? {}),
            },
        });
        let body: any;
        try {
            body = await response.json();
        } catch {
            body = null;
        }
        if (!response.ok || (body && body.success === false)) {
            throw new CloudflareDnsError(
                `Cloudflare API ${init.method ?? 'GET'} ${url} failed: ${response.status}`,
                response.status,
                body?.errors ?? body ?? null,
            );
        }
        return body as T;
    }
}

/**
 * Nest-injectable facade that owns the env reading + lazy-instantiation
 * of the `CloudflareDnsProvider`. Returns `null` from `getProvider()`
 * when DNS automation is not configured (env vars missing) so callers
 * can no-op cleanly in dev.
 */
@Injectable()
export class EverWorksDnsService {
    private readonly logger = new Logger(EverWorksDnsService.name);
    private cachedProvider: CloudflareDnsProvider | null | undefined;

    getProvider(): CloudflareDnsProvider | null {
        if (this.cachedProvider !== undefined) {
            return this.cachedProvider;
        }
        const apiToken = process.env.CLOUDFLARE_API_TOKEN?.trim();
        const zoneId = process.env.CLOUDFLARE_ZONE_ID?.trim();
        const targetHostname = process.env.EVER_WORKS_DEPLOY_LB_HOSTNAME?.trim();
        const rootDomain = process.env.EVER_WORKS_DOMAIN?.trim() || 'ever.works';

        if (!apiToken || !zoneId || !targetHostname) {
            this.logger.debug(
                'CloudflareDns not configured (missing CLOUDFLARE_API_TOKEN / CLOUDFLARE_ZONE_ID / EVER_WORKS_DEPLOY_LB_HOSTNAME) — skipping subdomain automation',
            );
            this.cachedProvider = null;
            return null;
        }

        this.cachedProvider = new CloudflareDnsProvider({
            apiToken,
            zoneId,
            rootDomain,
            targetHostname,
        });
        return this.cachedProvider;
    }

    /** Compute the canonical ingress host for a given Work slug. */
    ingressHostFor(slug: string): string {
        // Security: validate slug with the same rule enforced in CloudflareDnsProvider.assertSlug
        // to prevent malformed/injected values from being stored as canonical URLs.
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
            throw new Error(`Invalid slug for ingress host: ${slug}`);
        }
        const rootDomain = process.env.EVER_WORKS_DOMAIN?.trim() || 'ever.works';
        return `${slug}.${rootDomain}`;
    }

    async ensureWorkSubdomain(slug: string): Promise<void> {
        const provider = this.getProvider();
        if (!provider) return;
        try {
            await provider.ensureWorkSubdomain(slug);
        } catch (cause) {
            // DNS failures must not abort a deploy — the user can fix the
            // record manually and the Work is still reachable via the LB
            // hostname. Surface the error so ops can alert on it.
            this.logger.error(
                `Failed to ensure CNAME for ${slug}: ${(cause as Error).message}`,
                cause instanceof Error ? cause.stack : undefined,
            );
        }
    }

    async removeWorkSubdomain(slug: string): Promise<void> {
        const provider = this.getProvider();
        if (!provider) return;
        try {
            await provider.removeWorkSubdomain(slug);
        } catch (cause) {
            this.logger.error(`Failed to delete CNAME for ${slug}: ${(cause as Error).message}`);
        }
    }

    /** Reset the cache — test-only hook so unit tests can re-read env. */
    resetCacheForTest(): void {
        this.cachedProvider = undefined;
    }
}
