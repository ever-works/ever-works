'use client';

import { useTranslations } from 'next-intl';
import { Link, usePathname } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';

/**
 * Agents/Skills/Tasks PR #1017 — Phase 5. 6-tab strip on the
 * `/agents/[id]` detail layout, per `features/agents/spec.md §5.4`.
 *
 * Phase 5 ships the layout + nav. Individual tab bodies arrive
 * incrementally across later sub-ticks (Instructions lands first
 * — it reuses the KbEditor.tsx pattern).
 */
export function AgentDetailTabs({
    agentId,
    showComputer = false,
}: {
    agentId: string;
    /**
     * Agent computers — the Computer tab. Passed down by the (server) layout
     * from `isFleetEnabled()`, so the tab disappears with the fleet it shows.
     * Absent keeps the strip exactly as it was.
     */
    showComputer?: boolean;
}) {
    const t = useTranslations('dashboard.agentsPage.tabs');
    const pathname = usePathname() ?? '';

    const tabs = [
        {
            key: 'dashboard',
            href: ROUTES.DASHBOARD_AGENT_DASHBOARD(agentId),
            label: t('dashboard'),
        },
        { key: 'activity', href: ROUTES.DASHBOARD_AGENT_ACTIVITY(agentId), label: t('activity') },
        { key: 'terminal', href: ROUTES.DASHBOARD_AGENT_TERMINAL(agentId), label: t('terminal') },
        ...(showComputer
            ? [
                  {
                      key: 'computer',
                      href: ROUTES.DASHBOARD_AGENT_COMPUTER(agentId),
                      label: t('computer'),
                  },
              ]
            : []),
        {
            key: 'instructions',
            href: ROUTES.DASHBOARD_AGENT_INSTRUCTIONS(agentId),
            label: t('instructions'),
        },
        { key: 'skills', href: ROUTES.DASHBOARD_AGENT_SKILLS(agentId), label: t('skills') },
        {
            key: 'capabilities',
            href: ROUTES.DASHBOARD_AGENT_CAPABILITIES(agentId),
            label: t('capabilities'),
        },
        {
            key: 'mcp-servers',
            href: ROUTES.DASHBOARD_AGENT_MCP_SERVERS(agentId),
            label: t('mcpServers'),
        },
        {
            key: 'collaborators',
            href: ROUTES.DASHBOARD_AGENT_COLLABORATORS(agentId),
            label: t('collaborators'),
        },
        { key: 'budgets', href: ROUTES.DASHBOARD_AGENT_BUDGETS(agentId), label: t('budgets') },
        // Agent email (AW-05) — the inbox pages shipped without a way to
        // reach them by clicking.
        { key: 'inbox', href: ROUTES.DASHBOARD_AGENT_INBOX(agentId), label: t('inbox') },
        { key: 'settings', href: ROUTES.DASHBOARD_AGENT_SETTINGS(agentId), label: t('settings') },
    ];

    return (
        <nav className="border-b border-border/60 dark:border-border-dark/60 px-6">
            <ul className="flex items-center gap-1 overflow-x-auto">
                {tabs.map((tab) => {
                    const isActive =
                        tab.key === 'dashboard'
                            ? pathname.endsWith(`/agents/${agentId}`)
                            : pathname.endsWith(tab.href.replace(/^\//, ''));
                    return (
                        <li key={tab.key}>
                            <Link
                                href={tab.href}
                                className={cn(
                                    'inline-flex items-center px-3 h-10 text-sm border-b-2 transition-colors',
                                    isActive
                                        ? 'border-primary text-text dark:text-text-dark'
                                        : 'border-transparent text-text-secondary dark:text-text-secondary-dark hover:text-text dark:hover:text-text-dark',
                                )}
                            >
                                {tab.label}
                            </Link>
                        </li>
                    );
                })}
            </ul>
        </nav>
    );
}
