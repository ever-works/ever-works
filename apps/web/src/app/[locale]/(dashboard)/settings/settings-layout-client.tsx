'use client';

import { usePathname } from '@/i18n/navigation';
import { cn } from '@/lib/utils/cn';
import { User, Lock, AlertTriangle, ChevronRight, ChevronDown } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState, useMemo } from 'react';
import type { SettingsMenuResponse, SettingsMenuCategory } from '@/lib/api/plugins';
import { getCategoryIcon } from '@/lib/utils/plugin-category-icons';
import { PluginIcon } from '@/components/plugins/PluginIcon';

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

    // Track which categories are expanded
    const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set());

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

    const toggleCategory = (category: string) => {
        setExpandedCategories((prev) => {
            const next = new Set(prev);
            if (next.has(category)) {
                next.delete(category);
            } else {
                next.add(category);
            }
            return next;
        });
    };

    // Auto-expand active category
    const activeCategory = useMemo(() => {
        if (!settingsMenu?.categories) return null;
        return settingsMenu.categories.find((cat) => isCategoryActive(cat));
    }, [pathname, settingsMenu]);

    // Ensure active category is expanded
    useMemo(() => {
        if (activeCategory && !expandedCategories.has(activeCategory.category)) {
            setExpandedCategories((prev) => new Set([...prev, activeCategory.category]));
        }
    }, [activeCategory]);

    const renderStaticTab = (tab: StaticTab) => {
        const Icon = tab.icon;
        return (
            <Link
                key={tab.id}
                href={tab.href}
                className={cn(
                    'w-full flex items-center gap-3 px-4 py-3 rounded-lg text-left transition-colors',
                    isActive(tab.href)
                        ? 'bg-surface-secondary dark:bg-surface-secondary-dark text-text dark:text-text-dark font-medium'
                        : 'text-text-muted dark:text-text-muted-dark hover:bg-surface dark:hover:bg-surface-dark hover:text-text dark:hover:text-text-dark',
                )}
            >
                <Icon className="w-5 h-5" />
                <span>{tab.label}</span>
            </Link>
        );
    };

    const renderCategoryNav = (category: SettingsMenuCategory) => {
        const Icon = getCategoryIcon(category.category);
        const isExpanded = expandedCategories.has(category.category) || isCategoryActive(category);
        const hasMultiplePlugins = category.plugins.length > 1;
        const singlePlugin = category.plugins.length === 1 ? category.plugins[0] : null;

        // For categories with a single plugin, link directly to plugin settings
        if (singlePlugin) {
            const pluginHref = `${baseSettingsPath}/plugins/${category.category}`;
            return (
                <Link
                    key={category.category}
                    href={pluginHref}
                    className={cn(
                        'w-full flex items-center gap-3 px-4 py-3 rounded-lg text-left transition-colors',
                        isCategoryActive(category)
                            ? 'bg-surface-secondary dark:bg-surface-secondary-dark text-text dark:text-text-dark font-medium'
                            : 'text-text-muted dark:text-text-muted-dark hover:bg-surface dark:hover:bg-surface-dark hover:text-text dark:hover:text-text-dark',
                    )}
                >
                    <Icon className="w-5 h-5" />
                    <span className="flex-1">{category.label}</span>
                    {singlePlugin.hasRequiredSettings && (
                        <span
                            className="w-2 h-2 rounded-full bg-warning"
                            title={t('plugins.requiredSettingsMissing')}
                        />
                    )}
                </Link>
            );
        }

        // For categories with multiple plugins, show expandable list
        return (
            <div key={category.category}>
                <button
                    onClick={() => toggleCategory(category.category)}
                    className={cn(
                        'w-full flex items-center gap-3 px-4 py-3 rounded-lg text-left transition-colors',
                        isCategoryActive(category)
                            ? 'bg-surface-secondary dark:bg-surface-secondary-dark text-text dark:text-text-dark font-medium'
                            : 'text-text-muted dark:text-text-muted-dark hover:bg-surface dark:hover:bg-surface-dark hover:text-text dark:hover:text-text-dark',
                    )}
                >
                    <Icon className="w-5 h-5" />
                    <span className="flex-1">{category.label}</span>
                    {isExpanded ? (
                        <ChevronDown className="w-4 h-4" />
                    ) : (
                        <ChevronRight className="w-4 h-4" />
                    )}
                </button>

                {isExpanded && (
                    <div className="ml-4 pl-4 border-l border-border dark:border-border-dark mt-1 space-y-1">
                        {category.plugins.map((plugin) => {
                            const pluginHref = `${baseSettingsPath}/plugins/${category.category}`;
                            return (
                                <Link
                                    key={plugin.pluginId}
                                    href={pluginHref}
                                    className={cn(
                                        'w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left transition-colors text-sm',
                                        isCategoryActive(category)
                                            ? 'bg-surface-secondary dark:bg-surface-secondary-dark text-text dark:text-text-dark font-medium'
                                            : 'text-text-muted dark:text-text-muted-dark hover:bg-surface dark:hover:bg-surface-dark hover:text-text dark:hover:text-text-dark',
                                    )}
                                >
                                    <PluginIcon
                                        icon={plugin.icon}
                                        name={plugin.name}
                                        size={20}
                                        className="flex-shrink-0"
                                    />
                                    <span className="flex-1 truncate">{plugin.name}</span>
                                    {plugin.hasRequiredSettings && (
                                        <span
                                            className="w-2 h-2 rounded-full bg-warning flex-shrink-0"
                                            title={t('plugins.requiredSettingsMissing')}
                                        />
                                    )}
                                </Link>
                            );
                        })}
                    </div>
                )}
            </div>
        );
    };

    return (
        <div className="w-full">
            <div className="mb-8">
                <h1 className="text-3xl font-bold text-text dark:text-text-dark">{t('title')}</h1>
                <p className="text-text-muted dark:text-text-muted-dark mt-2">{t('subtitle')}</p>
            </div>

            <div className="flex flex-col lg:flex-row gap-8">
                {/* Sidebar Navigation */}
                <div className="lg:w-64 flex-shrink-0">
                    <nav className="space-y-1">
                        {/* Static tabs at top */}
                        {staticTabs.map(renderStaticTab)}

                        {/* Dynamic plugin category tabs */}
                        {settingsMenu?.categories && settingsMenu.categories.length > 0 && (
                            <>
                                <div className="pt-4 pb-2 px-4">
                                    <span className="text-xs font-medium text-text-muted dark:text-text-muted-dark uppercase tracking-wider">
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
