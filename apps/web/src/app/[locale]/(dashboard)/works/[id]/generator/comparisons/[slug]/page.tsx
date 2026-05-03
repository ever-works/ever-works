import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { workAPI } from '@/lib/api';
import { ComparisonDetailClient } from '@/components/works/detail/comparisons/ComparisonDetailClient';

export async function generateMetadata({
    params,
}: {
    params: Promise<{ id: string; slug: string }>;
}): Promise<Metadata> {
    const { id, slug } = await params;
    const t = await getTranslations('metadata.pages');

    try {
        const result = await workAPI.getComparison(id, slug);
        return { title: result.comparison.title };
    } catch {
        return { title: t('comparisons') };
    }
}

type Params = { params: Promise<{ id: string; slug: string }> };

export default async function ComparisonDetailPage({ params }: Params) {
    const { id, slug } = await params;
    let result;

    try {
        result = await workAPI.getComparison(id, slug);
    } catch {
        notFound();
    }

    return (
        <ComparisonDetailClient
            workId={id}
            comparison={result.comparison}
            markdown={result.markdown}
            extendedAnalysisMarkdown={result.extendedAnalysisMarkdown}
        />
    );
}
