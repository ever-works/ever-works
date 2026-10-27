'use client';

import { useEffect, useState } from 'react';
import {
    FLEET_HEALTH_DEFAULT_RANGE,
    type FleetNodeHealthHistory,
    type FleetNodeHealthRange,
} from '@ever-works/contracts';
import { fetchFleetNodeHealthHistoryAction } from '@/app/actions/fleet-health';
import type { FleetOverviewBlockProps } from '../../registry';
import {
    HealthHistoryChart,
    type HealthHistoryMetric,
    type HealthHistoryStatus,
} from './HealthHistoryChart';

/** One read's answer, tagged with what it was for. */
type HistoryRead = {
    key: string;
    status: Exclude<HealthHistoryStatus, 'loading'>;
    history: FleetNodeHealthHistory | null;
};

/**
 * Computer health, second phase (FL-03) — the computer page's Overview
 * "history" block, as FL-01's module registry loads it (`registerOverviewBlock`
 * with `surface: 'computer'`, see `components/fleet/modules/fl-03-health.ts`).
 *
 * Reads `GET /api/fleet/nodes/:id/health/history?range=` for the chosen range
 * (24 h first). Not flag-gated in the registry on purpose: with history
 * switched off the answer is `{ disabled: true }` and the block says so
 * (U10), so the owner learns why there is no chart. An answer is used only
 * while it is still for the computer and range on screen.
 */
export default function HealthHistoryBlock({ nodes }: FleetOverviewBlockProps) {
    const node = nodes[0];
    const nodeId = node?.id;
    const [range, setRange] = useState<FleetNodeHealthRange>(FLEET_HEALTH_DEFAULT_RANGE);
    const [visible, setVisible] = useState<Record<HealthHistoryMetric, boolean>>({
        cpu: true,
        mem: true,
        disk: true,
    });
    const [read, setRead] = useState<HistoryRead | null>(null);
    const [attempt, setAttempt] = useState(0);
    const key = `${nodeId ?? ''}|${range}|${attempt}`;

    useEffect(() => {
        if (!nodeId) return;
        let cancelled = false;
        const readKey = `${nodeId}|${range}|${attempt}`;
        void fetchFleetNodeHealthHistoryAction(nodeId, range).then((result) => {
            if (cancelled) return;
            setRead(
                result.success
                    ? { key: readKey, status: 'ready', history: result.data }
                    : { key: readKey, status: 'error', history: null },
            );
        });
        return () => {
            cancelled = true;
        };
    }, [nodeId, range, attempt]);

    if (!node) return null;
    const current = read && read.key === key ? read : null;

    return (
        <HealthHistoryChart
            nodeName={node.name}
            range={range}
            onRangeChange={setRange}
            visible={visible}
            onToggle={(metric) =>
                setVisible((previous) => ({ ...previous, [metric]: !previous[metric] }))
            }
            status={current?.status ?? 'loading'}
            history={current?.history ?? null}
            onRetry={() => setAttempt((value) => value + 1)}
        />
    );
}
