'use client';

import { Fragment, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { formatDistanceToNow } from 'date-fns';
import type { ActivityLogEntry } from '@/lib/api/activity-log';
import { formatActivitySummary } from './activity-summary';
import { ActivityStatusBadge } from './ActivityStatusBadge';
import { ActivityTypeBadge } from './ActivityTypeBadge';
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { Tooltip } from '@/components/ui/tooltip';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { TerminalLogViewer } from '@/components/works/detail/shared/TerminalLogViewer';
import type { GenerationStepLog } from '@/lib/api/types-only';
import { useMounted } from '@/lib/hooks/use-mounted';
import { CancelGenerationButton } from '@/components/works/detail/generator/CancelGenerationButton';

interface ActivityTableProps {
    activities: ActivityLogEntry[];
    loading: boolean;
    onStopRequested?: () => void;
}

const dateTimeFormatterCache = new Map<string, Intl.DateTimeFormat>();

function formatActivityDateTime(value: string, locale: string) {
    if (!dateTimeFormatterCache.has(locale)) {
        dateTimeFormatterCache.set(
            locale,
            new Intl.DateTimeFormat(locale, {
                dateStyle: 'medium',
                timeStyle: 'short',
            }),
        );
    }

    return dateTimeFormatterCache.get(locale)!.format(new Date(value));
}

function ActivityTimestamp({
    value,
    variant = 'absolute',
    className,
}: {
    value: string;
    variant?: 'absolute' | 'relative';
    className?: string;
}) {
    const locale = useLocale();
    const mounted = useMounted();

    if (!mounted) {
        return <time dateTime={value} className={className} />;
    }

    const absoluteValue = formatActivityDateTime(value, locale);

    return (
        <time
            dateTime={value}
            title={variant === 'relative' ? absoluteValue : undefined}
            className={className}
        >
            {variant === 'relative'
                ? formatDistanceToNow(new Date(value), { addSuffix: true })
                : absoluteValue}
        </time>
    );
}

function hasStructuredData(value?: Record<string, unknown>) {
    return !!value && Object.keys(value).length > 0;
}

function DetailValue({ value }: { value: unknown }) {
    const tCommon = useTranslations('common.ui');

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
                {value ? tCommon('yes') : tCommon('no')}
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

export function ActivityTable({ activities, loading, onStopRequested }: ActivityTableProps) {
    const t = useTranslations('dashboard.activity');
    const tSummary = useTranslations('dashboard.activity.summary');
    const [expandedIds, setExpandedIds] = useState<string[]>([]);
    const [hydratedActivities, setHydratedActivities] = useState<Record<string, ActivityLogEntry>>(
        {},
    );

    const toggleExpanded = (id: string) => {
        setExpandedIds((current) =>
            current.includes(id) ? current.filter((i) => i !== id) : [...current, id],
        );
    };

    useEffect(() => {
        const expandedInProgressIds = activities
            .filter(
                (activity) =>
                    expandedIds.includes(activity.id) && activity.status === 'in_progress',
            )
            .map((activity) => activity.id);

        if (expandedInProgressIds.length === 0) {
            return;
        }

        let cancelled = false;

        const refreshActivity = async (id: string) => {
            try {
                const response = await fetch(`/api/activity-log/${id}`, {
                    method: 'GET',
                    cache: 'no-store',
                });

                if (!response.ok) {
                    return;
                }

                const data = (await response.json()) as { activity?: ActivityLogEntry };
                if (!cancelled && data.activity) {
                    setHydratedActivities((current) => ({
                        ...current,
                        [id]: data.activity!,
                    }));
                }
            } catch {
                // Ignore transient network errors during background refresh.
            }
        };

        void Promise.all(expandedInProgressIds.map((id) => refreshActivity(id)));

        const interval = setInterval(() => {
            if (!document.hidden) {
                void Promise.all(expandedInProgressIds.map((id) => refreshActivity(id)));
            }
        }, 3000);

        return () => {
            cancelled = true;
            clearInterval(interval);
        };
    }, [activities, expandedIds]);

    const handleRowKeyDown = (e: React.KeyboardEvent, id: string) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleExpanded(id);
        }
    };

    return (
        <div className="relative overflow-hidden rounded-lg border border-border dark:border-border-dark">
            {loading && activities.length > 0 && (
                <div className="pointer-events-none absolute right-3 top-3 z-10 inline-flex items-center gap-1.5 rounded-full border border-border dark:border-border-dark bg-card/95 dark:bg-card-primary-dark/95 px-2.5 py-1 text-xs text-text-muted dark:text-text-muted-dark shadow-sm backdrop-blur-sm">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {t('loading')}
                </div>
            )}
            <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-border dark:divide-border-dark">
                    <thead className="bg-muted/50 dark:bg-muted/20">
                        <tr>
                            <th scope="col" className="w-8 px-3 py-3">
                                <span className="sr-only">{t('detail.expand')}</span>
                            </th>
                            <th
                                scope="col"
                                className="w-[9rem] whitespace-nowrap px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-text-secondary dark:text-text-secondary-dark"
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
                                {t('columns.work')}
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
                            const hydratedActivity = hydratedActivities[activity.id] ?? activity;
                            const liveLogs = hydratedActivity.details?.liveLogs as
                                | GenerationStepLog[]
                                | undefined;
                            const resolvedSummary = formatActivitySummary(
                                hydratedActivity,
                                tSummary,
                            );
                            const detailsWithoutLiveLogs = hydratedActivity.details
                                ? Object.fromEntries(
                                      Object.entries(hydratedActivity.details).filter(
                                          ([key]) => key !== 'liveLogs',
                                      ),
                                  )
                                : undefined;
                            const hasDetails = hasStructuredData(detailsWithoutLiveLogs);
                            const hasMetadata = hasStructuredData(hydratedActivity.metadata);
                            const hasStructuredContent = hasDetails || hasMetadata;
                            return (
                                <Fragment key={activity.id}>
                                    <tr
                                        className="bg-card dark:bg-transparent hover:bg-muted/30 dark:hover:bg-muted/10 transition-colors cursor-pointer"
                                        onClick={() => toggleExpanded(activity.id)}
                                        onKeyDown={(e) => handleRowKeyDown(e, activity.id)}
                                        tabIndex={0}
                                        role="button"
                                        aria-expanded={isExpanded}
                                    >
                                        <td className="px-3 py-3 text-center">
                                            <Tooltip
                                                content={
                                                    isExpanded
                                                        ? t('detail.collapse')
                                                        : t('detail.expand')
                                                }
                                                position="right"
                                            >
                                                {isExpanded ? (
                                                    <ChevronDown
                                                        className="w-4 h-4 text-text-muted dark:text-text-muted-dark"
                                                        aria-hidden="true"
                                                    />
                                                ) : (
                                                    <ChevronRight
                                                        className="w-4 h-4 text-text-muted dark:text-text-muted-dark"
                                                        aria-hidden="true"
                                                    />
                                                )}
                                            </Tooltip>
                                        </td>
                                        <td className="w-[9rem] whitespace-nowrap px-4 py-3 align-top">
                                            <ActivityStatusBadge status={activity.status} />
                                        </td>
                                        <td className="px-4 py-3 text-xs text-text-muted dark:text-text-muted-dark whitespace-nowrap">
                                            <ActivityTimestamp
                                                value={activity.createdAt}
                                                variant="relative"
                                            />
                                        </td>
                                        <td className="px-4 py-3 text-xs">
                                            {activity.work ? (
                                                <Link
                                                    href={ROUTES.DASHBOARD_WORK(activity.workId!)}
                                                    className="text-primary text-xs hover:underline font-medium"
                                                    onClick={(e) => e.stopPropagation()}
                                                >
                                                    {activity.work.name}
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
                                            <div className="flex items-start justify-between gap-3">
                                                <div className="min-w-0 flex-1 line-clamp-3 break-words">
                                                    {resolvedSummary}
                                                </div>
                                                {activity.actionType === 'generation' &&
                                                activity.status === 'in_progress' &&
                                                activity.workId ? (
                                                    <div onClick={(e) => e.stopPropagation()}>
                                                        <CancelGenerationButton
                                                            workId={activity.workId}
                                                            labels={{
                                                                stop: t('actions.stop'),
                                                                stopping: t('actions.stopping'),
                                                                stopRequested:
                                                                    t('actions.stopRequested'),
                                                                stopFailed: t('actions.stopFailed'),
                                                            }}
                                                            onCancelled={onStopRequested}
                                                            onAlreadyFinished={onStopRequested}
                                                        />
                                                    </div>
                                                ) : null}
                                            </div>
                                        </td>
                                    </tr>
                                    <tr
                                        className={isExpanded ? 'bg-muted/20 dark:bg-muted/10' : ''}
                                    >
                                        <td colSpan={6} style={{ padding: 0 }}>
                                            <div
                                                style={{
                                                    display: 'grid',
                                                    gridTemplateRows: isExpanded ? '1fr' : '0fr',
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
                                                                        {hydratedActivity.action}
                                                                    </code>
                                                                </p>
                                                                <p className="mb-3">
                                                                    <span className="font-medium text-text-secondary dark:text-text-secondary-dark">
                                                                        {t('detail.status')}:
                                                                    </span>{' '}
                                                                    <ActivityStatusBadge
                                                                        status={
                                                                            hydratedActivity.status
                                                                        }
                                                                    />
                                                                </p>
                                                                <p>
                                                                    <span className="font-medium text-text-secondary dark:text-text-secondary-dark">
                                                                        {t('detail.created')}:
                                                                    </span>{' '}
                                                                    <ActivityTimestamp
                                                                        value={
                                                                            hydratedActivity.createdAt
                                                                        }
                                                                        className="text-[11px] text-text-muted dark:text-text-muted-dark"
                                                                    />
                                                                </p>
                                                            </div>
                                                        </div>
                                                        {liveLogs && liveLogs.length > 0 && (
                                                            <section className="space-y-2">
                                                                <h5 className="text-xs font-semibold uppercase tracking-wide text-text-secondary dark:text-text-secondary-dark">
                                                                    {t('detail.liveLogs')}
                                                                </h5>
                                                                <TerminalLogViewer
                                                                    logs={liveLogs}
                                                                    title={t(
                                                                        'filters.types.generation',
                                                                    )}
                                                                    maxHeight="max-h-72"
                                                                    showCursor={
                                                                        hydratedActivity.status ===
                                                                        'in_progress'
                                                                    }
                                                                />
                                                            </section>
                                                        )}
                                                        <StructuredSection
                                                            title={t('detail.fields')}
                                                            data={detailsWithoutLiveLogs}
                                                        />
                                                        <StructuredSection
                                                            title={t('detail.metadata')}
                                                            data={hydratedActivity.metadata}
                                                        />
                                                        <RawJsonPanel
                                                            title={t('detail.rawJson')}
                                                            details={detailsWithoutLiveLogs}
                                                            metadata={hydratedActivity.metadata}
                                                        />
                                                    </div>
                                                </div>
                                            </div>
                                        </td>
                                    </tr>
                                </Fragment>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
