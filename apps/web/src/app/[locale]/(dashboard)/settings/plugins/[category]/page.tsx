import { pluginsAPI } from '@/lib/api/plugins';
import { oauthAPI, OAuthConnectionInfo } from '@/lib/api/oauth';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getCategoryLabel } from '@/lib/utils/plugin-category-icons';
import { isPluginCategory } from '@ever-works/plugin';
import { PluginSettingsInline } from '@/components/settings/PluginSettingsInline';

interface PageProps {
    params: Promise<{
        category: string;
    }>;
}

export default async function PluginCategoryPage({ params }: PageProps) {
    const { category } = await params;
    const t = await getTranslations('dashboard.settings');

    // Type-safe category validation
    if (!isPluginCategory(category)) {
        notFound();
    }

    let plugins;
    try {
        plugins = await pluginsAPI.listByCategory(category);
    } catch (error) {
        console.error('Failed to fetch plugins for category:', error);
        notFound();
    }

    if (plugins.length === 0) {
        notFound();
    }

    // Fetch OAuth connections for plugins with oauth capability
    const pluginsWithOAuth = await Promise.all(
        plugins.map(async (plugin) => {
            let oauthConnection: OAuthConnectionInfo | null = null;
            if (plugin.capabilities.includes('oauth')) {
                try {
                    oauthConnection = await oauthAPI.checkConnection(plugin.pluginId);
                } catch {
                    // OAuth check failed, leave as null
                    oauthConnection = null;
                }
            }
            return { plugin, oauthConnection };
        }),
    );

    const categoryLabel = getCategoryLabel(category);

    return (
        <div className="space-y-8">
            <div>
                <h2 className="text-xl font-semibold text-text dark:text-text-dark">
                    {categoryLabel}
                </h2>
                <p className="text-text-muted dark:text-text-muted-dark mt-1">
                    {t('plugins.configure')} {categoryLabel.toLowerCase()}
                </p>
            </div>

            <div className="space-y-8">
                {pluginsWithOAuth.map(({ plugin, oauthConnection }) => (
                    <div
                        key={plugin.pluginId}
                        className="p-6 rounded-xl bg-card dark:bg-card-dark border border-card-border dark:border-card-border-dark"
                    >
                        <PluginSettingsInline plugin={plugin} oauthConnection={oauthConnection} />
                    </div>
                ))}
            </div>
        </div>
    );
}
