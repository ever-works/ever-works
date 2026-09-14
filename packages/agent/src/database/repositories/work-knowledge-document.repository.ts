import { ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
    Brackets,
    EntityManager,
    In,
    IsNull,
    Like,
    Not,
    Repository,
    SelectQueryBuilder,
} from 'typeorm';
import { WorkKnowledgeDocument } from '../../entities/work-knowledge-document.entity';
import {
    KB_ORG_INHERITABLE_CLASSES,
    KbDocumentClass,
    KbDocumentSource,
    KbDocumentStatus,
    KbLockMode,
    KbReviewState,
} from '../../entities/kb-types';
import {
    buildCaseInsensitiveLikeClause,
    prepareCaseInsensitiveContainsPattern,
    sanitizeLikePattern,
} from '../utils';

/**
 * Knowledge library — how many read-and-compare rounds
 * {@link WorkKnowledgeDocumentRepository.bumpRevision} makes before giving
 * up. Each lost round means another edit of the same document landed in
 * between, so five in a row is contention no human edit produces.
 */
const REVISION_BUMP_MAX_ATTEMPTS = 5;

export interface KbDocumentListOptions {
    workId?: string;
    organizationId?: string;
    classes?: KbDocumentClass[];
    statuses?: KbDocumentStatus[];
    tag?: string;
    locked?: boolean;
    language?: string;
    source?: KbDocumentSource;
    /**
     * Memory facets — multi-value source filter (`?source=agent&source=user`).
     * Applied in addition to the single-value `source` above so every
     * existing caller keeps working unchanged.
     */
    sources?: KbDocumentSource[];
    /**
     * Memory upgrades M8 — review-state filter powering the review
     * queue. `proposed` matches the column exactly; `accepted` also
     * matches `NULL` because a null `review_state` reads as accepted
     * everywhere else in the system (the M7 feature is additive and
     * never backfilled pre-existing rows).
     */
    reviewState?: KbReviewState;
    q?: string;
    /**
     * Memory facets — widen the `q` predicate to the document BODY.
     *
     * The body lives inside the `metadata` `simple-json` column, which
     * TypeORM maps to TEXT on every supported driver, so a LIKE over
     * the serialized JSON is a portable full-document search. Opt-in
     * (default `false`) because it is a table scan on a wide column:
     * the tree/list callers that only need title+description must not
     * silently pay for it.
     */
    searchBody?: boolean;
    limit?: number;
    offset?: number;
}

/**
 * Org-wide Memory (Cortex P1) — options for the org-scoped aggregation
 * over `work_knowledge_documents`.
 *
 * Unlike {@link KbDocumentListOptions} (which is single-scope: exactly
 * one Work OR the org's own org-scoped rows), this is deliberately a
 * MULTI-Work fan-in: it returns `(workId IN workIds) OR (org-scoped rows
 * for organizationId)` in one feed. The mandatory-scope guard is
 * preserved — a call with neither a non-empty `workIds` nor an
 * `organizationId` throws, so an unscoped cross-tenant dump can never
 * be produced (spec §2.1 / §7). Every legitimate caller resolves the
 * org's Work ids via `WorkRepository.findIdsByOrganization` first.
 */
export interface OrgMemoryAggregateOptions {
    /** Work ids in the active org (from `WorkRepository.findIdsByOrganization`). */
    workIds?: string[];
    /** Active org id — includes its own org-scoped (`workId IS NULL`) documents. */
    organizationId?: string;
    /** Facet filter: KB document classes (the Type chip). */
    classes?: KbDocumentClass[];
    /** Facet filter: lifecycle statuses (the Status chip). */
    statuses?: KbDocumentStatus[];
    /** Facet filter: sources (the Source chip). */
    sources?: KbDocumentSource[];
    /** Free-text lexical search over title + description. */
    q?: string;
    limit?: number;
    offset?: number;
}

/**
 * Knowledge library — the scope of the organization shelf: the documents of
 * the Organization's Works plus (optionally) its own organization-scoped
 * documents. Same mandatory-scope guard as {@link OrgMemoryAggregateOptions}:
 * a call with neither throws.
 */
export interface KbLibraryScope {
    workIds: string[];
    organizationId?: string;
}

