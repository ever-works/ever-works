import { getLocale } from 'next-intl/server';
import { redirect } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';

/**
 * `/agents/sessions` — RETIRED as a tab. It was the hub's "Sessions" tab, and
 * it is now the **Activity** sub-tab of the Agents tab (`/agents/activity`),
 * where it sits beside the Skills catalog and carries a second view: the same
 * runs on the Day / Week / Month ledger, with totals and a receipt each.
 *
 * Kept as a redirect rather than deleted so every bookmark, notification deep
 * link, task link, help article and e2e journey written against it keeps
 * working. Its detail route redirects too (`/agents/sessions/<id>` →
 * `/agents/activity/<id>`).
 */
export default async function AgentSessionsRedirect() {
    const locale = await getLocale();
    redirect({ href: ROUTES.DASHBOARD_AGENTS_ACTIVITY, locale });
}
