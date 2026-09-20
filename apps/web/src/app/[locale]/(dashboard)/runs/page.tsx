import { getLocale } from 'next-intl/server';
import { redirect } from '@/i18n/navigation';
import { ACTIVITY_VIEW_PARAM } from '../activity/activity-views';

type SearchParams = Record<string, string | string[] | undefined>;

/** Query names the ledger owns, in the order they should be re-emitted. */
const RUNS_PARAMS = ['g', 'd', 'agent', 'kind', 'status', 'q', 'work', 'mission', 'run'] as const;

/**
 * `/runs` — RETIRED as a page: the Runs ledger is now the **Runs view of the
 * Activity page** (`/activity?view=runs`), so "what did my agents execute, and
 * what did it cost" sits in the same place as the rest of the workspace's
 * history instead of beside it.
 *
 * Kept as a redirect rather than deleted so every bookmark, dashboard tile,
 * help article and e2e journey written against `/runs` keeps working — and so
 * does the VIEW it named: all nine of the ledger's parameters ride along, which
 * is what makes `/runs?g=month&status=failed` land on that exact window rather
 * than on a default one.
 */
export default async function RunsRedirect({
    searchParams,
}: {
    searchParams?: Promise<SearchParams>;
}) {
    const params = (await searchParams) ?? {};
    const target = new URLSearchParams();
    target.set(ACTIVITY_VIEW_PARAM, 'runs');
    for (const name of RUNS_PARAMS) {
        const raw = params[name];
        const value = Array.isArray(raw) ? raw[0] : raw;
        if (value) target.set(name, value);
    }
    const locale = await getLocale();
    redirect({ href: `/activity?${target.toString()}`, locale });
}
