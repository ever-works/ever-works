import { Injectable } from '@nestjs/common';
import {
    type ComputerStateResolution,
    type FleetNodeView,
    type NeedsALookItem,
} from '@ever-works/contracts';
import type { NeedsALookContext, NeedsALookProducer } from '../needs-a-look.producer';
import {
    CHANGE_LIMITS_ROUTE,
    CLEAR_MODEL_THROTTLE_COMMAND,
    cliDisplayName,
    firstInstant,
    formatBinaryBytes,
    formatUtcInstant,
    reportingNodes,
    stateOf,
} from './health-producer.shared';

/** The English rendering of a `throttled` state's dimension sentence (spec U13). */
function throttledTitle(state: ComputerStateResolution): string {
    const { dimension, value, limit, reason } = state.params;
    if (dimension === 'cpu' && value !== undefined && limit !== undefined) {
        return `Pausing new work — CPU is above its ceiling (${value}% of ${limit}%)`;
    }
    if (dimension === 'memory' && value !== undefined && limit !== undefined) {
        return `Pausing new work — memory is above its ceiling (${value} MB of ${limit} MB)`;
    }
    if (dimension === 'disk' && value !== undefined && limit !== undefined) {
        return `Pausing new work — free disk is below its floor (${formatBinaryBytes(value)} of ${formatBinaryBytes(limit)})`;
    }
    return reason ? `Pausing new work — ${reason}` : 'Pausing new work';
}

/**
 * `node-throttled` (FR-13) — one `warn` item for a computer that is
 * `throttled` (a resource ceiling) or `limited` (a model CLI's usage limit),
 * as `resolveComputerState` decides it: the same function the cards, the
 * computer header and the Agent tool use, so the list can never disagree with
 * the state word beside the dot. Both states map to this one kind (the owner's
 * default, spec §8b): "Limited" and "Throttled" are two sentences, not two
 * kinds.
 *
 *   - limited → "Waiting for Claude Code's limit to reset at …" with **Clear
 *     limit now** (the named command {@link CLEAR_MODEL_THROTTLE_COMMAND}, which
 *     the web runs as the existing, audited clear route);
 *   - throttled → "Pausing new work — CPU is above its ceiling (92% of 85%)"
 *     with **Change limits** (Settings → Fleet, where the limits are set).
 *
 * `since` is when the limit window opened, or when the worker state changed:
 * both are stamped once per transition, so the item is stable (FR-17).
 */
export function nodeThrottledItems(
    nodes: readonly FleetNodeView[],
    context: Pick<NeedsALookContext, 'now'>,
): NeedsALookItem[] {
    const items: NeedsALookItem[] = [];
    for (const node of reportingNodes(nodes)) {
        const state = stateOf(node, context.now);
        if (state.state === 'limited') {
            const provider = state.params.provider ?? '';
            const until = state.params.until ?? '';
            const count = state.params.limitedCount ?? 1;
            const throttle = (node.modelThrottles ?? []).find(
                (entry) => entry.provider === provider,
            );
            items.push({
                id: `node-throttled:${node.id}`,
                nodeId: node.id,
                severity: 'warn',
                kind: 'node-throttled',
                title:
                    count > 1
                        ? `Waiting for model limits to reset — the first, ${cliDisplayName(provider)}, at ${formatUtcInstant(until)}`
                        : `Waiting for ${cliDisplayName(provider)}'s limit to reset at ${formatUtcInstant(until)}`,
                detail: throttle?.reason ?? '',
                action: {
                    label: count > 1 ? 'Clear limits now' : 'Clear limit now',
                    command: CLEAR_MODEL_THROTTLE_COMMAND,
                },
                since: firstInstant(
                    context.now,
                    throttle?.since,
                    node.workerStateChangedAt,
                    node.lastHeartbeatAt,
                ),
            });
        } else if (state.state === 'throttled') {
            items.push({
                id: `node-throttled:${node.id}`,
                nodeId: node.id,
                severity: 'warn',
                kind: 'node-throttled',
                title: throttledTitle(state),
                detail: state.params.dimension ? (node.workerStateReason ?? '') : '',
                action: { label: 'Change limits', route: CHANGE_LIMITS_ROUTE },
                since: firstInstant(context.now, node.workerStateChangedAt, node.lastHeartbeatAt),
            });
        }
    }
    return items;
}

@Injectable()
export class NodeThrottledProducer implements NeedsALookProducer {
    readonly id = 'fl-03.node-throttled';
    produce(nodes: readonly FleetNodeView[], context: NeedsALookContext): NeedsALookItem[] {
        return nodeThrottledItems(nodes, context);
    }
}
