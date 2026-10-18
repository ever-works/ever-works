import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { IntegrationKbDocumentDto, IntegrationKbFolderDto } from '@ever-works/contracts';
import { Brackets, DataSource } from 'typeorm';
import {
    kbDocumentOrganizationId,
    toIntegrationKbDocumentDto,
    toIntegrationKbFolderDto,
} from '../domain-events/domain-event-kb-snapshots';
import { MemoryFolder, MemoryFolderScope } from '../entities/memory-folder.entity';
import { Work } from '../entities/work.entity';
import { WorkKnowledgeDocument } from '../entities/work-knowledge-document.entity';
import { etagFor } from './if-match';
import { ResourceNotFoundError } from './integration-api.errors';
import { type KeysetPage, type KeysetQuery, readKeysetPage } from './keyset-cursor';

/** `GET /kb/documents` filters (contract v1 B.6 "KB"); the route validates the vocabularies. */
export interface IntegrationKbDocumentListQuery extends KeysetQuery {
    /** Only organization documents, or only Work documents. */
    readonly scopeType?: 'organization' | 'work' | null;
    /** Only the documents of this Work (implies `scopeType: 'work'`). */
    readonly workId?: string | null;
    /** Only the documents filed in this library folder; `'unfiled'` = in none. */
    readonly folderId?: string | null;
    readonly classes?: readonly string[];
    /** Only these statuses. Empty = every status except `archived` (unless `includeArchived`). */
    readonly statuses?: readonly string[];
    readonly includeArchived?: boolean;
}

/** A document of the pinned organization, with its `ETag` and where it lives. */
export interface IntegrationKbDocument {
    readonly dto: IntegrationKbDocumentDto;
    readonly etag: string;
    /** Set for a Work document; null for an organization document. */
    readonly workId: string | null;
}

export interface IntegrationKbFolder {
    readonly dto: IntegrationKbFolderDto;
    readonly etag: string;
}

/**
 * Knowledge Base reads of `/api/integrations/v1` (EW-P3-2, contract v1 B.6
 * "KB").
 *
 * The scope is the Knowledge library's: the organization's own documents plus
 * the documents of every Work of the organization (a personal Work's documents
 * never), and the organization's library folders (a person's own Memory
 * folders never). Anything outside it answers `404 not_found` by id.
 *
 * The DTOs are the `kb.document.*` / `kb.folder.*` event mappers, except that a
 * read always carries the full body.
 */
@Injectable()
export class IntegrationKbService {
    constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

    async listDocuments(
        organizationId: string,
        query: IntegrationKbDocumentListQuery,
    ): Promise<KeysetPage<IntegrationKbDocumentDto>> {
        const qb = this.dataSource.getRepository(WorkKnowledgeDocument).createQueryBuilder('row');
        const worksOfOrganization = qb
            .subQuery()
            .select('kbwork.id')
            .from(Work, 'kbwork')
            .where('kbwork.organizationId = :organizationId')
            .getQuery();
        if (query.workId) {
            qb.where('row.workId = :workId', { workId: query.workId }).andWhere(
                `row.workId IN ${worksOfOrganization}`,
            );
        } else if (query.scopeType === 'organization') {
            qb.where('row.organizationId = :organizationId').andWhere('row.workId IS NULL');
        } else if (query.scopeType === 'work') {
            qb.where(`row.workId IN ${worksOfOrganization}`);
        } else {
            qb.where(
                new Brackets((scope) => {
                    scope
                        .where('row.organizationId = :organizationId')
                        .orWhere(`row.workId IN ${worksOfOrganization}`);
                }),
            );
        }
        qb.setParameter('organizationId', organizationId);
        if (query.folderId === 'unfiled') {
            qb.andWhere('row.folderId IS NULL');
        } else if (query.folderId) {
            qb.andWhere('row.folderId = :folderId', { folderId: query.folderId });
        }
        const classes = query.classes ?? [];
        if (classes.length > 0) {
            qb.andWhere('row.kbDocumentClass IN (:...classes)', { classes: [...classes] });
        }
        const statuses = query.statuses ?? [];
        if (statuses.length > 0) {
            qb.andWhere('row.status IN (:...statuses)', { statuses: [...statuses] });
        } else if (!query.includeArchived) {
            qb.andWhere('row.status != :archived', { archived: 'archived' });
        }
        const page = await readKeysetPage(qb, 'row', query);
        return {
            data: page.data.map((row) => toIntegrationKbDocumentDto(row, organizationId)),
            nextCursor: page.nextCursor,
            hasMore: page.hasMore,
        };
    }

