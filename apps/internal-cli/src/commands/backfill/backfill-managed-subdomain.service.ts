/**
 * EW-736 — one-off backfill of `works.managedSubdomain` from live Cloudflare DNS.
 *
 * Context
 * -------
 * The `works.managedSubdomain` column was added by migration
 * `1780800000000-AddWorkManagedSubdomain` as nullable so existing rows kept
 * working unchanged. Seven legacy Works were already serving traffic at
 * `*.ever.works` before the column existed:
 *
 *   dir, mcpserver, vectordb, timetrack, chairs, startup-books,
 *   compliance-automation
 *
 * Note: these SLUGS may differ from the Works' current slugs (slug renames
 * are allowed). The authoritative pairing of "Work ↔ live subdomain" is the
 * Cloudflare zone, not the Work row. So the backfill must scan the LIVE
 * Cloudflare records and match each back to a Work — never derive from
 * `work.slug` blindly.
 *
 * Without backfill, a slug rename of one of those Works would orphan its
 * live CNAME (because the rename path tears down `${oldSlug}.ever.works`,
 * but the new managed-subdomain code only ever re-uses
 * `work.managedSubdomain` — which is `NULL` for these rows). Backfilling
 * gives them the same orphan-on-rename protection every newly-deployed Work
 * gets via `SubdomainAllocator` (EW-737).
 *
 * This is **idempotent** and **safe to re-run**:
 *  - Works that already have `managedSubdomain` set are skipped.
 *  - A Work that can't be unambiguously matched is logged and skipped (no write).
 *  - Dry-run is the default; `--write` is required to persist.
 *
 * See `docs/specs/features/cloudflare-dns-plugin/spec.md` §5.
 */

import type { Logger } from '@nestjs/common';
// `Work` is type-only so Vitest doesn't need the agent package to be
// pre-built when running unit tests against this service.
import type { Work } from '@ever-works/agent/entities';

/**
 * Minimal Cloudflare DNS record shape returned by
 * `GET /zones/{id}/dns_records`. We only consume the fields needed for
 * matching — any extra fields are tolerated.
 */
export interface CloudflareDnsRecord {
    id: string;
    type: string;
    name: string;
    content?: string;
}

/**
 * Lists ALL DNS records in the zone with pagination. The provider abstracts
 * fetch + auth + paging so this service stays unit-testable with a small
 * in-memory implementation.
 */
export interface CloudflareZoneLister {
    /**
     * Returns every CNAME (and A — k8s mode uses A records) record in the
     * configured zone. Implementations should handle pagination internally.
     */
    listAllRecords(): Promise<CloudflareDnsRecord[]>;
    rootDomain(): string;
}

/**
 * Subset of `WorkRepository` we actually use. Lets unit tests pass a plain
 * object literal rather than a TypeORM stub. The repository's real method
 * `update(id, partial)` is reused so this stays in sync with the persistence
 * path used by `SubdomainAllocator`.
 */
export interface WorkBackfillReadWrite {
    findCandidatesForBackfill(): Promise<Work[]>;
    update(id: string, updateData: Partial<Work>): Promise<unknown>;
}

export interface BackfillOptions {
    /** When `false` (the default) no DB writes are performed. */
    write?: boolean;
    /**
     * Deploy providers to include — defaults to `['ever-works', 'k8s']` to
     * match the providers that allocate managed subdomains. Surfaced as an
     * option mainly for tests.
     */
    deployProviders?: string[];
}

export interface BackfillSummary {
    /** Total Works inspected (after the deployProvider filter). */
    totalScanned: number;
    /** Works already carrying `managedSubdomain` — left untouched. */
    alreadySet: number;
    /** Works the script unambiguously matched to a live CNAME. */
    matched: number;
    /** Works that had no Cloudflare candidate at all. */
    noCandidate: number;
    /**
     * Works that had MORE than one plausible match (current slug + suffix +
     * who-knows-what), logged but NOT persisted. Manual intervention.
     */
    ambiguous: number;
    /** Of `matched`, how many DB rows were actually written. 0 in dry-run. */
    persisted: number;
    /** Detailed plan entries — useful for assertions + ops review. */
    plan: BackfillPlanEntry[];
}

