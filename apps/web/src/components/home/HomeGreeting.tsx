'use client';

import { useFormatter, useTranslations } from 'next-intl';
import type { HomeGlance } from '@ever-works/contracts';
import { cn } from '@/lib/utils/cn';
import { formatCount, greetingKeyForHour, localHour } from './home.shared';

interface HomeGreetingProps {
    name: string;
    /** The instant the greeting is for — the summary's `computedAt`, so server and client agree. */
    at: string;
    /** The timezone the summary computed "today" in. */
    timeZone: string;
    /** Null when the counters could not be read; the score line is then left out. */
    glance: HomeGlance | null;
    timezoneFallback: boolean;
    /** Secondary line kept from the previous Home header. */
    subtitle?: string;
}

/**
 * Home (AW-19) — the greeting, today's date and the one-line score.
 *
 * The hour and the date come from the summary's own instant and timezone,
 * never from the render clock, so the server render and the hydrated page
 * say the same thing. The score line is a single polite live region; it is
 * left out entirely when every counter is zero, and a zero counter is left
 * out of a rendered line.
 */
export function HomeGreeting({
    name,
    at,
    timeZone,
    glance,
    timezoneFallback,
    subtitle,
}: HomeGreetingProps) {
    const t = useTranslations('dashboard.home');
    const format = useFormatter();
    const instant = new Date(at);
    const valid = !Number.isNaN(instant.getTime());
    const greetingKey = greetingKeyForHour(valid ? localHour(instant, timeZone) : 12);

    let dateLabel = '';
    if (valid) {
        try {
            dateLabel = format.dateTime(instant, {
                weekday: 'long',
                day: 'numeric',
                month: 'long',
                timeZone,
            });
        } catch {
            dateLabel = format.dateTime(instant, {
                weekday: 'long',
                day: 'numeric',
                month: 'long',
            });
        }
    }

    const parts = glance
        ? [
              { key: 'needsYou', count: glance.needsYou, danger: false },
              { key: 'workingNow', count: glance.workingNow, danger: false },
              { key: 'doneToday', count: glance.doneToday, danger: false },
              { key: 'failedToday', count: glance.failedToday, danger: true },
          ].filter((part) => part.count > 0)
        : [];

    return (
        <header className="mb-6" data-testid="home-greeting">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <h1 className="text-3xl font-bold text-text dark:text-text-dark">
                    {t(`greeting.${greetingKey}`, { name })}
                </h1>
                {dateLabel ? (
                    <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                        {dateLabel}
                    </p>
                ) : null}
            </div>
            {subtitle ? (
                <p className="mt-1 text-sm text-text-secondary dark:text-text-secondary-dark">
                    {subtitle}
                </p>
            ) : null}
            {parts.length > 0 ? (
                <p
                    aria-live="polite"
                    data-testid="home-score-line"
                    className="mt-2 flex flex-wrap gap-x-2 text-sm text-text dark:text-text-dark"
                >
                    <span className="sr-only">{t('score.label')}: </span>
                    {parts.map((part, index) => (
                        <span
                            key={part.key}
                            className={cn(part.danger && 'font-medium text-danger')}
                        >
                            {index > 0 ? (
                                <span
                                    aria-hidden="true"
                                    className="mr-2 text-text-muted dark:text-text-muted-dark"
                                >
                                    ·
                                </span>
                            ) : null}
                            {t(`score.${part.key as 'needsYou'}`, {
                                count: formatCount(part.count),
                            })}
                        </span>
                    ))}
                </p>
            ) : null}
            {timezoneFallback ? (
                <p
                    data-testid="home-timezone-footnote"
                    className="mt-1 text-xs text-text-muted dark:text-text-muted-dark"
                >
                    {t('timezoneFootnote')}
                </p>
            ) : null}
        </header>
    );
}
