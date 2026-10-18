'use client';

import { useRef, type KeyboardEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Link, useRouter } from '@/i18n/navigation';
import { cn } from '@/lib/utils/cn';
import { FLEET_HUB_TABS, type FleetHubTabId } from '../registry';

/**
 * Fleet hub (FL-01, FR-3) — the six-tab strip: Overview · Computers ·
 * Sessions · Checkouts · Commands · Usage, each a route of its own, in that
 * order. Same visual language as the Teams hub strip (`AgentsPageTabs`).
 *
 * A `tablist` (spec §5.13): Left / Right / Home / End move focus between the
 * tabs (roving tab index), Enter or Space opens the focused one — it is a
 * navigation, so a tab is a link, never a panel toggled in place.
 */
export function FleetHubTabs({ active }: { active: FleetHubTabId }) {
    const t = useTranslations('fleet.hub');
    const router = useRouter();
    const refs = useRef<Array<HTMLAnchorElement | null>>([]);

    const focusTab = (index: number) => {
        const count = FLEET_HUB_TABS.length;
        refs.current[(index + count) % count]?.focus();
    };

    const onKeyDown = (event: KeyboardEvent<HTMLAnchorElement>, index: number) => {
        switch (event.key) {
            case 'ArrowRight':
                event.preventDefault();
                focusTab(index + 1);
                break;
            case 'ArrowLeft':
                event.preventDefault();
                focusTab(index - 1);
                break;
            case 'Home':
                event.preventDefault();
                focusTab(0);
                break;
            case 'End':
                event.preventDefault();
                focusTab(FLEET_HUB_TABS.length - 1);
                break;
            case ' ':
                event.preventDefault();
                router.push(FLEET_HUB_TABS[index].href);
                break;
            default:
                break;
        }
    };

    return (
        <nav
            className="border-b border-border/60 dark:border-border-dark/60 mb-6"
            aria-label={t('tabsLabel')}
            data-testid="fleet-hub-tabs"
        >
            <div
                role="tablist"
                aria-label={t('tabsLabel')}
                className="flex items-center gap-1 overflow-x-auto"
            >
                {FLEET_HUB_TABS.map((tab, index) => {
                    const selected = tab.id === active;
                    return (
                        <Link
                            key={tab.id}
                            ref={(element: HTMLAnchorElement | null) => {
                                refs.current[index] = element;
                            }}
                            id={`fleet-hub-tab-${tab.id}`}
                            href={tab.href}
                            role="tab"
                            aria-selected={selected}
                            aria-controls={selected ? 'fleet-hub-panel' : undefined}
                            aria-current={selected ? 'page' : undefined}
                            tabIndex={selected ? 0 : -1}
                            onKeyDown={(event: KeyboardEvent<HTMLAnchorElement>) =>
                                onKeyDown(event, index)
                            }
                            data-testid={`fleet-hub-tab-${tab.id}`}
                            className={cn(
                                'inline-flex items-center px-3 h-10 text-sm border-b-2 transition-colors whitespace-nowrap',
                                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded-t',
                                selected
                                    ? 'border-primary text-text dark:text-text-dark'
                                    : 'border-transparent text-text-secondary dark:text-text-secondary-dark hover:text-text dark:hover:text-text-dark',
                            )}
                        >
                            {t(`tabs.${tab.id}`)}
                        </Link>
                    );
                })}
            </div>
        </nav>
    );
}
