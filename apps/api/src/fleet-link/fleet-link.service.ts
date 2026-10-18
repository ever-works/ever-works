import { Injectable, Logger, Optional } from '@nestjs/common';
import { FleetAuditService, FleetNodeRepository, type FleetNode } from '@ever-works/agent/fleet';
import { config } from '@ever-works/agent/config';
import {
    isFleetLinkFamily,
    isFleetLinkVerb,
    type FleetLinkFamily,
    type FleetNodeLinkView,
    type FleetOperationView,
} from '@ever-works/contracts';
import { FleetLinkAuthorizer } from './fleet-link.authorizer';
import { describeAgo, FleetLinkException, fleetLinkError } from './fleet-link.errors';
import {
    FleetLinkRegistry,
    type FleetLinkChannelEvents,
    type FleetLinkChannelHandle,
} from './fleet-link.registry';
import {
    describeFleetLinkCaller,
    fleetLinkCallerUserId,
    type FleetLinkCaller,
    type FleetLinkNodeFacts,
    type FleetLinkRequirement,
} from './fleet-link.types';
import { FleetOperationsService } from './fleet-operations.service';

/**
 * Fleet node link — the ONE entry point every epic calls (FL-02).
 *
 * A controller that wants something from a machine — a health snapshot, a
 * log tail, a session, a file — calls {@link FleetLinkService.request} (one
 * request/reply on the node's shared `machine` channel) or
 * {@link FleetLinkService.openChannel} (a channel of its own family). Both:
 *
 *  1. refuse when this deployment does not accept links;
 *  2. authorise — existence, kill switch, consent, family audience — before
 *     the node is contacted (`FleetLinkAuthorizer`);
 *  3. answer `unreachable`, naming when the computer was last seen, when it
 *     has no link (nothing is queued — CONTRACTS R-11);
 *  4. carry the node's own refusal back as the same typed error.
 *
 * Every refusal is a {@link FleetLinkException}: its HTTP body is the shared
 * `{ error: { code, hint, details } }` envelope, so a controller just lets it
 * propagate.
 *
 * Opening a channel in a state-changing family writes one
 * `node.link.channel-open` audit row (CONTRACTS §7, spec FR-25); read-only
 * families write none. A `machine` verb's own audit row belongs to the epic
 * that owns the verb.
 */

export type FleetLinkRequestOutcome<T = unknown> =
    | { result: T; operationId?: undefined; operation?: undefined }
    | { operationId: string; operation: FleetOperationView; result?: undefined };

export interface FleetLinkRequestInput {
    nodeId: string;
    /** A `machine` verb (`health.now`, `services.list`, …). */
    verb: string;
    params?: Record<string, unknown>;
    caller: FleetLinkCaller;
    /** Narrow the defaults (consent, action family, state-changing, target) for this verb. */
    requirement?: Partial<FleetLinkRequirement>;
    timeoutMs?: number;
}

export interface FleetLinkOpenChannelInput {
    nodeId: string;
    family: FleetLinkFamily;
    params?: Record<string, unknown>;
    caller: FleetLinkCaller;
    requirement?: Partial<FleetLinkRequirement>;
    events?: FleetLinkChannelEvents;
}

function nodeFacts(node: FleetNode): FleetLinkNodeFacts {
    return {
        id: node.id,
        userId: node.userId,
        organizationId: node.organizationId ?? null,
        name: node.name,
        kind: node.kind,
        lastHeartbeatAt: node.lastHeartbeatAt ?? null,
        storedConsents: node.consents ?? null,
        capabilities: node.capabilities ?? null,
        workerState: node.workerState ?? null,
        controlPolicy: node.controlPolicy,
        controlPolicyFamilies: node.controlPolicyFamilies ?? null,
    };
}

@Injectable()
export class FleetLinkService {
    private readonly logger = new Logger(FleetLinkService.name);

    constructor(
        private readonly registry: FleetLinkRegistry,
        private readonly authorizer: FleetLinkAuthorizer,
        private readonly operations: FleetOperationsService,
        private readonly nodes: FleetNodeRepository,
        @Optional() private readonly audit?: FleetAuditService,
    ) {}

