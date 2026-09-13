import { Brackets, type DataSource, type ObjectLiteral, type SelectQueryBuilder } from 'typeorm';
import { buildCaseInsensitiveLikeClause, sanitizeLikePattern } from '../../database/utils/db.utils';
import { ownershipSqlPredicate } from '../../database/ownership-scope';
import { FUZZY_MIN_QUERY_LENGTH } from '../ranking';
import type {
    WorkspaceSearchScope,
    WorkspaceSearchSourceDefinition,
    WorkspaceSearchSourceQuery,
    WorkspaceSearchSourceResult,
} from '../workspace-search.types';

/** Lower-cased, LIKE-escaped `%query%`. */
export function buildContainsPattern(query: string): string {
    return `%${sanitizeLikePattern(query.trim().toLowerCase())}%`;
}

/**
 * Lower-cased, LIKE-escaped in-order subsequence pattern (`ivy` → `%i%v%y%`),
 * the portable SQL form of a fuzzy match. `null` below the fuzzy threshold.
 */
export function buildSubsequencePattern(query: string): string | null {
    const compact = query.trim().toLowerCase().replace(/\s+/g, '');
    if (compact.length < FUZZY_MIN_QUERY_LENGTH) return null;
    return `%${Array.from(compact, (char) => sanitizeLikePattern(char)).join('%')}%`;
}

/**
 * Default access rule: the caller's own rows inside the active workspace scope
 * (the same predicate every Tier C read uses).
 */
export function applyOwnerAccess<T extends ObjectLiteral>(
    qb: SelectQueryBuilder<T>,
    alias: string,
    scope: WorkspaceSearchScope,
): void {
    qb.andWhere(`${alias}.userId = :wsUserId`, { wsUserId: scope.userId });
    const predicate = ownershipSqlPredicate(alias, scope, 'wsScope');
    if (predicate) qb.andWhere(predicate.clause, predicate.parameters);
}

/**
 * Run one source definition: access rule, portable case-insensitive LIKE
 * across its columns, newest first, capped. Every column reference goes
 * through {@link buildCaseInsensitiveLikeClause}, so no source can emit a
 * database-specific operator.
 */
export async function runSource<T extends ObjectLiteral>(
    dataSource: DataSource,
    definition: WorkspaceSearchSourceDefinition<T>,
    query: WorkspaceSearchSourceQuery,
): Promise<WorkspaceSearchSourceResult> {
    const { alias } = definition;
    const qb = dataSource.getRepository(definition.entity).createQueryBuilder(alias);

    if (definition.applyAccess) {
        definition.applyAccess(qb, query.scope);
    } else {
        applyOwnerAccess(qb, alias, query.scope);
    }

    const matchColumns = [
        definition.titleColumn,
        ...(definition.identifierColumn ? [definition.identifierColumn] : []),
        ...(definition.secondaryColumns ?? []),
    ];
    qb.andWhere(
        new Brackets((inner) => {
            for (const column of matchColumns) {
                inner.orWhere(buildCaseInsensitiveLikeClause(`${alias}.${column}`, 'wsContains'), {
                    wsContains: query.containsPattern,
                });
            }
            if (query.subsequencePattern) {
                inner.orWhere(
                    buildCaseInsensitiveLikeClause(
                        `${alias}.${definition.titleColumn}`,
                        'wsSubsequence',
                    ),
                    { wsSubsequence: query.subsequencePattern },
                );
            }
        }),
    );

    qb.orderBy(`${alias}.${definition.updatedAtColumn ?? 'updatedAt'}`, 'DESC').take(query.cap);

    const [rows, total] = await qb.getManyAndCount();
    return { candidates: rows.map((row) => definition.toCandidate(row)), total };
}
