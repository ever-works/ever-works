'use client';

import { useState } from 'react';
import { Archive, ArchiveRestore, MoreHorizontal, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useRouter } from '@/i18n/navigation';
import { PageHeader } from '@/components/common/PageHeader';
import { unarchiveAgentAction } from '@/app/actions/agents';
import { AgentCard } from './AgentCard';
import { DeleteAgentDialog } from './DeleteAgentDialog';
import type { Agent } from '@/lib/api/agents';

/**
 * `/agents/archived` — the archived Agents the catalog filters out
 * (`AgentRepository.findByUserIdScoped` excludes `status='archived'`
 * unless the caller asks for it explicitly).
 *
 * Per-card ⋯ menu carries the two moves available to an archived
 * Agent: restore it (ARCHIVED → PAUSED) or delete it for good.
 */
export function ArchivedAgentsList({ agents }: { agents: Agent[] }) {
    const t = useTranslations('dashboard.agentsPage.archived');
    const router = useRouter();
    const [pendingDelete, setPendingDelete] = useState<Agent | null>(null);
    // Which row is mid-restore — the menu item is disabled for that
    // row only, so a slow call can't be double-submitted while the
    // other cards stay usable.
    const [restoringId, setRestoringId] = useState<string | null>(null);

    const unarchive = async (agent: Agent) => {
        if (restoringId) return;
        setRestoringId(agent.id);
        try {
            await unarchiveAgentAction(agent.id);
            toast.success(t('unarchiveSuccess', { name: agent.name }));
            router.refresh();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : t('unarchiveError'));
        } finally {
            setRestoringId(null);
        }
    };

    return (
        <div className="w-full">
            <PageHeader icon={Archive} title={t('title')} subtitle={t('subtitle')} tone="agent" />

            {agents.length === 0 ? (
                <div className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-6">
                    <p className="text-sm text-text dark:text-text-dark">{t('empty.title')}</p>
                    <p className="text-xs text-text-muted dark:text-text-muted-dark mt-1 max-w-2xl">
                        {t('empty.subtitle')}
                    </p>
                </div>
            ) : (
                <div
                    className="grid grid-cols-1 @lg/main:grid-cols-2 @3xl/main:grid-cols-3 gap-4"
                    data-testid="archived-agents-grid"
                >
                    {agents.map((agent) => (
                        <AgentCard
                            key={agent.id}
                            agent={agent}
                            actions={
                                <DropdownMenu>
                                    <DropdownMenuTrigger
                                        className="h-6 w-6 rounded text-text-muted hover:bg-surface-secondary hover:text-text dark:text-text-muted-dark dark:hover:bg-surface-secondary-dark dark:hover:text-text-dark transition-colors"
                                        aria-label={t('menuAria', { name: agent.name })}
                                    >
                                        <span data-testid={`archived-agent-menu-${agent.id}`}>
                                            <MoreHorizontal className="h-3.5 w-3.5" />
                                        </span>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="end" className="min-w-[10rem]">
                                        <DropdownMenuItem
                                            onClick={() => void unarchive(agent)}
                                            disabled={restoringId === agent.id}
                                            className="gap-2 py-1 text-xs"
                                        >
                                            <ArchiveRestore className="h-3.5 w-3.5" />
                                            {t('unarchive')}
                                        </DropdownMenuItem>
                                        <DropdownMenuSeparator />
                                        <DropdownMenuItem
                                            onClick={() => setPendingDelete(agent)}
                                            className="gap-2 py-1 text-xs text-danger"
                                        >
                                            <Trash2 className="h-3.5 w-3.5" />
                                            {t('delete')}
                                        </DropdownMenuItem>
                                    </DropdownMenuContent>
                                </DropdownMenu>
                            }
                        />
                    ))}
                </div>
            )}

            {pendingDelete ? (
                <DeleteAgentDialog
                    agent={pendingDelete}
                    open
                    onOpenChange={(open) => {
                        if (!open) setPendingDelete(null);
                    }}
                    onDeleted={() => {
                        setPendingDelete(null);
                        router.refresh();
                    }}
                />
            ) : null}
        </div>
    );
}
