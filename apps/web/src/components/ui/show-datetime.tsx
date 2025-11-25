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
}: {
    value?: string | null;
    default?: React.ReactNode | string;
}) {
    const locale = useLocale();
    const mounted = useMounted();

    if (!mounted) {
        return null;
    }

    return <>{value ? formatDate(value, locale) : defaultValue}</>;
}
