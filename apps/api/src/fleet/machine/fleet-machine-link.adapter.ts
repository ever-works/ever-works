import { Injectable } from '@nestjs/common';
import {
    FleetNodeRepository,
    type FleetMachineGateInput,
    type FleetMachineNodeFacts,
    type FleetMachineNodePort,
    type FleetMachineNodeReply,
    type FleetMachineNodeRequest,
} from '@ever-works/agent/fleet';
import { isFleetOperationTerminal, makeFleetLinkError } from '@ever-works/contracts';
import { FleetLinkException } from '../../fleet-link/fleet-link.errors';
import { FleetLinkService } from '../../fleet-link/fleet-link.service';
import { FleetOperationsService } from '../../fleet-link/fleet-operations.service';

/** How often a waited-for operation is re-read. */
const OPERATION_POLL_MS = 250;

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
        private readonly operations: FleetOperationsService,
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
        if (outcome.operationId === undefined) return { result: outcome.result };
        if (!input.awaitOperationMs || input.awaitOperationMs <= 0) {
            return { operationId: outcome.operationId, operation: outcome.operation };
        }
        // The node turned it into an operation: wait for it (the record is kept by
        // FleetOperationsService, readable by the person it belongs to).
        const userId = input.caller.kind === 'user' ? input.caller.userId : input.caller.ownerUserId;
        const deadline = Date.now() + input.awaitOperationMs;
        let view = outcome.operation;
        while (!isFleetOperationTerminal(view.state) && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, OPERATION_POLL_MS));
            try {
                view = this.operations.get(outcome.operationId, userId);
            } catch {
                break;
            }
        }
        if (view.state === 'done') return { result: view.result };
        if (isFleetOperationTerminal(view.state)) {
            throw new FleetLinkException(
                view.error ?? makeFleetLinkError('operation_failed', 'the computer did not finish it'),
            );
        }
        return { operationId: outcome.operationId, operation: view };
    }

    async describe(nodeId: string): Promise<FleetMachineNodeFacts | null> {
        const node = nodeId ? await this.nodes.findById(nodeId) : null;
        return node ? { id: node.id, userId: node.userId, name: node.name } : null;
    }
}
