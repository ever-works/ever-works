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

/**
 * Self-build slice AU — the "From your fleet" filter of the Active and
 * Archived views: only what runs on the owner's own machines asked or
 * reported (`sourceType: fleet-run`). A link pair rather than state, so a
 * filtered Inbox is linkable and the 30s poll (a `router.refresh()` of the
 * same URL) keeps the filter.
 */
export function inboxSourceHref(view: Exclude<InboxView, 'decisions'>, fleetOnly: boolean): string {
    const params = new URLSearchParams();
    if (view === 'archived') params.set('view', 'archived');
    if (fleetOnly) params.set('source', 'fleet');
    const qs = params.toString();
    return qs ? `/inbox?${qs}` : '/inbox';
}

export function InboxSourceFilter({
    view,
    fleetOnly,
}: {
    view: Exclude<InboxView, 'decisions'>;
    fleetOnly: boolean;
}) {
    const t = useTranslations('dashboard.inbox.sourceFilter');
    return (
        <div
            className="mb-4 flex flex-wrap items-center gap-2 text-xs"
            role="group"
            aria-label={t('label')}
            data-testid="inbox-source-filter"
        >
            <span className="text-text-secondary dark:text-text-secondary-dark">{t('label')}</span>
            {([false, true] as const).map((fleet) => (
                <Button
                    key={String(fleet)}
                    href={inboxSourceHref(view, fleet)}
                    variant={fleetOnly === fleet ? 'primary' : 'secondary'}
                    size="sm"
                    aria-pressed={fleetOnly === fleet}
                    data-testid={fleet ? 'inbox-source-fleet' : 'inbox-source-all'}
                >
                    {fleet ? t('fleet') : t('all')}
                </Button>
            ))}
        </div>
    );
}

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
