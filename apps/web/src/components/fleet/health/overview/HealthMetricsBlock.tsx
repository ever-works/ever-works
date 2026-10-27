'use client';

import { useCallback, useEffect, useState } from 'react';
import type { FleetNodeHealthView } from '@ever-works/contracts';
import {
    fetchFleetNodeHealthAction,
    fetchFleetNodeWakeStatusAction,
    refreshFleetNodeHealthAction,
    wakeFleetNodeAction,
} from '@/app/actions/fleet-health';
import type { FleetOverviewBlockProps } from '../../registry';
import { HealthMetrics, type HealthMetricsStatus, type HealthRefreshState } from './HealthMetrics';
import { WakePanel, type WakeOutcome } from './WakePanel';

/** One read's answer, tagged with the computer it was for. */
type HealthRead = {
    nodeId: string;
    status: Exclude<HealthMetricsStatus, 'loading'>;
    view: FleetNodeHealthView | null;
};

/** Where Refresh now is, for which computer. */
type RefreshRun = { nodeId: string; state: HealthRefreshState; error: string | null };

/**
 * Computer health (FL-03) — the computer page's Overview "metrics" block, as
 * FL-01's module registry loads it (`registerOverviewBlock` with
 * `surface: 'computer'`, see `components/fleet/modules/fl-03-health.ts`). On the
 * computer surface `nodes` holds the one computer the page is about.
 *
 * Reads `GET /api/fleet/nodes/:id/health` for the freshest snapshot, showing
 * the node row the page already holds while it loads. A failed read shows
 * "Could not load health — Try again" (spec §5.2); a completed fix reads
 * again. Whether history is kept comes from the health answer, else from the
 * flags the page passes.
 *
 * Second phase: Refresh now (`POST …/health`) replaces the answer with the
 * fresh one it returns — the cards update within the machine's 3 s, "Checked
 * just now" — or keeps the last snapshot and says the hint with Try again
 * (U3). An offline computer gets the Wake panel under the cards, driven by the
 * same answer's `wake`; when the woken computer checks in, the block reads
 * again.
 *
 * Every answer is tagged with the computer it was read for and used only
 * while that is still the computer on screen: if the page swaps computers
 * without remounting the block, the previous computer's snapshot is never
 * laid over the new one — the block reads "loading" until its own answer
 * arrives.
 */
export default function HealthMetricsBlock({ nodes, flags }: FleetOverviewBlockProps) {
    const node = nodes[0];
    const nodeId = node?.id;
    const [read, setRead] = useState<HealthRead | null>(null);
    // Bumped by Try again / a completed fix; each bump is one read.
    const [attempt, setAttempt] = useState(0);
    const [refresh, setRefresh] = useState<RefreshRun | null>(null);

    useEffect(() => {
        if (!nodeId) return;
        let cancelled = false;
        void fetchFleetNodeHealthAction(nodeId).then((result) => {
            if (cancelled) return;
            setRead(
                result.success
                    ? { nodeId, status: 'ready', view: result.data }
                    : { nodeId, status: 'error', view: null },
            );
        });
        return () => {
            cancelled = true;
        };
    }, [nodeId, attempt]);

    const runRefresh = useCallback(async () => {
        if (!nodeId) return;
        setRefresh({ nodeId, state: 'refreshing', error: null });
        const result = await refreshFleetNodeHealthAction(nodeId);
        if (result.success) {
            setRead({ nodeId, status: 'ready', view: result.data });
            setRefresh({ nodeId, state: 'done', error: null });
        } else {
            // The cards keep the last snapshot (U3); the hint says why.
            setRefresh({ nodeId, state: 'failed', error: result.error });
        }
    }, [nodeId]);

    const sendWake = useCallback(async (id: string) => {
        const result = await wakeFleetNodeAction(id);
        return (
            result.success ? { ok: true, data: result.data } : { ok: false, error: result.error }
        ) as WakeOutcome<NonNullable<typeof result.data>>;
    }, []);

    const readWakeStatus = useCallback(async (id: string) => {
        const result = await fetchFleetNodeWakeStatusAction(id);
        return (
            result.success ? { ok: true, data: result.data } : { ok: false, error: result.error }
        ) as WakeOutcome<NonNullable<typeof result.data>>;
    }, []);

    if (!node) return null;

    // An answer for another computer, or one from before the latest Try
    // again, is not this computer's: show the row the page holds, loading.
    const current = read && read.nodeId === node.id ? read : null;
    const status: HealthMetricsStatus = current?.status ?? 'loading';
    const view = current?.view ?? null;
    const run = refresh && refresh.nodeId === node.id ? refresh : null;

    const reload = () => {
        setRead(null);
        setRefresh(null);
        setAttempt((value) => value + 1);
    };
    // After a wake answered: read again, keeping what is on screen until the
    // new answer lands, so "win-lab is back" stays readable.
    const readAgain = () => setAttempt((value) => value + 1);

    return (
        <div className="space-y-3">
            <HealthMetrics
                node={view ? { ...node, health: view.snapshot } : node}
                status={status}
                stale={view?.stale}
                resolution={view?.state}
                historyEnabled={view?.historyEnabled ?? flags.FLEET_HEALTH_HISTORY_ENABLED === true}
                onRetry={reload}
                onActionDone={reload}
                refresh={view?.refresh}
                onRefresh={view?.refresh ? () => void runRefresh() : undefined}
                refreshState={run?.state ?? 'idle'}
                refreshError={run?.error ?? null}
                canWake={view?.wake?.available === true}
            />
            {/* Mounted whenever the answer carries `wake`: the panel renders nothing
                for an awake computer, except right after a wake it is reporting on. */}
            {view?.wake ? (
                <WakePanel
                    key={node.id}
                    node={{ id: node.id, name: node.name }}
                    availability={view.wake}
                    sendWake={sendWake}
                    readStatus={readWakeStatus}
                    onBack={readAgain}
                />
            ) : null}
        </div>
    );
}
