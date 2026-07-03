import { notFound } from 'next/navigation';
import { Bot, CalendarClock, Clock, HeartPulse, Moon, TriangleAlert } from 'lucide-react';
import { agentsAPI, type Agent } from '@/lib/api/agents';
import { AgentAttachmentsPanel } from '@/components/agents/AgentAttachmentsPanel';
import { ShowDateTime } from '@/components/ui/show-datetime';

/**
 * Agents/Skills/Tasks PR #1017 — Phase 5. Dashboard tab is the
 * default landing surface for `/agents/[id]`. Surfaces an overview
 * hero (avatar + status), quick stat tiles (heartbeat, idle
 * behavior, last / next run), capabilities, and attachments.
 */

const STATUS_TONE: Record<Agent['status'], string> = {
    draft: 'bg-text-muted/10 text-text-muted',
    active: 'bg-success/10 text-success',
    paused: 'bg-warning/10 text-warning',
    running: 'bg-info/10 text-info',
    error: 'bg-danger/10 text-danger',
    archived: 'bg-text-muted/10 text-text-muted',
};

const IDLE_LABEL: Record<Agent['idleBehavior'], string> = {
    propose: 'Propose work',
    sleep: 'Sleep',
    'self-improve': 'Self improve',
};

function initialsOf(name: string): string {
    return (
        name
            .split(/\s+/)
            .map((p) => p.charAt(0))
            .join('')
            .slice(0, 2)
            .toUpperCase() || 'A'
    );
}

function StatTile({
    icon: Icon,
    label,
    children,
    accent,
}: {
    icon: typeof Clock;
    label: string;
    children: React.ReactNode;
    accent?: string;
}) {
    return (
        <div className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-4">
            <div className="flex items-center gap-2 text-text-muted dark:text-text-muted-dark">
                <Icon className={`w-3.5 h-3.5 ${accent ?? ''}`} />
                <span className="text-[11px] uppercase tracking-wide">{label}</span>
            </div>
            <div className="mt-2 text-sm font-medium text-text dark:text-text-dark truncate">
                {children}
            </div>
        </div>
    );
}

export default async function AgentDashboardPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const agent = await agentsAPI.get(id);
    if (!agent) notFound();
    // Server-fetch the attachment edges so the client panel can hydrate
    // with the existing list. Defensive `.catch` so a missing migration
    // on a stale env doesn't 500 the whole page.
    const attachments = await agentsAPI.listAttachments(id).catch(() => []);

    const runFailing = agent.errorCount > 0;

    return (
        <div className="p-6 space-y-4 max-w-screen-2xl mx-auto">
            {/* Overview hero */}
            <section className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5">
                <div className="flex items-start gap-4">
                    <div className="shrink-0 w-14 h-14 rounded-xl bg-concept-agents/10 border border-concept-agents/20 flex items-center justify-center">
                        {agent.avatarMode === 'initials' ? (
                            <span className="text-base font-semibold text-concept-agents">
                                {initialsOf(agent.name)}
                            </span>
                        ) : (
                            <Bot className="w-6 h-6 text-concept-agents" />
                        )}
                    </div>
                    <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                            <h2 className="text-lg font-semibold text-text dark:text-text-dark truncate">
                                {agent.name}
                            </h2>
                            <span
                                className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${STATUS_TONE[agent.status]}`}
                            >
                                <span className="w-1.5 h-1.5 rounded-full bg-current" />
                                {agent.status}
                            </span>
                        </div>
                        <p className="mt-0.5 text-sm text-text-muted dark:text-text-muted-dark truncate">
                            {agent.title ?? 'No title set'}
                        </p>
                        <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">
                            <span className="rounded-md bg-surface-secondary dark:bg-surface-secondary-dark px-2 py-1 capitalize text-text-secondary dark:text-text-secondary-dark">
                                {agent.scope} scope
                            </span>
                            <span className="rounded-md bg-surface-secondary dark:bg-surface-secondary-dark px-2 py-1 font-mono text-text-secondary dark:text-text-secondary-dark">
                                {agent.modelId ?? 'default model'}
                            </span>
                            <span className="rounded-md bg-surface-secondary dark:bg-surface-secondary-dark px-2 py-1 font-mono text-text-muted dark:text-text-muted-dark">
                                {agent.slug}
                            </span>
                        </div>
                    </div>
                </div>
            </section>

            {/* Quick stats */}
            <div className="grid grid-cols-2 @lg/main:grid-cols-4 gap-3">
                <StatTile icon={HeartPulse} label="Heartbeat" accent="text-danger">
                    {agent.heartbeatCadence ?? 'Manual'}
                </StatTile>
                <StatTile icon={Moon} label="Idle behavior">
                    {IDLE_LABEL[agent.idleBehavior]}
                </StatTile>
                <StatTile icon={Clock} label="Last run">
                    {agent.lastRunAt ? <ShowDateTime value={agent.lastRunAt} /> : '—'}
                </StatTile>
                <StatTile icon={CalendarClock} label="Next heartbeat">
                    {agent.nextHeartbeatAt ? <ShowDateTime value={agent.nextHeartbeatAt} /> : '—'}
                </StatTile>
            </div>

            {/* Health strip */}
            <section
                className={`flex items-center gap-3 rounded-xl border p-4 ${
                    runFailing
                        ? 'border-danger/30 bg-danger/5'
                        : 'border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark'
                }`}
            >
                <div
                    className={`shrink-0 w-9 h-9 rounded-lg flex items-center justify-center ${
                        runFailing
                            ? 'bg-danger/10 border border-danger/20'
                            : 'bg-success/10 border border-success/20'
                    }`}
                >
                    <TriangleAlert
                        className={`w-4 h-4 ${runFailing ? 'text-danger' : 'text-success'}`}
                    />
                </div>
                <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-text dark:text-text-dark">
                        {runFailing ? 'Recent runs are failing' : 'Healthy'}
                    </div>
                    <div className="text-xs text-text-muted dark:text-text-muted-dark">
                        {agent.errorCount} error{agent.errorCount === 1 ? '' : 's'} · pauses after{' '}
                        {agent.pauseAfterFailures} consecutive failure
                        {agent.pauseAfterFailures === 1 ? '' : 's'}
                        {agent.lastRunStatus ? ` · last run ${agent.lastRunStatus}` : ''}
                    </div>
                </div>
            </section>

            {/* Capabilities */}
            <section className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5">
                <div className="mb-3">
                    <h2 className="text-sm font-medium text-text dark:text-text-dark">
                        Capabilities
                    </h2>
                </div>
                {agent.capabilities ? (
                    <p className="text-sm leading-relaxed text-text-secondary dark:text-text-secondary-dark whitespace-pre-wrap">
                        {agent.capabilities}
                    </p>
                ) : (
                    <p className="text-sm text-text-muted dark:text-text-muted-dark italic">
                        No capabilities set yet.
                    </p>
                )}
            </section>

            <AgentAttachmentsPanel agentId={id} initial={attachments} />
        </div>
    );
}
