import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { FleetNodeRepository, verifyNodeSecret } from '@ever-works/agent/fleet';

/** The ONE message every refused node credential gets, on every route. */
export const FLEET_NODE_UNAUTHORIZED_MESSAGE = 'Invalid node credential';

/**
 * The authenticated node, attached to the request by
 * {@link FleetNodeAuthGuard} and read with `@CurrentFleetNode()`.
 *
 * This is the node-channel equivalent of `request.user`: it is what
 * SCOPES every read the node is allowed to make. Nothing downstream may
 * take a node/owner id from the request BODY — a node token that could
 * name its own owner is a cross-org read waiting to happen.
 */
export interface AuthenticatedFleetNode {
    id: string;
    /** Owner the node executes for — the only scope its token buys. */
    userId: string;
    organizationId: string | null;
    capabilities: string[];
}

/** Request shape after the guard has run. */
export interface FleetNodeRequest {
    body?: { nodeId?: unknown; secret?: unknown };
    fleetNode?: AuthenticatedFleetNode;
}

/**
 * Nest guard for the node work channel (`/api/fleet/jobs/*`).
 *
 * Node authentication used to exist only as a bare helper called from
 * inside each service method. That worked, but it left the trust
 * boundary invisible at the edge: nothing in the controller said "this
 * route is node-authenticated", a new endpoint could be added without
 * it, and the check ran only after routing, validation and the handler
 * body had already been entered. Expressing it as a guard makes the
 * boundary declarative and refuses a bad credential before any handler
 * code runs — the house rule for access control (see the NestJS
 * "security-use-guards" skill).
 *
 * It does NOT replace the service-side verification: `FleetJobService`
 * still re-verifies every call. Two independent checks on the same fact
 * is the point — the guard is the edge contract, the service is the
 * invariant, and a future caller that reaches the service by another
 * path (chat tool, cron, another controller) is still fail-closed.
 *
 * Posture, identical to the rest of Fleet:
 *   - the credential is `(nodeId, secret)` in the BODY, shape-validated
 *     and constant-time compared against the stored sha256 via the
 *     shared `verifyNodeSecret` helper — ONE definition of "verified"
 *     across enroll / heartbeat / lease;
 *   - disabled and still-enrolling nodes are refused (a drained node
 *     stops working the instant it is drained);
 *   - EVERY invalid path — malformed id, unknown node, drained node,
 *     wrong secret — throws the SAME 401 with the SAME message, so an
 *     attacker holding a random uuid cannot enumerate which nodes exist.
 *
 * The routes it guards stay `@Public()`: the node secret IS the
 * credential, and there is no platform session on a node.
 */
@Injectable()
export class FleetNodeAuthGuard implements CanActivate {
    constructor(private readonly nodes: FleetNodeRepository) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const request = context.switchToHttp().getRequest<FleetNodeRequest>();
        const body = request.body ?? {};

        const verified = verifyNodeSecret(body.nodeId, body.secret);
        if (!verified) {
            throw new UnauthorizedException(FLEET_NODE_UNAUTHORIZED_MESSAGE);
        }

        const node = await this.nodes.findById(verified.nodeId);
        if (!node) {
            throw new UnauthorizedException(FLEET_NODE_UNAUTHORIZED_MESSAGE);
        }
        // Drained (`disabled`) and not-yet-enrolled (`enrolling`, whose
        // hash column still holds a TOKEN, not a secret) nodes are not
        // authenticated — they must not be able to touch work at all.
        if (node.status === 'disabled' || node.status === 'enrolling') {
            throw new UnauthorizedException(FLEET_NODE_UNAUTHORIZED_MESSAGE);
        }
        if (!verified.matches(node.enrollmentTokenHash)) {
            throw new UnauthorizedException(FLEET_NODE_UNAUTHORIZED_MESSAGE);
        }

        request.fleetNode = {
            id: node.id,
            userId: node.userId,
            organizationId: node.organizationId ?? null,
            capabilities: node.capabilities ?? [],
        };
        return true;
    }
}
