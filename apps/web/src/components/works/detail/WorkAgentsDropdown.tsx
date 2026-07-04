'use client';

import { Bot, ChevronDown, Plus } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import type { Agent } from '@/lib/api/agents';
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
 */

const STATUS_DOT_CLASS: Record<Agent['status'], string> = {
    draft: 'bg-text-muted/60',
    active: 'bg-success',
    paused: 'bg-warning',
    running: 'bg-info',
    error: 'bg-danger',
    archived: 'bg-text-muted/60',
};

export function WorkAgentsDropdown({ workId, agents }: { workId: string; agents: Agent[] }) {
    return (
        <span className="inline-flex">
            <DropdownMenu>
                <DropdownMenuTrigger
                    className="gap-1.5 rounded-lg border border-border dark:border-border-dark px-3 h-8 text-[12px] font-medium text-text-secondary dark:text-text-secondary-dark hover:border-primary/40 hover:text-primary dark:hover:text-primary transition-colors"
                    aria-label="Agents for this Work"
                >
                    <Bot className="w-3.5 h-3.5" />
                    Agents
                    {agents.length > 0 && (
                        <span className="rounded-full bg-black/5 px-1.5 text-[10px] tabular-nums dark:bg-white/8">
                            {agents.length}
                        </span>
                    )}
                    <ChevronDown className="w-3 h-3 opacity-60" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-72">
                    <DropdownMenuLabel className="text-xs font-medium text-text-muted dark:text-text-muted-dark">
                        Agents for this Work
                    </DropdownMenuLabel>
                    {agents.length === 0 ? (
                        <div className="px-2 py-2 text-xs text-text-muted dark:text-text-muted-dark">
                            No Agents scoped to this Work yet.
                        </div>
                    ) : (
                        agents.map((agent) => (
                            <DropdownMenuItem key={agent.id} asChild>
                                <Link
                                    href={ROUTES.DASHBOARD_AGENT(agent.id)}
                                    className="cursor-pointer gap-2"
                                >
                                    <span
                                        className={cn(
                                            'w-1.5 h-1.5 rounded-full shrink-0',
                                            STATUS_DOT_CLASS[agent.status],
                                        )}
                                        title={agent.status}
                                    />
                                    <span className="min-w-0 flex-1">
                                        <span className="block truncate text-sm text-text dark:text-text-dark">
                                            {agent.name}
                                        </span>
                                        {agent.title && (
                                            <span className="block truncate text-[11px] text-text-muted dark:text-text-muted-dark">
                                                {agent.title}
                                            </span>
                                        )}
                                    </span>
                                </Link>
                            </DropdownMenuItem>
                        ))
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem asChild>
                        <Link
                            href={`/works/${workId}/agents/new`}
                            className="cursor-pointer gap-2 text-sm text-text-secondary dark:text-text-secondary-dark"
                        >
                            <Plus className="w-3.5 h-3.5 shrink-0" />
                            New Agent
                        </Link>
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        </span>
    );
}
