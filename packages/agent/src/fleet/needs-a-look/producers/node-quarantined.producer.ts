import { Injectable } from '@nestjs/common';
import {
    FLEET_NODE_CLEAR_QUARANTINE_COMMAND,
    type FleetNodeView,
    type NeedsALookItem,
} from '@ever-works/contracts';
import type { NeedsALookContext, NeedsALookProducer } from '../needs-a-look.producer';
import { computerRoute, firstInstant, reportingNodes, stateOf } from './health-producer.shared';

/**
 * `node-quarantined` (FR-14, spec S4) — one `critical` item for a computer
 * that stopped ITSELF (its worker could not prove an earlier job's process
 * tree dead), with the node's own reason and, in the detail, the exact
 * command that clears it ON that machine. Nothing is offered that the
 * platform cannot do: quarantine is cleared only at the keyboard, so the
 * action opens the computer page (where the command has a copy button) and
 * never pretends to clear it.
 *
 * Judged by `resolveComputerState` with the offline window, so an offline or
 * long-silent computer (whose last report may be stale) reads "offline", not
 * "quarantined". `since` is the instant the
 * worker state changed — stamped once per transition (FR-17).
 */
export function nodeQuarantinedItems(
    nodes: readonly FleetNodeView[],
    context: Pick<NeedsALookContext, 'now'>,
): NeedsALookItem[] {
    const items: NeedsALookItem[] = [];
    for (const node of reportingNodes(nodes)) {
        const state = stateOf(node, context.now);
        if (state.state !== 'quarantined') continue;
        const reason = state.params.reason ?? null;
        items.push({
            id: `node-quarantined:${node.id}`,
            nodeId: node.id,
            severity: 'critical',
            kind: 'node-quarantined',
            title: reason
                ? `${node.name} stopped itself: ${reason}`
                : `${node.name} stopped itself`,
            detail: `On ${node.name}, after checking that no earlier job is still running there, run: ${FLEET_NODE_CLEAR_QUARANTINE_COMMAND}`,
            action: { label: 'Show command', route: computerRoute(node.id) },
            since: firstInstant(context.now, node.workerStateChangedAt, node.lastHeartbeatAt),
        });
    }
    return items;
}

@Injectable()
export class NodeQuarantinedProducer implements NeedsALookProducer {
    readonly id = 'fl-03.node-quarantined';
    produce(nodes: readonly FleetNodeView[], context: NeedsALookContext): NeedsALookItem[] {
        return nodeQuarantinedItems(nodes, context);
    }
}
