'use client';

import { Bot, Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import type { Agent } from '@/lib/api/agents';

const PREVIEW_LIMIT = 3;

const STATUS_TONES: Record<Agent['status'], string> = {
    draft: 'bg-text-muted/10 text-text-muted',
    active: 'bg-success/10 text-success',
    paused: 'bg-warning/10 text-warning',
    running: 'bg-info/10 text-info',
    error: 'bg-danger/10 text-danger',
    archived: 'bg-text-muted/10 text-text-muted',
};

interface AgentsPreviewSectionProps {
    agents: Agent[];
    totalAgents: number;
}

export function AgentsPreviewSection({ agents, totalAgents }: AgentsPreviewSectionProps) {
    const t = useTranslations('dashboard.agentsPreview');
    const previewAgents = agents.slice(0, PREVIEW_LIMIT);

    return (
        <section aria-labelledby="agents-preview-heading">
            <div className="flex flex-nowrap items-center justify-between gap-3 mb-4">
                <div className="flex items-center gap-2 min-w-0">
                    <div className="shrink-0 w-9 h-9 rounded-lg bg-surface-secondary dark:bg-white/6 border border-border/50 dark:border-white/10 flex items-center justify-center">
                        <Bot className="w-4 h-4 text-text-secondary dark:text-text-secondary-dark" />
                    </div>
                    <h2
                        id="agents-preview-heading"
                        className="text-xl font-semibold text-text dark:text-text-dark truncate"
                    >
                        {t('title')}
                    </h2>
                </div>
                <div className="flex flex-nowrap items-center gap-2 shrink-0">
                    <Link
                        href={ROUTES.DASHBOARD_AGENT_NEW}
                        className={cn(
                            'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap',
                            'border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark',
                            'text-text-secondary dark:text-text-secondary-dark',
                            'hover:border-primary/40 hover:text-primary',
                        )}
                    >
                        <Plus className="w-3.5 h-3.5" />
                        {t('add')}
                    </Link>
                    {totalAgents > 0 && (
                        <Link
                            href={ROUTES.DASHBOARD_AGENTS}
                            className="text-xs font-medium text-primary hover:underline inline-flex items-center gap-1 whitespace-nowrap"
                        >
                            {t('viewAll', { n: totalAgents })}
                        </Link>
                    )}
                </div>
            </div>

            {previewAgents.length === 0 ? (
                <div className="rounded-lg p-5 bg-card dark:bg-card-primary-dark/70 border border-card-border dark:border-white/9 text-sm text-text-secondary dark:text-text-secondary-dark">
                    <p>{t('empty.title')}</p>
                    <p className="mt-1 text-xs">
                        <Link
                            href={ROUTES.DASHBOARD_AGENT_NEW}
                            className="text-primary hover:underline"
                        >
                            {t('empty.subtitleLink')}
                        </Link>{' '}
                        {t('empty.subtitleSuffix')}
                    </p>
                </div>
            ) : (
                <div className="grid grid-cols-1 @lg/main:grid-cols-2 @3xl/main:grid-cols-3 gap-4">
                    {previewAgents.map((agent) => (
                        <AgentPreviewCard key={agent.id} agent={agent} t={t} />
                    ))}
                </div>
            )}
        </section>
    );
}

function AgentPreviewCard({
    agent,
    t,
}: {
    agent: Agent;
    t: ReturnType<typeof useTranslations<'dashboard.agentsPreview'>>;
}) {
    const initials =
        agent.name
            .split(/\s+/)
            .map((p) => p.charAt(0))
            .join('')
            .slice(0, 2)
            .toUpperCase() || 'A';

    return (
        <Link
            href={ROUTES.DASHBOARD_AGENT(agent.id)}
            className={cn(
                'group flex flex-col gap-3 rounded-xl p-4 no-underline',
                'bg-card dark:bg-card-primary-dark/60',
                'border border-card-border dark:border-white/8',
                'hover:border-border dark:hover:border-white/16',
                'transition-colors duration-150',
            )}
        >
            {/* Header: avatar + name + status */}
            <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2.5 min-w-0">
                    <div className="shrink-0 w-8 h-8 rounded-lg flex items-center justify-center bg-surface-secondary dark:bg-white/6 border border-border/40 dark:border-white/10">
                        {agent.avatarMode === 'initials' ? (
                            <span className="text-xs font-semibold text-text-secondary dark:text-text-secondary-dark">
                                {initials}
                            </span>
                        ) : (
                            <Bot className="w-4 h-4 text-text-secondary dark:text-text-secondary-dark" />
                        )}
                    </div>
                    <div className="min-w-0">
                        <h3 className="text-sm font-semibold text-text dark:text-text-dark truncate leading-snug">
                            {agent.name}
                        </h3>
                        {agent.title ? (
                            <p className="text-xs text-text-muted dark:text-text-muted-dark truncate mt-0.5">
                                {agent.title}
                            </p>
                        ) : null}
                    </div>
                </div>
                <span
                    className={cn(
                        'shrink-0 text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded-md',
                        STATUS_TONES[agent.status],
                    )}
                >
                    {agent.status}
                </span>
            </div>

            {/* Footer: scope + cadence */}
            <div className="flex items-center gap-2 pt-1 border-t border-card-border/50 dark:border-white/6 text-[11px] text-text-secondary dark:text-text-secondary-dark">
                <span className="px-1.5 py-0.5 rounded-md bg-surface-secondary dark:bg-white/6">
                    {t(`scope.${agent.scope}`)}
                </span>
                {agent.heartbeatCadence ? (
                    <span className="truncate text-text-muted dark:text-text-muted-dark">
                        {t('cadence', { cadence: agent.heartbeatCadence })}
                    </span>
                ) : null}
            </div>
        </Link>
    );
}
