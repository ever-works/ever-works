'use client';

import Link from 'next/link';
import { cn } from '@/lib/utils/cn';
import { ROUTES } from '@/lib/constants';
import { useTranslations } from 'next-intl';
import { usePathname } from '@/i18n/navigation';
import { useDirectoryDetail, useDirectoryPermissions } from '../DirectoryDetailContext';
import { Zap, CalendarClock, History, GitCompareArrows } from 'lucide-react';

interface GeneratorSubTabsProps {
    directoryId: string;
}

export function GeneratorSubTabs({ directoryId }: GeneratorSubTabsProps) {
    const t = useTranslations('dashboard.directoryDetail.generator.tabs');
    const pathname = usePathname();
    const { config } = useDirectoryDetail();
    const permissions = useDirectoryPermissions();

    const generatorBase = ROUTES.DASHBOARD_DIRECTORY_GENERATOR(directoryId);

    const tabs = [
        {
            name: t('generate'),
            href: generatorBase,
            icon: Zap,
            isActive: pathname.endsWith('/generator') || pathname.endsWith(`/generator/`),
        },
        {
            name: t('schedule'),
            href: ROUTES.DASHBOARD_DIRECTORY_SCHEDULE(directoryId),
            icon: CalendarClock,
            visible: Boolean(config) && permissions.canManageSchedule,
            isActive: pathname.includes('/generator/schedule'),
        },
        {
            name: t('history'),
            href: ROUTES.DASHBOARD_DIRECTORY_HISTORY(directoryId),
            icon: History,
            isActive: pathname.includes('/generator/history'),
        },
        {
            name: t('comparisons'),
            href: ROUTES.DASHBOARD_DIRECTORY_COMPARISONS(directoryId),
            icon: GitCompareArrows,
            visible: permissions.canEdit,
            isActive: pathname.includes('/generator/comparisons'),
        },
    ].filter((tab) => tab.visible !== false);

    return (
        <div className="mb-6 border-b border-border dark:border-border-dark">
            <nav className="-mb-px flex space-x-6" aria-label="Generator tabs">
                {tabs.map((tab) => {
                    const Icon = tab.icon;
                    return (
                        <Link
                            key={tab.name}
                            href={tab.href}
                            className={cn(
                                'flex items-center gap-2 whitespace-nowrap border-b-2 py-3 px-1 text-sm font-medium transition-colors',
                                tab.isActive
                                    ? 'border-primary text-primary dark:border-gray-200 dark:text-gray-200'
                                    : 'border-transparent text-text-secondary dark:text-text-secondary-dark hover:border-border dark:hover:border-border-dark hover:text-text dark:hover:text-text-dark',
                            )}
                        >
                            <Icon className="w-4 h-4" />
                            {tab.name}
                        </Link>
                    );
                })}
            </nav>
        </div>
    );
}
