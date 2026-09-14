import type { SelectQueryBuilder } from 'typeorm';
import { Team } from '../../entities/team.entity';
import { ownershipSqlPredicate } from '../../database/ownership-scope';
import type {
    WorkspaceSearchScope,
    WorkspaceSearchSourceDefinition,
} from '../workspace-search.types';
import { applyOwnerAccess } from './run-source';

/**
 * A Team belongs to one Organization and every member of that Organization
 * can open it, so inside an Organization scope Teams are matched on the
 * Organization, not on who created them. Outside one, only the caller's own
 * rows in the personal scope are visible.
 */
export function applyTeamAccess(qb: SelectQueryBuilder<Team>, scope: WorkspaceSearchScope): void {
    if (!scope.organizationId) {
        applyOwnerAccess(qb, 'team', scope);
        return;
    }
    const predicate = ownershipSqlPredicate('team', scope, 'wsScope');
    if (predicate) qb.andWhere(predicate.clause, predicate.parameters);
}

/** Teams — matched on name, slug and description. */
export const teamSource: WorkspaceSearchSourceDefinition<Team> = {
    kind: 'team',
    entity: Team,
    alias: 'team',
    titleColumn: 'name',
    identifierColumn: 'slug',
    secondaryColumns: ['description'],
    applyAccess: applyTeamAccess,
    toCandidate: (row) => ({
        kind: 'team',
        sourceId: row.id,
        title: row.name,
        identifier: row.slug ?? null,
        secondary: [row.description ?? ''],
        subtitle: row.slug ?? null,
        statusLabel: null,
        destination: `/teams/${row.id}`,
        updatedAt: row.updatedAt ?? null,
    }),
};
