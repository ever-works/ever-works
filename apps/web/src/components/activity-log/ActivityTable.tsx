'use client';

import { Fragment, useState } from 'react';
import { useTranslations } from 'next-intl';
import { formatDistanceToNow } from 'date-fns';
import type { ActivityLogEntry } from '@/lib/api/activity-log';
import { ActivityStatusBadge } from './ActivityStatusBadge';
import { ActivityTypeBadge } from './ActivityTypeBadge';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';

interface ActivityTableProps {
    activities: ActivityLogEntry[];
    loading: boolean;
}

function DetailValue({ value }: { value: unknown }) {
    if (value === null || value === undefined) {
        return <span className="text-text-muted dark:text-text-muted-dark italic">—</span>;
    }
    if (typeof value === 'boolean') {
        return <span>{value ? 'Yes' : 'No'}</span>;
    }
    if (typeof value === 'object') {
        return (
            <pre className="text-xs bg-surface-secondary dark:bg-surface-secondary-dark p-2 rounded-md overflow-x-auto text-text-muted dark:text-text-muted-dark mt-1">
                {JSON.stringify(value, null, 2)}
            </pre>
        );
    }
    return <span>{String(value)}</span>;
}

function DetailPanel({ details }: { details: Record<string, unknown> }) {
    const entries = Object.entries(details);

    return (
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
            {entries.map(([key, value]) => (
                <Fragment key={key}>
                    <dt className="font-medium text-text-secondary dark:text-text-secondary-dark capitalize whitespace-nowrap">
                        {key.replace(/_/g, ' ')}
                    </dt>
                    <dd className="text-text dark:text-text-dark break-words">
                        <DetailValue value={value} />
                    </dd>
                </Fragment>
            ))}
        </dl>
    );
}

export function ActivityTable({ activities, loading }: ActivityTableProps) {
    const t = useTranslations('dashboard.activity');
    const [expandedIds, setExpandedIds] = useState<string[]>([]);

    const toggleExpanded = (id: string) => {
        setExpandedIds((current) =>
            current.includes(id) ? current.filter((i) => i !== id) : [...current, id],
        );
    };

    const handleRowKeyDown = (e: React.KeyboardEvent, id: string, hasDetails: boolean) => {
        if (!hasDetails) return;
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleExpanded(id);
        }
    };

    return (
        <div className="overflow-hidden rounded-lg border border-border dark:border-border-dark">
            <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-border dark:divide-border-dark">
                    <thead className="bg-muted/50 dark:bg-muted/20">
                        <tr>
                            <th scope="col" className="w-8 px-3 py-3">
                                <span className="sr-only">Expand</span>
                            </th>
                            <th
                                scope="col"
                                className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-text-secondary dark:text-text-secondary-dark"
                            >
                                {t('columns.status')}
                            </th>
                            <th
                                scope="col"
                                className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-text-secondary dark:text-text-secondary-dark"
                            >
                                {t('columns.dateTime')}
                            </th>
                            <th
                                scope="col"
                                className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-text-secondary dark:text-text-secondary-dark"
                            >
                                {t('columns.directory')}
                            </th>
                            <th
                                scope="col"
                                className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-text-secondary dark:text-text-secondary-dark"
                            >
                                {t('columns.type')}
                            </th>
                            <th
                                scope="col"
                                className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-text-secondary dark:text-text-secondary-dark"
                            >
                                {t('columns.summary')}
                            </th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-border dark:divide-border-dark">
                        {activities.map((activity) => {
                            const isExpanded = expandedIds.includes(activity.id);
                            const hasDetails =
                                activity.details && Object.keys(activity.details).length > 0;

                            return (
                                <Fragment key={activity.id}>
                                    <tr
                                        className={`bg-card dark:bg-transparent hover:bg-muted/30 dark:hover:bg-muted/10 transition-colors ${hasDetails ? 'cursor-pointer' : ''}`}
                                        onClick={() => hasDetails && toggleExpanded(activity.id)}
                                        onKeyDown={(e) =>
                                            handleRowKeyDown(e, activity.id, !!hasDetails)
                                        }
                                        tabIndex={hasDetails ? 0 : undefined}
                                        role={hasDetails ? 'button' : undefined}
                                        aria-expanded={hasDetails ? isExpanded : undefined}
                                    >
                                        <td className="px-3 py-3 text-center">
                                            {hasDetails &&
                                                (isExpanded ? (
                                                    <ChevronDown
                                                        className="w-4 h-4 text-text-muted dark:text-text-muted-dark"
                                                        aria-hidden="true"
                                                    />
                                                ) : (
                                                    <ChevronRight
                                                        className="w-4 h-4 text-text-muted dark:text-text-muted-dark"
                                                        aria-hidden="true"
                                                    />
                                                ))}
                                        </td>
                                        <td className="px-4 py-3">
                                            <ActivityStatusBadge status={activity.status} />
                                        </td>
                                        <td className="px-4 py-3 text-sm text-text-muted dark:text-text-muted-dark whitespace-nowrap">
                                            <span
                                                title={new Date(
                                                    activity.createdAt,
                                                ).toLocaleString()}
                                            >
                                                {formatDistanceToNow(new Date(activity.createdAt), {
                                                    addSuffix: true,
                                                })}
                                            </span>
                                        </td>
                                        <td className="px-4 py-3 text-sm">
                                            {activity.directory ? (
                                                <Link
                                                    href={ROUTES.DASHBOARD_DIRECTORY(
                                                        activity.directoryId!,
                                                    )}
                                                    className="text-primary hover:underline font-medium"
                                                    onClick={(e) => e.stopPropagation()}
                                                >
                                                    {activity.directory.name}
                                                </Link>
                                            ) : (
                                                <span className="text-text-muted dark:text-text-muted-dark">
                                                    —
                                                </span>
                                            )}
                                        </td>
                                        <td className="px-4 py-3">
                                            <ActivityTypeBadge actionType={activity.actionType} />
                                        </td>
                                        <td className="px-4 py-3 text-sm text-text dark:text-text-dark max-w-md truncate">
                                            {activity.summary}
                                        </td>
                                    </tr>
                                    {hasDetails && isExpanded && (
                                        <tr className="bg-muted/20 dark:bg-muted/10">
                                            <td colSpan={6} className="px-6 py-4">
                                                <div className="space-y-3">
                                                    <h4 className="text-sm font-medium text-text dark:text-text-dark">
                                                        {t('detail.title')}
                                                    </h4>
                                                    <DetailPanel
                                                        details={
                                                            activity.details as Record<
                                                                string,
                                                                unknown
                                                            >
                                                        }
                                                    />
                                                </div>
                                            </td>
                                        </tr>
                                    )}
                                </Fragment>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
