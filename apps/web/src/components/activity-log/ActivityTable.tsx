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
        return <span className="text-text-muted dark:text-text-muted-dark">—</span>;
    }
    if (typeof value === 'boolean') {
        return (
            <span
                className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${
                    value
                        ? 'bg-success/10 text-success'
                        : 'bg-muted/50 text-text-muted dark:text-text-muted-dark'
                }`}
            >
                {value ? 'Yes' : 'No'}
            </span>
        );
    }
    if (typeof value === 'object') {
        return (
            <pre className="text-[11px] leading-relaxed font-mono bg-surface dark:bg-surface-dark border border-border dark:border-border-dark rounded-md p-2.5 overflow-x-auto text-text-secondary dark:text-text-secondary-dark mt-1">
                {JSON.stringify(value, null, 2)}
            </pre>
        );
    }
    return <span className="font-mono text-xs">{String(value)}</span>;
}

function DetailPanel({ details }: { details: Record<string, unknown> }) {
    const entries = Object.entries(details);

    return (
        <div className="divide-y divide-border dark:divide-border-dark rounded-md border border-border dark:border-border-dark overflow-hidden">
            {entries.map(([key, value]) => (
                <div
                    key={key}
                    className="grid grid-cols-[180px_1fr] items-start bg-card dark:bg-transparent hover:bg-muted/20 dark:hover:bg-muted/10 transition-colors"
                >
                    <div className="px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-text-muted dark:text-text-muted-dark border-r border-border dark:border-border-dark bg-muted/30 dark:bg-muted/10 self-stretch flex items-start">
                        {key.replace(/_/g, ' ')}
                    </div>
                    <div className="px-3 py-2.5 text-xs text-text dark:text-text-dark min-w-0">
                        <DetailValue value={value} />
                    </div>
                </div>
            ))}
        </div>
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
                                    className="px-4 py-10 text-center text-xs text-text-muted dark:text-text-muted-dark"
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
                                        <td className="px-4 py-3 text-xs text-text-muted dark:text-text-muted-dark whitespace-nowrap">
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
                                        <td className="px-4 py-3 text-xs">
                                            {activity.directory ? (
                                                <Link
                                                    href={ROUTES.DASHBOARD_DIRECTORY(
                                                        activity.directoryId!,
                                                    )}
                                                    className="text-primary text-xs hover:underline font-medium"
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
                                        <td className="px-4 py-3 text-xs text-text dark:text-text-dark max-w-md">
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
                                    {hasStructuredContent && (
                                        <tr
                                            className={
                                                isExpanded ? 'bg-muted/20 dark:bg-muted/10' : ''
                                            }
                                        >
                                            <td colSpan={6} style={{ padding: 0 }}>
                                                <div
                                                    style={{
                                                        display: 'grid',
                                                        gridTemplateRows: isExpanded
                                                            ? '1fr'
                                                            : '0fr',
                                                        transition: 'grid-template-rows 300ms ease',
                                                    }}
                                                >
                                                    <div className="overflow-hidden">
                                                        <div className="px-6 py-4 space-y-3">
                                                            <h4 className="text-xs font-semibold text-text dark:text-text-dark">
                                                                {t('detail.title')}
                                                            </h4>
                                                            <div className="rounded-md border border-border dark:border-border-dark bg-card dark:bg-card-primary-dark/30 p-3">
                                                                <p className="text-xs mb-4 font-semibold uppercase tracking-wide text-text-secondary dark:text-text-secondary-dark">
                                                                    {t('detail.event')}
                                                                </p>
                                                                <div className="mt-2 space-y-2 text-xs text-text dark:text-text-dark">
                                                                    <p className="mb-3">
                                                                        <span className="font-medium text-text-secondary dark:text-text-secondary-dark">
                                                                            {t('detail.action')}:
                                                                        </span>{' '}
                                                                        <code className="text-xs font-mono px-2 py-0.5 rounded bg-muted/40 dark:bg-muted/20 text-text dark:text-text-dark border border-border dark:border-border-dark">
                                                                            {activity.action}
                                                                        </code>
                                                                    </p>
                                                                    <p className="mb-3">
                                                                        <span className="font-medium text-text-secondary dark:text-text-secondary-dark">
                                                                            {t('detail.status')}:
                                                                        </span>{' '}
                                                                        <ActivityStatusBadge
                                                                            status={activity.status}
                                                                        />
                                                                    </p>
                                                                    <p>
                                                                        <span className="font-medium text-text-secondary dark:text-text-secondary-dark">
                                                                            {t('detail.created')}:
                                                                        </span>{' '}
                                                                        <span className="text-[11px] text-text-muted dark:text-text-muted-dark">
                                                                            {new Date(
                                                                                activity.createdAt,
                                                                            ).toLocaleString()}
                                                                        </span>
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
                                                    </div>
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
