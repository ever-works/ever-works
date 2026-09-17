'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMounted } from '@/lib/hooks/use-mounted';

type CountdownT = ReturnType<typeof useTranslations<'dashboard.schedules.countdown'>>;

/** Remaining time as the largest two units, e.g. `4h 12m` or `12m 05s`. */
export function formatRemaining(ms: number, t: CountdownT): string {
    if (ms <= 0) return t('due');
    const totalSeconds = Math.floor(ms / 1000);
    const days = Math.floor(totalSeconds / 86_400);
    const hours = Math.floor((totalSeconds % 86_400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    let value: string;
    if (days > 0) value = t('days', { days, hours });
    else if (hours > 0) value = t('hours', { hours, minutes });
    else if (minutes > 0)
        value = t('minutes', { minutes, seconds: String(seconds).padStart(2, '0') });
    else value = t('seconds', { seconds });
    return t('in', { value });
}

/**
 * A live countdown to the next fire.
 *
 * Ticks every second, measured against the SERVER clock (`serverOffsetMs` =
 * server time − browser time when the page was read), so a skewed laptop
 * clock cannot make a Schedule look overdue. The visible text is hidden from
 * assistive tech; a separate polite live region repeats it at most once a
 * minute so a screen reader is not flooded. Renders nothing until mounted,
 * so server and client HTML never disagree.
 */
export function ScheduleCountdown({
    target,
    serverOffsetMs = 0,
}: {
    target: string | null;
    serverOffsetMs?: number;
}) {
    const t = useTranslations('dashboard.schedules.countdown');
    const mounted = useMounted();
    const [browserNow, setBrowserNow] = useState(() => Date.now());

    useEffect(() => {
        if (!target) return;
        const timer = window.setInterval(() => setBrowserNow(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, [target]);

    if (!target || !mounted) return null;
    const remaining = Date.parse(target) - (browserNow + serverOffsetMs);
    const visible = formatRemaining(remaining, t);
    // Announce on the minute only.
    const spoken = formatRemaining(Math.floor(remaining / 60_000) * 60_000, t);

    return (
        <span data-testid="schedule-countdown" className="tabular-nums">
            <span aria-hidden="true">{visible}</span>
            <span className="sr-only" aria-live="polite">
                {spoken}
            </span>
        </span>
    );
}
