'use client';

import { useMounted } from '@/lib/hooks/use-mounted';
import { useLocale } from 'next-intl';

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatDate(value: string | undefined | null, locale: string) {
    if (!value) return '—';
    if (!formatterCache.has(locale)) {
        formatterCache.set(
            locale,
            new Intl.DateTimeFormat(locale, {
                dateStyle: 'medium',
                timeStyle: 'short',
            }),
        );
    }

    const formatter = formatterCache.get(locale)!;
    return formatter.format(new Date(value));
}

export function ShowDateTime({
    value,
    default: defaultValue,
    customFormatter,
}: {
    value?: string | null;
    default?: React.ReactNode | string;
    customFormatter?: (date: string, locale: string) => string;
}) {
    const locale = useLocale();
    const mounted = useMounted();

    if (!mounted) {
        return null;
    }

    const formatDateFn = customFormatter || formatDate;

    return <>{value ? formatDateFn(value, locale) : defaultValue}</>;
}
