import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { workAPI } from '@/lib/api';
import { WorkGenerationHistoryResponse } from '@/lib/api/work';
import { WorkHistoryPageClient } from '@/components/works/detail/history/WorkHistoryPageClient';
import { notFound } from 'next/navigation';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('history') };
}

type Params = { params: Promise<{ id: string }> };

export default async function WorkHistoryPage({ params }: Params) {
    const { id } = await params;

    let history: WorkGenerationHistoryResponse | null = null;

    try {
        const response = await workAPI.getHistory(id).catch(() => null);
        if (response?.history) {
            history = {
                history: response.history,
                total: response.total,
                limit: response.limit,
                offset: response.offset,
            };
        }
    } catch (error) {
        console.error('Failed to fetch generation history:', error);
        notFound();
    }

    return <WorkHistoryPageClient workId={id} initialHistory={history} />;
}
