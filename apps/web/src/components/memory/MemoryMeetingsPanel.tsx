'use client';

import { useTranslations } from 'next-intl';
import { ROUTES } from '@/lib/constants';
import { MeetingsList, type MeetingWorkOption } from '@/components/meetings/MeetingsList';
import type { MeetingSource } from '@/lib/api/meetings.shared';
import type { Meeting } from '@/lib/api/meetings';

/**
 * Everything the Memory page server-fetched for the Meetings block —
 * exactly what `MeetingsList` needs, with the pagination hrefs already
 * built against `/memory#meetings` (the page owns the base path, so the
 * panel never has to re-derive it).
 */
export interface MemoryMeetingsData {
    meetings: Meeting[];
    works: MeetingWorkOption[];
    loadError: string | null;
    filters: { source?: MeetingSource; workId?: string };
    pagination: {
        offset: number;
        hasPrevious: boolean;
        hasNext: boolean;
        previousHref: string;
        nextHref: string;
    };
}

/**
 * Meetings on Memory (`/memory#meetings`).
 *
 * Meetings are a memory *source*, not a separate feature — every
 * transcript and summary is ingested straight into Memory — so the
 * catalog lives here rather than in its own sidebar entry
 * (docs/specs/features/navigation-consolidation). `/meetings` still
 * resolves: it redirects here carrying its query string.
 *
 * The catalog itself is the same `MeetingsList` the standalone page
 * used, in its `panel` chrome with every href rebased onto this page —
 * not a second implementation that would drift.
 */
export function MemoryMeetingsPanel({ data }: { data: MemoryMeetingsData }) {
    const t = useTranslations('dashboard.memoryPage');

    return (
        <MeetingsList
            variant="panel"
            basePath={ROUTES.DASHBOARD_MEMORY}
            hash="#meetings"
            hint={t('meetings.hint')}
            meetings={data.meetings}
            works={data.works}
            loadError={data.loadError}
            filters={data.filters}
            pagination={data.pagination}
        />
    );
}
