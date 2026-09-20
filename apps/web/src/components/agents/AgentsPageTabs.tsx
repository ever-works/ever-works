'use client';

import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';

/**
 * Teams hub tab strip: Teams | Agents | Archived — rendered on `/teams`,
 * `/agents` and `/agents/archived`.
 *
 * Run orchestration (Wave 4 M4) introduced it over the Agents catalog and the
 * org-wide Sessions view (a filtered projection of `agent_runs`, exactly as the
 * Tasks kanban is a view over Task). Navigation consolidation
 * (`docs/specs/features/navigation-consolidation`) then folded Teams in as the
 * first tab, since people and agents are one org seen through two doors — hence
 * the `TeamsPageTabs` alias below for the `/teams` entry point.
 *
 * The Activity merge removed the top-level **Sessions** tab: it is now the
 * **Activity** sub-tab of the Agents tab (`AgentsHubTabs`), next to the Skills
 * catalog, because both are the Agents world seen from one level in. The URL it
 * lived at still works — `/agents/sessions` redirects to `/agents/activity` —
 * so nothing that pointed at it is broken; it simply is not a sibling of Teams
 * and Archived any more.
 *
 * Same visual language as the per-agent `AgentDetailTabs`.
 */
export function AgentsPageTabs({ active }: { active: 'teams' | 'agents' | 'archived' }) {
    const t = useTranslations('dashboard.agentsPage.pageTabs');

    const tabs = [
        // The hub's front door — the old standalone Teams page, now tab 1.
        { key: 'teams' as const, href: ROUTES.DASHBOARD_TEAMS, label: t('teams') },
        { key: 'agents' as const, href: ROUTES.DASHBOARD_AGENTS, label: t('agents') },
        // The catalog hides archived Agents, so without a tab of their
        // own they are unreachable in the UI — and permanent deletion
        // (the only transition left to them) with it.
        {
            key: 'archived' as const,
            href: ROUTES.DASHBOARD_AGENTS_ARCHIVED,
            label: t('archived'),
        },
    ];

    return (
        <nav
            className="border-b border-border/60 dark:border-border-dark/60 mb-6"
            data-testid="agents-page-tabs"
        >
            <ul className="flex items-center gap-1 overflow-x-auto">
                {tabs.map((tab) => (
                    <li key={tab.key}>
                        <Link
                            href={tab.href}
                            data-testid={`agents-page-tab-${tab.key}`}
                            className={cn(
                                'inline-flex items-center px-3 h-10 text-sm border-b-2 transition-colors',
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

/**
 * Alias for the `/teams` side of the same hub — identical component, named
 * after the page that renders it so the Teams pages don't read as importing
 * "Agents" tabs. The test ids stay `agents-page-tab-*` either way.
 */
export const TeamsPageTabs = AgentsPageTabs;
