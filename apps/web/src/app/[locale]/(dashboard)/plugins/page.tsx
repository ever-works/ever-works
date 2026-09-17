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

/** Longest `?q=` accepted as an initial search; anything longer is ignored. */
const MAX_INITIAL_QUERY = 64;

export default async function PluginsPage({
    searchParams,
}: {
    searchParams?: Promise<{ q?: string | string[] }>;
}) {
    const t = await getTranslations('dashboard.plugins');
    const query = (await searchParams)?.q;
    const rawQuery = (Array.isArray(query) ? query[0] : query)?.trim() ?? '';
    const initialQuery = rawQuery.length <= MAX_INITIAL_QUERY ? rawQuery : '';
    const pluginsData = await pluginsAPI.list().catch(() => ({
        plugins: [],
        categories: [],
        capabilities: [],
    }));

    return (
        <div className="w-full overflow-auto">
            <PageHeader icon={Puzzle} title={t('title')} subtitle={t('subtitle')} tone="info" />

            <PluginsList
                plugins={pluginsData.plugins}
                categories={pluginsData.categories}
                capabilities={pluginsData.capabilities}
                initialQuery={initialQuery}
            />
        </div>
    );
}
