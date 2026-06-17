import { Injectable, Logger } from '@nestjs/common';
import { Work } from '../entities/work.entity';
import { WorkRepository } from '../database/repositories/work.repository';
import { EverWorksDnsService } from './cloudflare-dns.provider';
import type { IDnsOperations } from '@ever-works/plugin';

/**
 * EW-734 / EW-737 — collision-safe managed-subdomain allocator.
 *
 * The legacy `applyEverWorksSubdomain` derives `${work.slug}.ever.works` on
 * every deploy. That's:
 *  - **not globally unique** (two users with the same slug both claim it),
 *  - **not persisted** (a slug rename orphans the old CNAME),
 *  - **not race-safe** (concurrent first-deploys of two new Works can both
 *    pick the same base and both succeed against an empty zone).
 *
 * `SubdomainAllocator` is an **additive** service that fixes all three
 * without touching the existing path. It is consumed by the new
 * `applyManagedSubdomain` extension (gated behind the
 * `K8S_MANAGED_SUBDOMAIN` env flag — see `deploy.service.ts`). When
 * the flag is OFF — which it is by default in this PR — the legacy
 * `applyEverWorksSubdomain` runs untouched and this service is unused.
 *
 * Algorithm (spec §4.3):
 *  1. If `work.managedSubdomain` is already persisted, **reuse it** as-is.
 *     Subsequent deploys never re-allocate (idempotent, also prevents a
 *     slug rename from orphaning the live CNAME).
 *  2. Otherwise `base = slugify(work.slug)`. Probe:
 *     - DB: does another Work already hold `managedSubdomain = base`?
 *     - Provider: does `recordExists(base.rootDomain)` return true?
 *     If either says yes, the base is taken.
 *  3. On collision, append `-${shortId}` where `shortId` is the first 4
 *     hex chars of `work.id` (deterministic across retries — mirrors
 *     `EverWorksGitProvider.buildRepoName(work, true)`). Re-probe.
 *  4. Retry up to `MAX_TRIES`. Persist the winner on `work.managedSubdomain`
 *     in a single repository `update()`. The partial unique index
 *     `UQ_works_managedSubdomain_notnull` is the DB-level race backstop.
 *
 * Note: this service ONLY allocates + persists. It does NOT create the DNS
 * record itself — the caller (`applyManagedSubdomain`) decides whether to
 * fire-and-forget via `EverWorksDnsService` (existing path) or via a
 * plugin-resolved `IDnsOperations` (future path).
 */
export interface SubdomainAllocationResult {
    /** The leftmost label stored on `work.managedSubdomain` (e.g. `ai-coding`). */
    readonly subdomain: string;
    /** Fully-qualified host (`${subdomain}.${rootDomain}`). */
    readonly fqdn: string;
    /** Root domain used (`'ever.works'` for managed mode). */
    readonly rootDomain: string;
    /** `true` when this call performed a fresh allocation; `false` when it reused. */
    readonly allocated: boolean;
}

@Injectable()
export class SubdomainAllocator {
    private readonly logger = new Logger(SubdomainAllocator.name);
    private static readonly MAX_TRIES = 5;
    private static readonly LABEL_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
    /**
     * Reserved platform labels — never let a tenant claim these. Mirrors the
     * blocklist intent in spec §7.
     */
    private static readonly BLOCKLIST: ReadonlySet<string> = new Set([
        'www',
        'api',
        'app',
        'admin',
        'mail',
        'auth',
        'docs',
        'status',
        'platform',
        'dashboard',
        'cdn',
        'static',
        'root',
        'mx',
        'ns',
        'ns1',
        'ns2',
    ]);

    constructor(
        private readonly workRepository: WorkRepository,
        private readonly dnsService: EverWorksDnsService,
    ) {}

