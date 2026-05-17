'use client';

import Link from 'next/link';
import { cn } from '@/lib/utils/cn';
import { ROUTES } from '@/lib/constants';
import { useTranslations } from 'next-intl';
import { usePathname } from '@/i18n/navigation';
import { Work } from '@/lib/api';
import { useWorkDetail, useWorkPermissions } from './WorkDetailContext';

interface WorkTabsProps {
    work: Work;
}

export function WorkTabs({ work }: WorkTabsProps) {
    const t = useTranslations('dashboard.workDetail.tabs');
    const pathname = usePathname();
    const { config } = useWorkDetail();
    const permissions = useWorkPermissions();

    const tabs = [
        {
            name: t('overview'),
            href: ROUTES.DASHBOARD_WORK(work.id),
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
            isActive: pathname.endsWith(`/works/${work.id}`),
        },
        {
            name: t('activity'),
            href: ROUTES.DASHBOARD_WORK_ACTIVITY(work.id),
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
                        d="M3 12h3l3-9 6 18 3-9h3"
                    />
                </svg>
            ),
            isActive: pathname.includes('/activity'),
        },
        {
            name: t('items'),
            href: `${ROUTES.DASHBOARD_WORK(work.id)}/items`,
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
            href: `${ROUTES.DASHBOARD_WORK(work.id)}/generator`,
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
            name: t('plugins'),
            href: ROUTES.DASHBOARD_WORK_PLUGINS(work.id),
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
                        d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
                    />
                </svg>
            ),
            isActive: pathname.includes('/plugins'),
        },
        {
            name: t('deploy'),
            href: `${ROUTES.DASHBOARD_WORK(work.id)}/deploy`,
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
            name: t('settings'),
            href: `${ROUTES.DASHBOARD_WORK(work.id)}/settings`,
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
                <div className="flex min-w-full @sm/main:min-w-0 gap-1 @sm/main:gap-2 @2xl/main:gap-6 @3xl/main:gap-8 px-1">
                    {tabs.map((tab) => (
                        <Link
                            key={tab.name}
                            href={tab.href}
                            className={cn(
                                'flex items-center gap-1.5 @sm/main:gap-2 py-3 @sm/main:py-4 px-3 @2xl/main:px-1 border-b-2 font-medium text-sm whitespace-nowrap transition-colors',
                                tab.isActive
                                    ? 'border-primary dark:border-gray-100 dark:text-text-dark text-primary'
                                    : 'border-transparent text-text-secondary dark:text-text-secondary-dark/70 hover:text-text dark:hover:text-text-dark hover:border-border-hover dark:hover:border-border-hover-dark',
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
