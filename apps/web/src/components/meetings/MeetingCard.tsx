'use client';

import { CalendarClock, ChevronRight, Users, Video } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { cn } from '@/lib/utils/cn';
import type { Meeting } from '@/lib/api/meetings';
import {
    SourceBadge,
    TranscriptBadge,
    durationMinutes,
    formatDateTime,
    formatDuration,
} from './meeting-ui';

/**
 * Meetings — read-only summary card for a single meeting in the
 * `/meetings` list grid. The whole card links to the meeting detail
 * page. Surfaces when it started (+ duration when it ended), the
 * producing surface, whether a transcript landed, the roster size, and
 * the first line of the AI summary when one exists.
 *
 * List rows deliberately carry NO transcript body (the API's list
 * projection omits it), so the card reads `hasTranscript` rather than
 * probing `transcriptText`.
 */
export function MeetingCard({ meeting }: { meeting: Meeting }) {
    const t = useTranslations('dashboard.meetingsPage.card');
    const minutes = durationMinutes(meeting.startedAt, meeting.endedAt);
    const participantCount = meeting.participants?.length ?? 0;
    const summaryLine = meeting.summary?.trim().split(/\r?\n/)[0] ?? '';

    return (
        <Link
            href={`/meetings/${meeting.id}`}
            data-testid="meeting-card"
            className={cn(
                'group relative flex min-h-[12rem] flex-col overflow-hidden rounded-lg p-4 shadow-xs',
                'bg-card dark:bg-card-primary-dark/70',
                'border border-card-border dark:border-white/9',
                'hover:border-primary-500/50 dark:hover:border-white/20',
                'transition-colors',
                'no-underline',
            )}
        >
            <div className="mb-3 flex min-w-0 items-start gap-3 pr-6">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-info/20 bg-info/10">
                    <Video strokeWidth={1.4} className="h-4 w-4 text-info" />
                </div>
                <div className="min-w-0 flex-1">
                    <h3 className="line-clamp-2 text-sm font-semibold leading-snug text-text dark:text-text-dark">
                        {meeting.title}
                    </h3>
                    {summaryLine ? (
                        <p className="mt-1 line-clamp-2 text-xs text-text-muted dark:text-text-muted-dark">
                            {summaryLine}
                        </p>
                    ) : null}
                </div>
                <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-text-muted opacity-0 transition-opacity group-hover:opacity-100 dark:text-text-muted-dark" />
            </div>

            <div className="mb-3 flex items-center gap-2 rounded-lg border border-border/50 bg-surface/40 px-3 py-2 dark:border-border-dark/50 dark:bg-surface-dark/30">
                <CalendarClock className="h-3.5 w-3.5 shrink-0 text-text-muted dark:text-text-muted-dark" />
                <time
                    dateTime={meeting.startedAt}
                    suppressHydrationWarning
                    className="truncate text-xs font-medium text-text dark:text-text-dark"
                >
                    {formatDateTime(meeting.startedAt)}
                </time>
            </div>

            <div className="mb-3 flex flex-wrap items-center gap-2">
                <SourceBadge source={meeting.source} />
                <TranscriptBadge hasTranscript={meeting.hasTranscript} />
            </div>

            <div className="mt-auto space-y-0.5 text-xs text-text-muted dark:text-text-muted-dark">
                <div className="flex items-center gap-1.5">
                    <Users className="h-3 w-3 shrink-0" />
                    <span>{t('participants', { count: participantCount })}</span>
                </div>
                <div>
                    <span className="font-medium text-text-secondary dark:text-text-secondary-dark">
                        {t('durationPrefix')}
                    </span>{' '}
                    {minutes !== null ? formatDuration(minutes) : t('durationUnknown')}
                </div>
            </div>
        </Link>
    );
}
