import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { memoryAPI, EMPTY_MEMORY_RESPONSE, type MemoryResponse } from '@/lib/api/memory';
import { meetingsAPI, type Meeting } from '@/lib/api/meetings';
import {
    MEETINGS_PAGE_SIZE,
    buildMeetingsHref,
    parseMeetingsSearchParams,
} from '@/lib/api/meetings-page-params';
import { workAPI } from '@/lib/api/work';
import { ROUTES } from '@/lib/constants';
import { MemoryShell, type MemoryMeetingsData } from '@/components/memory';
import type { MeetingWorkOption } from '@/components/meetings';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('dashboard.memoryPage');
    return { title: t('title') };
}

const WORK_OPTIONS_LIMIT = 100;

/**
 * Org-wide Memory (Cortex P1) — `/memory` catalog page.
 *
 * Server-fetches the initial aggregation once (documents + facets +
 * counts for the active Organization). The fetch is defensive
 * (`.catch`) so a flaky API / no-active-org renders the empty-state
 * surface instead of a 500 — the API itself already returns an empty
 * payload when there is no resolvable Organization, so the shell reads
 * `documents.length === 0` and shows the appropriate empty state.
 *
 * The page also owns the **Meetings block** (`#meetings`), which used to
 * be the standalone `/meetings` catalog — meetings are a memory source,
 * every transcript and summary lands in Memory
 * (docs/specs/features/navigation-consolidation). Its `source`/`workId`/
 * `offset` params are whitelisted by the shared helper before they reach
 * the API, and its two side fetches are independently defensive: a
 * meetings failure surfaces as a load-error box *inside the block* and a
 * works failure just costs the "routed to" filter its options. Neither
 * can take the Memory page down.
 *
 * All interactivity (search, filter chips, view toggle) lives in the
 * client `MemoryShell`, which re-queries the same-origin BFF proxy
 * (`/api/memory`).
 */
export default async function MemoryPage({
    searchParams,
}: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const query = parseMeetingsSearchParams(await searchParams);
    const { source, workId, offset } = query;

    const initialPromise: Promise<MemoryResponse> = memoryAPI
        .get({ limit: 200 })
        .catch(() => EMPTY_MEMORY_RESPONSE);

    const worksPromise = workAPI
        .getAll({ limit: WORK_OPTIONS_LIMIT })
        .then<MeetingWorkOption[]>((res) =>
            (res?.works ?? []).map((work) => ({ id: work.id, name: work.name })),
        )
        .catch<MeetingWorkOption[]>(() => []);

    // A `+1` look-ahead row is what tells the block whether a next page
    // exists without a second count query.
    const meetingsPromise = meetingsAPI
        .list({ source, workId, offset, limit: MEETINGS_PAGE_SIZE + 1 })
        .then((rows) => ({ rows, error: null as string | null }))
        .catch((err: unknown) => ({
            rows: [] as Meeting[],
            error: err instanceof Error ? err.message : 'Failed to load meetings.',
        }));

    const [initial, works, meetingsResult] = await Promise.all([
        initialPromise,
        worksPromise,
        meetingsPromise,
    ]);

    const hasNext = meetingsResult.rows.length > MEETINGS_PAGE_SIZE;
    const pageMeetings = hasNext
        ? meetingsResult.rows.slice(0, MEETINGS_PAGE_SIZE)
        : meetingsResult.rows;

    const meetings: MemoryMeetingsData = {
        meetings: pageMeetings,
        works,
        loadError: meetingsResult.error,
        filters: { source, workId },
        pagination: {
            offset,
            hasPrevious: offset > 0,
            hasNext,
            previousHref: buildMeetingsHref(
                ROUTES.DASHBOARD_MEMORY,
                { source, workId, offset: Math.max(0, offset - MEETINGS_PAGE_SIZE) },
                '#meetings',
            ),
            nextHref: buildMeetingsHref(
                ROUTES.DASHBOARD_MEMORY,
                { source, workId, offset: offset + MEETINGS_PAGE_SIZE },
                '#meetings',
            ),
        },
    };

    return <MemoryShell initial={initial} meetings={meetings} />;
}
