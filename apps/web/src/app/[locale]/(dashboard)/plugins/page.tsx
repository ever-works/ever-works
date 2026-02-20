import type { Metadata } from 'next';
import { pluginsAPI } from '@/lib/api/plugins';
import { PluginsList } from '@/components/plugins/PluginsList';
import { getTranslations } from 'next-intl/server';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('plugins') };
}

export default async function PluginsPage() {
    const t = await getTranslations('dashboard.plugins');
    const pluginsData = await pluginsAPI.list();

    return (
        <div className="w-full">
            <div className="mb-8">
                <h1 className="text-3xl font-bold text-text dark:text-text-dark">{t('title')}</h1>
                <p className="text-text-muted dark:text-text-muted-dark mt-2">{t('subtitle')}</p>
            </div>

            <PluginsList
                plugins={pluginsData.plugins}
                categories={pluginsData.categories}
                capabilities={pluginsData.capabilities}
            />
        </div>
    );
}
