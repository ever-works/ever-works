'use client';

import { usePathname } from '@/i18n/navigation';
import { cn } from '@/lib/utils/cn';
import { User, Lock, Key, AlertTriangle, HardDrive, Github } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useMemo } from 'react';
import type { SettingsMenuResponse, SettingsMenuCategory } from '@/lib/api/plugins';
import { getCategoryIcon } from '@/lib/utils/plugin-category-icons';

interface SettingsLayoutClientProps {
    children: React.ReactNode;
    settingsMenu: SettingsMenuResponse | null;
}

interface StaticTab {
    id: string;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    href: string;
}

export function SettingsLayoutClient({ children, settingsMenu }: SettingsLayoutClientProps) {
    const pathname = usePathname();
    const t = useTranslations('dashboard.settings');

    const baseSettingsPath = '/settings';

    // Static tabs that are always visible
    const staticTabs: StaticTab[] = useMemo(
        () => [
            { id: 'profile', label: t('tabs.profile'), icon: User, href: baseSettingsPath },
            {
                id: 'security',
                label: t('tabs.security'),
                icon: Lock,
                href: `${baseSettingsPath}/security`,
            },
            {
                id: 'api-keys',
                label: t('tabs.apiKeys'),
                icon: Key,
                href: `${baseSettingsPath}/api-keys`,
            },
            {
                id: 'data',
                label: t('tabs.data'),
                icon: HardDrive,
                href: `${baseSettingsPath}/data`,
            },
            {
                id: 'github-app',
                label: t('tabs.githubApp'),
                icon: Github,
                href: `${baseSettingsPath}/github-app`,
            },
        ],
        [t],
    );

    // Danger zone tab (always at bottom)
    const dangerTab: StaticTab = useMemo(
        () => ({
            id: 'danger',
            label: t('tabs.dangerZone'),
            icon: AlertTriangle,
            href: `${baseSettingsPath}/danger`,
        }),
        [t],
    );

    const isActive = (href: string) => {
        if (href === baseSettingsPath) {
            return pathname === baseSettingsPath;
        }
        return pathname === href || pathname.startsWith(href + '/');
    };

    const isCategoryActive = (category: SettingsMenuCategory) => {
        const categoryPath = `${baseSettingsPath}/plugins/${category.category}`;
        return pathname.startsWith(categoryPath);
    };

    const renderStaticTab = (tab: StaticTab) => {
        const Icon = tab.icon;
        return (
            <Link
                key={tab.id}
                href={tab.href}
                className={cn(
                    'w-full flex items-center gap-3 px-4 text-sm py-2 rounded-lg text-left transition-colors',
                    isActive(tab.href)
                        ? 'bg-surface-secondary dark:bg-surface-secondary-dark text-text dark:text-text-dark font-medium'
                        : 'text-text-muted dark:text-text-muted-dark hover:bg-surface dark:hover:bg-surface-dark hover:text-text dark:hover:text-text-dark',
                )}
            >
                <Icon className="w-4 h-4" />
                <span>{tab.label}</span>
            </Link>
        );
    };

    const renderCategoryNav = (category: SettingsMenuCategory) => {
        const Icon = getCategoryIcon(category.category);
        const categoryHref = `${baseSettingsPath}/plugins/${category.category}`;
        const hasUnconfigured = category.plugins.some((p) => p.hasRequiredSettings);

        return (
            <Link
                key={category.category}
                href={categoryHref}
                className={cn(
                    'w-full flex items-center gap-3 px-4 text-sm py-2 rounded-lg text-left transition-colors',
                    isCategoryActive(category)
                        ? 'bg-surface-secondary dark:bg-surface-secondary-dark text-text dark:text-text-dark font-medium'
                        : 'text-text-muted dark:text-text-muted-dark hover:bg-surface dark:hover:bg-surface-dark hover:text-text dark:hover:text-text-dark',
                )}
            >
                <Icon className="w-4 h-4" />
                <span className="flex-1">{category.label}</span>
                {hasUnconfigured && (
                    <span
                        className="w-2 h-2 rounded-full bg-warning"
                        title={t('plugins.requiredSettingsMissing')}
                    />
                )}
            </Link>
        );
    };

    return (
        <div className="w-full">
            <div className="mb-8">
                <h1 className="text-3xl font-bold text-text dark:text-text-dark">{t('title')}</h1>
                <p className="text-text-muted dark:text-text-muted-dark mt-2">{t('subtitle')}</p>
            </div>

            <div className="flex flex-col @3xl/main:flex-row gap-8">
                {/* Sidebar Navigation */}
                <div className="@3xl/main:w-64 flex-shrink-0">
                    <nav className="space-y-1">
                        {/* Static tabs at top */}
                        {staticTabs.map(renderStaticTab)}

                        {/* Dynamic plugin category tabs */}
                        {settingsMenu?.categories && settingsMenu.categories.length > 0 && (
                            <>
                                <div className="pt-4 pb-2 px-4">
                                    <span className="text-xs font-medium text-text-muted dark:text-text-muted-dark/70 uppercase tracking-wider">
                                        Plugins
                                    </span>
                                </div>
                                {settingsMenu.categories.map(renderCategoryNav)}
                            </>
                        )}

                        {/* Danger zone at bottom */}
                        <div className="pt-4">{renderStaticTab(dangerTab)}</div>
                    </nav>
                </div>

                {/* Content Area */}
                <div className="flex-1 rounded-lg border border-border dark:border-border-dark">
                    <div className="p-6">{children}</div>
                </div>
            </div>
        </div>
    );
}
