import type { Metadata } from 'next';
import { Suspense } from 'react';
import { getTranslations } from 'next-intl/server';
import { getSchedulePage, getScheduleHealth } from '@/app/actions/dashboard/schedules';
import { SchedulesWorkspace } from '@/components/schedules/SchedulesWorkspace';
import {
    filtersFromSearchParams,
    pageParamsFor,
} from '@/components/schedules/schedules-filters.shared';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('schedules') };
}

/**
 * Schedules workspace. Reads the first page (with the filters in the link)
 * and the health summary on the server, each on its own — one failing never
 * blanks the other.
 */
export default async function SchedulesPage({
    searchParams,
}: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const raw = await searchParams;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(raw ?? {})) {
        if (typeof value === 'string') params.set(key, value);
    }
    const filters = filtersFromSearchParams(params);

    const [pageResponse, healthResponse] = await Promise.all([
        getSchedulePage(pageParamsFor(filters)).catch(() => ({ ok: false as const })),
        getScheduleHealth().catch(() => ({ ok: false as const })),
    ]);

    return (
        <Suspense fallback={null}>
            <SchedulesWorkspace
                initialPage={pageResponse.ok ? pageResponse.page : null}
                initialFailed={!pageResponse.ok}
                initialHealth={healthResponse.ok ? healthResponse.summary : null}
                initialHealthFailed={!healthResponse.ok}
            />
        </Suspense>
    );
}
