/** Unicode "Combining Diacritical Marks" block, left behind by NFD decomposition. */
const COMBINING_MARKS = /[\u0300-\u036f]/g;

/**
 * Normalise a string for workspace-search comparison: trim, lower-case and
 * strip Latin diacritics (`Café` → `cafe`). Non-Latin scripts pass through
 * unchanged apart from lower-casing.
 *
 * Pure — no framework or database imports — so ranking is testable without a
 * database and every search back end compares strings the same way.
 */
export function fold(input: string | null | undefined): string {
    if (!input) return '';
    return input
        .trim()
        .toLowerCase()
        .normalize('NFD')
        .replace(COMBINING_MARKS, '')
        .normalize('NFC');
}
