'use client';

import { Bot, Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { AgentCard } from './AgentCard';
import type { Agent } from '@/lib/api/agents';

/**
 * Agents/Skills/Tasks PR #1017 — Phase 5. Catalog list. Matches
 * MissionsList layout: top-right "+ New Agent" CTA, empty state
 * nudge, then a responsive grid of AgentCards.
 *
 * View-mode switcher (Cards/Table) lands in a later sub-tick —
 * v1 is cards-only so the page is useful immediately.
 */
export function AgentsList({ agents }: { agents: Agent[] }) {
    const t = useTranslations('dashboard.agentsPage');

    return (
        <div className="w-full overflow-auto p-6 max-w-screen-2xl mx-auto">
            <div className="flex items-start justify-between gap-3 mb-6">
                <div className="flex items-start gap-3">
                    <div className="shrink-0 w-9 h-9 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center">
                        <Bot className="w-4 h-4 text-primary" />
                    </div>
                    <div>
                        <h1 className="text-2xl font-semibold text-text dark:text-text-dark">
                            {t('title')}
                        </h1>
                        <p className="text-sm text-text-secondary dark:text-text-secondary-dark mt-1 max-w-2xl">
                            {t('subtitle')}
                        </p>
                    </div>
                </div>
                <Button asChild size="sm" className="gap-1.5 shrink-0">
                    <Link href={ROUTES.DASHBOARD_AGENT_NEW}>
                        <Plus className="w-3.5 h-3.5" />
                        {t('newAgent')}
                    </Link>
                </Button>
            </div>

            {agents.length === 0 ? (
                <div className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-6">
                    <p className="text-sm text-text dark:text-text-dark">{t('empty.title')}</p>
                    <p className="text-xs text-text-muted dark:text-text-muted-dark mt-1 max-w-2xl">
                        {t('empty.subtitle')}
                    </p>
                    <div className="mt-4">
                        <Button asChild size="sm" className="gap-1.5">
                            <Link href={ROUTES.DASHBOARD_AGENT_NEW}>
                                <Plus className="w-3.5 h-3.5" />
                                {t('newAgent')}
                            </Link>
                        </Button>
                    </div>
                </div>
            ) : (
                <div className="grid grid-cols-1 @lg/main:grid-cols-2 @3xl/main:grid-cols-3 gap-4">
                    {agents.map((a) => (
                        <AgentCard key={a.id} agent={a} />
                    ))}
                </div>
            )}
        </div>
    );
}
