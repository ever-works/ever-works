import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { directoryAPI } from '@/lib/api';
import { ComparisonDetailClient } from '@/components/directories/detail/comparisons/ComparisonDetailClient';

export async function generateMetadata({
    params,
}: {
    params: Promise<{ id: string; slug: string }>;
}): Promise<Metadata> {
    const { id, slug } = await params;

    try {
        const result = await directoryAPI.getComparison(id, slug);
        return { title: result.comparison.title };
    } catch {
        return { title: 'Comparison' };
    }
}

type Params = { params: Promise<{ id: string; slug: string }> };

export default async function ComparisonDetailPage({ params }: Params) {
    const { id, slug } = await params;

    try {
        const result = await directoryAPI.getComparison(id, slug);
        return (
            <ComparisonDetailClient
                directoryId={id}
                comparison={result.comparison}
                markdown={result.markdown}
                extendedAnalysisMarkdown={result.extendedAnalysisMarkdown}
            />
        );
    } catch {
        notFound();
    }
}
