import type { DirectoryChangelog, DirectoryHistoryChangeEntry } from '@ever-works/contracts/api';

export function buildDirectoryChangelog(
    entries: DirectoryHistoryChangeEntry[],
    summary?: string | null,
): DirectoryChangelog | null {
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

function buildDefaultSummary(
    entries: DirectoryHistoryChangeEntry[],
    addedCount: number,
    updatedCount: number,
    removedCount: number,
): string {
    const entityType = entries[0]?.entityType ?? 'item';
    const label = entityType === 'comparison' ? 'comparison' : 'item';
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
