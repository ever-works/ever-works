import { Brackets, type DataSource, type ObjectLiteral, type SelectQueryBuilder } from 'typeorm';
import {
    buildCaseInsensitiveEqualsClause,
    buildCaseInsensitiveLikeClause,
    sanitizeLikePattern,
} from '../../database/utils/db.utils';
import { ownershipSqlPredicate } from '../../database/ownership-scope';
import {
    FRESH_WINDOW_MS,
    FRESHNESS_BOOST,
    FUZZY_MIN_QUERY_LENGTH,
    MATCH_SCORES,
    MAX_SCORE,
    RECENT_OPEN_BOOST,
} from '../ranking';
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

/** Lower-cased, LIKE-escaped `query%`. */
export function buildPrefixPattern(query: string): string {
    return `${sanitizeLikePattern(query.trim().toLowerCase())}%`;
}

/**
 * Characters that start a new word for the SQL word-prefix band. Ranking
 * splits on any character that is not a letter or digit; SQL cannot, so this
 * lists the separators titles actually use.
 */
export const WORD_SEPARATORS: readonly string[] = [
    ' ',
    '-',
    '_',
    '/',
    '.',
    ',',
    ':',
    ';',
    '(',
    '[',
    '"',
    "'",
    '#',
    '&',
    '+',
];

/**
 * Lower-cased, LIKE-escaped "a word inside the title starts with the query"
 * patterns. Empty when the query holds a non-letter, non-digit character:
 * ranking's words never contain one, so such a query can never be a word
 * prefix there either.
 */
export function buildWordPrefixPatterns(query: string): string[] {
    const normalized = query.trim().toLowerCase();
    if (!normalized || /[^\p{L}\p{N}]/u.test(normalized)) return [];
    const escaped = sanitizeLikePattern(normalized);
    return WORD_SEPARATORS.map((separator) => `%${sanitizeLikePattern(separator)}${escaped}%`);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The source ids among `recentKeys` that belong to `kind`. Every searchable
 * kind is keyed by a uuid primary key, so anything else cannot name a row —
 * and binding it against a uuid column would fail the whole source on
 * PostgreSQL — so it is dropped here.
 */
export function recentIdsForKind(kind: string, recentKeys: readonly string[]): string[] {
    const prefix = `${kind}:`;
    const ids = new Set<string>();
    for (const key of recentKeys) {
        if (!key.startsWith(prefix)) continue;
        const id = key.slice(prefix.length);
        if (UUID.test(id)) ids.add(id);
    }
    return [...ids];
}

export interface RelevanceOrder {
    /** SQL expression equal to ranking's capped score for the row. */
    expression: string;
    parameters: Record<string, unknown>;
}

/**
 * The portable SQL mirror of `scoreCandidate`: the same match bands in the
 * same order, the same recent-open and freshness boosts, capped the same way.
 * Ordering by it (then by last change) before the cap means the cap keeps the
 * rows ranking would keep, not merely the newest matching ones.
 *
 * Every column reference goes through the trusted-identifier builders; every
 * query-derived value is a bound parameter; the only literals are the score
 * constants from `ranking.ts`.
 */
export function buildRelevanceOrder<T extends ObjectLiteral>(
    definition: WorkspaceSearchSourceDefinition<T>,
    query: WorkspaceSearchSourceQuery,
): RelevanceOrder {
    const { alias } = definition;
    const title = `${alias}.${definition.titleColumn}`;
    const identifier = definition.identifierColumn
        ? `${alias}.${definition.identifierColumn}`
        : null;
    const secondary = (definition.secondaryColumns ?? []).map((column) => `${alias}.${column}`);
    const updatedAt = `${alias}.${definition.updatedAtColumn ?? 'updatedAt'}`;

    const parameters: Record<string, unknown> = {
        wsExact: query.exactValue,
        wsPrefix: query.prefixPattern,
        wsContains: query.containsPattern,
    };
    const any = (clauses: string[]) => `(${clauses.join(' OR ')})`;
    const bands: Array<[string, number]> = [];

    const exact = [buildCaseInsensitiveEqualsClause(title, 'wsExact')];
    if (identifier) exact.push(buildCaseInsensitiveEqualsClause(identifier, 'wsExact'));
    bands.push([any(exact), MATCH_SCORES.exact]);
    bands.push([buildCaseInsensitiveLikeClause(title, 'wsPrefix'), MATCH_SCORES.prefix]);

    if (query.wordPrefixPatterns.length > 0) {
        const wordStarts = query.wordPrefixPatterns.map((pattern, index) => {
            parameters[`wsWord${index}`] = pattern;
            return buildCaseInsensitiveLikeClause(title, `wsWord${index}`);
        });
        bands.push([any(wordStarts), MATCH_SCORES.wordPrefix]);
    }

    bands.push([buildCaseInsensitiveLikeClause(title, 'wsContains'), MATCH_SCORES.contains]);
    if (identifier) {
        bands.push([
            buildCaseInsensitiveLikeClause(identifier, 'wsContains'),
            MATCH_SCORES.identifier,
        ]);
    }
    if (secondary.length > 0) {
        bands.push([
            any(secondary.map((column) => buildCaseInsensitiveLikeClause(column, 'wsContains'))),
            MATCH_SCORES.secondary,
        ]);
    }
    if (query.subsequencePattern) {
        parameters.wsSubsequence = query.subsequencePattern;
        bands.push([buildCaseInsensitiveLikeClause(title, 'wsSubsequence'), MATCH_SCORES.fuzzy]);
    }

    const terms = [
        `CASE ${bands.map(([clause, score]) => `WHEN ${clause} THEN ${score}`).join(' ')} ELSE 0 END`,
    ];

    const recentIds = recentIdsForKind(definition.kind, query.recentKeys);
    if (recentIds.length > 0) {
        parameters.wsRecentIds = recentIds;
        terms.push(
            `CASE WHEN ${alias}.id IN (:...wsRecentIds) THEN ${RECENT_OPEN_BOOST} ELSE 0 END`,
        );
    }

    parameters.wsFreshSince = new Date(query.now.getTime() - FRESH_WINDOW_MS);
    parameters.wsNow = query.now;
    terms.push(
        `CASE WHEN ${updatedAt} >= :wsFreshSince AND ${updatedAt} <= :wsNow THEN ${FRESHNESS_BOOST} ELSE 0 END`,
    );

    const sum = `(${terms.join(' + ')})`;
    return {
        expression: `CASE WHEN ${sum} > ${MAX_SCORE} THEN ${MAX_SCORE} ELSE ${sum} END`,
        parameters,
    };
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
 * across its columns, ordered by relevance then newest first, capped. Every
 * column reference goes through the trusted-identifier builders, so no source
 * can emit a database-specific operator.
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

    // Relevance first, then recency — the same order ranking applies after
    // the read — so an older strong match is never cut for newer weak ones.
    const relevance = buildRelevanceOrder(definition, query);
    qb.setParameters(relevance.parameters)
        .orderBy(relevance.expression, 'DESC')
        .addOrderBy(`${alias}.${definition.updatedAtColumn ?? 'updatedAt'}`, 'DESC')
        .take(query.cap);

    const [rows, total] = await qb.getManyAndCount();
    return { candidates: rows.map((row) => definition.toCandidate(row)), total };
}
