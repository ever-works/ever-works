import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { workAPI } from '@/lib/api';
import type { ComparisonData } from '@/lib/api/work';
import { ComparisonsPageClient } from '@/components/works/detail/comparisons/ComparisonsPageClient';
import { getComparisonAiConfig } from '@/app/actions/dashboard/comparisons';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('comparisons') };
}

type Params = { params: Promise<{ id: string }> };

export default async function WorkComparisonsPage({ params }: Params) {
    const { id } = await params;

    let comparisons: ComparisonData[] = [];
    let items: Array<{ slug: string; name: string; category: string | string[] }> = [];
    let websiteUrl: string | null = null;

    const defaultAiConfig = {
        currentConfig: {
            provider: null as string | null,
            model: null as string | null,
            extendedAnalysis: false,
        },
        availableProviders: [] as Awaited<
            ReturnType<typeof getComparisonAiConfig>
        >['availableProviders'],
    };

    let aiConfig = defaultAiConfig;

    try {
        const [workRes, comparisonsRes, itemsRes, aiConfigRes] = await Promise.all([
            workAPI.get(id).catch(() => null),
            workAPI.getComparisons(id).catch(() => []),
            workAPI.getItems(id).catch(() => null),
            getComparisonAiConfig(id),
        ]);

        comparisons = comparisonsRes ?? [];
        aiConfig = aiConfigRes;
        websiteUrl = workRes?.work?.website ?? null;

        if (itemsRes?.items) {
            items = itemsRes.items.map((item) => ({
                slug: item.slug ?? '',
                name: item.name,
                category: item.category as string | string[],
            }));
        }
    } catch (error) {
        console.error('Failed to fetch comparisons:', error);
    }

    return (
        <ComparisonsPageClient
            workId={id}
            websiteUrl={websiteUrl}
            initialComparisons={comparisons}
            items={items}
            availableProviders={aiConfig.availableProviders}
            initialAiConfig={aiConfig.currentConfig}
        />
    );
}
