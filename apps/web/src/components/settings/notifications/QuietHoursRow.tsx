'use client';

import { useId, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import type { NotificationMatrixQuietHoursDto } from '@ever-works/contracts';
import { setNotificationQuietHours } from '@/app/actions/notification-preferences';

const PRESET_START = '22:00';
const PRESET_END = '07:00';

function browserTimeZone(): string {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
        return 'UTC';
    }
}

/**
 * AW-13 — quiet hours, surfaced on the matrix over the existing quiet-hours
 * preference: shows the window, offers the 22:00 – 07:00 preset, and lets
 * the window be changed or cleared.
 *
 * While a window is set, it also offers the person's own opt-in to let every
 * urgent event through. Off by default: only the alerts that always came
 * through quiet hours do, and everything else keeps waiting until they end.
 */
export function QuietHoursRow({
    quietHours,
    onChange,
}: {
    quietHours: NotificationMatrixQuietHoursDto;
    onChange: (next: NotificationMatrixQuietHoursDto) => void;
}) {
    const t = useTranslations('notifications-v2.preferences');
    const [editing, setEditing] = useState(false);
    const [start, setStart] = useState(quietHours.start?.slice(0, 5) ?? PRESET_START);
    const [end, setEnd] = useState(quietHours.end?.slice(0, 5) ?? PRESET_END);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    const urgentThrough = quietHours.urgentBypassesQuietHours === true;
    const urgentHintId = useId();

    const save = (next: NotificationMatrixQuietHoursDto) => {
        setError(null);
        startTransition(async () => {
            const result = await setNotificationQuietHours({
                quietHoursStart: next.start,
                quietHoursEnd: next.end,
                timezone: next.timezone,
                // Only named when the person changes it; a window change keeps it.
                ...(typeof next.urgentBypassesQuietHours === 'boolean'
                    ? { urgentBypassesQuietHours: next.urgentBypassesQuietHours }
                    : {}),
            });
            if (result.success) {
                onChange({ ...quietHours, ...next });
                setEditing(false);
            } else {
                setError(t('rowState.failed'));
            }
        });
    };

    const isSet = Boolean(quietHours.start && quietHours.end);

    return (
        <div className="flex flex-wrap items-center gap-3 text-sm text-text-secondary dark:text-text-secondary-dark">
            {editing ? (
                <>
                    <label className="flex items-center gap-1">
                        {t('quietHours.start')}
                        <input
                            type="time"
                            value={start}
                            onChange={(e) => setStart(e.target.value)}
                            className="rounded border border-border px-1 py-0.5 dark:border-border-dark dark:bg-transparent"
                        />
                    </label>
                    <label className="flex items-center gap-1">
                        {t('quietHours.end')}
                        <input
                            type="time"
                            value={end}
                            onChange={(e) => setEnd(e.target.value)}
                            className="rounded border border-border px-1 py-0.5 dark:border-border-dark dark:bg-transparent"
                        />
                    </label>
                    <button
                        type="button"
                        disabled={pending || !start || !end}
                        onClick={() =>
                            save({
                                start,
                                end,
                                timezone: quietHours.timezone ?? browserTimeZone(),
                            })
                        }
                        className="font-medium text-primary disabled:opacity-50"
                    >
                        {t('quietHours.save')}
                    </button>
                    <button type="button" onClick={() => setEditing(false)} className="underline">
                        {t('quietHours.cancel')}
                    </button>
                </>
            ) : isSet ? (
                <>
                    <span>
                        {t('quietHours.set', {
                            start: quietHours.start!.slice(0, 5),
                            end: quietHours.end!.slice(0, 5),
                            timezone: quietHours.timezone ?? 'UTC',
                        })}
                    </span>
                    <button type="button" onClick={() => setEditing(true)} className="underline">
                        {t('quietHours.change')}
                    </button>
                    <button
                        type="button"
                        disabled={pending}
                        onClick={() => save({ start: null, end: null, timezone: null })}
                        className="underline"
                    >
                        {t('quietHours.clear')}
                    </button>
                    <div className="basis-full">
                        <label className="flex items-center gap-2">
                            <input
                                type="checkbox"
                                checked={urgentThrough}
                                disabled={pending}
                                aria-describedby={urgentHintId}
                                onChange={(e) =>
                                    save({
                                        start: quietHours.start,
                                        end: quietHours.end,
                                        timezone: quietHours.timezone,
                                        urgentBypassesQuietHours: e.target.checked,
                                    })
                                }
                            />
                            <span>{t('quietHours.urgentBypass')}</span>
                        </label>
                        <p
                            id={urgentHintId}
                            className="pl-6 text-xs text-text-muted dark:text-text-muted-dark"
                        >
                            {t('quietHours.urgentBypassHint')}
                        </p>
                    </div>
                </>
            ) : (
                <>
                    <span>{t('quietHours.empty')}</span>
                    <button
                        type="button"
                        disabled={pending}
                        onClick={() =>
                            save({
                                start: PRESET_START,
                                end: PRESET_END,
                                timezone: browserTimeZone(),
                            })
                        }
                        className="font-medium text-primary disabled:opacity-50"
                    >
                        {t('quietHours.preset')}
                    </button>
                </>
            )}
            {error ? <span className="text-red-600 dark:text-red-400">{error}</span> : null}
        </div>
    );
}
