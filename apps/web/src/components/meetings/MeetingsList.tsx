'use client';

import { useEffect, useState } from 'react';
import { ListFilter, Plus, Video } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Select } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';
import { PageHeader } from '@/components/common/PageHeader';
import { MEETING_SOURCES, type MeetingSource } from '@/lib/api/meetings.shared';
import type { Meeting } from '@/lib/api/meetings';
import { MeetingCard } from './MeetingCard';
import { sourceIconMap } from './meeting-ui';

/**
 * The same marks the cards carry, plus a neutral one for "Any source" —
 * without it the trigger would lose its icon (and shift) whenever the
 * filter is cleared.
 */
const SOURCE_FILTER_ICONS = {
    ...sourceIconMap(MEETING_SOURCES),
    any: (
        <ListFilter
            aria-hidden="true"
            strokeWidth={1.75}
            className="h-3.5 w-3.5 shrink-0 text-text-muted dark:text-text-muted-dark"
        />
    ),
};

/** Minimal Work reference used by the "routed to" filter. */
export interface MeetingWorkOption {
    id: string;
    name: string;
}

interface MeetingsListProps {
    meetings: Meeting[];
    works?: MeetingWorkOption[];
    loadError?: string | null;
    filters?: {
        source?: MeetingSource;
        workId?: string;
    };
    pagination?: {
        offset: number;
        hasPrevious: boolean;
        hasNext: boolean;
        previousHref: string;
        nextHref: string;
    };
}

/**
 * Meetings — `/meetings` catalog list client. Grid of MeetingCards with
 * source + Work filters and a "+ New meeting" CTA routing to the
 * dedicated capture form. Load failures are surfaced explicitly so a
 * flaky API never masquerades as an empty meeting history (same
 * contract as `GoalsList`).
 *
 * The filter form is a plain GET form (no client router push), so the
 * filtered view is a real, shareable URL and works before hydration.
 */
