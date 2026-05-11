'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { formatDistanceToNow } from 'date-fns';
import { Dialog, DialogContent, DialogClose, DialogTitle } from '@/components/ui/dialog';
import type { ActivityLogEntry } from '@/lib/api/activity-log';
import type { GenerationStepLog } from '@/lib/api/types-only';
import { ActivityStatusBadge } from './ActivityStatusBadge';
import { ActivityTypeBadge } from './ActivityTypeBadge';
import { formatActivitySummary } from './activity-summary';
import { TerminalLogViewer } from '@/components/works/detail/shared/TerminalLogViewer';
import { CancelGenerationButton } from '@/components/works/detail/generator/CancelGenerationButton';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { ExternalLink } from 'lucide-react';
import { useMounted } from '@/lib/hooks/use-mounted';

// ─── Timestamp ──────────────────────────────────────────────────────────────

const dateTimeFormatterCache = new Map<string, Intl.DateTimeFormat>();

function formatAbsolute(value: string, locale: string) {
    if (!dateTimeFormatterCache.has(locale)) {
        dateTimeFormatterCache.set(
            locale,
            new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }),
        );
    }
    return dateTimeFormatterCache.get(locale)!.format(new Date(value));
}

function ActivityTimestamp({ value, className }: { value: string; className?: string }) {
    const locale = useLocale();
    const mounted = useMounted();
    if (!mounted) return <time dateTime={value} className={className} />;
    const absolute = formatAbsolute(value, locale);
    const relative = formatDistanceToNow(new Date(value), { addSuffix: true });
    return (
        <time dateTime={value} title={relative} className={className}>
            {absolute}
        </time>
    );
}

// ─── Detail sub-components (same design as ActivityTable) ───────────────────

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
    return (
        <div className="divide-y divide-border dark:divide-border-dark rounded-md border border-border dark:border-border-dark overflow-hidden">
            {Object.entries(details).map(([key, value]) => (
                <div
                    key={key}
                    className="grid grid-cols-[160px_1fr] items-start bg-card dark:bg-transparent hover:bg-muted/20 dark:hover:bg-muted/10 transition-colors"
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
    if (!hasStructuredData(data)) return null;
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
    if (!hasStructuredData(details) && !hasStructuredData(metadata)) return null;
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

// ─── Modal ──────────────────────────────────────────────────────────────────

interface ActivityDetailModalProps {
    entry: ActivityLogEntry | null;
    onClose: () => void;
    onStopRequested?: () => void;
}

export function ActivityDetailModal({ entry, onClose, onStopRequested }: ActivityDetailModalProps) {
    const t = useTranslations('dashboard.activity');
    const tSummary = useTranslations('dashboard.activity.summary');

    const [hydrated, setHydrated] = useState<ActivityLogEntry | null>(null);

    // Reset hydrated state when a new entry is opened
    useEffect(() => {
        setHydrated(null);
    }, [entry?.id]);

    // Live-refresh for in_progress activities (same 3 s cadence as the table)
    useEffect(() => {
        if (!entry || entry.status !== 'in_progress') return;

        let cancelled = false;

        const refresh = async () => {
            try {
                const res = await fetch(`/api/activity-log/${entry.id}`, {
                    method: 'GET',
                    cache: 'no-store',
                });
                if (!res.ok || cancelled) return;
                const data = (await res.json()) as { activity?: ActivityLogEntry };
                if (data.activity && !cancelled) setHydrated(data.activity);
            } catch {
                // ignore transient errors
            }
        };

        void refresh();
        const interval = setInterval(() => {
            if (!document.hidden) void refresh();
        }, 3000);

        return () => {
            cancelled = true;
            clearInterval(interval);
        };
    }, [entry?.id, entry?.status]);

    const activity = hydrated ?? entry;

    const liveLogs = activity?.details?.liveLogs as GenerationStepLog[] | undefined;
    const detailsWithoutLiveLogs = activity?.details
        ? Object.fromEntries(Object.entries(activity.details).filter(([key]) => key !== 'liveLogs'))
        : undefined;
    const resolvedSummary = activity ? formatActivitySummary(activity, tSummary) : '';

    return (
        <Dialog open={entry !== null} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-2xl w-full max-h-[90vh] overflow-y-auto">
                <DialogClose onClose={onClose} />

                {/* Header */}
                <div className="flex items-start gap-3 pr-6 mb-4">
                    <div className="flex-1 min-w-0 space-y-2">
                        <DialogTitle className="text-base font-semibold text-text dark:text-text-dark leading-tight">
                            {t('detail.title')}
                        </DialogTitle>
                        <div className="flex items-center gap-2 flex-wrap">
                            {activity && <ActivityTypeBadge actionType={activity.actionType} />}
                            {activity && <ActivityStatusBadge status={activity.status} />}
                            {activity?.work && (
                                <Link
                                    href={ROUTES.DASHBOARD_WORK(activity.work.id)}
                                    className="inline-flex items-center gap-1 text-xs text-primary hover:underline font-medium"
                                    onClick={onClose}
                                >
                                    {activity.work.name}
                                    <ExternalLink className="w-3 h-3 shrink-0" />
                                </Link>
                            )}
                        </div>
                    </div>
                </div>

                {activity && (
                    <div className="space-y-3">
                        {/* Event block — mirrors the table expand panel */}
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
                                    <ActivityStatusBadge status={activity.status} />
                                </p>
                                <p className="mb-3">
                                    <span className="font-medium text-text-secondary dark:text-text-secondary-dark">
                                        {t('detail.created')}:
                                    </span>{' '}
                                    <ActivityTimestamp
                                        value={activity.createdAt}
                                        className="text-[11px] text-text-muted dark:text-text-muted-dark"
                                    />
                                </p>
                                {resolvedSummary && (
                                    <p>
                                        <span className="font-medium text-text-secondary dark:text-text-secondary-dark">
                                            {t('columns.summary')}:
                                        </span>{' '}
                                        <span className="text-text dark:text-text-dark">
                                            {resolvedSummary}
                                        </span>
                                    </p>
                                )}
                            </div>
                        </div>

                        {/* Cancel button for in_progress generation */}
                        {activity.actionType === 'generation' &&
                            activity.status === 'in_progress' &&
                            activity.workId && (
                                <div className="flex justify-end">
                                    <CancelGenerationButton
                                        workId={activity.workId}
                                        labels={{
                                            stop: t('actions.stop'),
                                            stopping: t('actions.stopping'),
                                            stopRequested: t('actions.stopRequested'),
                                            stopFailed: t('actions.stopFailed'),
                                        }}
                                        onCancelled={onStopRequested}
                                        onAlreadyFinished={onStopRequested}
                                    />
                                </div>
                            )}

                        {/* Live logs */}
                        {liveLogs && liveLogs.length > 0 && (
                            <section className="space-y-2">
                                <h5 className="text-xs font-semibold uppercase tracking-wide text-text-secondary dark:text-text-secondary-dark">
                                    {t('detail.liveLogs')}
                                </h5>
                                <TerminalLogViewer
                                    logs={liveLogs}
                                    title={t('filters.types.generation')}
                                    maxHeight="max-h-64"
                                    showCursor={activity.status === 'in_progress'}
                                />
                            </section>
                        )}

                        <StructuredSection
                            title={t('detail.fields')}
                            data={detailsWithoutLiveLogs}
                        />
                        <StructuredSection title={t('detail.metadata')} data={activity.metadata} />
                        <RawJsonPanel
                            title={t('detail.rawJson')}
                            details={detailsWithoutLiveLogs}
                            metadata={activity.metadata}
                        />
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
}