    /**
     * Allocate (or reuse) the managed subdomain for `work`. Persists the
     * choice on `work.managedSubdomain` via `WorkRepository.update`. Does
     * NOT touch DNS — the caller decides when to (re)ensure the record.
     *
     * @param work    The Work to allocate for. Must have a valid `slug`.
     * @param dnsOps  Optional ops surface used for the collision probe
     *                (`recordExists`). When omitted, the allocator falls
     *                back to the managed `EverWorksDnsService` provider;
     *                when that's also unconfigured (no env vars in dev)
     *                the probe is skipped — the DB uniqueness check + DB
     *                unique index alone keep allocation safe.
     */
    async allocate(work: Work, dnsOps?: IDnsOperations): Promise<SubdomainAllocationResult> {
        const rootDomain = dnsOps?.rootDomain?.() ?? this.resolveRootDomain();

        // (1) idempotent reuse
        const persisted = (work.managedSubdomain ?? '').trim().toLowerCase();
        if (persisted) {
            this.assertLabel(persisted);
            return {
                subdomain: persisted,
                fqdn: `${persisted}.${rootDomain}`,
                rootDomain,
                allocated: false,
            };
        }

        const base = this.slugifyLabel(work.slug);
        if (!base) {
            throw new Error(
                `SubdomainAllocator: work ${work.id} has no usable slug (got: ${JSON.stringify(work.slug)})`,
            );
        }

        const probe = dnsOps ?? this.resolveProbe();
        const shortId = work.id.replace(/-/g, '').slice(0, 4);
        for (let attempt = 0; attempt < SubdomainAllocator.MAX_TRIES; attempt++) {
            // Explicit candidate sequence (Greptile P2): the previous version
            // reused `attempt` as both loop counter and suffix index, which
            // produced the right strings but was hard to reason about.
            //   attempt 0 → base
            //   attempt 1 → base-<shortId>            (mirrors buildRepoName)
            //   attempt n>1 → base-<shortId>-<n-1 in base36>
            const candidate =
                attempt === 0
                    ? base
                    : attempt === 1
                      ? `${base}-${shortId}`
                      : `${base}-${shortId}-${(attempt - 1).toString(36)}`;
            if (!(await this.isCandidateFree(candidate, work.id, rootDomain, probe))) {
                continue;
            }
            try {
                await this.workRepository.update(work.id, { managedSubdomain: candidate });
                this.logger.log(
                    `SubdomainAllocator allocated ${candidate} for work ${work.id} (attempt ${attempt + 1})`,
                );
                return {
                    subdomain: candidate,
                    fqdn: `${candidate}.${rootDomain}`,
                    rootDomain,
                    allocated: true,
                };
            } catch (cause) {
                // Augment medium: concurrent first-deploys can race past the
                // in-process probe and only collide at the DB partial-unique
                // index. Retry with the next candidate instead of failing.
                if (this.isUniqueViolation(cause)) {
                    this.logger.warn(
                        `SubdomainAllocator unique-index race for ${candidate} on work ${work.id}: retrying`,
                    );
                    continue;
                }
                throw cause;
            }
        }
        throw new Error(
            `SubdomainAllocator exhausted ${SubdomainAllocator.MAX_TRIES} candidates for work ${work.id} (base=${base})`,
        );
    }

    /**
     * Postgres unique-violation detection. Matches TypeORM's `QueryFailedError`
     * shape (`driverError.code === '23505'`) and the standard `code` field on
     * raw pg errors. SQLite (test adapter) surfaces unique violations with
     * `SQLITE_CONSTRAINT_UNIQUE`, also covered.
     */
    private isUniqueViolation(cause: unknown): boolean {
        if (!cause || typeof cause !== 'object') return false;
        const err = cause as { code?: string; driverError?: { code?: string }; message?: string };
        if (err.code === '23505') return true;
        if (err.driverError?.code === '23505') return true;
        if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return true;
        const msg = (err.message ?? '').toLowerCase();
        return msg.includes('unique constraint') || msg.includes('uq_works_managedsubdomain');
    }

    // --- helpers --------------------------------------------------------------

    private resolveRootDomain(): string {
        // Mirrors `EverWorksDnsService.ingressHostFor` — kept in sync so the
        // allocator and the legacy path agree on the FQDN shape.
        return process.env.EVER_WORKS_DOMAIN?.trim() || 'ever.works';
    }

    private resolveProbe(): IDnsOperations | null {
        // The legacy `CloudflareDnsProvider` implements `IDnsOperations` after
        // EW-735 (see `cloudflare-dns.provider.ts`). When env vars are missing
        // (dev / preview), `getProvider()` returns null and we skip the probe.
        // No type assertion needed — the structural implements relationship
        // is enforced by `CloudflareDnsProvider implements IDnsOperations`.
        return this.dnsService.getProvider();
    }

    private async isCandidateFree(
        candidate: string,
        ownWorkId: string,
        rootDomain: string,
        probe: IDnsOperations | null,
    ): Promise<boolean> {
        this.assertLabel(candidate);
        if (SubdomainAllocator.BLOCKLIST.has(candidate)) {
            return false;
        }
        // DB-level claim by another Work?
        const other = await this.workRepository.findByManagedSubdomain(candidate);
        if (other && other.id !== ownWorkId) {
            return false;
        }
        // Provider-level zone collision?
        if (probe) {
            try {
                const exists = await probe.recordExists(`${candidate}.${rootDomain}`);
                if (exists) {
                    // Owned by us already → reuse-safe. Owned by anyone else (or
                    // a stale orphan we can't attribute) → treat as taken.
                    return false;
                }
            } catch (cause) {
                // A probe failure must not block allocation — the DB unique
                // index + caller-side ensureRecord drift-correction will catch
                // any real collision when we actually try to write the record.
                this.logger.warn(
                    `SubdomainAllocator probe failed for ${candidate}.${rootDomain}: ${(cause as Error).message}`,
                );
            }
        }
        return true;
    }

    private slugifyLabel(raw: string | undefined | null): string {
        const lower = (raw ?? '').toString().toLowerCase().trim();
        // Replace any run of non-[a-z0-9] with `-`, collapse, trim edge dashes,
        // clamp to RFC 1035 label length (63).
        const slug = lower
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/-{2,}/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 63);
        return slug;
    }

    private assertLabel(label: string): void {
        if (!SubdomainAllocator.LABEL_RE.test(label) || label.length > 63) {
            throw new Error(`Invalid managed-subdomain label: ${label}`);
        }
    }
}