/** Knowledge library — one page of the shelf. */
export interface KbLibraryListOptions extends KbLibraryScope {
    /** A folder id, `null` for Unfiled, `undefined` for every folder. */
    folderId?: string | null;
    archived: 'exclude' | 'only' | 'include';
    classes?: KbDocumentClass[];
    /** Title, description or slug contains. */
    q?: string;
    sort: 'recent' | 'title' | 'unread';
    limit: number;
    /** Rows to skip. Ignored when {@link after} is given. */
    offset: number;
    /**
     * Keyset boundary: return only rows that sort strictly after this one.
     * Unlike an offset it still points at the same place when documents are
     * added, removed or re-sorted between two page requests.
     */
    after?: KbLibraryKeysetBoundary;
}

/**
 * Knowledge library — where a page ended: the active sort's key of its last
 * row, exactly as the database renders it, plus that row's id.
 */
export interface KbLibraryKeysetBoundary {
    sortKey: string;
    id: string;
}

/** Knowledge library — per-folder document counts for the folder rail. */
export interface KbLibraryCounts {
    /** Non-archived documents per direct folder; key `null` = Unfiled. */
    byFolder: Map<string | null, number>;
    archived: number;
}

/** A single `{ value, count }` facet bucket for the Memory chips. */
export interface OrgMemoryFacetCount {
    value: string;
    count: number;
}

/**
 * Repository for WorkKnowledgeDocument.
 *
 * Encapsulates the queries that need either a Work-scope or an
 * organization-scope filter; the spec's `workId XOR organizationId`
 * CHECK constraint means there's no "list documents for either" query
 * we'd want to expose at this layer.
 *
 * Lexical search (`q`) is implemented as a portable `LIKE` against
 * title + description in v1. Postgres FTS via a generated `tsvector`
 * column is the Phase 2 upgrade; we delay it because it requires a
 * separate migration + driver branch.
 */
@Injectable()
export class WorkKnowledgeDocumentRepository {
    constructor(
        @InjectRepository(WorkKnowledgeDocument)
        private readonly repository: Repository<WorkKnowledgeDocument>,
    ) {}

    async findById(workId: string, docId: string): Promise<WorkKnowledgeDocument | null> {
        return this.repository.findOne({ where: { id: docId, workId } });
    }

    async findByPath(workId: string, path: string): Promise<WorkKnowledgeDocument | null> {
        return this.repository.findOne({ where: { workId, path } });
    }

    /**
     * EW-643 Phase 3 slice 2b — look up a Work-scope document whose
     * `metadata[key] = value`. Used by `KnowledgeBaseTranscribeService`
     * for idempotency on `metadata.transcribedFromUploadId` so a
     * Trigger.dev retry never produces a duplicate transcript document.
     *
     * Driver-branched, exactly like `work-knowledge-chunk.repository.ts`
     * does for its pgvector query:
     *
     * - **PostgreSQL.** The `metadata` column is `text` (TypeORM
     *   `simple-json`), not `jsonb`, so it must be cast before applying
     *   `->>` — otherwise PostgreSQL throws
     *   `operator does not exist: text ->> unknown` and the whole
     *   transcribe pipeline crashes at the idempotency check (Greptile P2
     *   on PR #1219). The cast is cheap and runs once per query.
     * - **Everything else** (SQLite: demo, OSS self-host, local dev, CI).
     *   `::` and `->>` are PostgreSQL-only syntax, so the statement above
     *   is a hard syntax error there — the transcribe pipeline used to die
     *   at exactly the check that is supposed to make it retry-safe. The
     *   portable path narrows candidates with a LIKE over the serialized
     *   JSON, then compares the parsed value in JS. The LIKE is only a
     *   pre-filter (it looks for the JSON-encoded VALUE, so it is immune
     *   to key ordering and whitespace); the in-JS `===` is authoritative,
     *   so a nested or same-valued-different-key document cannot produce a
     *   false positive.
     */
    async findByMetadataKey(
        workId: string,
        key: string,
        value: string,
    ): Promise<WorkKnowledgeDocument | null> {
        const driverType = this.repository.manager.connection.options.type;

        if (driverType === 'postgres') {
            return this.repository
                .createQueryBuilder('doc')
                .where('doc.workId = :workId', { workId })
                .andWhere(`(doc.metadata::jsonb) ->> :key = :value`, { key, value })
                .getOne();
        }

        const candidates = await this.repository
            .createQueryBuilder('doc')
            .where('doc.workId = :workId', { workId })
            .andWhere(buildCaseInsensitiveLikeClause('doc.metadata', 'metadataMarker'), {
                // `JSON.stringify` produces exactly the encoding TypeORM's
                // `simple-json` writes, so the encoded value is a substring of
                // the stored text whenever the document really carries it.
                metadataMarker: `%${sanitizeLikePattern(JSON.stringify(value)).toLowerCase()}%`,
            })
            .getMany();

        return candidates.find((doc) => doc.metadata?.[key] === value) ?? null;
    }

