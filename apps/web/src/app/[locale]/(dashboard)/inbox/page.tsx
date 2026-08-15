import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { inboxAPI } from '@/lib/api/inbox';
import type { InboxItem } from '@/lib/api/inbox.shared';
import { InboxClient, type InboxView } from '@/components/inbox';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('dashboard.inbox');
    return { title: t('title') };
}

const PAGE_SIZE = 100;

type InboxSearchParams = Promise<{
    view?: string | string[];
    id?: string | string[];
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
 */
export default async function InboxPage({ searchParams }: { searchParams: InboxSearchParams }) {
    const params = await searchParams;
    const view: InboxView = firstParam(params.view) === 'archived' ? 'archived' : 'active';
    const selectedId = firstParam(params.id);

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
