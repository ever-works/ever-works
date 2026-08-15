import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { ArrowLeft } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { agentsAPI } from '@/lib/api/agents';
import { tasksAPI } from '@/lib/api/tasks';
import { SessionDetailClient } from '@/components/agents/SessionDetailClient';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('dashboard.agentsPage.sessions.detail');
    return { title: t('title') };
}

/**
 * Session detail (Feature K) — `/agents/sessions/[runId]`, the drill-in
 * behind each Sessions row. The detail endpoint is addressed by runId
 * alone and scoped to the acting user API-side, so a cross-user (or
 * unknown) run renders the 404 page — the authorization decision is the
 * API's, this page just translates it.
 *
 * The agent name + task title are resolved server-side once, defensively:
 * a missing agent (hard-deleted after the run) degrades to a short-id
 * label rather than a 500, matching the Sessions list's posture.
 */
export default async function AgentSessionDetailPage({
    params,
}: {
    params: Promise<{ runId: string }>;
}) {
    const { runId } = await params;
    const detail = await agentsAPI.getSessionDetail(runId).catch(() => null);
    if (!detail) notFound();

    const [agent, task] = await Promise.all([
        agentsAPI.get(detail.run.agentId).catch(() => null),
        detail.run.taskId ? tasksAPI.get(detail.run.taskId).catch(() => null) : null,
    ]);
    const agentName = agent?.name ?? `${detail.run.agentId.slice(0, 8)}…`;

    const t = await getTranslations('dashboard.agentsPage.sessions.detail');

    return (
        <div className="w-full space-y-4">
            <div>
                <Link
                    href={ROUTES.DASHBOARD_AGENT_SESSIONS}
                    className="inline-flex items-center gap-1 text-xs text-text-secondary dark:text-text-secondary-dark hover:text-text dark:hover:text-text-dark"
                    data-testid="session-detail-back"
                >
                    <ArrowLeft className="w-3.5 h-3.5" aria-hidden />
                    {t('backToSessions')}
                </Link>
                <h1 className="mt-1 text-2xl font-semibold text-text dark:text-text-dark">
                    {agentName}
                </h1>
            </div>
            <SessionDetailClient
                initialDetail={detail}
                agentName={agentName}
                taskTitle={task?.title ?? null}
            />
        </div>
    );
}
