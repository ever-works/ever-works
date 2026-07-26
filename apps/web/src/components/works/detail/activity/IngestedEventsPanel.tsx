'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import { ExternalLink, Loader2 } from 'lucide-react';
import { listWorkIngestedEventsAction } from '@/app/actions/works/pull-requests';
import type { IngestedEventView } from '@/lib/api/ingested-events';

/**
 * Wave 8 feature j — per-Work **external activity**: the commits, PRs,
 * issues, pages, messages and meetings that happened on this Work's
 * repos / channels / trackers, as ingested by the connectors.
 *
 * Why this exists: the audit's finding was that the generic ingest spine
 * wrote `ingested_events` rows nothing ever surfaced per Work. The
 * `workId` routing landed separately; this is the view that reads it —
 * `GET /api/ingest/events?workId=&source=`, owner-scoped server-side, so
 * a Work id the caller does not own returns an empty page rather than
 * someone else's events.
 *
 * Source filtering is server-side (pushed into SQL by the repository),
 * not a client-side array filter, so the chips stay correct as the feed
 * grows past one page. The chip set is derived from the events actually
 * present rather than a hardcoded connector list, so a newly enabled
 * connector shows up without a code change.
 */

export interface IngestedEventsPanelProps {
    readonly workId: string;
    /** Pre-fetched first page (specs / future server-render paths). */
    readonly initialEvents?: IngestedEventView[];
    /** Rows requested per fetch. */
    readonly limit?: number;
}

const DEFAULT_LIMIT = 50;

/** `github.pr.review` → `pr review`; purely presentational. */
function humanizeKind(kind: string): string {
    const withoutSource = kind.includes('.') ? kind.slice(kind.indexOf('.') + 1) : kind;
    return withoutSource.replace(/[._-]/g, ' ');
}

function formatWhen(value: string): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function IngestedEventsPanel({
    workId,
    initialEvents,
    limit = DEFAULT_LIMIT,
}: IngestedEventsPanelProps) {
    const t = useTranslations('dashboard.workDetail.externalEvents');
    const [events, setEvents] = useState<IngestedEventView[]>(initialEvents ?? []);
    const [loading, setLoading] = useState(initialEvents === undefined);
    const [error, setError] = useState<string | null>(null);
    const [source, setSource] = useState<string | null>(null);
    /**
     * Chip set is captured from the UNFILTERED load so selecting a source
     * cannot collapse the chip row to the single selected source (which
     * would strand the user with no way back).
     */
    const [knownSources, setKnownSources] = useState<string[]>([]);

    const load = useCallback(
        async (nextSource: string | null) => {
            setLoading(true);
            const result = await listWorkIngestedEventsAction(workId, {
                limit,
                ...(nextSource ? { source: nextSource } : {}),
            });
            if (result.success && result.data) {
                const rows = result.data.data ?? [];
                setEvents(rows);
                if (!nextSource) {
                    setKnownSources([...new Set(rows.map((row) => row.source))].sort());
                }
                setError(null);
            } else {
                setError(result.error ?? t('error'));
            }
            setLoading(false);
        },
        [workId, limit, t],
    );

    useEffect(() => {
        if (initialEvents === undefined) void load(null);
    }, [initialEvents, load]);

    // A pre-fetched first page still needs its chip set derived.
    useEffect(() => {
        if (initialEvents !== undefined) {
            setKnownSources([...new Set(initialEvents.map((row) => row.source))].sort());
        }
    }, [initialEvents]);

    const onSelectSource = useCallback(
        (next: string | null) => {
            setSource(next);
            void load(next);
        },
        [load],
    );

    const chips = useMemo(() => [null, ...knownSources], [knownSources]);

    return (
        <section className="space-y-3" aria-label={t('title')} data-testid="ingested-events-panel">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                    <h3 className="text-sm font-semibold text-text dark:text-text-dark">
                        {t('title')}
                    </h3>
                    <p className="text-xs text-text-secondary dark:text-text-secondary-dark">
                        {t('subtitle')}
                    </p>
                </div>
            </div>

            {chips.length > 1 ? (
                <div className="flex flex-wrap gap-1.5" data-testid="ingested-events-filters">
                    {chips.map((chip) => (
                        <button
                            key={chip ?? '__all'}
                            type="button"
                            onClick={() => onSelectSource(chip)}
                            aria-pressed={source === chip}
                            className={cn(
                                'rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors',
                                source === chip
                                    ? 'border-primary bg-primary/10 text-primary'
                                    : 'border-border dark:border-border-dark text-text-secondary dark:text-text-secondary-dark hover:text-text dark:hover:text-text-dark',
                            )}
                            data-testid={`ingested-events-filter-${chip ?? 'all'}`}
                        >
                            {chip ?? t('filters.all')}
                        </button>
                    ))}
                </div>
            ) : null}

            {loading ? (
                <div
                    className="flex items-center gap-2 py-6 text-sm text-text-secondary dark:text-text-secondary-dark"
                    data-testid="ingested-events-loading"
                >
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    {t('loading')}
                </div>
            ) : error ? (
                <div
                    className="rounded-lg border border-danger/40 bg-danger/5 p-3 text-sm text-danger"
                    data-testid="ingested-events-error"
                >
                    {error}
                </div>
            ) : events.length === 0 ? (
                <p
                    className="rounded-lg border border-dashed border-border dark:border-border-dark p-6 text-center text-sm text-text-secondary dark:text-text-secondary-dark"
                    data-testid="ingested-events-empty"
                >
                    {source ? t('emptyFiltered', { source }) : t('empty')}
                </p>
            ) : (
                <ul
                    className="divide-y divide-border dark:divide-border-dark rounded-lg border border-border dark:border-border-dark"
                    data-testid="ingested-events-list"
                >
                    {events.map((event) => (
                        <li
                            key={event.id}
                            className="flex flex-wrap items-center gap-2 p-3"
                            data-testid="ingested-event-row"
                        >
                            <span className="rounded-full border border-border dark:border-border-dark px-2 py-0.5 font-mono text-xs text-text-secondary dark:text-text-secondary-dark">
                                {event.source}
                            </span>
                            <span className="text-xs text-text-muted dark:text-text-muted-dark/70">
                                {humanizeKind(event.kind)}
                            </span>
                            <span className="min-w-0 flex-1 truncate text-sm text-text dark:text-text-dark">
                                {event.title ?? t('untitled')}
                                {event.actorName ? (
                                    <span className="text-text-secondary dark:text-text-secondary-dark">
                                        {' '}
                                        · {event.actorName}
                                    </span>
                                ) : null}
                            </span>
                            <time
                                dateTime={event.occurredAt}
                                className="text-xs text-text-muted dark:text-text-muted-dark/70"
                            >
                                {formatWhen(event.occurredAt)}
                            </time>
                            {/*
                             * `sourceUrl` is external content the connector
                             * copied from the source system — always
                             * noopener/noreferrer, never rendered as HTML.
                             */}
                            {event.sourceUrl ? (
                                <a
                                    href={event.sourceUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-text-muted hover:text-text dark:text-text-muted-dark/70 dark:hover:text-text-dark"
                                    aria-label={t('openSource')}
                                    data-testid="ingested-event-source-link"
                                >
                                    <ExternalLink className="h-4 w-4" aria-hidden="true" />
                                </a>
                            ) : null}
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}
