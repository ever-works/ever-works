'use client';

import { useRef, useLayoutEffect, useState } from 'react';
import Link from 'next/link';
import { cn } from '@/lib/utils/cn';
import { ROUTES } from '@/lib/constants';
import { useTranslations } from 'next-intl';
import { usePathname } from '@/i18n/navigation';
import { useWorkPermissions } from '../WorkDetailContext';
import { Settings, Users, Wallet } from 'lucide-react';

interface SettingsSubTabsProps {
    workId: string;
}

export function SettingsSubTabs({ workId }: SettingsSubTabsProps) {
    const t = useTranslations('dashboard.workDetail.settings.tabs');
    const pathname = usePathname();
    const permissions = useWorkPermissions();

    const navRef = useRef<HTMLDivElement>(null);
    const [pillStyle, setPillStyle] = useState<{ left: number; width: number } | null>(null);

    const settingsBase = ROUTES.DASHBOARD_WORK_SETTINGS(workId);
    const membersHref = ROUTES.DASHBOARD_WORK_SETTINGS_MEMBERS(workId);
    const budgetsHref = ROUTES.DASHBOARD_WORK_SETTINGS_BUDGETS(workId);

    const tabs = [
        {
            name: t('general'),
            href: settingsBase,
            icon: Settings,
            isActive:
                (pathname.endsWith('/settings') || pathname.endsWith('/settings/')) &&
                !pathname.includes('/settings/members') &&
                !pathname.includes('/settings/budgets-usage'),
        },
        {
            name: t('members'),
            href: membersHref,
            icon: Users,
            visible: permissions.canManageMembers,
            isActive: pathname.includes('/settings/members'),
        },
        {
            name: 'Budgets',
            href: budgetsHref,
            icon: Wallet,
            isActive: pathname.includes('/settings/budgets-usage'),
        },
    ].filter((tab) => tab.visible !== false);

    useLayoutEffect(() => {
        const nav = navRef.current;
        if (!nav) return;
        const activeLink = nav.querySelector('[data-active="true"]') as HTMLElement | null;
        if (!activeLink) return;
        setPillStyle({ left: activeLink.offsetLeft, width: activeLink.offsetWidth });
    }, [pathname]);

    return (
        <div className="mb-6">
            <nav
                ref={navRef}
                className="relative inline-flex items-center gap-1 rounded-lg border border-border dark:border-border-dark bg-muted/40 dark:bg-muted/10 p-1"
                aria-label={t('navigationLabel')}
            >
                {pillStyle && (
                    <div
                        className="absolute top-1 bottom-1 rounded-md bg-button-primary dark:bg-button-primary-dark shadow-sm pointer-events-none transition-all duration-200 ease-in-out"
                        style={{ left: pillStyle.left, width: pillStyle.width }}
                    />
                )}
                {tabs.map((tab) => {
                    const Icon = tab.icon;
                    return (
                        <Link
                            key={tab.name}
                            href={tab.href}
                            data-active={tab.isActive}
                            className={cn(
                                'relative z-10 flex items-center text-xs gap-2 whitespace-nowrap rounded-md px-4 py-1.5 font-medium transition-colors duration-200',
                                tab.isActive
                                    ? 'text-white dark:text-button-primary-foreground-dark bg-button-primary dark:bg-button-primary-dark shadow-sm'
                                    : 'text-text-secondary dark:text-text-secondary-dark hover:text-text dark:hover:text-text-dark',
                            )}
                        >
                            <Icon className="w-4 h-4 shrink-0" />
                            {tab.name}
                        </Link>
                    );
                })}
            </nav>
        </div>
    );
}
