import type { FleetActionFamily, FleetOperationView } from '@ever-works/contracts';

/**
 * Machine actions (FL-09) — how the machine-actions service reaches a
 * machine: one request/reply on the node's shared `machine` channel.
 *
 * A port, because the transport is the API's node link (FL-02:
 * `FleetLinkService.request`) and this package must not import the API. The
 * API binds it (`FleetMachineLinkAdapter`); a context without it (the
 * worker, a test) answers `unreachable` for every machine, which is the
 * honest answer when there is no link.
 *
 * Both calls run the link's own gate in its order — the link flag,
 * existence (a stranger reads `not_found`), the kill switch, the `manage`
 * consent against what the live link presented, the action family's
 * audience — and throw its refusal as an `HttpException` whose body is the
 * CONTRACTS §8 envelope (read it with `readFleetMachineError`).
 */

/** Who asked (CONTRACTS §2.3 `requestedBy`): a person, or an Agent acting for its owner. */
export type FleetMachineCaller =
    | { kind: 'user'; userId: string }
    | { kind: 'agent'; agentId: string; ownerUserId: string };

/** `user:<id>` · `agent:<id>`. */
export function describeFleetMachineCaller(caller: FleetMachineCaller): string {
    return caller.kind === 'user' ? `user:${caller.userId}` : `agent:${caller.agentId}`;
}

/** The person an audit row belongs to: the user, or the Agent's owner. */
export function fleetMachineCallerUserId(caller: FleetMachineCaller): string {
    return caller.kind === 'user' ? caller.userId : caller.ownerUserId;
}

export interface FleetMachineGateInput {
    nodeId: string;
    /** A `machine` verb (`services.action`, `processes.signal`, …). */
    verb: string;
    caller: FleetMachineCaller;
    /** `view` for every list; the act's family otherwise (CONTRACTS §2.1, FR-16). */
    actionFamily: FleetActionFamily;
    stateChanging: boolean;
    /** What the act is about (a service name, a pid). */
    target?: string | null;
}

export interface FleetMachineNodeRequest extends FleetMachineGateInput {
    params: Record<string, unknown>;
    timeoutMs?: number;
    /**
     * A request the node turned into an operation (it ran past the link's 2 s
     * inline window — a Windows process read, a slow restart) is waited for up
     * to this long and answered with its result, so a list or a quick act is
     * never handed an operation id. Past it the operation is returned as is.
     */
    awaitOperationMs?: number;
}

/** The node's answer: a result, or — for a request that ran over the inline window — its operation. */
export type FleetMachineNodeReply =
    | { result: unknown; operationId?: undefined }
    | { operationId: string; operation: FleetOperationView; result?: undefined };

/** The facts of a node every action needs (its owner for the audit row, its name for the dialog). */
export interface FleetMachineNodeFacts {
    id: string;
    userId: string;
    name: string;
}

export interface FleetMachineNodePort {
    /**
     * The link's gate WITHOUT contacting the machine: throws its refusal, or
     * answers the node's facts. Runs before a confirmation is asked for, so a
     * caller who may not act learns nothing about the act (not even the
     * machine's name).
     */
    authorize(input: FleetMachineGateInput): Promise<FleetMachineNodeFacts>;
    /** One request on the node's `machine` channel; the gate runs again first. */
    request(input: FleetMachineNodeRequest): Promise<FleetMachineNodeReply>;
    /**
     * The node's facts with NO gate — used only to put a refused act's audit
     * row in front of the node's owner. Never returned to a caller.
     */
    describe?(nodeId: string): Promise<FleetMachineNodeFacts | null>;
}

export const FLEET_MACHINE_NODE_PORT = 'FLEET_MACHINE_NODE_PORT' as const;