    /** One document of the pinned organization (`404 not_found` for any other). */
    async getDocument(organizationId: string, id: string): Promise<IntegrationKbDocument> {
        const manager = this.dataSource.manager;
        const row = await manager.getRepository(WorkKnowledgeDocument).findOne({ where: { id } });
        if (!row) throw new ResourceNotFoundError('kb_document', id);
        const owner = await kbDocumentOrganizationId(manager, row);
        if (owner.organizationId !== organizationId) {
            throw new ResourceNotFoundError('kb_document', id);
        }
        const dto = toIntegrationKbDocumentDto(row, organizationId);
        return { dto, etag: etagFor(dto.version), workId: row.workId ?? null };
    }

    /** The Work, when it is one of the pinned organization's (`404 not_found` otherwise). */
    async assertWorkOfOrganization(organizationId: string, workId: string): Promise<void> {
        const work = await this.dataSource
            .getRepository(Work)
            .findOne({ where: { id: workId }, select: ['id', 'organizationId'] });
        if (!work || work.organizationId !== organizationId) {
            throw new ResourceNotFoundError('work', workId);
        }
    }

    async listFolders(
        organizationId: string,
        query: KeysetQuery,
    ): Promise<KeysetPage<IntegrationKbFolderDto>> {
        const qb = this.dataSource
            .getRepository(MemoryFolder)
            .createQueryBuilder('row')
            .where('row.organizationId = :organizationId', { organizationId })
            .andWhere('row.scope = :scope', { scope: MemoryFolderScope.ORGANIZATION });
        const page = await readKeysetPage(qb, 'row', query);
        return {
            data: page.data.map((row) => toIntegrationKbFolderDto(row)),
            nextCursor: page.nextCursor,
            hasMore: page.hasMore,
        };
    }

    /**
     * `If-Match` as a compare-and-set: move a document's or a folder's
     * `version` from `expected` to `expected + 1` only while it still is
     * `expected` (one conditional UPDATE, the same on Postgres, MySQL and
     * SQLite). `false` = another write moved it first. The caller then writes
     * inside `runWithClaimedAggregateVersion`, so the write's event carries
     * the claimed version instead of bumping again.
     */
    async claimVersion(
        kind: 'kb_document' | 'kb_folder',
        id: string,
        expected: number,
    ): Promise<boolean> {
        const target = kind === 'kb_document' ? WorkKnowledgeDocument : MemoryFolder;
        const escape = (name: string) => this.dataSource.driver.escape(name);
        const result = await this.dataSource
            .createQueryBuilder()
            .update(target)
            .set({ version: () => `${escape('version')} + 1` })
            .where(`${escape('id')} = :id AND ${escape('version')} = :expected`, { id, expected })
            .execute();
        return (result.affected ?? 0) > 0;
    }

    /**
     * Review 2026-10-17 F53: undo a {@link claimVersion} no write used (the write was
     * refused, or changed nothing): the version goes back only while it is still the
     * claimed one, so a concurrent writer's bump is never undone.
     */
    async releaseClaimedVersion(
        kind: 'kb_document' | 'kb_folder',
        id: string,
        expected: number,
    ): Promise<void> {
        const target = kind === 'kb_document' ? WorkKnowledgeDocument : MemoryFolder;
        const escape = (name: string) => this.dataSource.driver.escape(name);
        await this.dataSource
            .createQueryBuilder()
            .update(target)
            .set({ version: () => `${escape('version')} - 1` })
            .where(`${escape('id')} = :id AND ${escape('version')} = :claimed`, {
                id,
                claimed: expected + 1,
            })
            .execute();
    }

    /** One library folder of the pinned organization (`404 not_found` for any other). */
    async getFolder(organizationId: string, id: string): Promise<IntegrationKbFolder> {
        const row = await this.dataSource.getRepository(MemoryFolder).findOne({
            where: { id, organizationId, scope: MemoryFolderScope.ORGANIZATION },
        });
        if (!row) throw new ResourceNotFoundError('kb_folder', id);
        const dto = toIntegrationKbFolderDto(row);
        return { dto, etag: etagFor(dto.version) };
    }
}
