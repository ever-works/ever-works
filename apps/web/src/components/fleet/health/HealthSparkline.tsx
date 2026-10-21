'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { FleetNodeHealthHistoryPoint } from '@ever-works/contracts';

const WIDTH = 64;
const HEIGHT = 16;

/**
 * The polyline segments of one metric across the points: a null value (an
 * offline stretch) ends a segment, so the line breaks there instead of
 * dropping to zero. Pure, for the unit spec.
 */
export function sparklineSegments(
    points: readonly FleetNodeHealthHistoryPoint[],
    metric: 'cpu' | 'mem' | 'disk' = 'cpu',
    width = WIDTH,
    height = HEIGHT,
): string[] {
    if (points.length === 0) return [];
    const step = points.length > 1 ? width / (points.length - 1) : 0;
    const segments: string[] = [];
    let current: string[] = [];
    points.forEach((point, index) => {
        const value = point[metric];
        if (value === null) {
            if (current.length > 0) segments.push(current.join(' '));
            current = [];
            return;
        }
        const x = Math.round(index * step * 10) / 10;
        const y = Math.round((height - (Math.max(0, Math.min(100, value)) / 100) * height) * 10) / 10;
        current.push(`${x},${y}`);
    });
    if (current.length > 0) segments.push(current.join(' '));
    return segments;
}

export interface HealthSparklineProps {
    nodeId: string;
    /** Injected points (tests, or a parent that already read them); absent, the last hour is read. */
    points?: readonly FleetNodeHealthHistoryPoint[];
}

/**
 * Computer health, second phase (FL-03, spec FR-21, §5.1) — a computer card's
 * sparkline: CPU over the last hour, from the one-minute samples. Rendered
 * only where the deployment keeps history (the hub passes the flag); a read
 * that fails, a history that is off, or an hour with no samples renders
 * nothing — the card's own cells still say the current numbers. Decorative
 * next to those numbers, so hidden from assistive technology with a label for
 * pointer users.
 */
export function HealthSparkline({ nodeId, points: injected }: HealthSparklineProps) {
    const t = useTranslations('fleet.history');
    const [points, setPoints] = useState<readonly FleetNodeHealthHistoryPoint[] | null>(injected ?? null);

    useEffect(() => {
        if (injected) return;
        let cancelled = false;
        // Loaded on demand: the cards render on pages and in tests that never
        // read history, and the action module is server-bound.
        void import('@/app/actions/fleet-health')
            .then(({ fetchFleetNodeHealthHistoryAction }) =>
                fetchFleetNodeHealthHistoryAction(nodeId, '1h'),
            )
            .then((result) => {
                if (cancelled) return;
                setPoints(result.success && !result.data.disabled ? result.data.points : []);
            })
            .catch(() => {
                if (!cancelled) setPoints([]);
            });
        return () => {
            cancelled = true;
        };
    }, [injected, nodeId]);

    const segments = points ? sparklineSegments(points) : [];
    if (segments.length === 0) return null;

    return (
        <svg
            width={WIDTH}
            height={HEIGHT}
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            className="shrink-0 text-primary"
            aria-hidden="true"
            data-testid="fleet-health-sparkline"
        >
            <title>{t('sparklineLabel')}</title>
            {segments.map((segment, index) => (
                <polyline
                    key={index}
                    points={segment}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.25}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                />
            ))}
        </svg>
    );
}
