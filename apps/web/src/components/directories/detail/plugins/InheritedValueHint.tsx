'use client';

import { useTranslations } from 'next-intl';

interface InheritedValueHintProps {
    value: unknown;
    isSecret: boolean;
}

/**
 * Shows the user-level inherited value below a directory-scoped setting field.
 * Secrets are always masked; other values are shown as-is.
 */
export function InheritedValueHint({ value, isSecret }: InheritedValueHintProps) {
    const t = useTranslations('dashboard.directoryPlugins');

    if (value === undefined || value === null || value === '') {
        return null;
    }

    const display = isSecret ? t('inheritedSecret') : t('inheritedFrom', { value: String(value) });

    return (
        <p className="text-xs text-text-muted dark:text-text-muted-dark mt-0.5 italic">{display}</p>
    );
}
