'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { FleetSessionBoardResponse, FleetSessionView } from '@ever-works/contracts';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import { readNodeConsents } from '../fleet-consents.shared';
import { useNow } from '../health/use-now';
import type { FleetHubTabProps } from '../registry';
import { SessionCard } from './SessionCard';
import { sessionsClient } from './sessions.client';
import { boardSessions } from './sessions-board.shared';

/** Re-read this often while visible (the board's cadence). */
const POLL_MS = 5_000;

/**
 * Fleet → Sessions (FL-05 P3, spec FR-45, S11, §5.6) — the operator's view of
 * the same live sessions as Activity → Sessions, grouped by computer: each
 * group says whether the computer is online, which consents it runs with
 * (`work · manage`; "manage only" says Agents need work switched on there) and
 * how many sessions it holds, then its cards (needs-you first). A computer
 * without a session still shows, so the fleet reads whole. The per-computer
 * Sessions tab is this view filtered to one computer.
 */
export default function SessionsByComputer({ nodes }: FleetHubTabProps) {
    const t = useTranslations('fleet.sessions');
    const nowMs = useNow(15_000);
    const now = useMemo(() => new Date(nowMs), [nowMs]);
    const [board, setBoard] = useState<FleetSessionBoardResponse | null>(null);
    const [failed, setFailed] = useState(false);

    const reload = useCallback(async () => {
        const result = await sessionsClient.board();
        if (result.ok) {
            setBoard(result.data);
            setFailed(false);
        } else setFailed(true);
    }, []);

    useEffect(() => {
        void reload();
        const timer = setInterval(() => {
            if (document.visibilityState === 'visible') void reload();
        }, POLL_MS);
        return () => clearInterval(timer);
    }, [reload]);

    const byNode = useMemo(() => {
        const map = new Map<string, FleetSessionView[]>();
        for (const session of boardSessions(board)) {
            const list = map.get(session.nodeId) ?? [];
            list.push(session);
            map.set(session.nodeId, list);
        }
        return map;
    }, [board]);

    if (nodes.length === 0) {
        return (
            <p
                className="text-sm text-text-muted dark:text-text-muted-dark"
                data-testid="fleet-sessions-by-computer-empty"
            >
                {t('byComputer.noComputers')}
            </p>
        );
    }

    return (
        <section className="space-y-5" data-testid="fleet-sessions-by-computer">
            {failed && (
                <p role="alert" className="text-sm text-danger">
                    {t('board.loadFailed')}
                </p>
            )}
            {nodes.map((node) => {
                const sessions = byNode.get(node.id) ?? [];
                const consents = readNodeConsents(node);
                const online = node.status !== 'offline';
                const consentWords = [
                    consents.work ? 'work' : null,
                    consents.manage ? 'manage' : null,
                ].filter((word): word is string => word !== null);
                return (
                    <div
                        key={node.id}
                        className="space-y-2"
                        data-testid="fleet-sessions-computer-group"
                        data-node-id={node.id}
                    >
                        <header className="flex flex-wrap items-center gap-x-3 gap-y-1">
                            <Link
                                href={ROUTES.DASHBOARD_FLEET_COMPUTER(node.id, 'sessions')}
                                className="text-sm font-semibold text-text dark:text-text-dark hover:underline"
                            >
                                {node.name}
                            </Link>
                            <span className="inline-flex items-center gap-1 text-xs text-text-muted dark:text-text-muted-dark">
                                <span
                                    className={cn(
                                        'h-2 w-2 rounded-full',
                                        online
                                            ? 'bg-success'
                                            : 'bg-text-muted dark:bg-text-muted-dark',
                                    )}
                                    aria-hidden="true"
                                />
                                {online ? t('byComputer.online') : t('byComputer.offline')}
                            </span>
                            {consentWords.length > 0 && (
                                <span className="text-xs text-text-muted dark:text-text-muted-dark">
                                    {consentWords.join(' · ')}
                                </span>
                            )}
                            <span className="text-xs text-text-muted dark:text-text-muted-dark">
                                {t('byComputer.sessions', { count: sessions.length })}
                            </span>
                            {consents.manage && !consents.work && (
                                <span className="text-xs text-text-muted dark:text-text-muted-dark">
                                    {t('byComputer.manageOnly')}
                                </span>
                            )}
                            {online && (consents.manage || consents.work) && (
                                <Link
                                    href={ROUTES.DASHBOARD_FLEET_COMPUTER(node.id, 'sessions')}
                                    className="ml-auto text-xs font-medium text-primary hover:underline"
                                >
                                    {t('byComputer.newSession')}
                                </Link>
                            )}
                        </header>
                        {sessions.length > 0 && (
                            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                                {sessions.map((session) => (
                                    <SessionCard
                                        key={session.id}
                                        session={session}
                                        nodeName={node.name}
                                        now={now}
                                        onAnswered={() => void reload()}
                                    />
                                ))}
                            </div>
                        )}
                    </div>
                );
            })}
        </section>
    );
}
