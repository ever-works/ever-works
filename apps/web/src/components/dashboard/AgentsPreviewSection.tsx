import { Bot, Plus } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import type { Agent } from '@/lib/api/agents';

/**
 * Dashboard polish (2026-05-27) — Agents preview block. Sits below
 * the Tasks section on the home page so the dashboard now reads:
 *   Missions → Ideas → Works → Tasks → Agents.
 *
 * Mirrors `MissionsPreviewSection`: header with icon tile + title +
 * `+ Add` + `View all (N) →`, body is a 3-up grid of compact Agent
 * cards. Avatar/status/scope chips reuse the same vocabulary as
 * `AgentCard` so the preview reads as a prefix of `/agents`.
 *
 * Defensive: degrades to a small "Create an Agent" empty state so a
 * fresh account doesn't see a shouty empty grid.
 */
const PREVIEW_LIMIT = 3;

interface AgentsPreviewSectionProps {
    agents: Agent[];
    totalAgents: number;
}

export function AgentsPreviewSection({ agents, totalAgents }: AgentsPreviewSectionProps) {
    const previewAgents = agents.slice(0, PREVIEW_LIMIT);
    return (
        <section className="mt-8" aria-labelledby="agents-preview-heading">
            <div className="flex flex-nowrap items-center justify-between gap-3 mb-4">
                <div className="flex items-center gap-2 min-w-0">
                    <div className="shrink-0 w-9 h-9 rounded-lg bg-concept-agents/10 border border-concept-agents/20 flex items-center justify-center">
                        <Bot className="w-4 h-4 text-concept-agents" />
                    </div>
                    <h2
                        id="agents-preview-heading"
                        className="text-xl font-semibold text-text dark:text-text-dark truncate"
                    >
                        Agents
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
                        Add
                    </Link>
                    {totalAgents > 0 && (
                        <Link
                            href={ROUTES.DASHBOARD_AGENTS}
                            className="text-sm font-medium text-primary hover:underline inline-flex items-center gap-1 whitespace-nowrap"
                        >
                            View all ({totalAgents}) →
                        </Link>
                    )}
                </div>
            </div>

            {previewAgents.length === 0 ? (
                <div className="rounded-lg p-5 bg-card dark:bg-card-primary-dark/70 border border-card-border dark:border-white/9 text-sm text-text-secondary dark:text-text-secondary-dark">
                    <p>No Agents yet.</p>
                    <p className="mt-1 text-xs">
                        <Link
                            href={ROUTES.DASHBOARD_AGENT_NEW}
                            className="text-primary hover:underline"
                        >
                            Create your first Agent
                        </Link>{' '}
                        to delegate recurring work.
                    </p>
                </div>
            ) : (
                <div className="grid grid-cols-1 @lg/main:grid-cols-2 @3xl/main:grid-cols-3 gap-4">
                    {previewAgents.map((a) => (
                        <AgentPreviewCard key={a.id} agent={a} />
                    ))}
                </div>
            )}
        </section>
    );
}

const STATUS_TONES: Record<Agent['status'], string> = {
    draft: 'bg-text-muted/10 text-text-muted',
    active: 'bg-success/10 text-success',
    paused: 'bg-warning/10 text-warning',
    running: 'bg-info/10 text-info',
    error: 'bg-danger/10 text-danger',
    archived: 'bg-text-muted/10 text-text-muted',
};

const SCOPE_LABELS: Record<Agent['scope'], string> = {
    tenant: 'Workspace',
    mission: 'Mission',
    work: 'Work',
    idea: 'Idea',
};

function AgentPreviewCard({ agent }: { agent: Agent }) {
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
                'group relative flex min-h-[8rem] flex-col overflow-hidden rounded-lg p-4 shadow-xs',
                'bg-card dark:bg-card-primary-dark/70',
                'border border-card-border dark:border-white/9',
                'hover:border-primary-500/50 dark:hover:border-white/20',
                'transition-colors no-underline',
            )}
        >
            <div className="flex items-start gap-2 min-w-0">
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
                            className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded shrink-0 ${STATUS_TONES[agent.status]}`}
                        >
                            {agent.status}
                        </span>
                    </div>
                    {agent.title ? (
                        <p className="text-xs text-text-muted dark:text-text-muted-dark mt-1 truncate">
                            {agent.title}
                        </p>
                    ) : null}
                </div>
            </div>
            <div className="mt-auto flex flex-wrap items-center gap-2 pt-3 text-[11px] text-text-secondary dark:text-text-secondary-dark">
                <span className="px-1.5 py-0.5 rounded bg-surface-secondary dark:bg-surface-secondary-dark">
                    {SCOPE_LABELS[agent.scope]}
                </span>
                {agent.heartbeatCadence ? (
                    <span className="truncate">every {agent.heartbeatCadence}</span>
                ) : null}
            </div>
        </Link>
    );
}
