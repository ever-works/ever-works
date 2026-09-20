import { getLocale } from 'next-intl/server';
import { redirect } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';

/**
 * `/agents/sessions/[runId]` — RETIRED as a path. The session drill-in now
 * lives under the Activity sub-tab, so `/agents/activity/[runId]`.
 *
 * Kept as a redirect rather than deleted: the run id is the only thing the URL
 * carried, so forwarding it lands the reader on exactly the session they
 * clicked — including from the Live Feed, whose `run` targets were written
 * against this shape before the tab was renamed.
 */
export default async function AgentSessionDetailRedirect({
    params,
}: {
    params: Promise<{ runId: string }>;
}) {
    const { runId } = await params;
    const locale = await getLocale();
    redirect({ href: ROUTES.DASHBOARD_AGENT_SESSION(runId), locale });
}