    /**
     * Partial update by id. Used by `KnowledgeBaseTranscribeService`
     * to persist `metadata.transcribedFromUploadId` + provider id +
     * duration on the freshly-created transcript document.
     */
    async updateById(
        workId: string,
        docId: string,
        patch: Partial<WorkKnowledgeDocument>,
    ): Promise<void> {
        await this.repository.update({ id: docId, workId }, patch);
    }

    async findOrgById(
        organizationId: string,
        docId: string,
    ): Promise<WorkKnowledgeDocument | null> {
        return this.repository.findOne({
            where: { id: docId, organizationId, workId: IsNull() },
        });
    }

    /**
     * EW-641 Phase 2/e row 38c-2 — look up an org-scope KB document by
     * `(organizationId, path)`. Sibling to `findOrgById`; used by
     * `KnowledgeBaseService.getInheritedDocument` so the workbench
     * detail page can render an inherited doc body when the Work-scope
     * `findByWorkOrPath` 404s.
     *
     * `workId IS NULL` is asserted at the DB level so a Work-scope row
     * that happens to share the same path can NEVER leak via this
     * lookup. The composite `(organizationId, path)` uniqueness
     * (migration `1779971000000-CreateWorkKnowledgeDocuments`) means
     * at most one row matches.
     */
    async findOrgByPath(
        organizationId: string,
        path: string,
    ): Promise<WorkKnowledgeDocument | null> {
        return this.repository.findOne({
            where: { organizationId, path, workId: IsNull() },
        });
    }

    async list(
        opts: KbDocumentListOptions,
    ): Promise<{ items: WorkKnowledgeDocument[]; total: number }> {
        // Security: mandatory tenant-scope guard. The `workId`/`organizationId`
        // filters below are applied only when truthy, so a caller that omits
        // BOTH would otherwise produce a WHERE-less query returning every
        // tenant's KB documents (cross-tenant metadata dump). Every legitimate
        // caller already passes one scope key; this enforces that mechanically
        // at the data layer instead of relying on call-site discipline.
        if (!opts.workId && !opts.organizationId) {
            throw new Error(
                'WorkKnowledgeDocumentRepository.list requires workId or organizationId',
            );
        }

        const qb = this.repository.createQueryBuilder('doc');

        if (opts.workId) {
            qb.andWhere('doc.workId = :workId', { workId: opts.workId });
        }

        if (opts.organizationId) {
            qb.andWhere('doc.organizationId = :orgId', { orgId: opts.organizationId });
            qb.andWhere('doc.workId IS NULL');
        }

        if (opts.classes && opts.classes.length > 0) {
            qb.andWhere('doc.kb_document_class IN (:...classes)', { classes: opts.classes });
        }

        if (opts.statuses && opts.statuses.length > 0) {
            qb.andWhere('doc.status IN (:...statuses)', { statuses: opts.statuses });
        }

        if (opts.locked !== undefined) {
            qb.andWhere('doc.locked = :locked', { locked: opts.locked });
        }

        if (opts.language) {
            qb.andWhere('doc.language = :language', { language: opts.language });
        }

        if (opts.source) {
            qb.andWhere('doc.source = :source', { source: opts.source });
        }

        if (opts.sources && opts.sources.length > 0) {
            qb.andWhere('doc.source IN (:...sources)', { sources: opts.sources });
        }

        if (opts.reviewState === KbReviewState.PROPOSED) {
            qb.andWhere('doc.reviewState = :reviewState', {
                reviewState: KbReviewState.PROPOSED,
            });
        } else if (opts.reviewState === KbReviewState.ACCEPTED) {
            // `NULL` reads as accepted (M7 is additive — no backfill),
            // so the accepted filter must include the un-stamped rows or
            // it would hide every document created before the feature.
            qb.andWhere('(doc.reviewState = :reviewState OR doc.reviewState IS NULL)', {
                reviewState: KbReviewState.ACCEPTED,
            });
        }

        if (opts.q) {
            // Security: escape LIKE wildcards (%/_/\) in the user-supplied
            // search term and pair each predicate with an explicit ESCAPE
            // clause. The value is already bound, so this is not SQLi, but
            // unescaped wildcards otherwise let a caller bypass the filter
            // (e.g. `%`) or force an index-defeating leading-wildcard scan
            // (DoS amplification within the caller's authorized Work/Org).
            //
            // Both sides are lower-cased (LOWER() on the column via
            // `buildCaseInsensitiveLikeClause`, `.toLowerCase()` on the
            // pattern via `prepareCaseInsensitiveContainsPattern`). SQLite's
            // LIKE folds ASCII case for free; PostgreSQL's does not, so the
            // previous bare LIKE made KB search case-SENSITIVE in stage and
            // production while CI (SQLite) saw the correct results.
            // Mirrors agent.repository.ts / work.repository.ts.
            const searchPattern = prepareCaseInsensitiveContainsPattern(opts.q);
            if (searchPattern) {
                qb.andWhere(
                    new Brackets((searchQb) => {
                        searchQb
                            .where(buildCaseInsensitiveLikeClause('doc.title', 'q'), {
                                q: searchPattern,
                            })
                            .orWhere(buildCaseInsensitiveLikeClause('doc.description', 'q'), {
                                q: searchPattern,
                            });
                        if (opts.searchBody) {
                            searchQb.orWhere(buildCaseInsensitiveLikeClause('doc.metadata', 'q'), {
                                q: searchPattern,
                            });
                        }
                    }),
                );
            }
        }

        qb.orderBy('doc.updatedAt', 'DESC');

        const total = await qb.getCount();

        if (opts.limit !== undefined) {
            qb.take(opts.limit);
        }
        if (opts.offset !== undefined) {
            qb.skip(opts.offset);
        }

        const items = await qb.getMany();

        return { items, total };
    }

