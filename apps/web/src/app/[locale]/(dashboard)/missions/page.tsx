import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { missionsAPI, type Mission } from '@/lib/api/missions';
import { MissionsList } from '@/components/missions';

export async function generateMetadata(): Promise<Metadata> {
    // `metadata.pages.missions` will be added in Phase 10 PR LOC's
    // localization sweep; until then, source the tab title from
    // the page namespace so type-check stays clean (next-intl's
    // NamespacedMessageKeys generic rejects unknown keys at
    // compile time, so we can't reach for the future key now).
    const tPage = await getTranslations('dashboard.missionsPage');
    return { title: tPage('title') };
}

/**
 * Phase 6 PR Q — `/missions` catalog page. Server-fetches the
 * user's Mission list once on render and hands it to the client
 * component for display. Defensive `.catch(() => [])` so a flaky
 * API doesn't 500 the page — the empty-state surface absorbs
 * the failure gracefully.
 */
export default async function MissionsPage() {
    const missions: Mission[] = await missionsAPI.list().catch(() => []);
    return <MissionsList missions={missions} />;
}
