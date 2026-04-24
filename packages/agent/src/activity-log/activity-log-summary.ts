type ActivityLogSummaryLike = {
    actionType?: string | null;
    status?: string | null;
    summary?: string | null;
    details?: Record<string, unknown> | null;
};

type GenerationCounts = {
    newItemsCount?: number | null;
    updatedItemsCount?: number | null;
    totalItemsCount?: number | null;
    itemsCount?: number | null;
};

export function formatGenerationCountsSummary(counts?: GenerationCounts): string {
    const added = counts?.newItemsCount ?? 0;
    const changed = counts?.updatedItemsCount ?? 0;
    const total = counts?.totalItemsCount ?? counts?.itemsCount ?? 0;

    if (added === 0 && changed === 0) {
        return `No item changes. Total: ${total}`;
    }

    return `Added ${added}. Changed ${changed}. Total: ${total}`;
}

function readGenerationCounts(details?: Record<string, unknown> | null): GenerationCounts {
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

export function formatStoredActivitySummary(activity: ActivityLogSummaryLike): string {
    if (activity.actionType === 'generation' && activity.status === 'completed') {
        const counts = readGenerationCounts(activity.details);

        if (hasGenerationCountData(counts)) {
            return formatGenerationCountsSummary(counts);
        }
    }

    return activity.summary ?? '';
}