    /**
     * Org-wide Memory (Cortex P1) — mandatory-scope predicate shared by
     * {@link listForOrgAggregate} and {@link facetsForOrgAggregate}.
     *
     * Builds `(doc.workId IN workIds) OR (doc.organizationId = orgId AND
     * doc.workId IS NULL)` and (optionally) the lexical `q` filter, so
     * both the list feed and the facet counters see the exact same
     * scope. Throws when NEITHER a non-empty `workIds` nor an
     * `organizationId` is supplied — the same anti-cross-tenant-dump
     * guard `list()` enforces, so an unscoped call can never leak every
     * tenant's KB rows.
     */
    private applyOrgAggregateScope(
        qb: SelectQueryBuilder<WorkKnowledgeDocument>,
        opts: OrgMemoryAggregateOptions,
    ): void {
        const hasWorkIds = !!opts.workIds && opts.workIds.length > 0;
        if (!hasWorkIds && !opts.organizationId) {
            throw new Error(
                'WorkKnowledgeDocumentRepository.listForOrgAggregate requires workIds or organizationId',
            );
        }

        qb.andWhere(
            new Brackets((w) => {
                if (hasWorkIds) {
                    w.orWhere('doc.workId IN (:...aggWorkIds)', { aggWorkIds: opts.workIds });
                }
                if (opts.organizationId) {
                    w.orWhere('(doc.organizationId = :aggOrgId AND doc.workId IS NULL)', {
                        aggOrgId: opts.organizationId,
                    });
                }
            }),
        );

        if (opts.q) {
            // Security: escape LIKE wildcards (%/_/\) in the user term and
            // pair each predicate with an explicit ESCAPE clause — mirrors
            // `list()` above. Value is bound (not SQLi); escaping stops a
            // caller bypassing the filter or forcing a leading-wildcard scan.
            // Case-folded on both sides for the same PostgreSQL-vs-SQLite
            // reason documented in `list()`.
            const searchPattern = prepareCaseInsensitiveContainsPattern(opts.q);
            if (searchPattern) {
                qb.andWhere(
                    new Brackets((searchQb) => {
                        searchQb
                            .where(buildCaseInsensitiveLikeClause('doc.title', 'aggQ'), {
                                aggQ: searchPattern,
                            })
                            .orWhere(buildCaseInsensitiveLikeClause('doc.description', 'aggQ'), {
                                aggQ: searchPattern,
                            });
                    }),
                );
            }
        }
    }

