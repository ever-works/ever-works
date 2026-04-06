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
        <div className="mb-6">
            <nav
                className="inline-flex items-center gap-1 rounded-lg border border-border dark:border-border-dark bg-muted/40 dark:bg-muted/10 p-1"
                aria-label="Generator tabs"
            >
                {tabs.map((tab) => {
                    const Icon = tab.icon;
                    return (
                        <Link
                            key={tab.name}
                            href={tab.href}
                            className={cn(
                                'relative flex items-center text-xs gap-2 whitespace-nowrap rounded-md px-4 py-1.5 font-medium transition-all duration-200',
                                tab.isActive
                                    ? 'bg-card dark:bg-button-primary-dark text-button-primary-foreground-dark shadow-sm'
                                    : 'text-text-secondary dark:text-text-secondary-dark hover:text-text dark:hover:text-text-dark hover:bg-muted/60 dark:hover:bg-muted/20',
                            )}
                        >
                            <Icon
                                className={cn(
                                    'w-4 h-4 shrink-0 transition-colors duration-200',
                                    tab.isActive
                                        ? 'text-text-muted dark:text-text-muted-dark'
                                        : 'text-text-muted dark:text-text-muted-dark',
                                )}
                            />
                            {tab.name}
                        </Link>
                    );
                })}
            </nav>
        </div>
    );
}
