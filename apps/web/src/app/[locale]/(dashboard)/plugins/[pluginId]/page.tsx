import { pluginsAPI } from '@/lib/api/plugins';
import { PluginSettings } from '@/components/plugins/PluginSettings';
import { PluginReadme } from '@/components/plugins/PluginReadme';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';

interface PluginDetailPageProps {
    params: Promise<{ pluginId: string }>;
}

export default async function PluginDetailPage({ params }: PluginDetailPageProps) {
    const { pluginId } = await params;
    const t = await getTranslations('dashboard.plugins');

    try {
        const plugin = await pluginsAPI.get(pluginId);

        return (
            <div className="w-full">
                <div className="mb-8">
                    <h1 className="text-3xl font-bold text-text dark:text-text-dark">
                        {plugin.name}
                    </h1>
                    <p className="text-text-muted dark:text-text-muted-dark mt-2">
                        {plugin.description || t('noDescription')}
                    </p>
                </div>

                {plugin.readme && (
                    <div className="mb-8 rounded-xl border border-border dark:border-border-dark bg-card dark:bg-card-dark p-6">
                        <PluginReadme content={plugin.readme} />
                    </div>
                )}

                <PluginSettings plugin={plugin} />
            </div>
        );
    } catch (error) {
        notFound();
    }
}
