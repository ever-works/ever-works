'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { buildDecisionsHref } from '@/lib/api/inbox.shared';

/**
 * The Inbox's top-level views. `decisions` (My Decisions) is the same
 * items read as a ranked decision queue; it is a view of the Inbox, not a
 * second place to look.
 */
export type InboxView = 'active' | 'archived' | 'decisions';

const TAB_ORDER: readonly InboxView[] = ['active', 'decisions', 'archived'];

const TAB_HREF: Record<InboxView, string> = {
    active: '/inbox',
    decisions: buildDecisionsHref({ tab: 'open' }),
    archived: '/inbox?view=archived',
};

/** The Active / My Decisions / Archived switch at the top of `/inbox`. */
export function InboxTabs({ view }: { view: InboxView }) {
    const t = useTranslations('dashboard.inbox');
    return (
        <div className="mb-4 flex flex-wrap items-center gap-2" role="tablist">
            {TAB_ORDER.map((tab) => (
                <Button
                    key={tab}
                    href={TAB_HREF[tab]}
                    variant={view === tab ? 'primary' : 'secondary'}
                    size="sm"
                    role="tab"
                    aria-selected={view === tab}
                    data-testid={`inbox-tab-${tab}`}
                >
                    {t(`tabs.${tab}`)}
                </Button>
            ))}
        </div>
    );
}
