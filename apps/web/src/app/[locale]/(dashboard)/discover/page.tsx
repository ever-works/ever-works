import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { workProposalsAPI } from '@/lib/api/work-proposals';
import { DiscoverClient } from './discover-client';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('discover') };
}

export default async function DiscoverPage() {
    const [proposals, status] = await Promise.all([
        workProposalsAPI.list(['pending']).catch(() => []),
        workProposalsAPI.status().catch(() => ({ researching: false, canRefresh: true }) as const),
    ]);

    return (
        <DiscoverClient
            initialProposals={proposals}
            initiallyResearching={status.researching}
            initiallyCanRefresh={status.canRefresh}
        />
    );
}
