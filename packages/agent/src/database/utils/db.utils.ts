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
