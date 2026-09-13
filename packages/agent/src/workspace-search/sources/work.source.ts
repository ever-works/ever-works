import { Brackets, type SelectQueryBuilder } from 'typeorm';
import { Work } from '../../entities/work.entity';
import { WorkMember } from '../../entities/work-member.entity';
import { ownershipSqlPredicate } from '../../database/ownership-scope';
import type {
    WorkspaceSearchScope,
    WorkspaceSearchSourceDefinition,
} from '../workspace-search.types';

/**
 * Restrict Works to those the caller created or is a member of — the same
 * rule the Works list uses — inside the active workspace scope.
 */
export function applyWorkAccess(
    qb: SelectQueryBuilder<Work>,
    alias: string,
    scope: WorkspaceSearchScope,
): void {
    const memberWorkIds = qb
        .subQuery()
        .select(`${alias}Member.workId`)
        .from(WorkMember, `${alias}Member`)
        .where(`${alias}Member.userId = :wsUserId`)
        .getQuery();
    qb.andWhere(
        new Brackets((inner) => {
            inner.where(`${alias}.userId = :wsUserId`).orWhere(`${alias}.id IN ${memberWorkIds}`);
        }),
        { wsUserId: scope.userId },
    );
    const predicate = ownershipSqlPredicate(alias, scope, 'wsScope');
    if (predicate) qb.andWhere(predicate.clause, predicate.parameters);
}

/** Works — matched on name, slug and description. */
export const workSource: WorkspaceSearchSourceDefinition<Work> = {
    kind: 'work',
    entity: Work,
    alias: 'work',
    titleColumn: 'name',
    identifierColumn: 'slug',
    secondaryColumns: ['description'],
    applyAccess: (qb, scope) => applyWorkAccess(qb, 'work', scope),
    toCandidate: (row) => ({
        kind: 'work',
        sourceId: row.id,
        title: row.name,
        identifier: row.slug ?? null,
        secondary: [row.description ?? ''],
        subtitle: row.slug ?? null,
        statusLabel: row.status ?? null,
        destination: `/works/${row.id}`,
        updatedAt: row.updatedAt ?? null,
    }),
};
