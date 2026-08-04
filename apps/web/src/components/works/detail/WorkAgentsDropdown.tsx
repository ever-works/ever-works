'use client';

import { useState, useTransition } from 'react';
import { Bot, ChevronDown, Link2, Loader2, Pause, Play, Plus, Unlink } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Link, useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import type { Agent } from '@/lib/api/agents';
import {
    pauseAgentAction,
    resumeAgentAction,
    unassignAgentFromWorkAction,
} from '@/app/actions/agents';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { AssignWorkAgentDialog } from './AssignWorkAgentDialog';

/**
 * Work header "Agents" dropdown — the visibility counterpart of the
 * header's "+ New Agent" affordance (FU-3). Two populations surface
 * here: Agents created PINNED to this Work (`scope: 'work'` +
 * `workId`), and Agents from elsewhere in the roster ASSIGNED to it via
 * their `targets`. Each row links to the Agent detail page. The list is
 * server-fetched by `works/[id]/layout.tsx` and threaded down through
 * WorkLayoutClient → WorkHeader.
 *
 * The footer carries BOTH on-ramps, because "create another Agent" is
 * the wrong default for an operator who already has a roster: "Assign
 * existing Agent" opens a picker of it (AssignWorkAgentDialog), "New
 * Agent" keeps the create flow one click away. Assigned rows can be
 * taken back off the Work from their hover action; pinned rows cannot —
 * their placement IS their scope, so it is changed by editing the Agent.
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

/**
 * The two footer actions. Same control shape as the dropdown's own
 * trigger button (h-8, rounded-lg, 12px medium label) so the popup ends
 * in something that reads as part of the header chrome rather than as
 * two more menu rows — but filled with the app's primary button tokens
 * (solid black on light, solid white on dark) so the commit actions
 * clearly outrank the navigating rows above them.
 *
 * `border` is kept, coloured to match the fill, purely so the box stays
 * the exact size of the bordered trigger it echoes.
 *
 * `data-[focus]` is Headless UI v2's keyboard-highlight hook: the base
 * `MenuItem` highlight (`bg-surface-hover`) loses to the fill below in
 * the tailwind-merge pass, so the footer restates it in its own palette.
 */
const FOOTER_ACTION_CLASS = cn(
    'flex-1 h-8 justify-center gap-1.5 rounded-lg px-2 whitespace-nowrap',
    'border border-button-primary dark:border-button-primary-dark',
    'bg-button-primary dark:bg-button-primary-dark',
    'text-[12px] font-medium text-button-primary-foreground dark:text-button-primary-foreground-dark',
    'hover:bg-button-primary-hover dark:hover:bg-button-primary-hover-dark',
    'hover:border-button-primary-hover dark:hover:border-button-primary-hover-dark',
    'data-[focus]:bg-button-primary-hover dark:data-[focus]:bg-button-primary-hover-dark',
    'cursor-pointer transition-colors',
);

