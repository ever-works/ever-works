import { redirect } from '@/i18n/navigation';
import { getLocale } from 'next-intl/server';
import { buildMeetingsHref, parseMeetingsSearchParams } from '@/lib/api/meetings-page-params';
import { ROUTES } from '@/lib/constants';

/**
 * `/meetings` (index) — retired as a standalone page by the navigation
 * consolidation: meetings are a memory source, so the catalog now
 * renders as a block on the Memory page
 * (docs/specs/features/navigation-consolidation).
 *
 * Kept as a redirect rather than deleted so every bookmark, deep link
 * and older doc keeps working — the filters come along, since the target
 * block reads the same `source`/`workId`/`offset` params. The params are
 * re-parsed (not forwarded verbatim) so a junk `workId` can't ride
 * through into the redirect URL.
 *
 * `/meetings/new` and `/meetings/[id]` are untouched.
 */
export default async function MeetingsIndexRedirect({
    searchParams,
}: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const query = parseMeetingsSearchParams(await searchParams);
    const locale = await getLocale();
    redirect({
        locale,
        href: buildMeetingsHref(ROUTES.DASHBOARD_MEMORY, query, '#meetings'),
    });
}
