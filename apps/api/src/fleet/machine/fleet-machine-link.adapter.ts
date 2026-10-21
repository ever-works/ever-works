import { Injectable } from '@nestjs/common';
import {
    FleetNodeRepository,
    type FleetMachineGateInput,
    type FleetMachineNodeFacts,
    type FleetMachineNodePort,
    type FleetMachineNodeReply,
    type FleetMachineNodeRequest,
} from '@ever-works/agent/fleet';
import { FleetLinkService } from '../../fleet-link/fleet-link.service';

/**
 * Machine actions (FL-09) — `FLEET_MACHINE_NODE_PORT` over the node link
 * (FL-02). The agent package's `FleetMachineActionsService` decides; this
 * only runs the link's gate and carries one `machine` request to the machine
 * and its answer back.
 *
 * `authorize` is the link's own gate (`FleetLinkService.authorizeRequest`:
 * the link flag, existence, kill switch, consent, family audience) without
 * contacting the machine, so the service can ask for a confirmation only once
 * it knows the caller may act. `request` is
 * `FleetLinkService.request`, which runs the same gate again, answers
 * `unreachable` when no API replica holds the node's link, and carries the
 * node's refusal back as the same CONTRACTS §8 error.
 */
@Injectable()
export class FleetMachineLinkAdapter implements FleetMachineNodePort {
    constructor(
        private readonly link: FleetLinkService,
        private readonly nodes: FleetNodeRepository,
    ) {}

    async authorize(input: FleetMachineGateInput): Promise<FleetMachineNodeFacts> {
        const node = await this.link.authorizeRequest({
            nodeId: input.nodeId,
            verb: input.verb,
            caller: input.caller,
            requirement: {
                actionFamily: input.actionFamily,
                stateChanging: input.stateChanging,
                target: input.target ?? null,
            },
        });
        return { id: node.id, userId: node.userId, name: node.name };
    }

    async request(input: FleetMachineNodeRequest): Promise<FleetMachineNodeReply> {
        const outcome = await this.link.request({
            nodeId: input.nodeId,
            verb: input.verb,
            params: input.params,
            caller: input.caller,
            requirement: {
                actionFamily: input.actionFamily,
                stateChanging: input.stateChanging,
                target: input.target ?? null,
            },
            timeoutMs: input.timeoutMs,
        });
        if (outcome.operationId !== undefined) {
            return { operationId: outcome.operationId, operation: outcome.operation };
        }
        return { result: outcome.result };
    }

    async describe(nodeId: string): Promise<FleetMachineNodeFacts | null> {
        const node = nodeId ? await this.nodes.findById(nodeId) : null;
        return node ? { id: node.id, userId: node.userId, name: node.name } : null;
    }
}