export type BackfillPlanEntry =
    | {
          kind: 'match';
          workId: string;
          slug: string;
          managedSubdomain: string;
          fqdn: string;
          /** Which matching strategy hit — for debuggability. */
          via: 'exact-slug' | 'slug-with-short-id-suffix';
      }
    | {
          kind: 'ambiguous';
          workId: string;
          slug: string;
          /** All candidate subdomain labels left after best-effort filtering. */
          candidates: string[];
      }
    | {
          kind: 'no-candidate';
          workId: string;
          slug: string;
      }
    | {
          kind: 'already-set';
          workId: string;
          slug: string;
          managedSubdomain: string;
      };

/**
 * Stable index — what the matcher actually consults. Builds two lookups
 * keyed by the leftmost label:
 *  - `byLabel`: leftmost label → record (used for exact-slug match).
 *  - `labels`: set of every label in the zone (used for ambiguity probes).
 */
function indexZone(
    records: CloudflareDnsRecord[],
    rootDomain: string,
): { byLabel: Map<string, CloudflareDnsRecord>; labels: Set<string> } {
    const suffix = `.${rootDomain.toLowerCase()}`;
    const byLabel = new Map<string, CloudflareDnsRecord>();
    const labels = new Set<string>();
    for (const record of records) {
        const type = record.type?.toUpperCase();
        // Managed subdomains today are CNAME (Ever Works mode) or A (k8s mode).
        if (type !== 'CNAME' && type !== 'A') continue;
        const name = (record.name ?? '').trim().toLowerCase();
        if (!name.endsWith(suffix)) continue;
        const label = name.slice(0, name.length - suffix.length);
        // Only single-label managed subdomains. `foo.bar.ever.works` is not
        // a managed-subdomain shape — skip it.
        if (!label || label.includes('.')) continue;
        labels.add(label);
        // First record per label wins for exact lookup. Multiple records on
        // the same label (e.g. CNAME + A) is unusual but tolerated.
        if (!byLabel.has(label)) {
            byLabel.set(label, record);
        }
    }
    return { byLabel, labels };
}

/**
 * Mirrors `SubdomainAllocator.shortId` — the first 4 hex chars of the Work
 * id with dashes removed. Used so the backfill script can recognise legacy
 * subdomains that may have been suffixed for collision-avoidance.
 */
function shortIdFor(workId: string): string {
    return workId.replace(/-/g, '').slice(0, 4).toLowerCase();
}

/**
 * Same slug normalization as `SubdomainAllocator.slugifyLabel` — keep the
 * two in sync so the backfill matches what the allocator would have
 * produced.
 */
function slugifyLabel(raw: string | null | undefined): string {
    return (raw ?? '')
        .toString()
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/-{2,}/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 63);
}

/**
 * Pure pairing function — given a Work and the zone index, decide whether
 * we can confidently pick exactly one Cloudflare label for it.
 *
 * Strategy (in order):
 *  1. Exact match: `slugifyLabel(work.slug)` is the unique label.
 *  2. Suffix match: `${slugifyLabel(work.slug)}-${shortId}` is the unique label.
 *
 * Note: we never auto-match on JUST shortId — too low entropy.
 */
export function planForWork(
    work: Work,
    zone: { byLabel: Map<string, CloudflareDnsRecord>; labels: Set<string> },
    rootDomain: string,
): BackfillPlanEntry {
    if (work.managedSubdomain && work.managedSubdomain.trim()) {
        return {
            kind: 'already-set',
            workId: work.id,
            slug: work.slug,
            managedSubdomain: work.managedSubdomain,
        };
    }
    const base = slugifyLabel(work.slug);
    if (!base) {
        return { kind: 'no-candidate', workId: work.id, slug: work.slug };
    }
    const candidates: string[] = [];
    if (zone.labels.has(base)) candidates.push(base);
    const suffixed = `${base}-${shortIdFor(work.id)}`;
    if (zone.labels.has(suffixed)) candidates.push(suffixed);

    if (candidates.length === 0) {
        return { kind: 'no-candidate', workId: work.id, slug: work.slug };
    }
    if (candidates.length === 1) {
        const label = candidates[0];
        return {
            kind: 'match',
            workId: work.id,
            slug: work.slug,
            managedSubdomain: label,
            fqdn: `${label}.${rootDomain}`,
            via: label === base ? 'exact-slug' : 'slug-with-short-id-suffix',
        };
    }
    return {
        kind: 'ambiguous',
        workId: work.id,
        slug: work.slug,
        candidates,
    };
}

