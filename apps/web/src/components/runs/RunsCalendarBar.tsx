'use client';

import { useLocale, useTranslations } from 'next-intl';
import { ChevronLeft, ChevronRight, Keyboard } from 'lucide-react';
import {
    RUN_LEDGER_GRANULARITIES,
    type RunLedgerGranularity,
    type RunLedgerWindow,
} from '@ever-works/contracts';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';

/**
 * Runs ledger (AW-09) — the calendar controls: Day / Week / Month, step back
 * and forward, jump to today, the window's own label, and the timezone every
 * timestamp on the page is shown in. Controls stay live while a window is
 * loading, so a slow window never traps the viewer.
 */
export function RunsCalendarBar({
    window,
    granularity,
    onGranularityChange,
    onStep,
    onToday,
    onShowShortcuts,
}: {
    window: RunLedgerWindow;
    granularity: RunLedgerGranularity;
    onGranularityChange: (next: RunLedgerGranularity) => void;
    onStep: (direction: -1 | 1) => void;
    onToday: () => void;
    onShowShortcuts: () => void;
}) {
    const t = useTranslations('dashboard.runsPage');
    const locale = useLocale();

    return (
        <div className="space-y-2" data-testid="runs-calendar-bar">
            <div className="flex flex-wrap items-center gap-3">
                <div
                    role="group"
                    aria-label={t('granularityLabel')}
                    className="inline-flex rounded-md border border-border dark:border-border-dark overflow-hidden"
                >
                    {RUN_LEDGER_GRANULARITIES.map((option) => (
                        <button
                            key={option}
                            type="button"
                            aria-pressed={granularity === option}
                            onClick={() => onGranularityChange(option)}
                            className={cn(
                                'px-3 h-8 text-xs transition-colors',
                                granularity === option
                                    ? 'bg-primary text-white'
                                    : 'text-text-secondary dark:text-text-secondary-dark hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark',
                            )}
                            data-testid={`runs-granularity-${option}`}
                        >
                            {t(`granularity.${option}`)}
                        </button>
                    ))}
                </div>

                <div className="inline-flex items-center gap-1">
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => onStep(-1)}
                        aria-label={t('previousWindow')}
                        data-testid="runs-previous-window"
                    >
                        <ChevronLeft className="w-4 h-4" aria-hidden />
                    </Button>
                    <h2
                        className="min-w-48 text-center text-sm font-medium text-text dark:text-text-dark"
                        aria-live="polite"
                        data-testid="runs-window-label"
                    >
                        {formatWindowLabel(window, locale)}
                    </h2>
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => onStep(1)}
                        aria-label={t('nextWindow')}
                        data-testid="runs-next-window"
                    >
                        <ChevronRight className="w-4 h-4" aria-hidden />
                    </Button>
                </div>

                <Button variant="secondary" size="sm" onClick={onToday} data-testid="runs-today">
                    {t('today')}
                </Button>

                <span className="flex-1" />
                <Button
                    variant="ghost"
                    size="sm"
                    onClick={onShowShortcuts}
                    aria-label={t('shortcuts.button')}
                    data-testid="runs-shortcuts-button"
                >
                    <Keyboard className="w-4 h-4" aria-hidden />
                </Button>
            </div>
            <p className="text-[11px] text-text-muted" data-testid="runs-timezone">
                {t('timezoneNote', { timezone: window.timezone })}
            </p>
            {window.clamped && (
                <p
                    className="text-[11px] text-amber-700 dark:text-amber-300"
                    role="status"
                    data-testid="runs-clamped-notice"
                >
                    {t('clampedNotice')}
                </p>
            )}
        </div>
    );
}

/**
 * "Monday, 8 September 2026" / "7 – 13 September 2026" / "September 2026",
 * formatted from the calendar dates so the label never shifts with the
 * viewer's machine timezone.
 */
export function formatWindowLabel(window: RunLedgerWindow, locale: string): string {
    const anchor = new Date(`${window.anchorDate}T12:00:00.000Z`);
    if (window.granularity === 'month') {
        return new Intl.DateTimeFormat(locale, {
            timeZone: 'UTC',
            month: 'long',
            year: 'numeric',
        }).format(anchor);
    }
    if (window.granularity === 'week') {
        const weekday = (anchor.getUTCDay() + 6) % 7;
        const start = new Date(anchor.getTime() - weekday * 86_400_000);
        const end = new Date(start.getTime() + 6 * 86_400_000);
        return new Intl.DateTimeFormat(locale, {
            timeZone: 'UTC',
            day: 'numeric',
            month: 'long',
            year: 'numeric',
        }).formatRange(start, end);
    }
    return new Intl.DateTimeFormat(locale, {
        timeZone: 'UTC',
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
    }).format(anchor);
}
