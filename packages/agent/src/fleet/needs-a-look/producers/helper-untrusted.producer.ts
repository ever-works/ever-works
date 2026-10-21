import { Injectable } from '@nestjs/common';
import type { FleetNodeView, NeedsALookItem } from '@ever-works/contracts';
import type { NeedsALookContext, NeedsALookProducer } from '../needs-a-look.producer';
import { computerRoute, firstInstant, reportingNodes } from './health-producer.shared';

/**
 * `helper-untrusted` (FR-16) — one `warn` item for a computer whose native
 * screen helper is admitted with REDUCED trust (`helperTrust: 'hash-pinned'`,
 * CONTRACTS R-8). FL-07 reports that field; it is read STRUCTURALLY so this
 * producer exists now and stays silent — produces nothing at all — while the
 * field is absent, which is every row until FL-07 lands.
 */
export function helperUntrustedItems(
    nodes: readonly FleetNodeView[],
    context: Pick<NeedsALookContext, 'now'>,
): NeedsALookItem[] {
    const items: NeedsALookItem[] = [];
    for (const node of reportingNodes(nodes)) {
        const trust = (node as FleetNodeView & { helperTrust?: unknown }).helperTrust;
        if (trust !== 'hash-pinned') continue;
        items.push({
            id: `helper-untrusted:${node.id}`,
            nodeId: node.id,
            severity: 'warn',
            kind: 'helper-untrusted',
            title: `${node.name}'s screen helper runs with reduced trust`,
            detail: 'It is admitted by its hash, not by a signature.',
            action: { label: 'Open', route: computerRoute(node.id) },
            since: firstInstant(context.now, node.createdAt, node.lastHeartbeatAt),
        });
    }
    return items;
}

@Injectable()
export class HelperUntrustedProducer implements NeedsALookProducer {
    readonly id = 'fl-03.helper-untrusted';
    produce(nodes: readonly FleetNodeView[], context: NeedsALookContext): NeedsALookItem[] {
        return helperUntrustedItems(nodes, context);
    }
}