/**
 * Core service that does the backfill. Takes its collaborators as plain
 * interfaces so it stays unit-testable without TypeORM / NestJS / Cloudflare.
 */
export class BackfillManagedSubdomainService {
    constructor(
        private readonly works: WorkBackfillReadWrite,
        private readonly cloudflare: CloudflareZoneLister,
        private readonly logger: Pick<Logger, 'log' | 'warn' | 'error'>,
    ) {}

    async run(options: BackfillOptions = {}): Promise<BackfillSummary> {
        const writeMode = options.write === true;
        const rootDomain = this.cloudflare.rootDomain();
        const records = await this.cloudflare.listAllRecords();
        const zone = indexZone(records, rootDomain);
        this.logger.log(
            `[backfill] Cloudflare zone ${rootDomain} has ${zone.labels.size} managed-shape labels in scope (${records.length} total records scanned)`,
        );

        const works = await this.works.findCandidatesForBackfill();
        const summary: BackfillSummary = {
            totalScanned: works.length,
            alreadySet: 0,
            matched: 0,
            noCandidate: 0,
            ambiguous: 0,
            persisted: 0,
            plan: [],
        };

        for (const work of works) {
            const entry = planForWork(work, zone, rootDomain);
            summary.plan.push(entry);

            switch (entry.kind) {
                case 'already-set':
                    summary.alreadySet += 1;
                    this.logger.log(
                        `[backfill] SKIP work=${entry.workId} slug=${entry.slug} already has managedSubdomain=${entry.managedSubdomain}`,
                    );
                    break;
                case 'no-candidate':
                    summary.noCandidate += 1;
                    this.logger.log(
                        `[backfill] NO_CANDIDATE work=${entry.workId} slug=${entry.slug} — no matching CNAME/A in zone`,
                    );
                    break;
                case 'ambiguous':
                    summary.ambiguous += 1;
                    this.logger.warn(
                        `[backfill] AMBIGUOUS work=${entry.workId} slug=${entry.slug} candidates=[${entry.candidates.join(
                            ', ',
                        )}] — skipping; resolve manually`,
                    );
                    break;
                case 'match':
                    summary.matched += 1;
                    if (writeMode) {
                        try {
                            await this.works.update(entry.workId, {
                                managedSubdomain: entry.managedSubdomain,
                            });
                            summary.persisted += 1;
                            this.logger.log(
                                `[backfill] WROTE work=${entry.workId} slug=${entry.slug} managedSubdomain=${entry.managedSubdomain} (via ${entry.via})`,
                            );
                        } catch (cause) {
                            this.logger.error(
                                `[backfill] FAIL work=${entry.workId} slug=${entry.slug} managedSubdomain=${entry.managedSubdomain}: ${(cause as Error).message}`,
                            );
                        }
                    } else {
                        this.logger.log(
                            `[backfill] PLAN work=${entry.workId} slug=${entry.slug} would set managedSubdomain=${entry.managedSubdomain} (via ${entry.via}) [dry-run]`,
                        );
                    }
                    break;
            }
        }

        this.logger.log(
            `[backfill] Summary: scanned=${summary.totalScanned} alreadySet=${summary.alreadySet} matched=${summary.matched} persisted=${summary.persisted} ambiguous=${summary.ambiguous} noCandidate=${summary.noCandidate} writeMode=${writeMode}`,
        );
        return summary;
    }
}