    /**
     * Org-wide Memory (Cortex P1) — the list feed. Returns the ranked,
     * facet-filtered page of documents across the org's Works ∪ the org's
     * own org-scoped rows, plus the true total (drives the "documents
     * indexed" header counter).
     */
    async listForOrgAggregate(
        opts: OrgMemoryAggregateOptions,
    ): Promise<{ items: WorkKnowledgeDocument[]; total: number }> {
        const qb = this.repository.createQueryBuilder('doc');
        this.applyOrgAggregateScope(qb, opts);

        if (opts.classes && opts.classes.length > 0) {
            qb.andWhere('doc.kbDocumentClass IN (:...aggClasses)', { aggClasses: opts.classes });
        }
        if (opts.statuses && opts.statuses.length > 0) {
            qb.andWhere('doc.status IN (:...aggStatuses)', { aggStatuses: opts.statuses });
        }
        if (opts.sources && opts.sources.length > 0) {
            qb.andWhere('doc.source IN (:...aggSources)', { aggSources: opts.sources });
        }

        qb.orderBy('doc.updatedAt', 'DESC');

        const total = await qb.getCount();

        if (opts.limit !== undefined) {
            qb.take(opts.limit);
        }
        if (opts.offset !== undefined) {
            qb.skip(opts.offset);
        }

        const items = await qb.getMany();
        return { items, total };
    }

    /**
     * Org-wide Memory (Cortex P1) — the org-wide total document count.
     *
     * Counts every KB document across the org scope (its Works ∪ its own
     * org-scoped rows) IGNORING the facet selections AND the lexical `q`,
     * so the "documents indexed" header stays stable while the user
     * searches or toggles chips. Only the mandatory scope predicate is
     * applied — `q`, `classes`, `statuses` and `sources` are deliberately
     * dropped by not forwarding them to {@link applyOrgAggregateScope}.
     */
    async countForOrgScope(opts: OrgMemoryAggregateOptions): Promise<number> {
        const qb = this.repository.createQueryBuilder('doc');
        this.applyOrgAggregateScope(qb, {
            workIds: opts.workIds,
            organizationId: opts.organizationId,
        });
        return qb.getCount();
    }

    /**
     * Org-wide Memory (Cortex P1) — per-facet value counts for the chips.
     *
     * Computed over the SCOPE (+ lexical `q`) only, NOT the chip
     * selections themselves, so multi-select chips show stable counts as
     * the user toggles values. The `works` facet excludes org-scoped
     * (`workId IS NULL`) rows — those documents belong to the org itself,
     * not to any Work.
     */
    async facetsForOrgAggregate(opts: OrgMemoryAggregateOptions): Promise<{
        types: OrgMemoryFacetCount[];
        works: OrgMemoryFacetCount[];
        statuses: OrgMemoryFacetCount[];
        sources: OrgMemoryFacetCount[];
    }> {
        const baseQb = (): SelectQueryBuilder<WorkKnowledgeDocument> => {
            const qb = this.repository.createQueryBuilder('doc');
            this.applyOrgAggregateScope(qb, opts);
            return qb;
        };

        const toBuckets = (
            rows: Array<{ value: string | null; count: string | number }>,
        ): OrgMemoryFacetCount[] =>
            rows
                .filter((r) => r.value !== null && r.value !== undefined)
                .map((r) => ({ value: r.value as string, count: Number(r.count) }));

        const [typeRows, workRows, statusRows, sourceRows] = await Promise.all([
            baseQb()
                .select('doc.kbDocumentClass', 'value')
                .addSelect('COUNT(*)', 'count')
                .groupBy('doc.kbDocumentClass')
                .getRawMany<{ value: string | null; count: string }>(),
            baseQb()
                .andWhere('doc.workId IS NOT NULL')
                .select('doc.workId', 'value')
                .addSelect('COUNT(*)', 'count')
                .groupBy('doc.workId')
                .getRawMany<{ value: string | null; count: string }>(),
            baseQb()
                .select('doc.status', 'value')
                .addSelect('COUNT(*)', 'count')
                .groupBy('doc.status')
                .getRawMany<{ value: string | null; count: string }>(),
            baseQb()
                .select('doc.source', 'value')
                .addSelect('COUNT(*)', 'count')
                .groupBy('doc.source')
                .getRawMany<{ value: string | null; count: string }>(),
        ]);

        return {
            types: toBuckets(typeRows),
            works: toBuckets(workRows),
            statuses: toBuckets(statusRows),
            sources: toBuckets(sourceRows),
        };
    }

