'use client';

import { useTranslations } from 'next-intl';
import { useWorkDetail } from '../WorkDetailContext';

export function WorkScheduleHeader() {
    const { work } = useWorkDetail();
    const pageT = useTranslations('dashboard.workDetail.schedule.page');

    return (
        <header className="rounded-xl border border-card-border dark:border-border-secondary-dark bg-card dark:bg-card-primary-dark/10 p-6 space-y-2">
            <p className="text-lg font-semibold text-text dark:text-text-dark">{pageT('title')}</p>
            <p className="text-sm text-text-secondary dark:text-text-secondary-dark max-w-2xl">
                {pageT('subtitle', {
                    name: work.name ?? pageT('fallbackName'),
                })}
            </p>
        </header>
    );
}
