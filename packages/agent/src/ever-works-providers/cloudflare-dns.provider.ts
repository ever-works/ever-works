import { Injectable, Logger } from '@nestjs/common';

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
    type: 'CNAME';
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
export class CloudflareDnsProvider {
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
                proxied: false,
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
            proxied: false,
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

    // Internal helpers ------------------------------------------------------

    private assertSlug(slug: string): void {
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
            throw new Error(`Invalid slug for Cloudflare DNS: ${slug}`);
        }
    }

    private async findRecord(name: string): Promise<DnsRecordSnapshot | null> {
        const url = new URL(`${this.baseUrl}/zones/${this.config.zoneId}/dns_records`);
        url.searchParams.set('name', name);
        url.searchParams.set('type', 'CNAME');
        const json = await this.request<{ result: DnsRecordSnapshot[] }>(url.toString(), {
            method: 'GET',
        });
        return json.result[0] ?? null;
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
            this.logger.error(
                `Failed to delete CNAME for ${slug}: ${(cause as Error).message}`,
            );
        }
    }

    /** Reset the cache — test-only hook so unit tests can re-read env. */
    resetCacheForTest(): void {
        this.cachedProvider = undefined;
    }
}
