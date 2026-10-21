import 'server-only';
import { getTranslations } from 'next-intl/server';
import { fleetAPI } from '@/lib/api/fleet';
import { fleetSessionsAPI } from '@/lib/api/fleet-sessions';
import { getAuthFromCookie } from '@/lib/auth';
import { readFleetFeatureFlags } from '@/lib/fleet-flags';
import { AgentSessionsList } from './AgentSessionsList';

/**
 * Sessions on computers (FL-04 P2, T-37a) — the Agent page's "Sessions" block:
 * this Agent's sessions on the person's computers, as the same `SessionCard`s
 * (and row menu) the computer page's Sessions tab shows. Rendered only while
 * `FLEET_SESSIONS_ENABLED` is on; every read is `.catch()`-ed, so a failed read
 * renders the block with its own words, never a broken page.
 */
export async function AgentSessionsBlock({ agentId, agentName }: { agentId: string; agentName: string }) {
    const flags = readFleetFeatureFlags(['FLEET_SESSIONS_ENABLED'] as const);
    if (flags.FLEET_SESSIONS_ENABLED !== true) return null;
    const t = await getTranslations('fleet.sessions.agentBlock');
    const [page, nodes, user] = await Promise.all([
        fleetSessionsAPI.listForAgent(agentId).catch(() => null),
        fleetAPI.listNodes().catch(() => null),
        getAuthFromCookie().catch(() => null),
    ]);
    const nodeNames: Record<string, string> = {};
    for (const node of (nodes as Array<{ id: string; name: string }> | null) ?? []) nodeNames[node.id] = node.name;

    return (
        <section
            className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5 space-y-3"
            data-testid="agent-sessions-block"
        >
            <h2 className="text-sm font-semibold text-text dark:text-text-dark">{t('title')}</h2>
            {page === null ? (
                <p className="text-sm text-text-muted dark:text-text-muted-dark">{t('loadFailed')}</p>
            ) : page.sessions.length === 0 ? (
                <p className="text-sm text-text-muted dark:text-text-muted-dark">{t('empty', { agent: agentName })}</p>
            ) : (
                <AgentSessionsList
                    sessions={page.sessions}
                    nodeNames={nodeNames}
                    agentName={agentName}
                    viewerUserId={user?.id ?? null}
                />
            )}
        </section>
    );
}