/** Shared look for the hover-revealed per-row actions (pause/resume, unassign). */
const QUICK_ACTION_CLASS = cn(
    'flex h-7 w-7 items-center justify-center rounded-md border border-transparent text-text-muted dark:text-text-muted-dark transition-all',
    'opacity-0 group-hover/agent:opacity-100 focus-visible:opacity-100',
    'hover:border-border dark:hover:border-border-dark hover:text-text dark:hover:text-text-dark hover:bg-surface-hover dark:hover:bg-surface-hover-dark',
);

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
    assignedAgentIds = [],
}: {
    workId: string;
    agents: Agent[];
    /** Upstream total — may exceed agents.length when the fetch was capped. */
    total?: number;
    /** Which of `agents` are ASSIGNED (detachable) rather than pinned by scope. */
    assignedAgentIds?: string[];
}) {
    const t = useTranslations('dashboard.agentsPage.card');
    const tDropdown = useTranslations('dashboard.workDetail.agentsDropdown');
    const router = useRouter();
    // Both the row AND which of its two quick actions is in flight — a row
    // can be pausable and assigned at once, so the id alone cannot tell the
    // pause/resume button apart from the unassign button when spinning.
    const [pending, setPending] = useState<{ id: string; kind: 'status' | 'unassign' } | null>(
        null,
    );
    const [assignOpen, setAssignOpen] = useState(false);
    const [, startTransition] = useTransition();
    const agentsTotal = Math.max(total ?? agents.length, agents.length);
    const omittedCount = agentsTotal - agents.length;
    const assignedIds = new Set(assignedAgentIds);

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
        setPending({ id: agent.id, kind: 'status' });
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
                setPending(null);
            }
        });
    };

    const unassign = (agent: Agent) => {
        setPending({ id: agent.id, kind: 'unassign' });
        startTransition(async () => {
            try {
                await unassignAgentFromWorkAction(agent.id, workId);
                toast.success(tDropdown('unassignedToast', { name: agent.name }));
                router.refresh();
            } catch (error) {
                toast.error(error instanceof Error ? error.message : tDropdown('unassignFailed'));
            } finally {
                setPending(null);
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
                                const isPending = pending?.id === agent.id;
                                const isStatusPending = isPending && pending?.kind === 'status';
                                const isUnassignPending = isPending && pending?.kind === 'unassign';
                                const isAssigned = assignedIds.has(agent.id);
                                const hasQuickAction = canPause || canResume;
                                const quickActionCount =
                                    (hasQuickAction ? 1 : 0) + (isAssigned ? 1 : 0);
                                return (
                                    // The quick actions are positioned SIBLINGS of the
                                    // row Link (not children) so the DOM never nests a
                                    // button inside an anchor: the Link stays the menu
                                    // item and navigates on click/Enter, while button
                                    // clicks never reach the anchor or close the menu —
                                    // no preventDefault/stopPropagation needed.
                                    <div key={agent.id} className="group/agent relative">
                                        <DropdownMenuItem asChild>
                                            <Link
                                                href={ROUTES.DASHBOARD_AGENT(agent.id)}
                                                className={cn(
                                                    'cursor-pointer items-center gap-2.5 py-2',
                                                    quickActionCount === 1 && 'pr-10',
                                                    quickActionCount === 2 && 'pr-18',
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
                                                    <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-text-muted dark:text-text-muted-dark">
                                                        <span className="truncate">
                                                            {agent.title ?? t('noTitle')}
                                                        </span>
                                                        {isAssigned && (
                                                            <span
                                                                className="inline-flex shrink-0 items-center gap-0.5"
                                                                title={tDropdown('assignedHint')}
                                                            >
                                                                <Link2 className="h-2.5 w-2.5" />
                                                                {tDropdown('assignedLabel')}
                                                            </span>
                                                        )}
                                                    </span>
                                                </span>
                                            </Link>
                                        </DropdownMenuItem>
                                        {quickActionCount > 0 && (
                                            <div className="absolute right-2 top-1/2 z-10 flex -translate-y-1/2 items-center gap-0.5">
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
                                                            QUICK_ACTION_CLASS,
                                                            isPending && 'opacity-100',
                                                        )}
                                                    >
                                                        {isStatusPending ? (
                                                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                                        ) : canPause ? (
                                                            <Pause className="h-3.5 w-3.5" />
                                                        ) : (
                                                            <Play className="h-3.5 w-3.5" />
                                                        )}
                                                    </button>
                                                )}
                                                {/* Only ASSIGNED Agents can be taken off the
                                                    Work here — a pinned Agent's placement is
                                                    its scope, changed on the Agent itself. */}
                                                {isAssigned && (
                                                    <button
                                                        type="button"
                                                        aria-label={tDropdown('unassign')}
                                                        title={tDropdown('unassign')}
                                                        disabled={isPending}
                                                        onClick={() => unassign(agent)}
                                                        className={cn(
                                                            QUICK_ACTION_CLASS,
                                                            'hover:text-danger dark:hover:text-danger',
                                                            isPending && 'opacity-100',
                                                        )}
                                                    >
                                                        {isUnassignPending ? (
                                                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                                        ) : (
                                                            <Unlink className="h-3.5 w-3.5" />
                                                        )}
                                                    </button>
                                                )}
                                            </div>
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
                    {/* An action BAR, not two more list rows: the items above
                        navigate, these two commit a change, and matching the
                        header's own control style (same height, radius, and
                        border as the trigger) is what makes the footer read as
                        controls. Assign comes first — reusing an Agent you
                        already run is the cheaper move, and it's the one the
                        original footer hid. */}
                    <div className="flex items-center gap-1.5">
                        <DropdownMenuItem
                            onClick={() => setAssignOpen(true)}
                            className={FOOTER_ACTION_CLASS}
                        >
                            <Link2 className="h-3.5 w-3.5 shrink-0" />
                            {tDropdown('assignExisting')}
                        </DropdownMenuItem>
                        <DropdownMenuItem asChild>
                            <Link
                                href={`/works/${workId}/agents/new`}
                                className={FOOTER_ACTION_CLASS}
                            >
                                <Plus className="h-3.5 w-3.5 shrink-0" />
                                {tDropdown('newAgent')}
                            </Link>
                        </DropdownMenuItem>
                    </div>
                </DropdownMenuContent>
            </DropdownMenu>
            <AssignWorkAgentDialog workId={workId} open={assignOpen} onOpenChange={setAssignOpen} />
        </span>
    );
}
