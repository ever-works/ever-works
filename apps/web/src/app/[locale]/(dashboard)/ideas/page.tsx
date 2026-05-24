import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { workProposalsAPI, type WorkProposal } from '@/lib/api/work-proposals';
import { IdeasPageClient } from '@/components/ideas/IdeasPageClient';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('dashboard.ideasPage');
    return { title: t('title') };
}

/**
 * Phase 5 PR N — `/ideas` dedicated catalog page. Lists every
 * Idea the user has across the four "actionable" statuses
 * (PENDING / QUEUED / BUILDING / FAILED) by default, with
 * client-side toggles to also surface ACCEPTED + DISMISSED rows.
 *
 * Server-side fetch hits a SINGLE list call with all six statuses
 * so the client can pivot filters without re-rounding to the API.
 * Defensive `.catch(() => [])` so a flaky API doesn't 500 the
 * page — the empty-state UI absorbs the failure gracefully.
 */
export default async function IdeasPage() {
    const allIdeas: WorkProposal[] = await workProposalsAPI
        .list(['pending', 'queued', 'building', 'failed', 'accepted', 'dismissed'])
        .catch(() => []);

    return <IdeasPageClient initialIdeas={allIdeas} />;
}