export function MeetingsList({
    meetings,
    works = [],
    loadError = null,
    filters,
    pagination,
}: MeetingsListProps) {
    const t = useTranslations('dashboard.meetingsPage');
    const [sourceFilter, setSourceFilter] = useState<string>(filters?.source ?? '');
    const [workFilter, setWorkFilter] = useState<string>(filters?.workId ?? '');

    useEffect(() => {
        setSourceFilter(filters?.source ?? '');
    }, [filters?.source]);
    useEffect(() => {
        setWorkFilter(filters?.workId ?? '');
    }, [filters?.workId]);

    return (
        <div className="w-full" data-testid="meetings-shell">
            <PageHeader
                icon={Video}
                title={t('title')}
                subtitle={t('subtitle')}
                tone="info"
                actions={
                    <Button href="/meetings/new" size="sm">
                        <Plus className="h-4 w-4" />
                        <span className="font-medium">{t('newMeeting')}</span>
                    </Button>
                }
            />

            {/*
                Connect affordance: provider-synced meetings (Zoom
                recordings, Google Meet transcripts picked up by the
                Workspace connector) land through the ingest spine, not
                this form — point at the connector catalog rather than
                inventing a second sync surface here.
            */}
            <p
                className="mb-5 rounded-lg border border-dashed border-border/70 bg-surface/40 px-4 py-3 text-xs text-text-muted dark:border-border-dark/70 dark:bg-surface-dark/30 dark:text-text-muted-dark"
                data-testid="meetings-connect-hint"
            >
                {t('connectHint')}{' '}
                <Link href="/plugins" className="font-medium text-info hover:underline">
                    {t('connectHintLink')}
                </Link>
            </p>

            <form className="mb-5 flex flex-col gap-2 @lg/main:flex-row @lg/main:items-end">
                <div className="min-w-40">
                    <span className="mb-1 block text-xs text-text-secondary dark:text-text-secondary-dark">
                        {t('filterBar.source')}
                    </span>
                    <input type="hidden" name="source" value={sourceFilter} />
                    <Select
                        value={sourceFilter}
                        onValueChange={setSourceFilter}
                        placeholder={t('filterBar.anySource')}
                        size="xs"
                        data-testid="meetings-source-filter"
                        iconMap={SOURCE_FILTER_ICONS}
                    >
                        <option value="" data-icon="any">
                            {t('filterBar.anySource')}
                        </option>
                        {MEETING_SOURCES.map((source) => (
                            <option key={source} value={source} data-icon={source}>
                                {t(`sources.${source}`)}
                            </option>
                        ))}
                    </Select>
                </div>

                {works.length > 0 ? (
                    <div className="min-w-40">
                        <span className="mb-1 block text-xs text-text-secondary dark:text-text-secondary-dark">
                            {t('filterBar.work')}
                        </span>
                        <input type="hidden" name="workId" value={workFilter} />
                        <Select
                            value={workFilter}
                            onValueChange={setWorkFilter}
                            placeholder={t('filterBar.anyWork')}
                            size="xs"
                            data-testid="meetings-work-filter"
                        >
                            <option value="">{t('filterBar.anyWork')}</option>
                            {works.map((work) => (
                                <option key={work.id} value={work.id}>
                                    {work.name}
                                </option>
                            ))}
                        </Select>
                    </div>
                ) : null}

                <div className="flex items-center gap-2">
                    <Button type="submit" size="sm">
                        {t('filterBar.apply')}
                    </Button>
                    <Button href="/meetings" size="sm" variant="ghost">
                        {t('filterBar.reset')}
                    </Button>
                </div>
            </form>

            {loadError ? (
                <div
                    role="alert"
                    data-testid="meetings-load-error"
                    className="mb-5 rounded-lg border border-danger/30 bg-danger/5 p-4"
                >
                    <p className="text-sm font-medium text-danger">{t('loadError.title')}</p>
                    <p className="mt-1 text-xs text-text-muted dark:text-text-muted-dark">
                        {loadError}
                    </p>
                </div>
            ) : null}

            {!loadError ? (
                meetings.length === 0 ? (
                    <div
                        data-testid="meetings-empty"
                        className="rounded-lg border border-dashed border-border/70 bg-surface/40 p-8 text-center dark:border-border-dark/70 dark:bg-surface-dark/30"
                    >
                        <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-lg border border-info/20 bg-info/10">
                            <Video className="h-4 w-4 text-info" />
                        </div>
                        <p className="text-sm font-medium text-text dark:text-text-dark">
                            {t('empty.title')}
                        </p>
                        <p className="mx-auto mt-1 max-w-2xl text-xs text-text-muted dark:text-text-muted-dark">
                            {t('empty.subtitle')}
                        </p>
                        <div className="mt-4">
                            <Button href="/meetings/new" size="sm">
                                <Plus className="h-4 w-4" />
                                <span className="font-medium">{t('newMeeting')}</span>
                            </Button>
                        </div>
                    </div>
                ) : (
                    <div
                        data-testid="meetings-grid"
                        className="grid grid-cols-1 gap-4 @lg/main:grid-cols-2 @3xl/main:grid-cols-3"
                    >
                        {meetings.map((meeting) => (
                            <MeetingCard key={meeting.id} meeting={meeting} />
                        ))}
                    </div>
                )
            ) : null}

            {!loadError && pagination && (pagination.hasPrevious || pagination.hasNext) ? (
                <nav className="mt-5 flex items-center justify-between gap-3 text-xs text-text-muted dark:text-text-muted-dark">
                    {meetings.length > 0 ? (
                        <span>
                            {t('pagination.showing', {
                                from: pagination.offset + 1,
                                to: pagination.offset + meetings.length,
                            })}
                        </span>
                    ) : (
                        <span>{t('pagination.noResults')}</span>
                    )}
                    <div className="flex items-center gap-2">
                        {pagination.hasPrevious ? (
                            <Link
                                href={pagination.previousHref}
                                className="rounded-md border border-border/60 px-3 py-1.5 text-text hover:bg-surface-secondary dark:border-border-dark/60 dark:text-text-dark dark:hover:bg-surface-secondary-dark"
                            >
                                {t('pagination.previous')}
                            </Link>
                        ) : null}
                        {pagination.hasNext ? (
                            <Link
                                href={pagination.nextHref}
                                className="rounded-md border border-border/60 px-3 py-1.5 text-text hover:bg-surface-secondary dark:border-border-dark/60 dark:text-text-dark dark:hover:bg-surface-secondary-dark"
                            >
                                {t('pagination.next')}
                            </Link>
                        ) : null}
                    </div>
                </nav>
            ) : null}
        </div>
    );
}
