'use client';

import { DirectoryGenerationHistoryEntry } from '@/lib/api/types-only';
import { useTranslations } from 'next-intl';
import { Fragment, useState } from 'react';
import { cn } from '@/lib/utils/cn';
import { ShowDateTime } from '@/components/ui/show-datetime';
import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';

interface HistoryTableProps {
    entries: DirectoryGenerationHistoryEntry[];
    locale: string;
}

const statusColor: Record<string, string> = {
    generating: 'bg-blue-100 text-blue-800 dark:bg-blue-500/20 dark:text-blue-200',
    generated: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200',
    error: 'bg-red-100 text-red-800 dark:bg-red-500/20 dark:text-red-200',
    cancelled: 'bg-gray-200 text-gray-800 dark:bg-gray-800 dark:text-gray-200',
};

const tdClass = 'px-4 py-4 text-sm text-text dark:text-text-dark align-top';

function formatDuration(seconds?: number | null) {
    if (!seconds || seconds <= 0) {
        return '—';
    }

    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    if (hrs > 0) {
        return `${hrs}h ${mins}m`;
    }

    if (mins > 0) {
        return `${mins}m ${secs}s`;
    }

    return `${secs}s`;
}

function formatTokens(tokens?: number | null) {
    if (!tokens || tokens <= 0) {
        return '—';
    }

    if (tokens >= 1_000_000) {
        return `${(tokens / 1_000_000).toFixed(1)}M`;
    }

    if (tokens >= 1_000) {
        return `${(tokens / 1_000).toFixed(1)}K`;
    }

    return tokens.toLocaleString();
}

function formatCost(cost?: number | null) {
    if (!cost || cost <= 0) {
        return '—';
    }

    return `$${cost.toFixed(4)}`;
}

function getStatusLabel(status: string, t: ReturnType<typeof useTranslations>) {
    switch (status) {
        case 'generating':
            return t('status.generating');
        case 'generated':
            return t('status.generated');
        case 'error':
            return t('status.error');
        case 'cancelled':
            return t('status.cancelled');
        default:
            return t('unknown');
    }
}

function formatActivityLabel(activityType: DirectoryGenerationHistoryEntry['activityType']) {
    switch (activityType) {
        case 'item_added':
            return 'Item Added';
        case 'item_updated':
            return 'Item Updated';
        case 'item_removed':
            return 'Item Removed';
        case 'comparison_added':
            return 'Comparison Added';
        case 'comparison_removed':
            return 'Comparison Removed';
        case 'category_change':
            return 'Category Change';
        case 'tag_change':
            return 'Tag Change';
        case 'collection_change':
            return 'Collection Change';
        case 'community_pr_merged':
            return 'Community PR';
        case 'generation':
        default:
            return 'Generation';
    }
}

function renderMetricCount(
    entry: DirectoryGenerationHistoryEntry,
    value: number,
    kind: 'new' | 'updated' | 'total',
) {
    if (entry.activityType !== 'generation' && kind === 'total' && value === 0) {
        return '—';
    }

    if (
        entry.activityType !== 'generation' &&
        kind !== 'total' &&
        value === 0 &&
        entry.changelog?.entries?.length
    ) {
        return '—';
    }

    return value;
}

