import type { IntegrationKbDocumentDto, IntegrationKbFolderDto } from '@ever-works/contracts';
import type { EntityManager } from 'typeorm';
import { MemoryFolder, MemoryFolderScope } from '../entities/memory-folder.entity';
import { Organization } from '../entities/organization.entity';
import { Work } from '../entities/work.entity';
import { WorkKnowledgeDocument } from '../entities/work-knowledge-document.entity';
import { type AggregateSnapshot, webAppOrigin } from './domain-event-snapshots';

/**
 * EW-P3-2 — Knowledge Base snapshots: the `data` of `kb.document.*` /
 * `kb.folder.*` events and the bodies of `GET /api/integrations/v1/kb/...`
 * (`resources/kb-document.schema.json`, `resources/kb-folder.schema.json`).
 *
 * Kept out of `domain-event-snapshots.ts` so the KB slice does not touch the
 * P1/P2 builders.
 */

/**
 * The largest Markdown body (UTF-8 bytes) an EVENT carries. A longer one is
 * sent as `body: null, bodyOmitted: true` — the outbox row, every feed page
 * and every webhook POST would otherwise carry megabytes of an extracted PDF
 * or transcript per edit. `GET /kb/documents/:id` always returns the body, and
 * `revision` / `normalizedContentHash` say when it changed.
 */
export const KB_EVENT_BODY_MAX_BYTES = 256 * 1024;

const iso = (value: Date | string | null | undefined): string | null =>
    value ? new Date(value).toISOString() : null;
const isoRequired = (value: Date | string | null | undefined): string =>
    iso(value) ?? new Date(0).toISOString();

const webUrl = (path: string): string | null => {
    const origin = webAppOrigin();
    return origin ? `${origin}${path}` : null;
};

const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

/** The Markdown body the knowledge base stores in `metadata.body`. */
export function kbDocumentBody(row: WorkKnowledgeDocument): string {
    const body = (row.metadata ?? {}).body;
    return typeof body === 'string' ? body : '';
}

/**
 * One document as the integration DTO. `organizationId` is the document's
 * organization: its own for an organization document, its Work's for a Work
 * document (the caller resolves it). `forEvent` applies the event body limit.
 */
export function toIntegrationKbDocumentDto(
    row: WorkKnowledgeDocument,
    organizationId: string,
    options: { forEvent?: boolean } = {},
): IntegrationKbDocumentDto {
    const body = kbDocumentBody(row);
    const omit =
        options.forEvent === true && Buffer.byteLength(body, 'utf8') > KB_EVENT_BODY_MAX_BYTES;
    const scope = row.workId
        ? { type: 'work' as const, id: row.workId }
        : { type: 'organization' as const, id: organizationId };
    const dto: IntegrationKbDocumentDto = {
        id: row.id,
        organizationId,
        version: Number((row as { version?: number }).version) || 1,
        createdAt: isoRequired(row.createdAt),
        updatedAt: isoRequired(row.updatedAt ?? row.createdAt),
        scope,
        workId: row.workId ?? null,
        folderId: row.folderId ?? null,
        path: row.path,
        slug: row.slug,
        title: row.title,
        description: row.description ?? null,
        class: String(row.kbDocumentClass),
        tags: strings(row.tags),
        categories: strings(row.categories),
        status: row.status as IntegrationKbDocumentDto['status'],
        reviewState: (row.reviewState ?? null) as IntegrationKbDocumentDto['reviewState'],
        locked: !!row.locked,
        lockMode: (row.lockMode ?? null) as IntegrationKbDocumentDto['lockMode'],
        language: row.language || 'en',
        source: String(row.source),
        body: omit ? null : body,
        revision: Number(row.revision) || 1,
        revisionAt: iso(row.revisionAt),
        normalizedContentHash: row.normalizedContentHash ?? null,
        decision: (row.decision ?? null) as unknown as IntegrationKbDocumentDto['decision'],
        createdById: row.createdById ?? null,
        updatedById: row.updatedById ?? null,
        archivedAt: iso(row.archivedAt),
        wordCount: row.wordCount ?? null,
        webUrl: row.workId
            ? webUrl(
                  `/works/${row.workId}/kb/${row.path
                      .split('/')
                      .map((segment) => encodeURIComponent(segment))
                      .join('/')}`,
              )
            : webUrl('/memory?view=library'),
    };
    if (omit) return { ...dto, bodyOmitted: true };
    return dto;
}

