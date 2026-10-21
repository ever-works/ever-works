'use client';

import { useMemo, useState } from 'react';
import type { FleetSessionView } from '@ever-works/contracts';
import { useNow } from '@/components/fleet/health/use-now';
import { SessionCard } from '@/components/fleet/sessions/SessionCard';
import { SessionRowMenu } from '@/components/fleet/sessions/SessionRowMenu';
import { groupSessions } from '@/components/fleet/sessions/sessions.shared';

/**
 * Sessions on computers (FL-04 P2) — the client half of the Agent page's
 * Sessions block: live sessions first, then ended ones, each a `SessionCard`
 * with the same row menu as the computer page (End… on a live one says the
 * Agent's Run ends with it).
 */
export function AgentSessionsList({
    sessions: initial,
    nodeNames,
    agentName,
    viewerUserId,
}: {
    sessions: FleetSessionView[];
    nodeNames: Record<string, string>;
    agentName: string;
    viewerUserId: string | null;
}) {
    const nowMs = useNow(30_000);
    const now = useMemo(() => new Date(nowMs), [nowMs]);
    const [sessions, setSessions] = useState(initial);
    const { live, ended } = useMemo(() => groupSessions(sessions), [sessions]);
    const onChanged = (view: FleetSessionView) =>
        setSessions((current) => [view, ...current.filter((session) => session.id !== view.id)]);

    return (
        <ul className="space-y-2" data-testid="agent-sessions-list">
            {[...live, ...ended].map((session) => {
                const nodeName = nodeNames[session.nodeId] ?? '…';
                return (
                    <li key={session.id}>
                        <SessionCard
                            session={session}
                            nodeName={nodeName}
                            viewerUserId={viewerUserId}
                            now={now}
                            menu={
                                <SessionRowMenu
                                    session={session}
                                    nodeName={nodeName}
                                    agentName={agentName}
                                    onChanged={onChanged}
                                />
                            }
                        />
                    </li>
                );
            })}
        </ul>
    );
}
