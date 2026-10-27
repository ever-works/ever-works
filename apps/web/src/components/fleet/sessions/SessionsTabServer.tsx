import 'server-only';
import { fleetSessionsAPI } from '@/lib/api/fleet-sessions';
import { getAuthFromCookie } from '@/lib/auth';
import type { FleetComputerTabProps } from '../registry';
import { SessionsTab } from './SessionsTab';

/**
 * Sessions on computers (FL-04 P1b) — the computer page's Sessions tab as the
 * page renders it: the first page of the computer's sessions and the
 * signed-in person's id are read here, on the server, in parallel, each
 * `.catch()`-ed — a failed read renders the tab, which then reads again and
 * says what went wrong, never a broken page.
 */
export default async function SessionsTabServer({ node }: FleetComputerTabProps) {
    const [page, user] = await Promise.all([
        fleetSessionsAPI.listForNode(node.id, { limit: 100 }).catch(() => null),
        getAuthFromCookie().catch(() => null),
    ]);
    return (
        <SessionsTab
            node={node}
            initial={page ? page.sessions : null}
            viewerUserId={user?.id ?? null}
        />
    );
}
