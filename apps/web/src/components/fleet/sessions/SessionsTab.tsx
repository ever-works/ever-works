'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Plus, TerminalSquare } from 'lucide-react';
import type { FleetNodeView, FleetSessionView } from '@ever-works/contracts';
import { Button } from '@/components/ui/button';
import { useNow } from '../health/use-now';
import { SessionCard } from './SessionCard';
import { SessionRowMenu } from './SessionRowMenu';
import { SessionStartDialog } from './SessionStartDialog';
import { SessionStateCard } from './SessionStateCard';
import { sessionsClient } from './sessions.client';
import { atOwnerLimit, groupSessions, sessionsTabCard, type SessionErrorRead } from './sessions.shared';

/** How often the tab re-reads the computer's sessions while it is open. */
const REFRESH_MS = 15_000;

/**
 * Sessions on computers (FL-04 P1b, spec §5.1, FR-27 … FR-30) — the computer
 * page's Sessions tab: the one state card the computer calls for (offline,
 * consent missing, daemon down, at its limit), then the live sessions (most
 * recently active first) and the ended ones (most recently ended first), each
 * a {@link SessionCard} with its row menu, and "New session".
 *
 * The first page is server-rendered (`SessionsTabServer`); the tab re-reads
 * every 15 s while open and after every act, so a session started on another
 * tab — or ended by the machine — shows up without a reload.
 */
export function SessionsTab({
    node,
    initial,
    viewerUserId,
}: {
    node: FleetNodeView;
    initial: FleetSessionView[] | null;
    viewerUserId: string | null;
}) {
    const t = useTranslations('fleet.sessions');
    const nowMs = useNow(30_000);
    const now = useMemo(() => new Date(nowMs), [nowMs]);
    const [sessions, setSessions] = useState<FleetSessionView[]>(initial ?? []);
    const [error, setError] = useState<SessionErrorRead | null>(null);
    const [loaded, setLoaded] = useState(initial !== null);
    const [starting, setStarting] = useState(false);

    const reload = useCallback(async () => {
        const result = await sessionsClient.listForNode(node.id, { limit: 100 });
        setLoaded(true);
        if (!result.ok) {
            setError(result.error);
            return;
        }
        setError(null);
        setSessions(result.data.sessions);
    }, [node.id]);

    useEffect(() => {
        if (initial === null) void reload();
        const timer = setInterval(() => {
            if (document.visibilityState === 'visible') void reload();
        }, REFRESH_MS);
        return () => clearInterval(timer);
    }, [initial, reload]);

    const { live, ended } = useMemo(() => groupSessions(sessions), [sessions]);
    const card = sessionsTabCard(node);
    const limited = card.kind === 'none' && atOwnerLimit(sessions);

    const onChanged = (view: FleetSessionView) => {
        setSessions((current) => {
            const others = current.filter((session) => session.id !== view.id);
            return [view, ...others];
        });
        void reload();
    };

    const list = (group: FleetSessionView[]) => (
        <ul className="space-y-2">
            {group.map((session) => (
                <li key={session.id}>
                    <SessionCard
                        session={session}
                        nodeName={node.name}
                        viewerUserId={viewerUserId}
                        now={now}
                        menu={<SessionRowMenu session={session} nodeName={node.name} onChanged={onChanged} />}
                    />
                </li>
            ))}
        </ul>
    );

    return (
        <section className="space-y-4" data-testid="fleet-sessions-tab" aria-labelledby="fleet-sessions-live">
            <div className="flex items-center justify-between gap-3">
                <h2 id="fleet-sessions-live" className="text-sm font-semibold text-text dark:text-text-dark">
                    {t('tab.live')} <span className="text-text-muted dark:text-text-muted-dark">({live.length})</span>
                </h2>
                <Button
                    size="sm"
                    onClick={() => setStarting(true)}
                    disabled={card.kind !== 'none' || limited}
                    data-testid="fleet-sessions-new"
                >
                    <Plus className="w-4 h-4" aria-hidden="true" />
                    {t('tab.newSession')}
                </Button>
            </div>

            <SessionStateCard
                card={limited ? { kind: 'limit', count: live.filter((s) => s.kind === 'owner').length } : card}
                nodeName={node.name}
                onRetry={() => void reload()}
            />

            {error && (
                <div role="alert" className="flex items-center gap-3 text-sm text-danger">
                    <span>{error.hint ?? t('tab.loadFailed')}</span>
                    <Button size="sm" variant="secondary" onClick={() => void reload()}>
                        {t('tab.retry')}
                    </Button>
                </div>
            )}

            {loaded && sessions.length === 0 && !error ? (
                <div
                    className="rounded-xl border border-dashed border-border dark:border-border-dark p-8 flex flex-col items-center text-center gap-2"
                    data-testid="fleet-sessions-empty"
                >
                    <TerminalSquare className="w-5 h-5 text-text-muted dark:text-text-muted-dark" aria-hidden="true" />
                    <p className="text-sm font-medium text-text dark:text-text-dark">
                        {t('tab.empty', { node: node.name })}
                    </p>
                    <p className="text-sm text-text-muted dark:text-text-muted-dark max-w-md">{t('tab.emptyBody')}</p>
                </div>
            ) : (
                <>
                    {live.length > 0 ? (
                        list(live)
                    ) : (
                        <p className="text-sm text-text-muted dark:text-text-muted-dark">
                            {t('tab.noLive', { node: node.name })}
                        </p>
                    )}
                    {ended.length > 0 && (
                        <div className="space-y-2">
                            <h2 className="text-sm font-semibold text-text dark:text-text-dark">
                                {t('tab.ended')}{' '}
                                <span className="text-text-muted dark:text-text-muted-dark">({ended.length})</span>
                            </h2>
                            {list(ended)}
                        </div>
                    )}
                </>
            )}

            <SessionStartDialog open={starting} onOpenChange={setStarting} node={node} onStarted={onChanged} />
        </section>
    );
}
