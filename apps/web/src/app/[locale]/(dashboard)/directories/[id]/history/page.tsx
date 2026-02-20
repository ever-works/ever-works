import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { directoryAPI } from '@/lib/api';
import { DirectoryGenerationHistoryResponse } from '@/lib/api/directory';
import { DirectoryHistoryPageClient } from '@/components/directories/detail/history/DirectoryHistoryPageClient';
import { notFound } from 'next/navigation';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('history') };
}

type Params = { params: Promise<{ id: string }> };

export default async function DirectoryHistoryPage({ params }: Params) {
    const { id } = await params;

    let history: DirectoryGenerationHistoryResponse | null = null;

    try {
        const response = await directoryAPI.getHistory(id).catch(() => null);
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

    return <DirectoryHistoryPageClient directoryId={id} initialHistory={history} />;
}
