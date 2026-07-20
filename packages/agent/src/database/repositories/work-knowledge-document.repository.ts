import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, In, IsNull, Like, Not, Repository, SelectQueryBuilder } from 'typeorm';
import { WorkKnowledgeDocument } from '../../entities/work-knowledge-document.entity';
import {
    KB_ORG_INHERITABLE_CLASSES,
    KbDocumentClass,
    KbDocumentSource,
    KbDocumentStatus,
    KbLockMode,
} from '../../entities/kb-types';
import { sanitizeLikePattern } from '../utils';

export interface KbDocumentListOptions {
    workId?: string;
    organizationId?: string;
    classes?: KbDocumentClass[];
    statuses?: KbDocumentStatus[];
    tag?: string;
    locked?: boolean;
    language?: string;
    source?: KbDocumentSource;
    q?: string;
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
     * The `metadata` column is `text` (TypeORM `simple-json`), not
     * `jsonb`, so we must cast before applying `->>` — otherwise
     * PostgreSQL throws `operator does not exist: text ->> unknown`
     * and the entire transcribe pipeline crashes at the idempotency
     * check (Greptile P2 on PR #1219). The cast is cheap and runs
     * once per query. SQLite + Postgres path-pick differs but the
     * `simple-json` columnar comparison still works because TypeORM
     * stringifies on read and `LIKE` matches the JSON literal —
     * we use the Postgres-shaped query because the production DB
     * is Postgres; the test DB uses an in-memory mock at the repo
     * layer (no SQL is exercised).
     */
    async findByMetadataKey(
        workId: string,
        key: string,
        value: string,
    ): Promise<WorkKnowledgeDocument | null> {
        return this.repository
            .createQueryBuilder('doc')
            .where('doc.workId = :workId', { workId })
            .andWhere(`(doc.metadata::jsonb) ->> :key = :value`, { key, value })
            .getOne();
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

        if (opts.q) {
            // Security: escape LIKE wildcards (%/_/\) in the user-supplied
            // search term and pair each predicate with an explicit ESCAPE
            // clause. The value is already bound, so this is not SQLi, but
            // unescaped wildcards otherwise let a caller bypass the filter
            // (e.g. `%`) or force an index-defeating leading-wildcard scan
            // (DoS amplification within the caller's authorized Work/Org).
            // Mirrors agent.repository.ts; escape-only (no LOWER()) preserves
            // the existing matching for legitimate input.
            qb.andWhere("(doc.title LIKE :q ESCAPE '\\' OR doc.description LIKE :q ESCAPE '\\')", {
                q: `%${sanitizeLikePattern(opts.q)}%`,
            });
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
            qb.andWhere(
                "(doc.title LIKE :aggQ ESCAPE '\\' OR doc.description LIKE :aggQ ESCAPE '\\')",
                { aggQ: `%${sanitizeLikePattern(opts.q)}%` },
            );
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

        return this.repository.find({
            where: {
                organizationId,
                workId: IsNull(),
                kbDocumentClass: In(inheritableClasses),
                status: 'active' as KbDocumentStatus,
            },
            order: { path: 'ASC' },
        });
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
        return this.repository.save(entity);
    }

    async update(
        docId: string,
        patch: Partial<WorkKnowledgeDocument>,
    ): Promise<WorkKnowledgeDocument | null> {
        await this.repository.update({ id: docId }, patch);
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