    async listInheritableForOrg(
        organizationId: string,
        classes?: KbDocumentClass[],
    ): Promise<WorkKnowledgeDocument[]> {
        const inheritableClasses = (classes ?? [...KB_ORG_INHERITABLE_CLASSES]).filter((c) =>
            (KB_ORG_INHERITABLE_CLASSES as ReadonlyArray<KbDocumentClass>).includes(c),
        );

        if (inheritableClasses.length === 0) {
            return [];
        }

        // Defense in depth for the review gate.
        //
        // `KnowledgeBaseService.resolveInheritableDocuments` already
        // withholds `proposed` documents, but this is the query that feeds
        // it: excluding them here means an unreviewed machine merge is
        // never even fetched, and any future caller of this method
        // inherits the guarantee instead of having to remember it.
        //
        // Written as an explicit NULL branch rather than `Not('proposed')`.
        // In SQL, `review_state != 'proposed'` evaluates to NULL — not
        // true — for a NULL column, so the simple form would silently drop
        // every document predating the review gate, which is all of them.
        return this.repository
            .createQueryBuilder('doc')
            .where('doc.organizationId = :organizationId', { organizationId })
            .andWhere('doc.workId IS NULL')
            .andWhere('doc.kbDocumentClass IN (:...inheritableClasses)', { inheritableClasses })
            .andWhere('doc.status = :status', { status: 'active' as KbDocumentStatus })
            .andWhere('(doc.reviewState IS NULL OR doc.reviewState != :proposed)', {
                proposed: KbReviewState.PROPOSED,
            })
            .orderBy('doc.path', 'ASC')
            .getMany();
    }

    async listWorkOverridesForClasses(
        workId: string,
        classes: KbDocumentClass[],
    ): Promise<WorkKnowledgeDocument[]> {
        if (classes.length === 0) {
            return [];
        }

        return this.repository.find({
            where: {
                workId,
                kbDocumentClass: In(classes),
                status: 'active' as KbDocumentStatus,
            },
            order: { path: 'ASC' },
        });
    }

    /**
     * Path-collision check used to suffix on conflict (see service).
     */
    async pathExists(workId: string, path: string, excludeId?: string): Promise<boolean> {
        const where = excludeId ? { workId, path, id: Not(excludeId) } : { workId, path };
        const count = await this.repository.count({ where });
        return count > 0;
    }

    async create(data: Partial<WorkKnowledgeDocument>): Promise<WorkKnowledgeDocument> {
        const entity = this.repository.create(data);
        // Knowledge library — every document carries a revision timestamp
        // from birth, whichever service created it, so the "recently
        // changed" sort never has to reason about NULLs.
        if (!entity.revisionAt) {
            entity.revisionAt = new Date();
        }
        return this.repository.save(entity);
    }

    /**
     * Apply `patch` and return the row as it now reads (`null` when it does
     * not exist).
     *
     * Knowledge library — with `expectedRevision`, the UPDATE is a
     * compare-and-set: it lands only while the row still carries that
     * revision, so an edit's content, fingerprint and next revision are
     * written together or not at all. `null` then also means "another edit
     * moved the revision first; nothing was written".
     */
    async update(
        docId: string,
        patch: Partial<WorkKnowledgeDocument>,
        opts: { expectedRevision?: number } = {},
    ): Promise<WorkKnowledgeDocument | null> {
        if (opts.expectedRevision !== undefined) {
            const result = await this.repository.update(
                { id: docId, revision: opts.expectedRevision },
                patch,
            );
            if ((result.affected ?? 0) === 0) return null;
        } else {
            await this.repository.update({ id: docId }, patch);
        }
        return this.repository.findOne({ where: { id: docId } });
    }

    async delete(docId: string): Promise<boolean> {
        const result = await this.repository.delete({ id: docId });
        return (result.affected ?? 0) > 0;
    }

    /**
     * Set (or clear, with `null`) the `consolidation` marker on many
     * documents in a single UPDATE. Used by the consolidation apply pass to
     * clear stale promotions without N per-row round-trips. No-op on an empty
     * id list.
     */
    async bulkSetConsolidation(
        docIds: string[],
        consolidation: WorkKnowledgeDocument['consolidation'],
    ): Promise<void> {
        if (docIds.length === 0) return;
        await this.repository.update({ id: In(docIds) }, {
            consolidation,
        } as Partial<WorkKnowledgeDocument>);
    }

    async setLock(
        docId: string,
        locked: boolean,
        lockMode: KbLockMode | null,
    ): Promise<WorkKnowledgeDocument | null> {
        await this.repository.update({ id: docId }, { locked, lockMode });
        return this.repository.findOne({ where: { id: docId } });
    }

    // ─── Knowledge library ───────────────────────────────────────────────

