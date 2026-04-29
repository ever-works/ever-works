import type { ActivityLogEntry } from '@/lib/api/activity-log';

type ActivitySummaryTranslator = (
    key: 'generation.withChanges' | 'generation.noChanges',
    values: {
        total: number;
        added?: number;
        changed?: number;
    },
) => string;

type GenerationCounts = {
    newItemsCount?: number | null;
    updatedItemsCount?: number | null;
    totalItemsCount?: number | null;
    itemsCount?: number | null;
};

function readGenerationCounts(details?: Record<string, unknown>): GenerationCounts {
    return {
        newItemsCount:
            typeof details?.newItemsCount === 'number' ? details.newItemsCount : undefined,
        updatedItemsCount:
            typeof details?.updatedItemsCount === 'number' ? details.updatedItemsCount : undefined,
        totalItemsCount:
            typeof details?.totalItemsCount === 'number' ? details.totalItemsCount : undefined,
        itemsCount: typeof details?.itemsCount === 'number' ? details.itemsCount : undefined,
    };
}

function hasGenerationCountData(counts: GenerationCounts): boolean {
    return (
        counts.newItemsCount !== undefined ||
        counts.updatedItemsCount !== undefined ||
        counts.totalItemsCount !== undefined ||
        counts.itemsCount !== undefined
    );
}

export function formatActivitySummary(
    activity: Pick<ActivityLogEntry, 'actionType' | 'status' | 'summary' | 'details'>,
    tSummary: ActivitySummaryTranslator,
): string {
    if (activity.actionType === 'generation' && activity.status === 'completed') {
        const counts = readGenerationCounts(activity.details);

        if (hasGenerationCountData(counts)) {
            const added = counts.newItemsCount ?? 0;
            const changed = counts.updatedItemsCount ?? 0;
            const total = counts.totalItemsCount ?? counts.itemsCount ?? 0;

            if (added === 0 && changed === 0) {
                return tSummary('generation.noChanges', { total });
            }

            return tSummary('generation.withChanges', {
                added,
                changed,
                total,
            });
        }
    }

    return activity.summary;
}
