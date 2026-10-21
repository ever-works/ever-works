'use client';

import { useEffect, useState } from 'react';
import type { FleetNodeHealthView } from '@ever-works/contracts';
import { fetchFleetNodeHealthAction } from '@/app/actions/fleet-health';
import type { FleetOverviewBlockProps } from '../../registry';
import { HealthMetrics, type HealthMetricsStatus } from './HealthMetrics';

/** One read's answer, tagged with the computer it was for. */
type HealthRead = {
    nodeId: string;
    status: Exclude<HealthMetricsStatus, 'loading'>;
    view: FleetNodeHealthView | null;
};

/**
 * Computer health (FL-03) — the computer page's Overview "metrics" block, as
 * FL-01's module registry loads it (`registerOverviewBlock` with
 * `surface: 'computer'`, see `components/fleet/modules/health.ts`). On the
 * computer surface `nodes` holds the one computer the page is about.
 *
 * Reads `GET /api/fleet/nodes/:id/health` for the freshest snapshot, showing
 * the node row the page already holds while it loads. A failed read shows
 * "Could not load health — Try again" (spec §5.2); a completed fix reads
 * again. Whether history is kept comes from the health answer, else from the
 * flags the page passes.
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

    if (!node) return null;

    // An answer for another computer, or one from before the latest Try
    // again, is not this computer's: show the row the page holds, loading.
    const current = read && read.nodeId === node.id ? read : null;
    const status: HealthMetricsStatus = current?.status ?? 'loading';
    const view = current?.view ?? null;

    const reload = () => {
        setRead(null);
        setAttempt((value) => value + 1);
    };

    return (
        <HealthMetrics
            node={view ? { ...node, health: view.snapshot } : node}
            status={status}
            stale={view?.stale}
            resolution={view?.state}
            historyEnabled={view?.historyEnabled ?? flags.FLEET_HEALTH_HISTORY_ENABLED === true}
            onRetry={reload}
            onActionDone={reload}
        />
    );
}
