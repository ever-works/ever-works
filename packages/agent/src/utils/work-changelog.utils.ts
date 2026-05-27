import type {
    WorkChangelog,
    WorkHistoryChangeEntityType,
    WorkHistoryChangeEntry,
} from '@ever-works/contracts/api';

export function buildWorkChangelog(
    entries: WorkHistoryChangeEntry[],
    summary?: string | null,
): WorkChangelog | null {
    if (entries.length === 0) {
        return null;
    }

    const addedCount = entries.filter((entry) => entry.action === 'added').length;
    const updatedCount = entries.filter((entry) => entry.action === 'updated').length;
    const removedCount = entries.filter((entry) => entry.action === 'removed').length;

    return {
        summary: summary ?? buildDefaultSummary(entries, addedCount, updatedCount, removedCount),
        addedCount,
        updatedCount,
        removedCount,
        entries,
    };
}

/**
 * Build a human-readable summary line like "3 items added, 1 item updated".
 *
 * **Two behavioural caveats worth flagging:**
 *
 *   - **Mixed-entity lists are mis-labeled.** The label is derived
 *     from `entries[0].entityType` and applied to every count. A
 *     changelog containing both items and categories will say "5
 *     items added" even if some of the entries are categories.
 *     If we ever batch multi-entity changelogs, switch to
 *     per-entity grouping.
 *
 *   - **Plural form is naive `+ 's'`.** Works for `item` → `items`,
 *     `tag` → `tags`, `collection` → `collections`, `comparison` →
 *     `comparisons` — but produces `categorys` for `category`.
 *     If this ever ships in user-visible UI, fix with a per-label
 *     plural table (or `Intl.PluralRules` + a translation key).
 */
function buildDefaultSummary(
    entries: WorkHistoryChangeEntry[],
    addedCount: number,
    updatedCount: number,
    removedCount: number,
): string {
    const entityType = entries[0]?.entityType ?? 'item';
    const label = getEntityLabel(entityType);
    const parts: string[] = [];

    if (addedCount > 0) {
        parts.push(`${addedCount} ${label}${addedCount === 1 ? '' : 's'} added`);
    }

    if (updatedCount > 0) {
        parts.push(`${updatedCount} ${label}${updatedCount === 1 ? '' : 's'} updated`);
    }

    if (removedCount > 0) {
        parts.push(`${removedCount} ${label}${removedCount === 1 ? '' : 's'} removed`);
    }

    return parts.join(', ');
}

function getEntityLabel(entityType: WorkHistoryChangeEntityType): string {
    switch (entityType) {
        case 'comparison':
            return 'comparison';
        case 'category':
            return 'category';
        case 'tag':
            return 'tag';
        case 'collection':
            return 'collection';
        case 'item':
        default:
            return 'item';
    }
}
