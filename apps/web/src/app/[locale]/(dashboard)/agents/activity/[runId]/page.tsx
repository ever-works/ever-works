import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { ArrowLeft } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { agentsAPI } from '@/lib/api/agents';
import { tasksAPI } from '@/lib/api/tasks';
import { runsAPI } from '@/lib/api/runs';
import { SessionDetailClient } from '@/components/agents/SessionDetailClient';
import { RunReceiptView } from '@/components/runs/RunReceiptView';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('dashboard.agentsPage.sessions.detail');
    return { title: t('title') };
}

/**
 * Session detail (Feature K) — `/agents/activity/[runId]`, the drill-in behind
 * each row of the Agents hub's Activity tab (Sessions view). The detail
 * endpoint is addressed by runId alone and scoped to the acting user API-side,
 * so a cross-user (or unknown) run renders the 404 page — the authorization
 * decision is the API's, this page just translates it.
 *
 * The path moved from `/agents/sessions/[runId]` when the hub's Sessions tab
 * became the Activity sub-tab. The old path still resolves:
 * `/agents/sessions/[runId]` redirects here, carrying its id.
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

    // Runs ledger (AW-09) — the run's receipt (cost from the same usage rows
    // the Costs dashboard reads, related work, cited knowledge) rides along
    // below the session. Defensive like the other two reads: a receipt that
    // cannot load simply is not shown, the session renders unchanged.
    const [agent, task, receipt] = await Promise.all([
        agentsAPI.get(detail.run.agentId).catch(() => null),
        detail.run.taskId ? tasksAPI.get(detail.run.taskId).catch(() => null) : null,
        runsAPI.receipt(runId).catch(() => null),
    ]);
    const agentName = agent?.name ?? `${detail.run.agentId.slice(0, 8)}…`;

    const t = await getTranslations('dashboard.agentsPage.sessions.detail');

    return (
        <div className="w-full space-y-4">
            <div>
                <Link
                    href={ROUTES.DASHBOARD_AGENTS_ACTIVITY}
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
            {receipt && (
                <section
                    className="rounded-lg border border-border/60 dark:border-border-dark/60 p-4 space-y-3"
                    data-testid="session-detail-receipt"
                >
                    <h2 className="text-sm font-semibold text-text dark:text-text-dark">
                        {t('receiptHeading')}
                    </h2>
                    <RunReceiptView receipt={receipt} showSessionLink={false} />
                </section>
            )}
        </div>
    );
}
