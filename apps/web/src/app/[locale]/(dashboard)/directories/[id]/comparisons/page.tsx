import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { directoryAPI } from '@/lib/api';
import type { ComparisonData } from '@/lib/api/directory';
import { ComparisonsPageClient } from '@/components/directories/detail/comparisons/ComparisonsPageClient';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('comparisons') };
}

type Params = { params: Promise<{ id: string }> };

export default async function DirectoryComparisonsPage({ params }: Params) {
    const { id } = await params;

    let comparisons: ComparisonData[] = [];
    let items: Array<{ slug: string; name: string; category: string | string[] }> = [];

    try {
        const [comparisonsRes, itemsRes] = await Promise.all([
            directoryAPI.getComparisons(id).catch(() => []),
            directoryAPI.getItems(id).catch(() => null),
        ]);

        comparisons = comparisonsRes ?? [];

        if (itemsRes?.items) {
            items = itemsRes.items.map((item) => ({
                slug: item.slug ?? '',
                name: item.name,
                category: item.category,
            }));
        }
    } catch (error) {
        console.error('Failed to fetch comparisons:', error);
    }

    return (
        <ComparisonsPageClient directoryId={id} initialComparisons={comparisons} items={items} />
    );
}
