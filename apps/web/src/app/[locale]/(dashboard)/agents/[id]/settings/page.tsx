import { notFound } from 'next/navigation';
import { agentsAPI } from '@/lib/api/agents';

/**
 * Agents/Skills/Tasks PR #1017 — Phase 5. Read-only Settings
 * panel for v1. Editing (permissions matrix, heartbeat cadence,
 * idle behavior, pause-after-failures, archive / hard-delete)
 * lands in a later sub-tick once the shared Form primitives are
 * extracted from the Mission settings surface.
 */
export default async function AgentSettingsPage({
    params,
}: {
    params: Promise<{ id: string }>;
}) {
    const { id } = await params;
    const agent = await agentsAPI.get(id);
    if (!agent) notFound();

    return (
        <div className="p-6 max-w-screen-2xl mx-auto space-y-4">
            <section className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5">
                <h2 className="text-sm font-medium text-text dark:text-text-dark mb-3">
                    Identity
                </h2>
                <dl className="grid grid-cols-2 gap-4 text-xs">
                    <div>
                        <dt className="text-text-muted">Slug</dt>
                        <dd className="text-text dark:text-text-dark font-mono">{agent.slug}</dd>
                    </div>
                    <div>
                        <dt className="text-text-muted">Scope</dt>
                        <dd className="text-text dark:text-text-dark capitalize">{agent.scope}</dd>
                    </div>
                </dl>
            </section>
            <section className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5">
                <h2 className="text-sm font-medium text-text dark:text-text-dark mb-3">
                    Permissions
                </h2>
                <ul className="grid grid-cols-2 gap-2 text-xs">
                    {Object.entries(agent.permissions).map(([k, v]) => (
                        <li key={k} className="flex items-center gap-2">
                            <span
                                className={`inline-block w-1.5 h-1.5 rounded-full ${v ? 'bg-success' : 'bg-text-muted/40'}`}
                            />
                            <span className="text-text-secondary dark:text-text-secondary-dark">
                                {k}
                            </span>
                        </li>
                    ))}
                </ul>
            </section>
        </div>
    );
}
