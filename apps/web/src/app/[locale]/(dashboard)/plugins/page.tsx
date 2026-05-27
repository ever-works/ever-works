import type { Metadata } from 'next';
import { Puzzle } from 'lucide-react';
import { pluginsAPI } from '@/lib/api/plugins';
import { PluginsList } from '@/components/plugins/PluginsList';
import { PageHeader } from '@/components/common/PageHeader';
import { getTranslations } from 'next-intl/server';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('plugins') };
}

export default async function PluginsPage() {
    const t = await getTranslations('dashboard.plugins');
    const pluginsData = await pluginsAPI.list().catch(() => ({
        plugins: [],
        categories: [],
        capabilities: [],
    }));

    return (
        <div className="w-full overflow-auto">
            <PageHeader
                icon={Puzzle}
                title={t('title')}
                subtitle={t('subtitle')}
                tone="info"
            />

            <PluginsList
                plugins={pluginsData.plugins}
                categories={pluginsData.categories}
                capabilities={pluginsData.capabilities}
            />
        </div>
    );
}