export function HistoryTable({ entries, locale }: HistoryTableProps) {
    const t = useTranslations('dashboard.directoryDetail.history');
    const [expandedIds, setExpandedIds] = useState<string[]>([]);

    function toggleExpanded(id: string) {
        setExpandedIds((current) =>
            current.includes(id) ? current.filter((entryId) => entryId !== id) : [...current, id],
        );
    }

    return (
        <div className="overflow-hidden rounded-lg border border-border dark:border-border-dark">
            <table className="min-w-full divide-y divide-border dark:divide-border-dark">
                <thead className="bg-muted/50 dark:bg-muted/20">
                    <tr>
                        <th className="px-4 py-3 text-left text-sm font-semibold text-text-secondary dark:text-text-secondary-dark">
                            {t('table.run')}
                        </th>
                        <th className="px-4 py-3 text-left text-sm font-semibold text-text-secondary dark:text-text-secondary-dark">
                            {t('table.startedAt')}
                        </th>
                        <th className="px-4 py-3 text-left text-sm font-semibold text-text-secondary dark:text-text-secondary-dark">
                            {t('table.duration')}
                        </th>
                        <th className="px-4 py-3 text-left text-sm font-semibold text-text-secondary dark:text-text-secondary-dark">
                            {t('table.newItems')}
                        </th>
                        <th className="px-4 py-3 text-left text-sm font-semibold text-text-secondary dark:text-text-secondary-dark">
                            {t('table.updatedItems')}
                        </th>
                        <th className="px-4 py-3 text-left text-sm font-semibold text-text-secondary dark:text-text-secondary-dark">
                            {t('table.totalItems')}
                        </th>
                        <th className="px-4 py-3 text-left text-sm font-semibold text-text-secondary dark:text-text-secondary-dark">
                            {t('table.tokens')}
                        </th>
                        {/* <th className="px-4 py-3 text-left text-sm font-semibold text-text-secondary dark:text-text-secondary-dark">
                            {t('table.cost')}
                        </th> */}
                    </tr>
                </thead>
                <tbody className="divide-y divide-border dark:divide-border-dark">
                    {entries.map((entry) => {
                        const statusKey = entry.status?.toLowerCase?.() ?? 'unknown';
                        const statusClass = statusColor[statusKey] ?? 'bg-gray-100 text-gray-700';
                        const hasDetails = (entry.changelog?.entries?.length ?? 0) > 0;
                        const isExpanded = expandedIds.includes(entry.id);

                        const addedEntries =
                            entry.changelog?.entries?.filter(
                                (change) => change.action === 'added',
                            ) ?? [];
                        const updatedEntries =
                            entry.changelog?.entries?.filter(
                                (change) => change.action === 'updated',
                            ) ?? [];
                        const removedEntries =
                            entry.changelog?.entries?.filter(
                                (change) => change.action === 'removed',
                            ) ?? [];

                        return (
                            <Fragment key={entry.id}>
                                <tr className="bg-background dark:bg-background-dark">
                                    <td className="px-4 py-4 align-top">
                                        <div className="flex flex-col gap-2">
                                            <div className="flex items-start gap-2">
                                                {hasDetails ? (
                                                    <button
                                                        type="button"
                                                        onClick={() => toggleExpanded(entry.id)}
                                                        className="mt-0.5 rounded p-0.5 text-text-secondary transition hover:bg-muted dark:text-text-secondary-dark dark:hover:bg-muted/20"
                                                        aria-label={
                                                            isExpanded
                                                                ? 'Collapse changelog details'
                                                                : 'Expand changelog details'
                                                        }
                                                    >
                                                        {isExpanded ? (
                                                            <ChevronDown className="h-4 w-4" />
                                                        ) : (
                                                            <ChevronRight className="h-4 w-4" />
                                                        )}
                                                    </button>
                                                ) : (
                                                    <span className="w-5" />
                                                )}
                                                <div className="flex flex-col gap-2">
                                                    <span
                                                        className={cn(
                                                            'inline-flex w-fit items-center rounded-full px-3 py-1 text-xs font-medium capitalize',
                                                            statusClass,
                                                        )}
                                                    >
                                                        {getStatusLabel(statusKey, t)}
                                                    </span>
                                                    <span className="text-xs text-text-secondary dark:text-text-secondary-dark">
                                                        {formatActivityLabel(entry.activityType)}
                                                    </span>
                                                    {entry.changelog?.summary ? (
                                                        <p className="max-w-sm text-xs text-text-secondary dark:text-text-secondary-dark">
                                                            {entry.changelog.summary}
                                                        </p>
                                                    ) : null}
                                                    {entry.triggerRunId && (
                                                        <a
                                                            href={`https://cloud.trigger.dev/runs/${entry.triggerRunId}`}
                                                            target="_blank"
                                                            rel="noopener noreferrer"
                                                            className="flex items-center gap-1 text-xs text-primary hover:underline dark:text-primary-dark"
                                                        >
                                                            <span>Trigger.dev</span>
                                                            <ExternalLink className="h-3 w-3" />
                                                        </a>
                                                    )}
                                                </div>
                                            </div>
                                        </div>
                                    </td>

                                    <td className={tdClass}>
                                        <ShowDateTime value={entry.startedAt ?? entry.createdAt} />
                                    </td>

                                    <td className={tdClass}>
                                        {formatDuration(entry.durationInSeconds)}
                                    </td>
                                    <td className={tdClass}>
                                        {renderMetricCount(entry, entry.newItemsCount, 'new')}
                                    </td>
                                    <td className={tdClass}>
                                        {renderMetricCount(
                                            entry,
                                            entry.updatedItemsCount,
                                            'updated',
                                        )}
                                    </td>
                                    <td className={tdClass}>
                                        {renderMetricCount(entry, entry.totalItemsCount, 'total')}
                                    </td>
                                    <td className={tdClass}>
                                        {formatTokens(entry.metrics?.total_tokens_used)}
                                    </td>
                                    {/* <td className={tdClass}>{formatCost(entry.metrics?.total_cost)}</td> */}
                                </tr>
                                {hasDetails && isExpanded ? (
                                    <tr className="bg-muted/20 dark:bg-muted/10">
                                        <td colSpan={7} className="px-4 py-4">
                                            <div className="grid gap-4 md:grid-cols-3">
                                                <div>
                                                    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary dark:text-text-secondary-dark">
                                                        Added
                                                    </p>
                                                    <div className="space-y-2">
                                                        {addedEntries.length > 0 ? (
                                                            addedEntries.map((change) => (
                                                                <div
                                                                    key={`${entry.id}-${change.action}-${change.slug ?? change.name}`}
                                                                    className="rounded-md border border-border bg-background px-3 py-2 text-sm dark:border-border-dark dark:bg-background-dark"
                                                                >
                                                                    <div className="font-medium text-text dark:text-text-dark">
                                                                        {change.name}
                                                                    </div>
                                                                    {change.slug ? (
                                                                        <div className="text-xs text-text-secondary dark:text-text-secondary-dark">
                                                                            {change.slug}
                                                                        </div>
                                                                    ) : null}
                                                                </div>
                                                            ))
                                                        ) : (
                                                            <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                                                                —
                                                            </p>
                                                        )}
                                                    </div>
                                                </div>
                                                <div>
                                                    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary dark:text-text-secondary-dark">
                                                        Updated
                                                    </p>
                                                    <div className="space-y-2">
                                                        {updatedEntries.length > 0 ? (
                                                            updatedEntries.map((change) => (
                                                                <div
                                                                    key={`${entry.id}-${change.action}-${change.slug ?? change.name}`}
                                                                    className="rounded-md border border-border bg-background px-3 py-2 text-sm dark:border-border-dark dark:bg-background-dark"
                                                                >
                                                                    <div className="font-medium text-text dark:text-text-dark">
                                                                        {change.name}
                                                                    </div>
                                                                    {change.slug ? (
                                                                        <div className="text-xs text-text-secondary dark:text-text-secondary-dark">
                                                                            {change.slug}
                                                                        </div>
                                                                    ) : null}
                                                                    {change.fieldsChanged
                                                                        ?.length ? (
                                                                        <div className="mt-1 text-xs text-text-secondary dark:text-text-secondary-dark">
                                                                            Fields:{' '}
                                                                            {change.fieldsChanged.join(
                                                                                ', ',
                                                                            )}
                                                                        </div>
                                                                    ) : null}
                                                                </div>
                                                            ))
                                                        ) : (
                                                            <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                                                                —
                                                            </p>
                                                        )}
                                                    </div>
                                                </div>
                                                <div>
                                                    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary dark:text-text-secondary-dark">
                                                        Removed
                                                    </p>
                                                    <div className="space-y-2">
                                                        {removedEntries.length > 0 ? (
                                                            removedEntries.map((change) => (
                                                                <div
                                                                    key={`${entry.id}-${change.action}-${change.slug ?? change.name}`}
                                                                    className="rounded-md border border-border bg-background px-3 py-2 text-sm dark:border-border-dark dark:bg-background-dark"
                                                                >
                                                                    <div className="font-medium text-text dark:text-text-dark">
                                                                        {change.name}
                                                                    </div>
                                                                    {change.slug ? (
                                                                        <div className="text-xs text-text-secondary dark:text-text-secondary-dark">
                                                                            {change.slug}
                                                                        </div>
                                                                    ) : null}
                                                                </div>
                                                            ))
                                                        ) : (
                                                            <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                                                                —
                                                            </p>
                                                        )}
                                                    </div>
                                                </div>
                                            </div>
                                        </td>
                                    </tr>
                                ) : null}
                            </Fragment>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}
