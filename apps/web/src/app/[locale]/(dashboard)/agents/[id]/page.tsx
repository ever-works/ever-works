import { agentsAPI } from '@/lib/api/agents';
import { notFound } from 'next/navigation';

/**
 * Agents/Skills/Tasks PR #1017 — Phase 5. Dashboard tab is the
 * default landing surface for `/agents/[id]`. v1 is a placeholder
 * — real summary tiles (status, last run, due next, current
 * budget consumption) land in a later sub-tick once the run /
 * heartbeat dispatcher ships in Phase 6.
 */
export default async function AgentDashboardPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const agent = await agentsAPI.get(id);
    if (!agent) notFound();

    return (
        <div className="p-6 space-y-4 max-w-screen-2xl mx-auto">
            <section className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5">
                <h2 className="text-sm font-medium text-text dark:text-text-dark mb-3">Summary</h2>
                <dl className="grid grid-cols-2 @lg/main:grid-cols-4 gap-4 text-xs">
                    <div>
                        <dt className="text-text-muted">Scope</dt>
                        <dd className="text-text dark:text-text-dark capitalize">{agent.scope}</dd>
                    </div>
                    <div>
                        <dt className="text-text-muted">Status</dt>
                        <dd className="text-text dark:text-text-dark capitalize">{agent.status}</dd>
                    </div>
                    <div>
                        <dt className="text-text-muted">Heartbeat</dt>
                        <dd className="text-text dark:text-text-dark">
                            {agent.heartbeatCadence ?? '—'}
                        </dd>
                    </div>
                    <div>
                        <dt className="text-text-muted">Last run</dt>
                        <dd className="text-text dark:text-text-dark">{agent.lastRunAt ?? '—'}</dd>
                    </div>
                </dl>
            </section>
            <section className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5">
                <h2 className="text-sm font-medium text-text dark:text-text-dark mb-3">
                    Capabilities
                </h2>
                <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                    {agent.capabilities ?? 'No capabilities set yet.'}
                </p>
            </section>
        </div>
    );
}
