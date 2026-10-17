/**
 * APW-06 T47/T48 (A0.8, lane aw-deploy-2, 2026-10-17) — **the apps-domain DNS service** (plan §8.3).
 *
 * The managed subdomain `<label>.<apps domain>` of an App Work: the label is allocated once by
 * `SubdomainAllocator` (persisted on `works.managedSubdomain`), the record points at the address
 * the cluster's ingress reported (`work_app_runtime_states.ingressAddress`), and it is removed when
 * the App Work is deleted (`APPS_DOMAIN_DNS_SERVICE`, `app-runtime-deletion.service.ts`).
 *
 * ## The configuration it reads — and only it (T47)
 *
 * `config.everWorks.apps.getDomain()` (the apps apex, or the platform domain on the shared
 * default), `EVER_WORKS_APPS_DNS_ZONE_ID` and `EVER_WORKS_APPS_DNS_API_TOKEN`. It never falls
 * back to the platform's own DNS provider instance: with no apps-DNS configuration it answers
 * `null` from {@link provider} and every write is a no-op the caller can see.
 *
 * ## The record (T48)
 *
 * `A` for a public IPv4 ingress address, `CNAME` for a hostname; never proxied (the cluster
 * terminates TLS for Your cluster). A private, loopback or link-local address is refused — a public
 * name must never point into someone's private network.
 */

import { isIP } from 'node:net';
import { Injectable, Logger, Optional } from '@nestjs/common';
import type { IDnsOperations } from '@ever-works/plugin';

import { config } from '../config';
import { WorkRepository } from '../database/repositories/work.repository';
import { CloudflareDnsProvider } from './cloudflare-dns.provider';
import { SubdomainAllocator } from './subdomain-allocator.service';

/** §8.3 — the shortest label a managed App subdomain may have. */
export const APPS_DOMAIN_MIN_LABEL_LENGTH = 3;

/** What `ensureFor` decided, for its caller's log and spec. */
export type AppsDomainRecordOutcome =
    | { status: 'ensured'; host: string; type: 'A' | 'CNAME'; target: string }
    | { status: 'skipped'; reason: string };

@Injectable()
export class AppsDomainDnsServiceImpl {
    private readonly logger = new Logger(AppsDomainDnsServiceImpl.name);
    private cached: { key: string; provider: CloudflareDnsProvider } | null = null;

    constructor(
        @Optional() private readonly works?: WorkRepository,
        private readonly env: NodeJS.ProcessEnv = process.env,
        private readonly fetchImpl?: typeof fetch,
    ) {}

    /** The apps apex, or `null` when no managed subdomain can be addressed. */
    rootDomain(): string | null {
        try {
            return config.everWorks?.apps?.getDomain?.() ?? null;
        } catch {
            return null;
        }
    }

    /** The apps-DNS provider, or `null` when the apps-DNS configuration is incomplete. */
    provider(): (IDnsOperations & CloudflareDnsProvider) | null {
        const rootDomain = this.rootDomain();
        const zoneId = (this.env.EVER_WORKS_APPS_DNS_ZONE_ID ?? '').trim();
        const apiToken = (this.env.EVER_WORKS_APPS_DNS_API_TOKEN ?? '').trim();
        if (!rootDomain || !zoneId || !apiToken) return null;

        const key = `${rootDomain}|${zoneId}|${apiToken.length}`;
        if (this.cached?.key !== key) {
            this.cached = {
                key,
                provider: new CloudflareDnsProvider(
                    { apiToken, zoneId, rootDomain, targetHostname: rootDomain },
                    this.fetchImpl ?? fetch,
                ),
            };
        }
        return this.cached.provider as IDnsOperations & CloudflareDnsProvider;
    }

    /**
     * Allocate (or reuse) the Work's managed label — `SubdomainAllocator`'s own algorithm (reuse a
     * persisted label; else the slug, then `-<shortId>`), probed against the APPS zone when it is
     * configured. Answers the host, or `null` when no apex is configured or allocation failed.
     */
    async allocate(workId: string): Promise<string | null> {
        const root = this.rootDomain();
        if (!root || !this.works?.findById) return null;
        const work = await this.works.findById(workId);
        if (!work) return null;
        const probe: IDnsOperations = this.provider() ?? {
            rootDomain: () => root,
            recordExists: async () => false,
            ensureRecord: async () => {
                throw new Error('apps DNS is not configured');
            },
            removeRecord: async () => undefined,
        };
        try {
            const result = await new SubdomainAllocator(this.works, null as never).allocate(
                work,
                probe,
            );
            return result.subdomain.length >= APPS_DOMAIN_MIN_LABEL_LENGTH ? result.fqdn : null;
        } catch (error) {
            this.logger.warn(
                `Allocating the managed App subdomain of ${workId} failed: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return null;
        }
    }

    /** The managed host of a Work, or `null` when it has no allocated label or no apex. */
    async hostOf(workId: string): Promise<string | null> {
        const root = this.rootDomain();
        if (!root || !this.works?.findById) return null;
        const work = await this.works.findById(workId);
        const label =
            typeof work?.managedSubdomain === 'string'
                ? work.managedSubdomain.trim().toLowerCase()
                : '';
        return label.length >= APPS_DOMAIN_MIN_LABEL_LENGTH ? `${label}.${root}` : null;
    }

    /** Point the Work's managed host at the address its ingress reported (T48). */
    async ensureFor(
        workId: string,
        address: { ip?: string | null; hostname?: string | null } | null | undefined,
    ): Promise<AppsDomainRecordOutcome> {
        const dns = this.provider();
        if (!dns) return { status: 'skipped', reason: 'apps_dns_unconfigured' };
        const host = await this.hostOf(workId);
        if (!host) return { status: 'skipped', reason: 'no_managed_subdomain' };

        const ip = (address?.ip ?? '').trim();
        const hostname = (address?.hostname ?? '').trim().toLowerCase();
        let record: { type: 'A' | 'CNAME'; target: string } | null = null;
        if (ip && isIP(ip) === 4 && isPublicIPv4(ip)) record = { type: 'A', target: ip };
        else if (!ip && hostname && isHostname(hostname))
            record = { type: 'CNAME', target: hostname };
        if (!record) return { status: 'skipped', reason: 'ingress_address_not_public' };

        await dns.ensureRecord({ host, type: record.type, target: record.target, proxied: false });
        this.logger.log(
            `Managed App host ${host} → ${record.type} ${record.target} (work ${workId}).`,
        );
        return { status: 'ensured', host, ...record };
    }

    /** `APPS_DOMAIN_DNS_SERVICE.removeRecord(workId)` — the deletion path (plan §9.7:1504). */
    async removeRecord(workId: string): Promise<boolean> {
        const dns = this.provider();
        if (!dns) return false;
        const host = await this.hostOf(workId);
        if (!host) return false;
        await dns.removeRecord({ host });
        return true;
    }
}

/** A routable IPv4 address: not private, loopback, link-local, CGNAT, multicast or reserved. */
export function isPublicIPv4(ip: string): boolean {
    const parts = ip.split('.').map((part) => Number(part));
    if (
        parts.length !== 4 ||
        parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
    ) {
        return false;
    }
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 192 && b === 0) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    return true;
}

function isHostname(value: string): boolean {
    if (value.length > 253 || value.endsWith('.local') || value === 'localhost') return false;
    return (
        value.split('.').length >= 2 &&
        value.split('.').every((label) => /^[a-z0-9-]{1,63}$/.test(label))
    );
}