    /** One request/reply on the node's `machine` channel. */
    async request<T = unknown>(input: FleetLinkRequestInput): Promise<FleetLinkRequestOutcome<T>> {
        if (!isFleetLinkVerb(input.verb))
            throw fleetLinkError('invalid', 'verb', { verb: input.verb });
        const node = await this.prepare(input.nodeId);
        const facts = nodeFacts(node);
        await this.authorizer.authorize({
            node: facts,
            caller: input.caller,
            family: 'machine',
            verb: input.verb,
            requirement: input.requirement,
        });
        this.requireLink(facts);
        const channel = await this.registry.machineChannel(
            node.id,
            describeFleetLinkCaller(input.caller),
        );
        const reply = await channel.request(input.verb, input.params ?? {}, {
            timeoutMs: input.timeoutMs,
        });
        if ('error' in reply) throw new FleetLinkException(reply.error);
        if ('operationId' in reply) {
            const operation = this.operations.track({
                operationId: reply.operationId,
                nodeId: node.id,
                family: 'machine',
                verb: input.verb,
                requesterUserId: fleetLinkCallerUserId(input.caller),
                ownerUserId: node.userId,
            });
            return { operationId: reply.operationId, operation };
        }
        return { result: reply.result as T };
    }

    /** A channel of `family` on the node's link, opened for this caller. */
    async openChannel(input: FleetLinkOpenChannelInput): Promise<FleetLinkChannelHandle> {
        if (!isFleetLinkFamily(input.family))
            throw fleetLinkError('invalid', 'family', { family: input.family });
        const node = await this.prepare(input.nodeId);
        const facts = nodeFacts(node);
        const requirement = await this.authorizer.authorize({
            node: facts,
            caller: input.caller,
            family: input.family,
            requirement: input.requirement,
        });
        this.requireLink(facts);
        const requestedBy = describeFleetLinkCaller(input.caller);
        try {
            const handle = await this.registry.openChannel({
                nodeId: node.id,
                family: input.family,
                params: input.params ?? {},
                requirement,
                requestedBy,
                events: input.events,
            });
            if (requirement.stateChanging)
                await this.auditOpen(node, input, requirement, requestedBy, 'opened');
            return handle;
        } catch (error) {
            if (requirement.stateChanging && error instanceof FleetLinkException) {
                await this.auditOpen(node, input, requirement, requestedBy, 'refused', error.code);
            }
            throw error;
        }
    }

    /** The link as the platform's own socket sees it, for a node view. */
    linkView(node: { id: string; kind: string }): FleetNodeLinkView {
        return this.registry.linkView(node, config.fleet.isNodeLinkEnabled());
    }

    isConnected(nodeId: string): boolean {
        return this.registry.isConnected(nodeId);
    }

    private async prepare(nodeId: string): Promise<FleetNode> {
        if (!config.fleet.isNodeLinkEnabled()) {
            throw fleetLinkError('unreachable', 'this deployment does not accept node links yet');
        }
        const node =
            typeof nodeId === 'string' && nodeId.length > 0
                ? await this.nodes.findById(nodeId)
                : null;
        if (!node) throw fleetLinkError('not_found', 'no such computer');
        return node;
    }

    private requireLink(node: FleetLinkNodeFacts): void {
        if (this.registry.isConnected(node.id)) return;
        const ago = describeAgo(node.lastHeartbeatAt);
        throw fleetLinkError(
            'unreachable',
            ago
                ? `${node.name} is not connected; last seen ${ago} ago`
                : `${node.name} is not connected`,
            { nodeId: node.id },
        );
    }

    private async auditOpen(
        node: FleetNode,
        input: FleetLinkOpenChannelInput,
        requirement: FleetLinkRequirement,
        requestedBy: string,
        outcome: 'opened' | 'refused',
        code?: string,
    ): Promise<void> {
        if (!this.audit) return;
        await this.audit.tryRecord({
            action: 'node.link.channel-open',
            actorUserId: input.caller.kind === 'user' ? input.caller.userId : null,
            ownerUserId: node.userId,
            nodeId: node.id,
            details: {
                family: input.family,
                target: requirement.target ?? null,
                requestedBy,
                outcome,
                ...(code ? { code } : {}),
            },
        });
    }
}

/**
 * The same service under the name later epic plans use for it (FL-08:
 * "`NodeLinkService` on the API"). One class, two names — never a second copy.
 */
export { FleetLinkService as NodeLinkService };
