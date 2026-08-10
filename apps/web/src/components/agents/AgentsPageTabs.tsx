'use client';

import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';

/**
 * Run orchestration (Wave 4 M4) — top-level tab strip on the Agents
 * page: the Agents catalog and the org-wide Sessions view (a filtered
 * projection of `agent_runs`, exactly as the Tasks kanban is a view
 * over Task). Same visual language as the per-agent `AgentDetailTabs`.
 */
export function AgentsPageTabs({ active }: { active: 'agents' | 'sessions' | 'archived' }) {
    const t = useTranslations('dashboard.agentsPage.pageTabs');

    const tabs = [
        { key: 'agents' as const, href: ROUTES.DASHBOARD_AGENTS, label: t('agents') },
        {
            key: 'sessions' as const,
            href: ROUTES.DASHBOARD_AGENT_SESSIONS,
            label: t('sessions'),
        },
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
