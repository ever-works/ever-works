'use client';

import { useTranslations } from 'next-intl';

export function HistoryEmptyState() {
    const t = useTranslations('dashboard.directoryDetail.history.empty');

    return (
        <div className="rounded-lg border border-dashed border-border dark:border-border-dark p-10 text-center">
            <h3 className="text-lg font-semibold text-text dark:text-text-dark">{t('title')}</h3>
            <p className="mt-2 text-sm text-text-secondary dark:text-text-secondary-dark">
                {t('description')}
            </p>
        </div>
    );
}
