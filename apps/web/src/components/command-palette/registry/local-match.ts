/**
 * Client-side matching for the palette's local rows — Commands, Screens and
 * Recent — which never reach the server. Same bands as the server ranking
 * (exact → prefix → word prefix → contains → alias → fuzzy), so a local row
 * and a record row with the same kind of match sit at comparable scores.
 */

const COMBINING_MARKS = /\p{M}/gu;

export function foldText(input: string | null | undefined): string {
    if (!input) return '';
    return input
        .trim()
        .toLowerCase()
        .normalize('NFD')
        .replace(COMBINING_MARKS, '')
        .normalize('NFC');
}

function isSubsequence(needle: string, haystack: string): boolean {
    let index = 0;
    for (const char of haystack) {
        if (char === needle[index]) index += 1;
        if (index === needle.length) return true;
    }
    return false;
}

/**
 * Score `label` (plus a comma-separated `aliases` list and any extra
 * haystacks) against `query`. `null` when nothing matches. An empty query
 * matches everything with score 0 so callers can show the unfiltered list.
 */
export function localMatchScore(
    query: string,
    label: string,
    aliases = '',
    extra: ReadonlyArray<string> = [],
): number | null {
    const q = foldText(query);
    if (!q) return 0;
    const text = foldText(label);
    if (text === q) return 100;
    if (text.startsWith(q)) return 90;
    if (text.split(/[^\p{L}\p{N}]+/u).some((word) => word.startsWith(q))) return 80;
    if (text.includes(q)) return 65;
    const others = [...aliases.split(','), ...extra].map(foldText).filter(Boolean);
    if (others.some((alias) => alias === q || alias.startsWith(q))) return 60;
    if (others.some((alias) => alias.includes(q))) return 40;
    const compact = q.replace(/\s+/g, '');
    if (compact.length >= 3 && isSubsequence(compact, text)) return 25;
    return null;
}
