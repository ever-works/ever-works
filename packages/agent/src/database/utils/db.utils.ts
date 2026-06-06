/**
 * Sanitizes a search string for use in SQL LIKE queries.
 * Escapes special characters that have meaning in SQL LIKE patterns.
 *
 * @param search - The search string to sanitize
 * @returns The sanitized search string safe for use in LIKE queries
 */
export function sanitizeLikePattern(search: string): string {
    // Escape special LIKE pattern characters: %, _, and \
    // The backslash must be escaped first to avoid double-escaping
    return search.replace(/[%_\\]/g, '\\$&');
}

/**
 * Builds a portable case-insensitive LIKE clause for PostgreSQL, MySQL, and SQLite.
 * The explicit ESCAPE clause makes backslash escaping behave consistently.
 *
 * @param columnExpression - Must be a trusted, hardcoded column identifier (e.g. 'work.name'
 *   or a TypeORM-generated alias). Never pass user-controlled input here.
 * @param paramName - The named parameter token used in the LIKE clause.
 */
export function buildCaseInsensitiveLikeClause(
    columnExpression: string,
    paramName = 'search',
): string {
    // Security: allowlist check — column expressions must be dotted SQL identifiers or
    // TypeORM-generated aliases (alphanumeric, underscores, dots). Reject anything else
    // to prevent SQL injection if a future caller inadvertently passes user-controlled input.
    if (!/^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(columnExpression)) {
        throw new Error(
            `buildCaseInsensitiveLikeClause: columnExpression must be a trusted SQL identifier, got: ${JSON.stringify(columnExpression)}`,
        );
    }
    return `LOWER(${columnExpression}) LIKE :${paramName} ESCAPE '\\'`;
}

/**
 * Prepares a search term for use in SQL LIKE queries.
 * Trims whitespace and escapes special characters.
 *
 * @param search - The search term to prepare
 * @returns The prepared search term or undefined if empty
 */
export function prepareLikeSearchTerm(search?: string): string | undefined {
    if (!search) {
        return undefined;
    }

    const trimmed = search.trim();
    if (!trimmed) {
        return undefined;
    }

    return sanitizeLikePattern(trimmed);
}

/**
 * Prepares a case-insensitive contains-search pattern for SQL LIKE queries.
 */
export function prepareCaseInsensitiveContainsPattern(search?: string): string | undefined {
    const prepared = prepareLikeSearchTerm(search);
    if (!prepared) {
        return undefined;
    }

    return `%${prepared.toLowerCase()}%`;
}
