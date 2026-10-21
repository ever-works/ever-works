'use client';

import { useRef, type KeyboardEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Link, useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import { FLEET_COMPUTER_TABS, type FleetComputerTabId } from '../registry';

/**
 * Fleet hub (FL-01, FR-17, spec §5.8) — one computer's twelve tabs, in the
 * fixed order, each selected by `?tab=` (Overview is the plain URL). A
 * `tablist` with roving focus: Left / Right / Home / End move between tabs,
 * Enter or Space opens the focused one (spec §5.13).
 */
export function ComputerTabs({ nodeId, active }: { nodeId: string; active: FleetComputerTabId }) {
    const t = useTranslations('fleet.computer');
    const router = useRouter();
    const refs = useRef<Array<HTMLAnchorElement | null>>([]);
    const count = FLEET_COMPUTER_TABS.length;
    const focusTab = (index: number) => refs.current[(index + count) % count]?.focus();

    const onKeyDown = (event: KeyboardEvent<HTMLAnchorElement>, index: number) => {
        const keys: Record<string, () => void> = {
            ArrowRight: () => focusTab(index + 1),
            ArrowLeft: () => focusTab(index - 1),
            Home: () => focusTab(0),
            End: () => focusTab(count - 1),
            ' ': () =>
                router.push(ROUTES.DASHBOARD_FLEET_COMPUTER(nodeId, FLEET_COMPUTER_TABS[index].id)),
        };
        const act = keys[event.key];
        if (!act) return;
        event.preventDefault();
        act();
    };

    return (
        <nav
            className="border-b border-border/60 dark:border-border-dark/60 mb-6"
            aria-label={t('tabsLabel')}
            data-testid="fleet-computer-tabs"
        >
            <div
                role="tablist"
                aria-label={t('tabsLabel')}
                className="flex items-center gap-1 overflow-x-auto"
            >
                {FLEET_COMPUTER_TABS.map((tab, index) => {
                    const selected = tab.id === active;
                    return (
                        <Link
                            key={tab.id}
                            id={`fleet-computer-tab-${tab.id}`}
                            ref={(element: HTMLAnchorElement | null) => {
                                refs.current[index] = element;
                            }}
                            href={ROUTES.DASHBOARD_FLEET_COMPUTER(nodeId, tab.id)}
                            role="tab"
                            aria-selected={selected}
                            aria-current={selected ? 'page' : undefined}
                            aria-controls="fleet-computer-panel"
                            tabIndex={selected ? 0 : -1}
                            onKeyDown={(event: KeyboardEvent<HTMLAnchorElement>) =>
                                onKeyDown(event, index)
                            }
                            data-testid={`fleet-computer-tab-${tab.id}`}
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
