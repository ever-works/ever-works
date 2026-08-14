'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Bot } from 'lucide-react';
import { toast } from 'sonner';
import { Switch } from '@/components/ui/switch';
import { listAgentCollaboratorsAction, setAgentCollaboratorAction } from '@/app/actions/agents';
import type { AgentCollaboratorCandidate } from '@/lib/api/agents.shared';

interface Props {
    agentId: string;
    initial: { data: AgentCollaboratorCandidate[] };
}

/**
 * Agent Collaborators tab — "select which agents this agent can spawn
 * as collaborators for subtasks".
 *
 * Fully dynamic: every OTHER agent of the owner is a candidate row (new
 * agents appear automatically), each with a Switch that upserts the
 * allow-list rule via `PUT /api/agents/:id/collaborators/:cid`. No rows
 * configured keeps the legacy self-only delegation default — the copy
 * says so, because an all-off list that silently means "off" and one
 * that means "not configured" look identical otherwise.
 */
export function AgentCollaboratorsClient({ agentId, initial }: Props) {
    const t = useTranslations('dashboard.agentsPage.collaborators');
    const [rows, setRows] = useState(initial.data);
    const [, startTransition] = useTransition();
    const [togglingId, setTogglingId] = useState<string | null>(null);

    const toggle = (collaboratorAgentId: string, enabled: boolean) => {
        // Optimistic flip; reconciled from the server (or rolled back) below.
        setRows((prev) =>
            prev.map((row) =>
                row.agentId === collaboratorAgentId ? { ...row, enabled, configured: true } : row,
            ),
        );
        setTogglingId(collaboratorAgentId);
        startTransition(() => {
            void (async () => {
                try {
                    await setAgentCollaboratorAction(agentId, collaboratorAgentId, enabled);
                    const next = await listAgentCollaboratorsAction(agentId);
                    setRows(next.data);
                } catch {
                    toast.error(t('toggleFailed'));
                    setRows((prev) =>
                        prev.map((row) =>
                            row.agentId === collaboratorAgentId
                                ? { ...row, enabled: !enabled }
                                : row,
                        ),
                    );
                } finally {
                    setTogglingId(null);
                }
            })();
        });
    };

    const enabledCount = rows.filter((row) => row.enabled).length;

    return (
        <div className="p-6 max-w-screen-2xl mx-auto space-y-4">
            <header className="flex items-center justify-between gap-4">
                <div>
                    <h2 className="text-sm font-medium text-text dark:text-text-dark">
                        {t('title')}
                    </h2>
                    <p className="text-xs text-text-muted dark:text-text-muted-dark mt-1 max-w-2xl">
                        {t('description')}
                    </p>
                </div>
                <p className="text-xs text-text-muted dark:text-text-muted-dark shrink-0">
                    {t('enabledCount', { count: enabledCount })}
                </p>
            </header>
            <section className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark divide-y divide-border/40 dark:divide-border-dark/40">
                {rows.length === 0 ? (
                    <div className="p-6 text-center text-xs text-text-muted dark:text-text-muted-dark">
                        {t('empty')}
                    </div>
                ) : (
                    rows.map((row) => (
                        <article key={row.agentId} className="p-4 flex items-center gap-3">
                            <div className="shrink-0 w-9 h-9 rounded-lg bg-concept-agents/10 border border-concept-agents/20 flex items-center justify-center">
                                {row.avatarMode === 'initials' ? (
                                    <span className="text-xs font-semibold text-concept-agents">
                                        {row.name.slice(0, 2).toUpperCase()}
                                    </span>
                                ) : (
                                    <Bot className="w-4 h-4 text-concept-agents" />
                                )}
                            </div>
                            <div className="min-w-0 flex-1">
                                <div className="text-sm text-text dark:text-text-dark truncate">
                                    {row.name}{' '}
                                    <span className="text-xs text-text-muted dark:text-text-muted-dark">
                                        ({row.slug})
                                    </span>
                                </div>
                                <p className="text-xs text-text-muted dark:text-text-muted-dark truncate">
                                    {row.title ?? t('noTitle')}
                                </p>
                            </div>
                            <Switch
                                checked={row.enabled}
                                disabled={togglingId === row.agentId}
                                onChange={(checked) => toggle(row.agentId, checked)}
                                data-testid={`collaborator-switch-${row.slug}`}
                            />
                        </article>
                    ))
                )}
            </section>
            <p className="text-[11px] text-text-muted dark:text-text-muted-dark">
                {t('legacyNote')}
            </p>
        </div>
    );
}
