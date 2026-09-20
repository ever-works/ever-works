'use client';

import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';

export type AgentsHubTab = 'agents' | 'skills' | 'activity';

/**
 * Agents hub — the SUB-tabs of the Agents tab: Agents | Skills | Activity.
 *
 * The hub's top strip (`AgentsPageTabs`) answers "people or agents, and are we
 * looking at the live ones?"; this strip answers "which part of the agents
 * world?" and exists because two of its three members used to be somewhere
 * else entirely:
 *
 *  - **Skills** was a `#skills` block at the bottom of the Agents catalog
 *    (anchor navigation, no URL of its own). It is a catalog in its own right,
 *    so it gets its own address — `/agents/skills` — and the old anchor is
 *    redirected here.
 *  - **Activity** was the hub's top-level "Sessions" tab. It is the agent-only
 *    twin of the global Activity page — the same runs seen through an agent
 *    lens (live sessions, gates, tokens, cost, and the Day/Week/Month ledger) —
 *    so it is named for what it is and sits where it belongs, one level in.
 *
 * Same visual language as `AgentsPageTabs` (underline tabs) so the two strips
 * read as one hierarchy rather than two unrelated navs.
 */
export function AgentsHubTabs({ active }: { active: AgentsHubTab }) {
    const t = useTranslations('dashboard.agentsPage');
    const tActivity = useTranslations('dashboard.activity');

    const tabs: Array<{ key: AgentsHubTab; href: string; label: string; testId: string }> = [
        {
            key: 'agents',
            href: ROUTES.DASHBOARD_AGENTS,
            label: t('pageTabs.agents'),
            testId: 'agents-hub-tab-agents',
        },
        {
            key: 'skills',
            href: ROUTES.DASHBOARD_AGENTS_SKILLS,
            // The catalog's own title ("Skills") — the same word the block it
            // replaces used as its heading.
            label: t('skillsBlock.title'),
            testId: 'agents-hub-tab-skills',
        },
        {
            key: 'activity',
            href: ROUTES.DASHBOARD_AGENTS_ACTIVITY,
            // The page it now lives on. The old label ("Sessions") described one
            // of its two views, not the whole surface.
            label: tActivity('title'),
            testId: 'agents-hub-tab-activity',
        },
    ];

    return (
        <nav
            className="border-b border-border/60 dark:border-border-dark/60 mb-5"
            aria-label={t('subTabsLabel')}
            data-testid="agents-hub-tabs"
        >
            <ul className="flex items-center gap-1 overflow-x-auto">
                {tabs.map((tab) => (
                    <li key={tab.key}>
                        <Link
                            href={tab.href}
                            data-testid={tab.testId}
                            aria-current={tab.key === active ? 'page' : undefined}
                            className={cn(
                                'inline-flex items-center px-3 h-9 text-sm border-b-2 transition-colors',
                                tab.key === active
                                    ? 'border-primary text-text dark:text-text-dark'
                                    : 'border-transparent text-text-secondary dark:text-text-secondary-dark hover:text-text dark:hover:text-text-dark',
                            )}
                        >
                            {tab.label}
                        </Link>
                    </li>
                ))}
            </ul>
        </nav>
    );
}
