import { getLocale } from 'next-intl/server';
import { redirect } from '@/i18n/navigation';
import {
    filtersFromSearchParams,
    scheduleFilterParams,
} from '@/components/schedules/schedules-filters.shared';

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * `/schedules` — RETIRED as a page. The Schedules list is now the **Schedules
 * view of the Activity page** (`/activity?view=schedules`), because the two
 * surfaces had grown into the same surface: one list of everything that runs
 * without you, sitting next to the record of everything that ran. Keeping both
 * meant two implementations of one list, and only one of them could have the
 * per-row controls.
 *
 * Kept as a redirect rather than deleted so every bookmark, dashboard link,
 * help article and e2e journey written against `/schedules` keeps working —
 * and so does the VIEW it named: the whole filter set rides along, so
 * `/schedules?source=data_sync&status=active&active=1` lands on that exact
 * list rather than an unfiltered one.
 */
export default async function SchedulesRedirect({
    searchParams,
}: {
    searchParams?: Promise<SearchParams>;
}) {
    const params = (await searchParams) ?? {};
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        const first = Array.isArray(value) ? value[0] : value;
        if (first !== undefined) search.set(key, first);
    }
    // Through the shared parser, so an unknown or malformed value is dropped
    // here exactly as it would have been by the list itself.
    const filters = filtersFromSearchParams(search);

    const target = new URLSearchParams();
    target.set('view', 'schedules');
    for (const [key, value] of scheduleFilterParams(filters)) target.set(key, value);

    const locale = await getLocale();
    redirect({ href: `/activity?${target.toString()}`, locale });
}
