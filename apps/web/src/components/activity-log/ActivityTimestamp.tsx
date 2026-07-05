'use client';

import { useLocale } from 'next-intl';
import { formatDistanceToNow } from 'date-fns';
import { useMounted } from '@/lib/hooks/use-mounted';

const dateTimeFormatterCache = new Map<string, Intl.DateTimeFormat>();
const dateFormatterCache = new Map<string, Intl.DateTimeFormat>();
const timeFormatterCache = new Map<string, Intl.DateTimeFormat>();

function formatActivityDateTime(date: Date, locale: string) {
    if (!dateTimeFormatterCache.has(locale)) {
        dateTimeFormatterCache.set(
            locale,
            new Intl.DateTimeFormat(locale, {
                dateStyle: 'medium',
                timeStyle: 'short',
            }),
        );
    }

    return dateTimeFormatterCache.get(locale)!.format(date);
}

function formatActivityDate(date: Date, locale: string) {
    if (!dateFormatterCache.has(locale)) {
        dateFormatterCache.set(
            locale,
            new Intl.DateTimeFormat(locale, {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
            }),
        );
    }

    return dateFormatterCache.get(locale)!.format(date);
}

function formatActivityTime(date: Date, locale: string) {
    if (!timeFormatterCache.has(locale)) {
        timeFormatterCache.set(
            locale,
            new Intl.DateTimeFormat(locale, {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
            }),
        );
    }

    return timeFormatterCache.get(locale)!.format(date);
}

export function ActivityTimestamp({
    value,
    variant = 'absolute',
    className,
}: {
    value: string;
    variant?: 'absolute' | 'relative' | 'stacked';
    className?: string;
}) {
    const locale = useLocale();
    const mounted = useMounted();

    const date = new Date(value);
    if (!mounted || Number.isNaN(date.getTime())) {
        return <time dateTime={value} className={className} />;
    }

    const absoluteValue = formatActivityDateTime(date, locale);
    const dateValue = formatActivityDate(date, locale);
    const timeValue = formatActivityTime(date, locale);

    return (
        <time
            dateTime={value}
            title={variant === 'relative' ? absoluteValue : undefined}
            className={className}
        >
            {variant === 'relative' ? (
                formatDistanceToNow(date, { addSuffix: true })
            ) : variant === 'stacked' ? (
                <span className="inline-flex flex-col leading-4 whitespace-nowrap">
                    <span>{dateValue}</span>
                    <span>{timeValue}</span>
                </span>
            ) : (
                absoluteValue
            )}
        </time>
    );
}
