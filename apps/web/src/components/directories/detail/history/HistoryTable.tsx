'use client';

import { DirectoryGenerationHistoryEntry } from '@/lib/api/types-only';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';

interface HistoryTableProps {
    entries: DirectoryGenerationHistoryEntry[];
    locale: string;
}

const statusColor: Record<string, string> = {
    generating: 'bg-blue-100 text-blue-800 dark:bg-blue-500/20 dark:text-blue-200',
    generated: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200',
    error: 'bg-red-100 text-red-800 dark:bg-red-500/20 dark:text-red-200',
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatDate(value: string | undefined | null, locale: string) {
    if (!value) return '—';
    if (!formatterCache.has(locale)) {
        formatterCache.set(
            locale,
            new Intl.DateTimeFormat(locale, {
                dateStyle: 'medium',
                timeStyle: 'short',
            }),
        );
    }

    const formatter = formatterCache.get(locale)!;
    return formatter.format(new Date(value));
}

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

function getStatusLabel(status: string, t: ReturnType<typeof useTranslations>) {
    switch (status) {
        case 'generating':
            return t('status.generating');
        case 'generated':
            return t('status.generated');
        case 'error':
            return t('status.error');
        default:
            return t('unknown');
    }
}

export function HistoryTable({ entries, locale }: HistoryTableProps) {
    const t = useTranslations('dashboard.directoryDetail.history');

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
                    </tr>
                </thead>
                <tbody className="divide-y divide-border dark:divide-border-dark">
                    {entries.map((entry) => {
                        const statusKey = entry.status?.toLowerCase?.() ?? 'unknown';
                        const statusClass = statusColor[statusKey] ?? 'bg-gray-100 text-gray-700';

                        return (
                            <tr key={entry.id} className="bg-background dark:bg-background-dark">
                                <td className="px-4 py-4 align-top">
                                    <span
                                        className={cn(
                                            'inline-flex items-center rounded-full px-3 py-1 text-xs font-medium capitalize',
                                            statusClass,
                                        )}
                                    >
                                        {getStatusLabel(statusKey, t)}
                                    </span>
                                </td>
                                <td className="px-4 py-4 text-sm text-text dark:text-text-dark align-top">
                                    {formatDate(entry.startedAt ?? entry.createdAt, locale)}
                                </td>
                                <td className="px-4 py-4 text-sm text-text dark:text-text-dark align-top">
                                    {formatDuration(entry.durationInSeconds)}
                                </td>
                                <td className="px-4 py-4 text-sm text-text dark:text-text-dark align-top">
                                    {entry.newItemsCount}
                                </td>
                                <td className="px-4 py-4 text-sm text-text dark:text-text-dark align-top">
                                    {entry.updatedItemsCount}
                                </td>
                                <td className="px-4 py-4 text-sm text-text dark:text-text-dark align-top">
                                    {entry.totalItemsCount}
                                </td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}
