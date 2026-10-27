import 'server-only';
import { getTranslations } from 'next-intl/server';
import { ArrowLeft } from 'lucide-react';
import type { FleetNodeView, FleetSessionView } from '@ever-works/contracts';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { agentsAPI } from '@/lib/api/agents';
import { fleetAPI } from '@/lib/api/fleet';
import { fleetSessionsAPI } from '@/lib/api/fleet-sessions';
import { getAuthFromCookie } from '@/lib/auth';
import type { FleetSessionPageProps } from '../registry';
import { SessionDetailClient } from './SessionDetailClient';

/**
 * Sessions on computers (FL-04 P1b, spec §5.4) — `/fleet/sessions/[id]`, one
 * session's page, as FL-01's route renders it once FL-04 registered it.
 *
 * Reads, in parallel and each `.catch()`-ed (one failing read never takes the
 * page down): the session (with its last screen when ended and who is
 * attached when live), its computer, and the signed-in person. P2 adds the
 * Agent, P3 the recording manifest. A session the person may not see reads
 * exactly like one that does not exist.
 */
export default async function SessionPage({ sessionId }: FleetSessionPageProps) {
    const t = await getTranslations('fleet.sessions');
    const session: FleetSessionView | null = await fleetSessionsAPI
        .get(sessionId)
        .catch(() => null);
    const [detail, user, agent] = await Promise.all([
        session ? fleetAPI.nodeDetail(session.nodeId).catch(() => null) : Promise.resolve(null),
        getAuthFromCookie().catch(() => null),
        // P2: the Agent of an Agent session (its name in the footer and the end dialog).
        session?.agentId ? agentsAPI.get(session.agentId).catch(() => null) : Promise.resolve(null),
    ]);
    const node: FleetNodeView | null = detail?.node ?? null;

    if (!session) {
        return (
            <div
                className="w-full space-y-6"
                data-testid="fleet-session-page"
                data-state="not-found"
            >
                <Link
                    href={ROUTES.DASHBOARD_FLEET}
                    className="inline-flex items-center gap-1 text-sm text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark"
                >
                    <ArrowLeft className="w-4 h-4" aria-hidden="true" />
                    {t('detail.back')}
                </Link>
                <p role="status" className="text-sm text-text dark:text-text-dark">
                    {t('detail.notFound')}
                </p>
            </div>
        );
    }

    return (
        <SessionDetailClient
            initial={session}
            node={node}
            viewerUserId={user?.id ?? null}
            agentName={agent?.name ?? null}
        />
    );
}
