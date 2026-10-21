import { Injectable } from '@nestjs/common';
import {
    FLEET_NODE_UPGRADE_COMMAND,
    type FleetNodeView,
    type NeedsALookItem,
} from '@ever-works/contracts';
import type { NeedsALookContext, NeedsALookProducer } from '../needs-a-look.producer';
import { firstInstant, isOfflineNow, reportingNodes } from './health-producer.shared';

/** The computer page's Settings tab, where the Node version section carries the copy button. */
export function computerSettingsRoute(nodeId: string): string {
    return `/fleet/computers/${encodeURIComponent(nodeId)}?tab=settings`;
}

/**
 * `node-upgrade-required` (FL-02 FR-36, spec S11, CONTRACTS §4.6, R-23) — one
 * `info` item per computer whose daemon is below this deployment's version
 * floor: it keeps reporting health and settling the work it holds, but the
 * lease refuses it new work until it is upgraded. The detail names the exact
 * command; the action opens the computer's Settings tab, where the Node
 * version section has a copy button — the upgrade itself happens only at that
 * machine's keyboard (or by its own `--auto-update`).
 *
 * Judged from the view's `upgradeRequired` (the platform compares the
 * version the node last reported with `FLEET_MIN_NODE_VERSION`, failing open
 * on an unparseable version), never re-derived here. A computer that reads
 * offline is skipped: its version may be stale, and "offline" already says
 * more. The id is stable per node.
 */
export function nodeUpgradeRequiredItems(
    nodes: readonly FleetNodeView[],
    context: Pick<NeedsALookContext, 'now'>,
): NeedsALookItem[] {
    const items: NeedsALookItem[] = [];
    for (const node of reportingNodes(nodes)) {
        if (node.upgradeRequired !== true) continue;
        if (isOfflineNow(node, context.now)) continue;
        const version = node.version
            ? `ever-works-node ${node.version}`
            : 'an older ever-works-node';
        const floor = node.minNodeVersion ? `${node.minNodeVersion} or newer` : 'a newer version';
        items.push({
            id: `node-upgrade-required:${node.id}`,
            nodeId: node.id,
            severity: 'info',
            kind: 'node-upgrade-required',
            title: `${node.name} runs ${version}; this deployment needs ${floor}. It takes no work until it is upgraded.`,
            detail: `On ${node.name}, run: ${FLEET_NODE_UPGRADE_COMMAND} — then restart the node service.`,
            action: { label: 'Show command', route: computerSettingsRoute(node.id) },
            since: firstInstant(context.now, node.lastHeartbeatAt, node.createdAt),
        });
    }
    return items;
}

@Injectable()
export class NodeUpgradeRequiredProducer implements NeedsALookProducer {
    readonly id = 'fl-02.node-upgrade-required';
    produce(nodes: readonly FleetNodeView[], context: NeedsALookContext): NeedsALookItem[] {
        return nodeUpgradeRequiredItems(nodes, context);
    }
}
