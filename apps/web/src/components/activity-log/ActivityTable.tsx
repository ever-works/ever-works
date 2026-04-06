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

function hasStructuredData(value?: Record<string, unknown>) {
    return !!value && Object.keys(value).length > 0;
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

function StructuredSection({ title, data }: { title: string; data?: Record<string, unknown> }) {
    if (!hasStructuredData(data)) {
        return null;
    }

    return (
        <section className="space-y-2">
            <h5 className="text-xs font-semibold uppercase tracking-wide text-text-secondary dark:text-text-secondary-dark">
                {title}
            </h5>
            <DetailPanel details={data!} />
        </section>
    );
}

function RawJsonPanel({
    title,
    details,
    metadata,
}: {
    title: string;
    details?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
}) {
    if (!hasStructuredData(details) && !hasStructuredData(metadata)) {
        return null;
    }

    return (
        <section className="space-y-2">
            <h5 className="text-xs font-semibold uppercase tracking-wide text-text-secondary dark:text-text-secondary-dark">
                {title}
            </h5>
            <pre className="text-xs bg-surface-secondary dark:bg-surface-secondary-dark p-3 rounded-md overflow-x-auto text-text-muted dark:text-text-muted-dark">
                {JSON.stringify(
                    {
                        ...(hasStructuredData(details) ? { details } : {}),
                        ...(hasStructuredData(metadata) ? { metadata } : {}),
                    },
                    null,
                    2,
                )}
            </pre>
        </section>
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
                        {loading && activities.length === 0 && (
                            <tr className="bg-card dark:bg-transparent">
                                <td
                                    colSpan={6}
                                    className="px-4 py-10 text-center text-sm text-text-muted dark:text-text-muted-dark"
                                >
                                    {t('loading')}
                                </td>
                            </tr>
                        )}
                        {activities.map((activity) => {
                            const isExpanded = expandedIds.includes(activity.id);
                            const hasDetails = hasStructuredData(activity.details);
                            const hasMetadata = hasStructuredData(activity.metadata);
                            const hasStructuredContent = hasDetails || hasMetadata;

                            return (
                                <Fragment key={activity.id}>
                                    <tr
                                        className={`bg-card dark:bg-transparent hover:bg-muted/30 dark:hover:bg-muted/10 transition-colors ${hasStructuredContent ? 'cursor-pointer' : ''}`}
                                        onClick={() =>
                                            hasStructuredContent && toggleExpanded(activity.id)
                                        }
                                        onKeyDown={(e) =>
                                            handleRowKeyDown(e, activity.id, hasStructuredContent)
                                        }
                                        tabIndex={hasStructuredContent ? 0 : undefined}
                                        role={hasStructuredContent ? 'button' : undefined}
                                        aria-expanded={
                                            hasStructuredContent ? isExpanded : undefined
                                        }
                                    >
                                        <td className="px-3 py-3 text-center">
                                            {hasStructuredContent &&
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
                                        <td className="px-4 py-3 text-sm text-text dark:text-text-dark max-w-md">
                                            <div className="space-y-1">
                                                <div className="truncate">{activity.summary}</div>
                                                {hasStructuredContent && (
                                                    <button
                                                        type="button"
                                                        className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            toggleExpanded(activity.id);
                                                        }}
                                                    >
                                                        {isExpanded
                                                            ? t('detail.collapse')
                                                            : t('detail.expand')}
                                                    </button>
                                                )}
                                            </div>
                                        </td>
                                    </tr>
                                    {hasStructuredContent && isExpanded && (
                                        <tr className="bg-muted/20 dark:bg-muted/10">
                                            <td colSpan={6} className="px-6 py-4">
                                                <div className="space-y-3">
                                                    <h4 className="text-sm font-semibold text-text dark:text-text-dark">
                                                        {t('detail.title')}
                                                    </h4>
                                                    <div className="rounded-md border border-border dark:border-border-dark bg-card dark:bg-card-dark p-3">
                                                        <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary dark:text-text-secondary-dark">
                                                            {t('detail.event')}
                                                        </p>
                                                        <div className="mt-2 space-y-2 text-sm text-text dark:text-text-dark">
                                                            <p>
                                                                <span className="font-medium">
                                                                    {t('detail.action')}:
                                                                </span>{' '}
                                                                {activity.action}
                                                            </p>
                                                            <p>
                                                                <span className="font-medium">
                                                                    Status:
                                                                </span>{' '}
                                                                {activity.status}
                                                            </p>
                                                            <p>
                                                                <span className="font-medium">
                                                                    {t('detail.created')}:
                                                                </span>{' '}
                                                                {new Date(
                                                                    activity.createdAt,
                                                                ).toLocaleString()}
                                                            </p>
                                                        </div>
                                                    </div>
                                                    <StructuredSection
                                                        title={t('detail.fields')}
                                                        data={activity.details}
                                                    />
                                                    <StructuredSection
                                                        title={t('detail.metadata')}
                                                        data={activity.metadata}
                                                    />
                                                    <RawJsonPanel
                                                        title={t('detail.rawJson')}
                                                        details={activity.details}
                                                        metadata={activity.metadata}
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
