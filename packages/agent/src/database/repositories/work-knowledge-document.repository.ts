import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Like, Not, Repository } from 'typeorm';
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
     * Uses raw `->>` JSON access — TypeORM's `Like`/`Equal` operators
     * don't reach into `simple-json` columns. Safe because both inputs
     * are parameterised.
     */
    async findByMetadataKey(
        workId: string,
        key: string,
        value: string,
    ): Promise<WorkKnowledgeDocument | null> {
        return this.repository
            .createQueryBuilder('doc')
            .where('doc.workId = :workId', { workId })
            .andWhere(`doc.metadata ->> :key = :value`, { key, value })
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
