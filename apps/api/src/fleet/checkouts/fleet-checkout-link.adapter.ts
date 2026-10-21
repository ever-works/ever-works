import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { config } from '@ever-works/agent/config';
import {
    FleetCheckoutService,
    FleetNodeRepository,
    type FleetCheckoutNodeOutcome,
    type FleetCheckoutNodePort,
    type FleetCheckoutNodeRequest,
} from '@ever-works/agent/fleet';
import type { FleetConsents } from '@ever-works/contracts';
import { FleetLinkRegistry } from '../../fleet-link/fleet-link.registry';
import { FleetLinkService } from '../../fleet-link/fleet-link.service';
import { FleetOperationsService } from '../../fleet-link/fleet-operations.service';
import type { FleetLinkCaller } from '../../fleet-link/fleet-link.types';

/**
 * Checkouts on computers (FL-14) — `FLEET_CHECKOUT_NODE_PORT` over the node
 * link (FL-02). The agent package's `FleetCheckoutService` decides; this only
 * carries one `machine` request to the machine and its answer back, through
 * `FleetLinkService.request` — so the link's own gate runs first, in its
 * order: the link flag, existence, the kill switch for a state-changing act,
 * the consent the verb needs against the consents the live link presented
 * (`checkouts.list` on `--work` or `--manage`, a rescan and `checkouts.sync`
 * on `--manage`), the family audience, then "is it connected" (on any API
 * replica). The node's refusal comes back as the same CONTRACTS §8 error.
 */
@Injectable()
export class FleetCheckoutLinkAdapter implements FleetCheckoutNodePort {
    constructor(private readonly link: FleetLinkService) {}

    isConnected(nodeId: string): boolean {
        return this.link.isConnected(nodeId);
    }

    liveConsents(nodeId: string): FleetConsents | null {
        return this.link.liveConsents(nodeId);
    }

    async request(input: FleetCheckoutNodeRequest): Promise<FleetCheckoutNodeOutcome> {
        const caller: FleetLinkCaller =
            input.caller.kind === 'user'
                ? { kind: 'user', userId: input.caller.userId }
                : input.caller.kind === 'agent'
                  ? {
                        kind: 'agent',
                        agentId: input.caller.agentId,
                        ownerUserId: input.caller.ownerUserId,
                    }
                  : { kind: 'system', job: input.caller.job };
        const outcome = await this.link.request({
            nodeId: input.nodeId,
            verb: input.verb,
            params: input.params,
            caller,
            requirement: {
                ...(input.consent ? { consent: input.consent } : {}),
                ...(input.actionFamily ? { actionFamily: input.actionFamily } : {}),
                stateChanging: input.stateChanging,
                target: input.target ?? null,
            },
            ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        });
        if (outcome.operationId) return { operationId: outcome.operationId };
        return { result: outcome.result };
    }
}

/**
 * Checkouts on computers (FL-14) — what the machines report back, folded into
 * the rows:
 *
 *  - a slow `checkouts.list` or a `checkouts.sync` that finished as a link
 *    operation (`FleetOperationsService.onEnded`, fired once on the replica
 *    that ended it);
 *  - a link that (re)connected (spec FR-11: every checkout's path is
 *    reconciled on link open) — the node is asked for its list, as the
 *    platform, a moment after `link.ready`.
 *
 * Dropped while `FLEET_CHECKOUTS_ENABLED` is off.
 */
@Injectable()
export class FleetCheckoutLinkListener implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(FleetCheckoutLinkListener.name);
    private readonly stops: Array<() => void> = [];

    constructor(
        private readonly checkouts: FleetCheckoutService,
        private readonly operations: FleetOperationsService,
        private readonly registry: FleetLinkRegistry,
        private readonly link: FleetLinkService,
        private readonly nodes: FleetNodeRepository,
    ) {}

    onModuleInit(): void {
        this.stops.push(
            this.operations.onEnded((view) => {
                if (!config.fleet.isCheckoutsEnabled()) return;
                void this.checkouts.applyOperationEnded(view);
            }),
            this.registry.onLinkEvent((event) => {
                if (event.type !== 'connected' || !config.fleet.isCheckoutsEnabled()) return;
                void this.listOnConnect(event.nodeId);
            }),
        );
    }

    onModuleDestroy(): void {
        for (const stop of this.stops.splice(0)) stop();
    }

    private async listOnConnect(nodeId: string): Promise<void> {
        try {
            const node = await this.nodes.findById(nodeId);
            if (!node) return;
            const outcome = await this.link.request({
                nodeId,
                verb: 'checkouts.list',
                params: {},
                caller: { kind: 'system', job: 'fleet-checkout-link-open' },
                requirement: { actionFamily: 'view', stateChanging: false },
                timeoutMs: 10_000,
            });
            if (!outcome.operationId) await this.checkouts.applyNodeList(node, outcome.result);
        } catch (error) {
            // A node without the consent, or one that went away again: the
            // reconcile sweep asks later. Never an error for the link.
            this.logger.debug(
                `checkouts.list on link open for node ${nodeId} skipped: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }
}
