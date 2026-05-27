'use client';

import { Bot, Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { cn } from '@/lib/utils/cn';
import { ROUTES } from '@/lib/constants';
import { AgentCard } from './AgentCard';
import { PageHeader } from '@/components/common/PageHeader';
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
            <PageHeader
                icon={Bot}
                title={t('title')}
                subtitle={t('subtitle')}
                tone="primary"
                actions={
                    <Link
                        href={ROUTES.DASHBOARD_AGENT_NEW}
                        className={cn(
                            'inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-lg font-medium whitespace-nowrap transition-colors shrink-0 px-3 py-2 text-sm',
                            'bg-button-primary dark:bg-button-primary-dark hover:bg-button-primary-hover dark:hover:bg-button-primary-hover-dark text-button-primary-foreground dark:text-button-primary-foreground-dark rounded-sm',
                        )}
                    >
                        <Plus className="w-3.5 h-3.5" />
                        {t('newAgent')}
                    </Link>
                }
            />

            {agents.length === 0 ? (
                <div className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-6">
                    <p className="text-sm text-text dark:text-text-dark">{t('empty.title')}</p>
                    <p className="text-xs text-text-muted dark:text-text-muted-dark mt-1 max-w-2xl">
                        {t('empty.subtitle')}
                    </p>
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
