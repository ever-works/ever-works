'use client';

import { useState, useTransition } from 'react';
import { Globe } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { setProfileTimezone } from '@/app/actions/notification-preferences';
import { cn } from '@/lib/utils/cn';

/** UTC and its alias — the two spellings the API accepts for a fixed clock. */
const FIXED_ZONES = new Set(['UTC', 'GMT']);

/**
 * The browser's IANA zone. `Intl` is always present in a real browser; the
 * guard is for the server render and for engines with a broken ICU build,
 * where the only honest fallback is the fixed clock.
 */
export function browserTimeZone(): string {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
        return 'UTC';
    }
}

interface TimeZoneSettingProps {
    /**
     * The account's stored profile time zone, or `null` when it has never been
     * set — in which case the product falls back to UTC and says so.
     */
    timezone: string | null;
}

type Mode = 'local' | 'utc';

function modeOf(timezone: string | null): Mode | null {
    if (timezone === null) return null;
    return FIXED_ZONES.has(timezone) ? 'utc' : 'local';
}

/**
 * Owner 2026-09-18 — Settings → Profile's `Time zone` control.
 *
 * The Dashboard used to carry a "Times shown in UTC." footnote because the
 * product picked the reader's zone for them and, with nothing stored, always
 * landed on UTC. The owner asked for the footnote gone and a real setting in
 * its place: this is it. Two choices, because that is the decision a person
 * actually makes — "my local time" or "UTC" — and the choice is stored as the
 * profile time zone the whole product already reads (the morning read's day
 * window, the runs ledger, quiet hours), so nothing else had to grow a second
 * notion of what time it is.
 *
 * "My local time" records the zone the browser reports AT THE MOMENT OF
 * CHOOSING. That is deliberate and stated in the copy: the stored value is a
 * zone, not a machine, so a person who moves can change it again in one click.
 */
export function TimeZoneSetting({ timezone }: TimeZoneSettingProps) {
    const t = useTranslations('dashboard.settings.profile.timeZone');
    const [stored, setStored] = useState<string | null>(timezone);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    const mode = modeOf(stored);
    const localZone = browserTimeZone();

    const choose = (next: Mode) => {
        const zone = next === 'utc' ? 'UTC' : localZone;
        if (zone === stored) return;
        setError(null);
        startTransition(async () => {
            const result = await setProfileTimezone(zone);
            if (result.success) setStored(zone);
            else setError(result.error ?? t('saveFailed'));
        });
    };

    const options: Array<{ value: Mode; label: string; hint: string | null }> = [
        // The hint earns its place on "local time" by naming the zone that will
        // actually be stored; the UTC row needs none — its label already says it.
        { value: 'local', label: t('local'), hint: localZone },
        { value: 'utc', label: t('utc'), hint: null },
    ];

    return (
        <div className="border-t border-border dark:border-border-dark pt-4">
            <p className="text-sm font-medium text-text dark:text-text-dark mb-1 flex items-center gap-2">
                <Globe aria-hidden="true" className="h-4 w-4 text-text-muted" />
                {t('title')}
            </p>
            <p className="text-xs text-text-muted dark:text-text-muted-dark mb-3">
                {t('description')}
            </p>

            <div
                role="radiogroup"
                aria-label={t('title')}
                data-testid="profile-timezone"
                className="space-y-2"
            >
                {options.map((option) => {
                    const checked = mode === option.value;
                    return (
                        <label
                            key={option.value}
                            data-testid={`profile-timezone-${option.value}`}
                            className={cn(
                                'flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-sm',
                                'border-border dark:border-border-dark',
                                checked
                                    ? 'border-primary/40 bg-primary/5'
                                    : 'hover:border-border-secondary dark:hover:border-white/20',
                                pending && 'opacity-60',
                            )}
                        >
                            <input
                                type="radio"
                                name="profile-timezone"
                                value={option.value}
                                checked={checked}
                                disabled={pending}
                                onChange={() => choose(option.value)}
                                className="h-4 w-4"
                            />
                            <span className="min-w-0 flex-1 text-text dark:text-text-dark">
                                {option.label}
                            </span>
                            {option.hint ? (
                                <span className="shrink-0 text-xs text-text-muted dark:text-text-muted-dark">
                                    {option.hint}
                                </span>
                            ) : null}
                        </label>
                    );
                })}
            </div>

            <p
                data-testid="profile-timezone-current"
                className="mt-2 text-xs text-text-muted dark:text-text-muted-dark"
            >
                {stored === null ? t('unset') : t('current', { zone: stored })}
            </p>

            {error ? (
                <p role="alert" className="mt-2 text-xs text-danger">
                    {error}
                </p>
            ) : null}
        </div>
    );
}
