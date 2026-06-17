/**
 * EW-736 — Cloudflare zone lister for the managed-subdomain backfill.
 *
 * Thin pager around `GET /zones/{id}/dns_records` that returns every record
 * in the zone, regardless of type. The backfill service filters down to
 * CNAME/A records under the managed domain. Kept separate from the
 * `CloudflareDnsProvider` in `@ever-works/agent/ever-works-providers`
 * because that provider is the hot path (per-deploy ensureRecord) and we
 * don't want a `list all` helper bloating its API surface for a one-off.
 */

import type { CloudflareDnsRecord, CloudflareZoneLister } from './backfill-managed-subdomain.service';

/**
 * Local error class mirroring the shape of
 * `CloudflareDnsError` from `@ever-works/agent/ever-works-providers`
 * without taking the import — the agent package is a workspace dependency
 * but only its compiled `dist/` is exposed at build time, and we want the
 * unit test to run against source without a prebuild step.
 */
export class CloudflareZoneListerError extends Error {
    constructor(
        message: string,
        readonly status: number,
        readonly errors: unknown,
    ) {
        super(message);
        this.name = 'CloudflareZoneListerError';
    }
}

export interface CloudflareZoneListerConfig {
    apiToken: string;
    zoneId: string;
    rootDomain: string;
    /** Optional override (tests). */
    apiBaseUrl?: string;
    /** Per-page size — Cloudflare allows up to 100 (which is the default). */
    perPage?: number;
}

export class CloudflareApiZoneLister implements CloudflareZoneLister {
    private readonly baseUrl: string;
    private readonly perPage: number;

    constructor(
        private readonly config: CloudflareZoneListerConfig,
        private readonly fetchImpl: typeof fetch = fetch,
    ) {
        this.baseUrl = (config.apiBaseUrl ?? 'https://api.cloudflare.com/client/v4').replace(
            /\/$/,
            '',
        );
        this.perPage = Math.min(Math.max(config.perPage ?? 100, 1), 100);
    }

    rootDomain(): string {
        return this.config.rootDomain;
    }

    async listAllRecords(): Promise<CloudflareDnsRecord[]> {
        const out: CloudflareDnsRecord[] = [];
        let page = 1;
        for (;;) {
            const url = new URL(`${this.baseUrl}/zones/${this.config.zoneId}/dns_records`);
            url.searchParams.set('per_page', String(this.perPage));
            url.searchParams.set('page', String(page));
            const body = await this.fetchJson<{
                result?: CloudflareDnsRecord[];
                result_info?: { total_pages?: number; page?: number };
                success?: boolean;
                errors?: unknown;
            }>(url.toString());

            const result = Array.isArray(body.result) ? body.result : [];
            out.push(...result);

            const totalPages = body.result_info?.total_pages ?? 1;
            if (page >= totalPages || result.length === 0) {
                break;
            }
            page += 1;
            // Guard against runaway pagination loops on bad servers.
            if (page > 1000) {
                throw new Error(
                    `CloudflareApiZoneLister: pagination did not terminate after ${page} pages`,
                );
            }
        }
        return out;
    }

    private async fetchJson<T>(url: string): Promise<T> {
        const response = await this.fetchImpl(url, {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${this.config.apiToken}`,
                'Content-Type': 'application/json',
            },
        });
        let body: any;
        try {
            body = await response.json();
        } catch {
            body = null;
        }
        if (!response.ok || (body && body.success === false)) {
            throw new CloudflareZoneListerError(
                `Cloudflare API GET ${url} failed: ${response.status}`,
                response.status,
                body?.errors ?? body ?? null,
            );
        }
        return body as T;
    }
}
