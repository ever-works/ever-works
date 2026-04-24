import type { ActivityLogEntry } from '@/lib/api/activity-log';

type ActivitySummaryTranslator = (
    key: 'generation.completed',
    values: {
        added: number;
        changed: number;
        total: number;
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
            return tSummary('generation.completed', {
                added: counts.newItemsCount ?? 0,
                changed: counts.updatedItemsCount ?? 0,
                total: counts.totalItemsCount ?? counts.itemsCount ?? 0,
            });
        }
    }

    return activity.summary;
}
