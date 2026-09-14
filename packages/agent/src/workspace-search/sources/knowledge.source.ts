import type { SelectQueryBuilder } from 'typeorm';
import { Work } from '../../entities/work.entity';
import { WorkMember } from '../../entities/work-member.entity';
import { WorkKnowledgeDocument } from '../../entities/work-knowledge-document.entity';
import { ownershipSqlPredicate } from '../../database/ownership-scope';
import type {
    WorkspaceSearchScope,
    WorkspaceSearchSourceDefinition,
} from '../workspace-search.types';

/**
 * Knowledge-Base documents are only returned for Works the caller created or
 * is a member of, inside the active workspace scope (spec FR-33). Documents
 * with no Work (inherited organisation-level rows) are not returned here.
 */
export function applyKnowledgeAccess(
    qb: SelectQueryBuilder<WorkKnowledgeDocument>,
    scope: WorkspaceSearchScope,
): void {
    const memberWorkIds = qb
        .subQuery()
        .select('kbMember.workId')
        .from(WorkMember, 'kbMember')
        .where('kbMember.userId = :wsUserId')
        .getQuery();
    const accessibleWorks = qb
        .subQuery()
        .select('kbWork.id')
        .from(Work, 'kbWork')
        .where(`(kbWork.userId = :wsUserId OR kbWork.id IN ${memberWorkIds})`);
    const predicate = ownershipSqlPredicate('kbWork', scope, 'wsScope');
    if (predicate) accessibleWorks.andWhere(predicate.clause);

    qb.andWhere(`knowledge.workId IN ${accessibleWorks.getQuery()}`, {
        wsUserId: scope.userId,
        ...(predicate?.parameters ?? {}),
    });
}

/**
 * The workbench URL for one document. The path keeps its `/` separators (the
 * route is a catch-all) but each segment is percent-encoded, so a `#`, `?` or
 * `%` in a stored path reaches the route as part of the path instead of
 * starting a fragment or query string.
 */
export function knowledgeDocumentDestination(workId: string, path: string): string {
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    return `/works/${encodeURIComponent(workId)}/kb/${encodedPath}`;
}

/** Knowledge — matched on document title, slug, path, description and tags. */
export const knowledgeSource: WorkspaceSearchSourceDefinition<WorkKnowledgeDocument> = {
    kind: 'knowledge',
    entity: WorkKnowledgeDocument,
    alias: 'knowledge',
    titleColumn: 'title',
    identifierColumn: 'slug',
    secondaryColumns: ['path', 'description', 'tags'],
    applyAccess: applyKnowledgeAccess,
    toCandidate: (row) => ({
        kind: 'knowledge',
        sourceId: row.id,
        title: row.title || row.path,
        identifier: row.slug ?? null,
        secondary: [row.path, row.description ?? '', ...(row.tags ?? [])],
        subtitle: row.path ?? null,
        statusLabel: row.status ?? null,
        destination: knowledgeDocumentDestination(row.workId, row.path ?? ''),
        updatedAt: row.updatedAt ?? null,
    }),
};
