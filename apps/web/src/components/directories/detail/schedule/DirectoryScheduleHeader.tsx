'use client';

import { useTranslations } from 'next-intl';
import { useDirectoryDetail } from '../DirectoryDetailContext';

export function DirectoryScheduleHeader() {
    const { directory } = useDirectoryDetail();
    const pageT = useTranslations('dashboard.directoryDetail.schedule.page');

    return (
        <header className="rounded-2xl border border-card-border dark:border-card-border-dark bg-card dark:bg-card-dark p-6 shadow-sm space-y-2">
            <p className="text-2xl font-semibold text-text dark:text-text-dark">{pageT('title')}</p>
            <p className="text-sm text-text-secondary dark:text-text-secondary-dark max-w-2xl">
                {pageT('subtitle', {
                    name: directory.name ?? pageT('fallbackName'),
                })}
            </p>
        </header>
    );
}
