import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { inboxAPI } from '@/lib/api/inbox';
import {
    INBOX_DECISION_PAGE_SIZE,
    parseDecisionFilters,
    type InboxDecision,
    type InboxDecisionCounts,
    type InboxItem,
} from '@/lib/api/inbox.shared';
import { InboxClient, InboxDecisionsClient, type InboxView } from '@/components/inbox';

export async function generateMetadata({
    searchParams,
}: {
    searchParams: InboxSearchParams;
}): Promise<Metadata> {
    const params = await searchParams;
    if (firstParam(params.view) === 'decisions') {
        const t = await getTranslations('dashboard.inbox.decisions');
        return { title: t('title') };
    }
    const t = await getTranslations('dashboard.inbox');
    return { title: t('title') };
}

const PAGE_SIZE = 100;

type InboxSearchParams = Promise<{
    view?: string | string[];
    id?: string | string[];
    /** My Decisions view filters — see `parseDecisionFilters`. */
    tab?: string | string[];
    kind?: string | string[];
    agentId?: string | string[];
    taskId?: string | string[];
    missionId?: string | string[];
    q?: string | string[];
}>;

function firstParam(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
}

/**
 * Inbox (operator message center) — `/inbox`.
 *
 * Server-fetches the active or archived view and hands load failures to
 * the client rather than rendering an empty inbox: "nothing is waiting
 * on you" and "we could not ask" must never look the same on a surface
 * whose whole job is telling the human what is blocked.
 *
 * `?id=` is the deep link the bell's "Open inbox" action and the channel
 * notifications carry; the client selects that row when it is in the
 * fetched page and falls back to the newest message otherwise.
 *
 * `?view=decisions` is My Decisions: the same items read as a ranked
 * decision queue, with its own tabs (`?tab=open|answered|archived`) and
 * filters (`?kind= ?agentId= ?taskId= ?missionId= ?q=`) in the URL so any
 * state of the queue is linkable. A failed read reaches the client as an
 * error for the same reason as above.
 */
export default async function InboxPage({ searchParams }: { searchParams: InboxSearchParams }) {
    const params = await searchParams;
    const viewParam = firstParam(params.view);
    const view: InboxView =
        viewParam === 'archived' ? 'archived' : viewParam === 'decisions' ? 'decisions' : 'active';
    const selectedId = firstParam(params.id);

    if (view === 'decisions') {
        const filters = parseDecisionFilters(params);
        let decisions: InboxDecision[] = [];
        let total = 0;
        let counts: InboxDecisionCounts | null = null;
        let decisionsError: string | null = null;
        try {
            const result = await inboxAPI.listDecisions({
                ...filters,
                limit: INBOX_DECISION_PAGE_SIZE,
            });
            decisions = result?.data ?? [];
            total = result?.meta?.total ?? decisions.length;
            if (result?.meta) {
                counts = {
                    open: result.meta.openCount,
                    blocking: result.meta.blockingCount,
                    lastRaisedAt: result.meta.lastRaisedAt ?? null,
                };
            }
        } catch (err) {
            decisionsError = err instanceof Error ? err.message : 'Failed to load your decisions.';
        }
        return (
            <InboxDecisionsClient
                decisions={decisions}
                total={total}
                counts={counts}
                filters={filters}
                selectedId={selectedId}
                loadError={decisionsError}
            />
        );
    }

    let items: InboxItem[] = [];
    let unreadCount = 0;
    let loadError: string | null = null;
    try {
        const result = await inboxAPI.list({
            // Active = everything not archived, which the API returns when
            // `status` is omitted.
            ...(view === 'archived' ? { status: 'archived' as const } : {}),
            limit: PAGE_SIZE,
        });
        items = result?.data ?? [];
        unreadCount = result?.meta?.unreadCount ?? 0;
    } catch (err) {
        loadError = err instanceof Error ? err.message : 'Failed to load your inbox.';
    }

    return (
        <InboxClient
            items={items}
            unreadCount={unreadCount}
            view={view}
            selectedId={selectedId}
            loadError={loadError}
        />
    );
}