    /**
     * One page of the organization shelf. Filters apply in the order the
     * library promises — archived → folder → class / query — then the sort.
     *
     * `recent` orders by `revisionAt` (the last SUBSTANTIVE change), never
     * `updatedAt`, which background mirror / embed writes move; a row with
     * no revision timestamp falls back to `createdAt`, so the order is the
     * same on every driver. `title` is case-insensitive A→Z. `unread` has no
     * read state to order by until per-person read state is wired in, so it
     * orders like `recent`. Every sort ends on `id`, a total order.
     *
     * Pagination is keyset: `nextAfter` is the boundary of the last row
     * returned (`null` on the last page), and passing it back as `after`
     * resumes strictly after that row — the sort key is compared as the
     * database renders it, so no precision is lost in the round trip.
     * `offset` is still honoured when no `after` is given.
     */
    async listForLibrary(opts: KbLibraryListOptions): Promise<{
        items: WorkKnowledgeDocument[];
        total: number;
        nextAfter: KbLibraryKeysetBoundary | null;
    }> {
        const qb = this.repository.createQueryBuilder('doc');
        this.applyOrgAggregateScope(qb, {
            workIds: opts.workIds,
            organizationId: opts.organizationId,
        });
        this.applyArchivedFilter(qb, opts.archived);

        if (opts.folderId === null) {
            qb.andWhere('doc.folderId IS NULL');
        } else if (opts.folderId !== undefined) {
            qb.andWhere('doc.folderId = :libFolderId', { libFolderId: opts.folderId });
        }
        if (opts.classes && opts.classes.length > 0) {
            qb.andWhere('doc.kbDocumentClass IN (:...libClasses)', { libClasses: opts.classes });
        }
        const pattern = prepareCaseInsensitiveContainsPattern(opts.q);
        if (pattern) {
            qb.andWhere(
                new Brackets((w) => {
                    w.where(buildCaseInsensitiveLikeClause('doc.title', 'libQ'), { libQ: pattern })
                        .orWhere(buildCaseInsensitiveLikeClause('doc.description', 'libQ'), {
                            libQ: pattern,
                        })
                        .orWhere(buildCaseInsensitiveLikeClause('doc.slug', 'libQ'), {
                            libQ: pattern,
                        });
                }),
            );
        }

        const total = await qb.getCount();

        const ascending = opts.sort === 'title';
        const sortExpression = ascending
            ? 'LOWER(doc.title)'
            : 'COALESCE(doc.revisionAt, doc.createdAt)';
        if (opts.after) {
            qb.andWhere(
                new Brackets((w) => {
                    w.where(`${sortExpression} ${ascending ? '>' : '<'} :libAfterKey`, {
                        libAfterKey: opts.after?.sortKey,
                    }).orWhere(`(${sortExpression} = :libAfterKey AND doc.id > :libAfterId)`, {
                        libAfterKey: opts.after?.sortKey,
                        libAfterId: opts.after?.id,
                    });
                }),
            );
        }
        qb.addSelect(`CAST(${sortExpression} AS TEXT)`, 'lib_sort_key');
        qb.orderBy(sortExpression, ascending ? 'ASC' : 'DESC');
        qb.addOrderBy('doc.id', 'ASC');
        // One extra row says whether another page exists.
        qb.limit(opts.limit + 1).offset(opts.after ? 0 : opts.offset);

        const { entities, raw } = await qb.getRawAndEntities<{
            doc_id: string;
            lib_sort_key: string | null;
        }>();
        const items = entities.slice(0, opts.limit);
        const last = items[items.length - 1];
        let nextAfter: KbLibraryKeysetBoundary | null = null;
        if (entities.length > opts.limit && last) {
            const row = raw.find((candidate) => candidate.doc_id === last.id);
            nextAfter = { sortKey: String(row?.lib_sort_key ?? ''), id: last.id };
        }
        return { items, total, nextAfter };
    }

    /**
     * Non-archived documents per direct folder (`null` key = Unfiled) plus
     * the archived total — two grouped queries, no per-folder round-trips.
     */
    async countsForLibrary(scope: KbLibraryScope): Promise<KbLibraryCounts> {
        const live = this.repository.createQueryBuilder('doc');
        this.applyOrgAggregateScope(live, scope);
        this.applyArchivedFilter(live, 'exclude');
        const rows = await live
            .select('doc.folderId', 'folderId')
            .addSelect('COUNT(*)', 'count')
            .groupBy('doc.folderId')
            .getRawMany<{ folderId: string | null; count: string | number }>();

        const archivedQb = this.repository.createQueryBuilder('doc');
        this.applyOrgAggregateScope(archivedQb, scope);
        this.applyArchivedFilter(archivedQb, 'only');
        const archived = await archivedQb.getCount();

        const byFolder = new Map<string | null, number>();
        for (const row of rows) {
            byFolder.set(row.folderId ?? null, Number(row.count));
        }
        return { byFolder, archived };
    }

