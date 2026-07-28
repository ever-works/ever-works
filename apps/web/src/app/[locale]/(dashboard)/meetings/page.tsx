import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { meetingsAPI, type Meeting } from '@/lib/api/meetings';
import { MEETING_SOURCES, type MeetingSource } from '@/lib/api/meetings.shared';
import { workAPI } from '@/lib/api/work';
import { MeetingsList, type MeetingWorkOption } from '@/components/meetings';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('dashboard.meetingsPage');
    return { title: t('title') };
}

const PAGE_SIZE = 24;
const WORK_OPTIONS_LIMIT = 100;

/** Canonical uuid shape — anything else is dropped before it reaches the API. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type MeetingsSearchParams = Promise<{
    source?: string | string[];
    workId?: string | string[];
    offset?: string | string[];
}>;

function firstParam(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
}

function buildMeetingsHref(input: {
    source?: MeetingSource;
    workId?: string;
    offset?: number;
}): string {
    const params = new URLSearchParams();
    if (input.source) params.set('source', input.source);
    if (input.workId) params.set('workId', input.workId);
    if (input.offset && input.offset > 0) params.set('offset', String(input.offset));
    const qs = params.toString();
    return qs ? `/meetings?${qs}` : '/meetings';
}

/**
 * Meetings — `/meetings` catalog page. Server-fetches the user's
 * meetings with bounded pagination and hands load errors to the client
 * so a flaky API doesn't masquerade as an empty meeting history (same
 * contract as the Goals catalog).
 *
 * Both filters are whitelisted here before they reach the API:
 *   - `source` must be one of the closed `MeetingSource` set — the API
 *     silently ignores unknown values, so dropping it locally keeps the
 *     rendered filter chip and the actual query in agreement.
 *   - `workId` must look like a uuid. The API compares it straight
 *     against a uuid column, so an arbitrary string would be a Postgres
 *     cast error (a 500) rather than an empty result.
 *
 * The Work options powering the "routed to" filter are a best-effort
 * side fetch (`.catch(() => [])`) — the meetings list must render even
 * when the works endpoint is unhappy.
 */
export default async function MeetingsPage({
    searchParams,
}: {
    searchParams: MeetingsSearchParams;
}) {
    const params = await searchParams;
    const sourceParam = firstParam(params.source);
    const source = MEETING_SOURCES.includes(sourceParam as MeetingSource)
        ? (sourceParam as MeetingSource)
        : undefined;
    const workIdParam = firstParam(params.workId);
    const workId = workIdParam && UUID_RE.test(workIdParam) ? workIdParam : undefined;
    const offset = Math.max(0, parseInt(firstParam(params.offset) ?? '0', 10) || 0);

    const worksPromise = workAPI
        .getAll({ limit: WORK_OPTIONS_LIMIT })
        .then<MeetingWorkOption[]>((res) =>
            (res?.works ?? []).map((work) => ({ id: work.id, name: work.name })),
        )
        .catch<MeetingWorkOption[]>(() => []);

    let meetings: Meeting[] = [];
    let loadError: string | null = null;
    try {
        meetings = await meetingsAPI.list({
            source,
            workId,
            offset,
            limit: PAGE_SIZE + 1,
        });
    } catch (err) {
        loadError = err instanceof Error ? err.message : 'Failed to load meetings.';
    }

    const works = await worksPromise;

    const hasNext = meetings.length > PAGE_SIZE;
    const pageMeetings = hasNext ? meetings.slice(0, PAGE_SIZE) : meetings;
    const prevOffset = Math.max(0, offset - PAGE_SIZE);
    const nextOffset = offset + PAGE_SIZE;

    return (
        <MeetingsList
            meetings={pageMeetings}
            works={works}
            loadError={loadError}
            filters={{ source, workId }}
            pagination={{
                offset,
                hasPrevious: offset > 0,
                hasNext,
                previousHref: buildMeetingsHref({ source, workId, offset: prevOffset }),
                nextHref: buildMeetingsHref({ source, workId, offset: nextOffset }),
            }}
        />
    );
}
