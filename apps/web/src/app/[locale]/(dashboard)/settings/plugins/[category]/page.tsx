import { pluginsAPI } from '@/lib/api/plugins';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { PluginIcon } from '@/components/plugins/PluginIcon';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { getCategoryLabel } from '@/lib/utils/plugin-category-icons';
import { AlertCircle, ChevronRight } from 'lucide-react';

interface PageProps {
    params: Promise<{
        category: string;
    }>;
}

export default async function PluginCategoryPage({ params }: PageProps) {
    const { category } = await params;
    const t = await getTranslations('dashboard.settings');

    let settingsMenu;
    try {
        settingsMenu = await pluginsAPI.listForSettingsMenu();
    } catch (error) {
        console.error('Failed to fetch settings menu:', error);
        notFound();
    }

    // Find the category
    const categoryData = settingsMenu.categories.find((c) => c.category === category);

    if (!categoryData) {
        notFound();
    }

    // If category has only one plugin, redirect directly to that plugin's settings
    if (categoryData.plugins.length === 1) {
        redirect(ROUTES.DASHBOARD_SETTINGS_PLUGIN(category, categoryData.plugins[0].pluginId));
    }

    const categoryLabel = getCategoryLabel(category);

    return (
        <div className="space-y-6">
            <div>
                <h2 className="text-xl font-semibold text-text dark:text-text-dark">
                    {categoryLabel}
                </h2>
                <p className="text-text-muted dark:text-text-muted-dark mt-1">
                    Configure your {categoryLabel.toLowerCase()} plugins
                </p>
            </div>

            <div className="divide-y divide-border dark:divide-border-dark">
                {categoryData.plugins.map((plugin) => (
                    <Link
                        key={plugin.pluginId}
                        href={ROUTES.DASHBOARD_SETTINGS_PLUGIN(category, plugin.pluginId)}
                        className="flex items-center gap-4 py-4 hover:bg-surface-secondary/50 dark:hover:bg-surface-secondary-dark/50 -mx-4 px-4 rounded-lg transition-colors"
                    >
                        <PluginIcon icon={plugin.icon} name={plugin.name} size={48} />

                        <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                                <span className="font-medium text-text dark:text-text-dark">
                                    {plugin.name}
                                </span>
                                {plugin.hasRequiredSettings && (
                                    <span className="inline-flex items-center gap-1 text-xs text-warning">
                                        <AlertCircle className="w-3 h-3" />
                                        {t('plugins.requiredSettingsMissing')}
                                    </span>
                                )}
                            </div>
                            <span className="text-sm text-text-muted dark:text-text-muted-dark">
                                {t('plugins.configure')}
                            </span>
                        </div>

                        <ChevronRight className="w-5 h-5 text-text-muted dark:text-text-muted-dark" />
                    </Link>
                ))}

                {categoryData.plugins.length === 0 && (
                    <div className="py-8 text-center text-text-muted dark:text-text-muted-dark">
                        {t('plugins.noPluginsInCategory')}
                    </div>
                )}
            </div>
        </div>
    );
}
