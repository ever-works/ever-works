'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils/cn';
import { ROUTES } from '@/lib/constants';
import { useTranslations } from 'next-intl';

interface DirectoryTabsProps {
    directoryId: string;
}

export function DirectoryTabs({ directoryId }: DirectoryTabsProps) {
    const pathname = usePathname();
    const t = useTranslations('dashboard.directoryDetail.tabs');

    const tabs = [
        {
            name: t('overview'),
            href: ROUTES.DASHBOARD_DIRECTORY(directoryId),
            icon: (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                </svg>
            ),
            isActive: pathname.endsWith(`/directories/${directoryId}`),
        },
        {
            name: t('items'),
            href: `${ROUTES.DASHBOARD_DIRECTORY(directoryId)}/items`,
            icon: (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M4 6h16M4 10h16M4 14h16M4 18h16" />
                </svg>
            ),
            isActive: pathname.includes('/items'),
        },
        {
            name: t('generator'),
            href: `${ROUTES.DASHBOARD_DIRECTORY(directoryId)}/generator`,
            icon: (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
            ),
            isActive: pathname.includes('/generator'),
        },
        {
            name: t('settings'),
            href: `${ROUTES.DASHBOARD_DIRECTORY(directoryId)}/settings`,
            icon: (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
            ),
            isActive: pathname.includes('/settings'),
        },
    ];

    return (
        <nav className="border-b border-border dark:border-border-dark">
            <div className="flex space-x-8">
                {tabs.map((tab) => (
                    <Link
                        key={tab.name}
                        href={tab.href}
                        className={cn(
                            'flex items-center gap-2 py-4 px-1 border-b-2 font-medium text-sm transition-colors',
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
        </nav>
    );
}