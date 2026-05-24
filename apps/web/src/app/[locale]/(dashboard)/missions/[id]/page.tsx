import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { missionsAPI } from '@/lib/api/missions';
import { workProposalsAPI } from '@/lib/api/work-proposals';
import { MissionDetailClient } from '@/components/missions';

/**
 * Phase 6 PR R — `/missions/[id]` detail page.
 *
 * Server-fetches the Mission + its Ideas (filtered by missionId
 * via the PR R extension to the work-proposals list endpoint).
 * Mission-fetch failures or unknown ids trigger Next.js's
 * notFound() so the user sees the standard 404 surface instead
 * of a half-rendered detail page.
 */
type Params = Promise<{ id: string; locale: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
    const { id } = await params;
    const mission = await missionsAPI.get(id);
    if (!mission) {
        const tPage = await getTranslations('dashboard.missionsPage');
        return { title: tPage('title') };
    }
    return { title: mission.title };
}

export default async function MissionDetailPage({ params }: { params: Params }) {
    const { id } = await params;
    const mission = await missionsAPI.get(id);
    if (!mission) {
        notFound();
    }

    // Fetch every Idea attached to this Mission across all six
    // statuses so the detail page can render the full Ideas list
    // (the client doesn't need to know about status; it just
    // renders IdeaCards in order). Defensive .catch(() => []) so
    // a flaky API doesn't 500 the page — the empty-state surface
    // absorbs the failure.
    const ideas = await workProposalsAPI
        .list(
            ['pending', 'queued', 'building', 'failed', 'accepted', 'dismissed'],
            { missionId: id },
        )
        .catch(() => []);

    return <MissionDetailClient mission={mission} ideas={ideas} />;
}
