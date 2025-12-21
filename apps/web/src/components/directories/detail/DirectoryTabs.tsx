'use client';

import Link from 'next/link';
import { cn } from '@/lib/utils/cn';
import { ROUTES } from '@/lib/constants';
import { useTranslations } from 'next-intl';
import { usePathname } from '@/i18n/navigation';
import { Directory } from '@/lib/api';
import { useDirectoryDetail, useDirectoryPermissions } from './DirectoryDetailContext';

interface DirectoryTabsProps {
    directory: Directory;
}

export function DirectoryTabs({ directory }: DirectoryTabsProps) {
    const t = useTranslations('dashboard.directoryDetail.tabs');
    const pathname = usePathname();
    const { config } = useDirectoryDetail();
    const permissions = useDirectoryPermissions();

    const tabs = [
        {
            name: t('overview'),
            href: ROUTES.DASHBOARD_DIRECTORY(directory.id),
            icon: (
                <svg
                    className="w-4 h-4 shrink-0"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                >
                    <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
                    />
                </svg>
            ),
            isActive: pathname.endsWith(`/directories/${directory.id}`),
        },
        {
            name: t('items'),
            href: `${ROUTES.DASHBOARD_DIRECTORY(directory.id)}/items`,
            icon: (
                <svg
                    className="w-4 h-4 shrink-0"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                >
                    <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M4 6h16M4 10h16M4 14h16M4 18h16"
                    />
                </svg>
            ),
            isActive: pathname.includes('/items'),
        },
        {
            name: t('generator'),
            href: `${ROUTES.DASHBOARD_DIRECTORY(directory.id)}/generator`,
            visible: permissions.canGenerate,
            icon: (
                <svg
                    className="w-4 h-4 shrink-0"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                >
                    <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M13 10V3L4 14h7v7l9-11h-7z"
                    />
                </svg>
            ),
            isActive: pathname.includes('/generator'),
        },
        {
            name: t('schedule'),
            href: `${ROUTES.DASHBOARD_DIRECTORY(directory.id)}/schedule`,
            visible: Boolean(config) && permissions.canManageSchedule,
            icon: (
                <svg
                    className="w-4 h-4 shrink-0"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                >
                    <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M8 7V5a2 2 0 114 0v2m0 0V5a2 2 0 114 0v2m-8 0h8M5 11h14M7 15h2m4 0h2m-8 4h2m4 0h2M6 5h0a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V7a2 2 0 00-2-2h0"
                    />
                </svg>
            ),
            isActive: pathname.includes('/schedule'),
        },
        {
            name: t('history'),
            href: `${ROUTES.DASHBOARD_DIRECTORY(directory.id)}/history`,
            icon: (
                <svg
                    className="w-4 h-4 shrink-0"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                >
                    <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                    />
                </svg>
            ),
            isActive: pathname.includes('/history'),
        },
        {
            name: t('deploy'),
            href: `${ROUTES.DASHBOARD_DIRECTORY(directory.id)}/deploy`,
            visible: Boolean(config) && permissions.canDeploy,
            icon: (
                <svg
                    className="w-4 h-4 shrink-0"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                >
                    <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M7 16l-4-4m0 0l4-4m-4 4h18M17 8l4 4m0 0l-4 4m4-4H3"
                    />
                </svg>
            ),
            isActive: pathname.includes('/deploy'),
        },
        {
            name: t('members'),
            href: `${ROUTES.DASHBOARD_DIRECTORY(directory.id)}/members`,
            // visible: permissions.canManageMembers,
            visible: false,
            icon: (
                <svg
                    className="w-4 h-4 shrink-0"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                >
                    <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z"
                    />
                </svg>
            ),
            isActive: pathname.includes('/members'),
        },
        {
            name: t('settings'),
            href: `${ROUTES.DASHBOARD_DIRECTORY(directory.id)}/settings`,
            visible: permissions.canAccessSettings,
            icon: (
                <svg
                    className="w-4 h-4 shrink-0"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                >
                    <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
                    />
                    <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                    />
                </svg>
            ),
            isActive: pathname.includes('/settings'),
        },
    ].filter((tab) => tab.visible !== false);

    return (
        <nav className="border-b border-border dark:border-border-dark">
            <div className="-mb-px flex overflow-x-auto scrollbar-none">
                <div className="flex min-w-full sm:min-w-0 gap-1 sm:gap-2 md:gap-6 lg:gap-8 px-1">
                    {tabs.map((tab) => (
                        <Link
                            key={tab.name}
                            href={tab.href}
                            className={cn(
                                'flex items-center gap-1.5 sm:gap-2 py-3 sm:py-4 px-3 md:px-1 border-b-2 font-medium text-sm whitespace-nowrap transition-colors',
                                tab.isActive
                                    ? 'border-primary text-primary'
                                    : 'border-transparent text-text-secondary dark:text-text-secondary-dark hover:text-text dark:hover:text-text-dark hover:border-border-hover dark:hover:border-border-hover-dark',
                            )}
                        >
                            {tab.icon}
                            {tab.name}
                        </Link>
                    ))}
                </div>
            </div>
        </nav>
    );
}
