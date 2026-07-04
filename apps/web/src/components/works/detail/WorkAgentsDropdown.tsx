'use client';

import { useState, useTransition } from 'react';
import { Bot, ChevronDown, Loader2, Pause, Play, Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Link, useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import type { Agent } from '@/lib/api/agents';
import { pauseAgentAction, resumeAgentAction } from '@/app/actions/agents';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/**
 * Work header "Agents" dropdown — the visibility counterpart of the
 * header's "+ New Agent" affordance (FU-3). Agents created pinned to
 * this Work (`scope: 'work'` + `workId`) surface here; each row links
 * to the Agent detail page and the footer keeps the create flow one
 * click away. The list is server-fetched by `works/[id]/layout.tsx`
 * and threaded down through WorkLayoutClient → WorkHeader.
 *
 * Rows reuse the AgentCard design language (bot avatar tile tinted by
 * the Agent's status tone, tone-mapped status badge with the translated
 * `agentsPage.card.status*` labels) and expose a hover pause/resume
 * quick action mirroring the AgentSettingsClient semantics: pause is
 * offered for `active`, resume for `draft`/`paused`/`error`. All other
 * copy lives under `dashboard.workDetail.agentsDropdown`.
 */

const STATUS_BADGE_CLASS: Record<Agent['status'], string> = {
    draft: 'bg-text-muted/10 text-text-muted',
    active: 'bg-success/10 text-success',
    paused: 'bg-warning/10 text-warning',
    running: 'bg-info/10 text-info',
    error: 'bg-danger/10 text-danger',
    archived: 'bg-text-muted/10 text-text-muted',
};

const STATUS_DOT_CLASS: Record<Agent['status'], string> = {
    draft: 'bg-text-muted/60',
    active: 'bg-success',
    paused: 'bg-warning',
    running: 'bg-info animate-pulse',
    error: 'bg-danger',
    archived: 'bg-text-muted/60',
};

const STATUS_AVATAR_CLASS: Record<Agent['status'], string> = {
    draft: 'bg-text-muted/10 border-text-muted/20 text-text-muted',
    active: 'bg-success/10 border-success/20 text-success',
    paused: 'bg-warning/10 border-warning/20 text-warning',
    running: 'bg-info/10 border-info/20 text-info',
    error: 'bg-danger/10 border-danger/20 text-danger',
    archived: 'bg-text-muted/10 border-text-muted/20 text-text-muted',
};

export function WorkAgentsDropdown({
    workId,
    agents,
    total,
}: {
    workId: string;
    agents: Agent[];
    /** Upstream total — may exceed agents.length when the fetch was capped. */
    total?: number;
}) {
    const t = useTranslations('dashboard.agentsPage.card');
    const tDropdown = useTranslations('dashboard.workDetail.agentsDropdown');
    const router = useRouter();
    const [pendingId, setPendingId] = useState<string | null>(null);
    const [, startTransition] = useTransition();
    const agentsTotal = Math.max(total ?? agents.length, agents.length);
    const omittedCount = agentsTotal - agents.length;

    const statusLabel: Record<Agent['status'], string> = {
        draft: t('statusDraft'),
        active: t('statusActive'),
        paused: t('statusPaused'),
        running: t('statusRunning'),
        error: t('statusError'),
        archived: t('statusArchived'),
    };

    const toggleStatus = (agent: Agent) => {
        const action = agent.status === 'active' ? 'pause' : 'resume';
        setPendingId(agent.id);
        startTransition(async () => {
            try {
                if (action === 'pause') {
                    await pauseAgentAction(agent.id);
                    toast.success(tDropdown('pausedToast'));
                } else {
                    await resumeAgentAction(agent.id);
                    toast.success(tDropdown('activatedToast'));
                }
                router.refresh();
            } catch (error) {
                toast.error(
                    error instanceof Error ? error.message : tDropdown('statusUpdateFailed'),
                );
            } finally {
                setPendingId(null);
            }
        });
    };

    return (
        <span className="inline-flex">
            <DropdownMenu>
                <DropdownMenuTrigger
                    className="gap-1.5 rounded-lg border border-border dark:border-border-dark px-3 h-8 text-[12px] font-medium text-text-secondary dark:text-text-secondary-dark hover:border-border-hover dark:hover:border-border-hover-dark hover:text-text dark:hover:text-text-dark outline-none focus:outline-none focus-visible:border-border-hover dark:focus-visible:border-border-hover-dark transition-colors"
                    aria-label={tDropdown('heading')}
                >
                    <Bot className="w-3.5 h-3.5" />
                    {tDropdown('trigger')}
                    {agentsTotal > 0 && (
                        <span className="rounded-full bg-black/5 px-1.5 text-[10px] tabular-nums dark:bg-white/8">
                            {agentsTotal}
                        </span>
                    )}
                    <ChevronDown className="w-3 h-3 opacity-60" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-80">
                    <DropdownMenuLabel className="text-[11px] font-medium uppercase tracking-wide text-text-muted dark:text-text-muted-dark">
                        {tDropdown('heading')}
                    </DropdownMenuLabel>
                    <div className="max-h-80 overflow-y-auto">
                        {agents.length === 0 ? (
                            <div className="px-2 py-6 text-center">
                                <div className="mx-auto mb-2 flex h-9 w-9 items-center justify-center rounded-lg bg-concept-agents/10 border border-concept-agents/20">
                                    <Bot className="h-4 w-4 text-concept-agents" />
                                </div>
                                <p className="text-sm text-text dark:text-text-dark">
                                    {tDropdown('emptyTitle')}
                                </p>
                                <p className="mt-0.5 text-xs text-text-muted dark:text-text-muted-dark">
                                    {tDropdown('emptySubtitle')}
                                </p>
                            </div>
                        ) : (
                            agents.map((agent) => {
                                const canPause = agent.status === 'active';
                                const canResume =
                                    agent.status === 'draft' ||
                                    agent.status === 'paused' ||
                                    agent.status === 'error';
                                const isPending = pendingId === agent.id;
                                const hasQuickAction = canPause || canResume;
                                return (
                                    // The quick action is a positioned SIBLING of the row
                                    // Link (not a child) so the DOM never nests a button
                                    // inside an anchor: the Link stays the menu item and
                                    // navigates on click/Enter, while button clicks never
                                    // reach the anchor or close the menu — no
                                    // preventDefault/stopPropagation needed.
                                    <div key={agent.id} className="group/agent relative">
                                        <DropdownMenuItem asChild>
                                            <Link
                                                href={ROUTES.DASHBOARD_AGENT(agent.id)}
                                                className={cn(
                                                    'cursor-pointer items-center gap-2.5 py-2',
                                                    hasQuickAction && 'pr-10',
                                                )}
                                            >
                                                <span
                                                    className={cn(
                                                        'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border',
                                                        STATUS_AVATAR_CLASS[agent.status],
                                                    )}
                                                >
                                                    <Bot className="h-3.5 w-3.5" />
                                                </span>
                                                <span className="min-w-0 flex-1">
                                                    <span className="flex items-center gap-2">
                                                        <span className="truncate text-sm font-medium text-text dark:text-text-dark">
                                                            {agent.name}
                                                        </span>
                                                        <span
                                                            className={cn(
                                                                'inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-px text-[8px] font-medium uppercase tracking-wide',
                                                                STATUS_BADGE_CLASS[agent.status],
                                                            )}
                                                        >
                                                            <span
                                                                className={cn(
                                                                    'h-1 w-1 rounded-full',
                                                                    STATUS_DOT_CLASS[agent.status],
                                                                )}
                                                            />
                                                            {statusLabel[agent.status]}
                                                        </span>
                                                    </span>
                                                    <span className="mt-0.5 block truncate text-[11px] text-text-muted dark:text-text-muted-dark">
                                                        {agent.title ?? t('noTitle')}
                                                    </span>
                                                </span>
                                            </Link>
                                        </DropdownMenuItem>
                                        {hasQuickAction && (
                                            <button
                                                type="button"
                                                aria-label={
                                                    canPause
                                                        ? tDropdown('pause')
                                                        : tDropdown('activate')
                                                }
                                                title={
                                                    canPause
                                                        ? tDropdown('pause')
                                                        : tDropdown('activate')
                                                }
                                                disabled={isPending}
                                                onClick={() => toggleStatus(agent)}
                                                className={cn(
                                                    'absolute right-2 top-1/2 z-10 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md border border-transparent text-text-muted dark:text-text-muted-dark transition-all',
                                                    'opacity-0 group-hover/agent:opacity-100 focus-visible:opacity-100',
                                                    'hover:border-border dark:hover:border-border-dark hover:text-text dark:hover:text-text-dark hover:bg-surface-hover dark:hover:bg-surface-hover-dark',
                                                    isPending && 'opacity-100',
                                                )}
                                            >
                                                {isPending ? (
                                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                                ) : canPause ? (
                                                    <Pause className="h-3.5 w-3.5" />
                                                ) : (
                                                    <Play className="h-3.5 w-3.5" />
                                                )}
                                            </button>
                                        )}
                                    </div>
                                );
                            })
                        )}
                        {omittedCount > 0 && (
                            <DropdownMenuItem asChild>
                                <Link
                                    href={ROUTES.DASHBOARD_AGENTS}
                                    className="cursor-pointer justify-center text-xs text-text-muted dark:text-text-muted-dark"
                                >
                                    {tDropdown('moreAgents', { count: omittedCount })}
                                </Link>
                            </DropdownMenuItem>
                        )}
                    </div>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem asChild>
                        <Link
                            href={`/works/${workId}/agents/new`}
                            className="cursor-pointer gap-2 text-sm font-medium text-text-secondary dark:text-text-secondary-dark"
                        >
                            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-dashed border-border dark:border-border-dark">
                                <Plus className="h-3.5 w-3.5" />
                            </span>
                            {tDropdown('newAgent')}
                        </Link>
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        </span>
    );
}
