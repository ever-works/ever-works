'use client';

import { Bot } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import type { Agent } from '@/lib/api/agents';

/**
 * Agents/Skills/Tasks PR #1017 — Phase 5. Minimal first-pass card,
 * patterned after MissionCard. Avatar mode is rendered as initials
 * for v1 — icon + uploaded image modes (H3 override) wire in later
 * once the avatar-icon picker + image upload UX lands.
 */
export function AgentCard({ agent }: { agent: Agent }) {
    const t = useTranslations('dashboard.agentsPage.card');

    const scopeLabel: Record<Agent['scope'], string> = {
        tenant: t('scopeTenant'),
        mission: t('scopeMission'),
        work: t('scopeWork'),
        idea: t('scopeIdea'),
    };
    const statusLabel: Record<Agent['status'], string> = {
        draft: t('statusDraft'),
        active: t('statusActive'),
        paused: t('statusPaused'),
        running: t('statusRunning'),
        error: t('statusError'),
        archived: t('statusArchived'),
    };
    const statusToneClass: Record<Agent['status'], string> = {
        draft: 'bg-text-muted/10 text-text-muted',
        active: 'bg-success/10 text-success',
        paused: 'bg-warning/10 text-warning',
        running: 'bg-info/10 text-info',
        error: 'bg-danger/10 text-danger',
        archived: 'bg-text-muted/10 text-text-muted',
    };

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
            className="group block rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5 hover:border-border dark:hover:border-border-dark transition-colors"
        >
            <div className="flex items-start gap-3">
                <div className="shrink-0 w-9 h-9 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center">
                    {agent.avatarMode === 'initials' ? (
                        <span className="text-xs font-semibold text-primary">{initials}</span>
                    ) : (
                        <Bot className="w-4 h-4 text-primary" />
                    )}
                </div>
                <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                        <h3 className="text-sm font-semibold text-text dark:text-text-dark truncate">
                            {agent.name}
                        </h3>
                        <span
                            className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${statusToneClass[agent.status]}`}
                        >
                            {statusLabel[agent.status]}
                        </span>
                    </div>
                    <p className="text-xs text-text-muted dark:text-text-muted-dark mt-1 truncate">
                        {agent.title ?? t('noTitle')}
                    </p>
                    <div className="flex items-center gap-2 mt-3 text-[11px] text-text-secondary dark:text-text-secondary-dark">
                        <span className="px-1.5 py-0.5 rounded bg-surface-secondary dark:bg-surface-secondary-dark">
                            {scopeLabel[agent.scope]}
                        </span>
                        <span className="truncate">
                            {agent.heartbeatCadence
                                ? `${t('cadencePrefix')} ${agent.heartbeatCadence}`
                                : t('noCadence')}
                        </span>
                    </div>
                </div>
            </div>
        </Link>
    );
}