/**
 * The organization a document belongs to: its own, else its Work's. `null`
 * for a document of a personal Work (no organization), which an integration
 * never sees.
 */
export async function kbDocumentOrganizationId(
    manager: EntityManager,
    row: WorkKnowledgeDocument,
): Promise<{ organizationId: string | null; tenantId: string | null }> {
    if (row.organizationId) {
        let tenantId = row.tenantId ?? null;
        if (!tenantId) {
            const org = await manager
                .getRepository(Organization)
                .findOne({ where: { id: row.organizationId }, select: ['id', 'tenantId'] });
            tenantId = org?.tenantId ?? null;
        }
        return { organizationId: row.organizationId, tenantId };
    }
    if (!row.workId) return { organizationId: null, tenantId: row.tenantId ?? null };
    const work = await manager
        .getRepository(Work)
        .findOne({ where: { id: row.workId }, select: ['id', 'organizationId', 'tenantId'] });
    return {
        organizationId: work?.organizationId ?? null,
        tenantId: row.tenantId ?? work?.tenantId ?? null,
    };
}

/**
 * `kb_document` snapshot (event `data`). A document of a personal Work has no
 * organization and answers `null`: nothing is recorded for it (the integration
 * feed is per organization, and no in-process listener consumes KB events yet).
 */
export async function buildKbDocumentSnapshot(
    manager: EntityManager,
    id: string,
): Promise<AggregateSnapshot<IntegrationKbDocumentDto> | null> {
    const row = await manager.getRepository(WorkKnowledgeDocument).findOne({ where: { id } });
    if (!row) return null;
    const { organizationId, tenantId } = await kbDocumentOrganizationId(manager, row);
    if (!organizationId) return null;
    return {
        dto: toIntegrationKbDocumentDto(row, organizationId, { forEvent: true }),
        tenantId,
        organizationId,
    };
}

/** One organization library folder as the integration DTO. */
export function toIntegrationKbFolderDto(row: MemoryFolder): IntegrationKbFolderDto {
    return {
        id: row.id,
        organizationId: row.organizationId ?? '',
        version: Number((row as { version?: number }).version) || 1,
        createdAt: isoRequired(row.createdAt),
        updatedAt: isoRequired(row.updatedAt ?? row.createdAt),
        name: row.name,
        parentId: row.parentId ?? null,
        path: row.path,
        createdById: row.userId,
        webUrl: webUrl('/memory?view=library'),
    };
}

/**
 * `kb_folder` snapshot. Only organization library folders are KB folders; a
 * person's own Memory folder (`scope = user`) answers `null`, so nothing is
 * recorded for it.
 */
export async function buildKbFolderSnapshot(
    manager: EntityManager,
    id: string,
): Promise<AggregateSnapshot<IntegrationKbFolderDto> | null> {
    const row = await manager.getRepository(MemoryFolder).findOne({ where: { id } });
    if (!row || row.scope !== MemoryFolderScope.ORGANIZATION || !row.organizationId) return null;
    let tenantId = row.tenantId ?? null;
    if (!tenantId) {
        const org = await manager
            .getRepository(Organization)
            .findOne({ where: { id: row.organizationId }, select: ['id', 'tenantId'] });
        tenantId = org?.tenantId ?? null;
    }
    return { dto: toIntegrationKbFolderDto(row), tenantId, organizationId: row.organizationId };
}