    /** The subset of `ids` that lies inside the library scope. */
    async findInLibraryScope(
        scope: KbLibraryScope,
        ids: string[],
    ): Promise<WorkKnowledgeDocument[]> {
        if (ids.length === 0) return [];
        const qb = this.repository.createQueryBuilder('doc');
        this.applyOrgAggregateScope(qb, scope);
        qb.andWhere('doc.id IN (:...libIds)', { libIds: ids });
        return qb.getMany();
    }

    /**
     * File documents into a folder (`null` = Unfiled). Touches ONLY the
     * folder column — `revision` and the fingerprint are untouched, because
     * moving a document is not a change to what it says.
     */
    async setFolder(docIds: string[], folderId: string | null): Promise<number> {
        if (docIds.length === 0) return 0;
        const result = await this.repository
            .createQueryBuilder()
            .update(WorkKnowledgeDocument)
            .set({ folderId })
            .where('id IN (:...docIds)', { docIds })
            .execute();
        return result.affected ?? docIds.length;
    }

    /**
     * Move `revision` forward by exactly one and stamp `revisionAt`, safely
     * under concurrent edits.
     *
     * A compare-and-set on the revision just read: the UPDATE lands only
     * while the row still carries that revision, so two edits racing on the
     * same document can never write the same number — the one that loses
     * sees no affected row, re-reads and takes the next number. Each caller
     * therefore knows exactly which revision it wrote, without a read-back
     * that a later edit may already have moved.
     *
     * Touches only `revision` and `revisionAt` (and the `updatedAt` stamp
     * every update carries), so it is for a revision-only move. An edit that
     * also writes content must not pair a content write with this call — it
     * writes both in one statement through {@link update} with
     * `expectedRevision`. `null` when the document no longer exists; a
     * {@link ConflictException} only if the row keeps changing for
     * {@link REVISION_BUMP_MAX_ATTEMPTS} reads in a row.
     */
    async bumpRevision(
        docId: string,
        at: Date = new Date(),
    ): Promise<{ revision: number; revisionAt: Date } | null> {
        for (let attempt = 0; attempt < REVISION_BUMP_MAX_ATTEMPTS; attempt += 1) {
            const current = await this.repository.findOne({
                where: { id: docId },
                select: { id: true, revision: true },
            });
            if (!current) return null;
            const next = current.revision + 1;
            const result = await this.repository
                .createQueryBuilder()
                .update(WorkKnowledgeDocument)
                .set({ revision: next, revisionAt: at })
                .where('id = :docId', { docId })
                .andWhere('revision = :expected', { expected: current.revision })
                .execute();
            if ((result.affected ?? 0) > 0) {
                return { revision: next, revisionAt: at };
            }
        }
        throw new ConflictException(
            `KB document ${docId} changed too often to record its revision; retry the edit`,
        );
    }

    /**
     * Unfile every document filed in any of `folderIds`; returns how many
     * moved. Pass `manager` to enlist both statements in an open transaction
     * (a shared-folder delete unfiles and deletes as one unit).
     */
    async clearFolders(folderIds: string[], manager?: EntityManager): Promise<number> {
        if (folderIds.length === 0) return 0;
        const repository = manager?.getRepository(WorkKnowledgeDocument) ?? this.repository;
        const count = await repository.count({ where: { folderId: In(folderIds) } });
        if (count === 0) return 0;
        await repository
            .createQueryBuilder()
            .update(WorkKnowledgeDocument)
            .set({ folderId: null })
            .where('folder_id IN (:...folderIds)', { folderIds })
            .execute();
        return count;
    }

    private applyArchivedFilter(
        qb: SelectQueryBuilder<WorkKnowledgeDocument>,
        archived: 'exclude' | 'only' | 'include',
    ): void {
        if (archived === 'exclude') {
            qb.andWhere('doc.status != :libArchived', { libArchived: KbDocumentStatus.ARCHIVED });
        } else if (archived === 'only') {
            qb.andWhere('doc.status = :libArchived', { libArchived: KbDocumentStatus.ARCHIVED });
        }
    }

    /** Lookup using either Work id+slug-path or org id+path. */
    async findByWorkOrPath(
        workId: string,
        idOrPath: string,
    ): Promise<WorkKnowledgeDocument | null> {
        // Heuristic: a path contains '/' or ends with '.md'; an id is a UUID.
        if (idOrPath.includes('/') || idOrPath.endsWith('.md')) {
            return this.findByPath(workId, idOrPath);
        }
        return this.findById(workId, idOrPath);
    }
}

/** Convenience re-export of search helper used by the service. */
export { Like };
