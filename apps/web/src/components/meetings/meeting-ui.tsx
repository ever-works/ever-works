'use client';

import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import type { MeetingSource } from '@/lib/api/meetings.shared';

/**
 * Meetings — shared presentational helpers for the surface (list card +
 * detail page), so the source badge, timestamps and durations render
 * identically everywhere. Mirrors `components/goals/goal-ui.tsx`.
 */

const SOURCE_STYLES: Record<string, string> = {
    zoom: 'bg-info/10 text-info border-info/20',
    'google-meet': 'bg-success/10 text-success border-success/20',
    manual: 'bg-surface-secondary dark:bg-surface-secondary-dark text-text-muted dark:text-text-muted-dark border-border/70 dark:border-border-dark/70',
    import: 'bg-accent-indigo/10 text-accent-indigo border-accent-indigo/20',
};

const UNKNOWN_SOURCE_STYLE =
    'bg-surface-secondary dark:bg-surface-secondary-dark text-text-muted dark:text-text-muted-dark border-border/70 dark:border-border-dark/70';

/** Sources the UI has a translated label for. */
const KNOWN_SOURCES: readonly string[] = ['zoom', 'google-meet', 'manual', 'import'];

/**
 * Format an ISO timestamp for display. Locale/timezone formatting
 * differs between the server and client render, so callers wrap the
 * output in an element with `suppressHydrationWarning`.
 */
export function formatDateTime(iso: string | null | undefined): string {
    if (!iso) return '—';
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return '—';
    return new Date(ms).toLocaleString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
    });
}

/**
 * Meeting length in whole minutes, or `null` when the meeting has no
 * end (still running / never closed) or the pair does not parse.
 */
export function durationMinutes(
    startedAt: string | null | undefined,
    endedAt: string | null | undefined,
): number | null {
    if (!startedAt || !endedAt) return null;
    const from = Date.parse(startedAt);
    const to = Date.parse(endedAt);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
    const minutes = Math.round((to - from) / 60_000);
    return minutes >= 0 ? minutes : null;
}

/** `95` → `1h 35m`, `35` → `35m`, `0` → `0m`. */
export function formatDuration(minutes: number | null): string {
    if (minutes === null) return '—';
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/**
 * Convert a `datetime-local` input value into an ISO instant, or `null`
 * when the field is empty / unparseable. The API validates
 * `@IsDateString()`, so the form never posts a raw local string.
 */
export function localInputToIso(value: string): string | null {
    if (!value) return null;
    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) return null;
    return new Date(ms).toISOString();
}

/**
 * Inverse of {@link localInputToIso} — an ISO instant rendered as the
 * `YYYY-MM-DDTHH:mm` string a `datetime-local` input expects, in the
 * viewer's own timezone. Returns '' for missing/unparseable input so
 * the control stays empty rather than showing `Invalid Date`.
 */
export function isoToLocalInput(iso: string | null | undefined): string {
    if (!iso) return '';
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return '';
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Producing-surface pill (Zoom / Google Meet / Manual / Import). The
 * API's source set is closed, but an unrecognized value still renders
 * verbatim in a neutral chip rather than crashing on a missing
 * translation key.
 */
export function SourceBadge({ source, className }: { source: string; className?: string }) {
    const t = useTranslations('dashboard.meetingsPage');
    const known = KNOWN_SOURCES.includes(source);
    return (
        <span
            data-testid="meeting-source-badge"
            className={cn(
                'inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium',
                SOURCE_STYLES[source] ?? UNKNOWN_SOURCE_STYLE,
                className,
            )}
        >
            {known ? t(`sources.${source as MeetingSource}`) : source}
        </span>
    );
}

/** "Transcript" / "No transcript" chip driven by `hasTranscript`. */
export function TranscriptBadge({
    hasTranscript,
    className,
}: {
    hasTranscript: boolean;
    className?: string;
}) {
    const t = useTranslations('dashboard.meetingsPage');
    return (
        <span
            data-testid="meeting-transcript-badge"
            className={cn(
                'inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium',
                hasTranscript
                    ? 'bg-success/10 text-success border-success/20'
                    : 'bg-surface-secondary dark:bg-surface-secondary-dark text-text-muted dark:text-text-muted-dark border-border/70 dark:border-border-dark/70',
                className,
            )}
        >
            {hasTranscript ? t('badges.transcript') : t('badges.noTranscript')}
        </span>
    );
}
