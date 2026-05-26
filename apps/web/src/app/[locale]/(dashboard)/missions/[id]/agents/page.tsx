import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Link } from '@/i18n/navigation';
import { Bot, Plus } from 'lucide-react';
import { ROUTES } from '@/lib/constants';
import { agentsAPI } from '@/lib/api/agents';
import { missionsAPI } from '@/lib/api/missions';

type Params = Promise<{ id: string; locale: string }>;

export async function generateMetadata(): Promise<Metadata> {
    return { title: 'Agents — Mission' };
}

/**
 * FU-3 review fix (greptile P2): the Agents tab on MissionTabs
 * previously routed straight to `/agents/new`, which conflicted with
 * the tab metaphor (clicking opens a wizard, not a list). This page
 * is the canonical listing — Mission-scoped Agents owned by the
 * current user. The "+ New" affordance still routes to
 * `/missions/[id]/agents/new` so the create flow remains one click
 * away.
 */
export default async function MissionAgentsListPage({ params }: { params: Params }) {
    const { id } = await params;
    const mission = await missionsAPI.get(id);
    if (!mission) notFound();

    const { data: agents } = await agentsAPI
        .list({ scope: 'mission', missionId: id, limit: 100 })
        .catch(() => ({
            data: [] as Awaited<ReturnType<typeof agentsAPI.list>>['data'],
            meta: { total: 0, limit: 100, offset: 0 },
        }));

    return (
        <div className="p-6 max-w-screen-2xl mx-auto space-y-4">
            <header className="flex items-center justify-between">
                <div>
                    <h2 className="text-sm font-medium text-text dark:text-text-dark">Agents</h2>
                    <p className="text-xs text-text-muted dark:text-text-muted-dark mt-1">
                        Agents scoped to this Mission.
                    </p>
                </div>
                <Link
                    href={`/missions/${id}/agents/new`}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-border dark:border-border-dark px-3 h-8 text-[12px] font-medium text-text-secondary dark:text-text-secondary-dark hover:border-primary/40 hover:text-primary dark:hover:text-primary transition-colors"
                >
                    <Plus className="w-3.5 h-3.5" />
                    New Agent
                </Link>
            </header>

            {agents.length === 0 ? (
                <div className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-6 text-sm text-text-muted dark:text-text-muted-dark">
                    No Agents scoped to this Mission yet.
                </div>
            ) : (
                <ul className="grid grid-cols-1 @lg/main:grid-cols-2 @3xl/main:grid-cols-3 gap-4">
                    {agents.map((a) => (
                        <li key={a.id}>
                            <Link
                                href={ROUTES.DASHBOARD_AGENT(a.id)}
                                className="block rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-4 hover:border-primary/40 transition-colors"
                            >
                                <div className="flex items-center gap-2 text-xs text-text-muted">
                                    <Bot className="w-3.5 h-3.5" />
                                    <span className="font-mono">{a.slug}</span>
                                </div>
                                <div className="text-sm font-medium text-text dark:text-text-dark mt-1.5">
                                    {a.name}
                                </div>
                                {a.title && (
                                    <div className="text-xs text-text-secondary mt-0.5">
                                        {a.title}
                                    </div>
                                )}
                                <div className="text-[10px] uppercase tracking-wide text-text-muted mt-2">
                                    {a.status}
                                </div>
                            </Link>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
