import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { missionsAPI, type Mission, type MissionStatus } from '@/lib/api/missions';
import { MissionsList } from '@/components/missions';
import { ROUTES } from '@/lib/constants';

export async function generateMetadata(): Promise<Metadata> {
    // `metadata.pages.missions` will be added in Phase 10 PR LOC's
    // localization sweep; until then, source the tab title from
    // the page namespace so type-check stays clean (next-intl's
    // NamespacedMessageKeys generic rejects unknown keys at
    // compile time, so we can't reach for the future key now).
    const tPage = await getTranslations('dashboard.missionsPage');
    return { title: tPage('title') };
}

const MISSION_STATUSES: MissionStatus[] = ['active', 'paused', 'completed', 'failed'];
const PAGE_SIZE = 24;

type MissionsSearchParams = Promise<{
    status?: string | string[];
    search?: string | string[];
    offset?: string | string[];
}>;

function firstParam(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
}

function buildMissionsHref(input: {
    status?: MissionStatus;
    search?: string;
    offset?: number;
}): string {
    const params = new URLSearchParams();
    if (input.status) params.set('status', input.status);
    if (input.search) params.set('search', input.search);
    if (input.offset && input.offset > 0) params.set('offset', String(input.offset));
    const qs = params.toString();
    return qs ? `${ROUTES.DASHBOARD_MISSIONS}?${qs}` : ROUTES.DASHBOARD_MISSIONS;
}

/**
 * Phase 6 PR Q — `/missions` catalog page. Server-fetches the
 * user's Mission list with bounded pagination and hands load errors
 * to the client component so a flaky API doesn't masquerade as an
 * empty Mission catalog.
 */
export default async function MissionsPage({
    searchParams,
}: {
    searchParams: MissionsSearchParams;
}) {
    const params = await searchParams;
    const statusParam = firstParam(params.status);
    const status = MISSION_STATUSES.includes(statusParam as MissionStatus)
        ? (statusParam as MissionStatus)
        : undefined;
    const search = firstParam(params.search)?.trim() || undefined;
    const offset = Math.max(0, parseInt(firstParam(params.offset) ?? '0', 10) || 0);

    let missions: Mission[] = [];
    let loadError: string | null = null;
    try {
        missions = await missionsAPI.list({
            status,
            search,
            offset,
            limit: PAGE_SIZE + 1,
        });
    } catch (err) {
        loadError = err instanceof Error ? err.message : 'Failed to load Missions.';
    }

    const hasNext = missions.length > PAGE_SIZE;
    const pageMissions = hasNext ? missions.slice(0, PAGE_SIZE) : missions;
    const prevOffset = Math.max(0, offset - PAGE_SIZE);
    const nextOffset = offset + PAGE_SIZE;

    return (
        <MissionsList
            missions={pageMissions}
            loadError={loadError}
            filters={{ status, search }}
            pagination={{
                offset,
                hasPrevious: offset > 0,
                hasNext,
                previousHref: buildMissionsHref({ status, search, offset: prevOffset }),
                nextHref: buildMissionsHref({ status, search, offset: nextOffset }),
            }}
        />
    );
}
