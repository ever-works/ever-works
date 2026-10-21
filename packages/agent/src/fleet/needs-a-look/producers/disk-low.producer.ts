import { Injectable } from '@nestjs/common';
import {
    diskLowSeverity,
    fleetNodeDiskLowInput,
    type FleetNodeView,
    type NeedsALookItem,
} from '@ever-works/contracts';
import type { NeedsALookContext, NeedsALookProducer } from '../needs-a-look.producer';
import {
    computerRoute,
    firstInstant,
    formatBinaryBytes,
    isOfflineNow,
    reportingNodes,
} from './health-producer.shared';

/**
 * `disk-low` (FR-12, spec S5) — free disk at or below the node's own floor
 * plus 1 GiB is `critical` ("the node stops at 5 GiB"); below 10% of the
 * volume is `warn`; with the floor switched off only the percentage rule
 * applies. The rule itself is `diskLowSeverity` in contracts, shared with the
 * heartbeat's `diskLowSince` marker so the item's `since` is the instant the
 * platform first saw the disk low (FR-17).
 *
 * Offline computers are skipped — by status, or by a silence longer than the
 * offline window (the stored status lags it): their last figure may be hours
 * old, and a stale snapshot is never presented as current (FR-30). The percentage is
 * the one the node reported; when it reported none, the sentence says only
 * what is left.
 */
export function diskLowItems(
    nodes: readonly FleetNodeView[],
    context: Pick<NeedsALookContext, 'now'>,
): NeedsALookItem[] {
    const items: NeedsALookItem[] = [];
    for (const node of reportingNodes(nodes)) {
        if (isOfflineNow(node, context.now)) continue;
        const input = fleetNodeDiskLowInput(node);
        const severity = diskLowSeverity(input);
        if (!severity || typeof input.freeBytes !== 'number') continue;
        const percent =
            typeof node.health?.diskPercent === 'number'
                ? Math.round(node.health.diskPercent)
                : null;
        const free = formatBinaryBytes(input.freeBytes);
        const floor =
            typeof input.floorBytes === 'number' ? formatBinaryBytes(input.floorBytes) : null;
        const full = percent === null ? null : `Disk is ${percent}% full`;
        const title =
            severity === 'critical'
                ? `${full ? `${full} · ${free} left` : `${free} left on the disk`}, the node stops at ${floor}`
                : `${full ? `${full} · ` : ''}${free} left`;
        items.push({
            id: `disk-low:${node.id}`,
            nodeId: node.id,
            severity,
            kind: 'disk-low',
            title,
            detail:
                severity === 'critical'
                    ? 'Below its floor the node refuses new work. Free up space on the workspace volume.'
                    : 'Less than a tenth of the workspace volume is free.',
            action: { label: 'Open', route: computerRoute(node.id) },
            since: firstInstant(
                context.now,
                node.health?.diskLowSince,
                node.health?.at,
                node.lastHeartbeatAt,
            ),
        });
    }
    return items;
}

@Injectable()
export class DiskLowProducer implements NeedsALookProducer {
    readonly id = 'fl-03.disk-low';
    produce(nodes: readonly FleetNodeView[], context: NeedsALookContext): NeedsALookItem[] {
        return diskLowItems(nodes, context);
    }
}
