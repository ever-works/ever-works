import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AuthenticatedFleetNode, FleetNodeRequest } from '../guards/fleet-node-auth.guard';

/**
 * The node authenticated by `FleetNodeAuthGuard`, mirroring
 * `@CurrentUser()` on the session side.
 *
 * Handlers must scope node-channel reads by THIS value, never by an id
 * taken from the request body: the body is attacker-controlled, this is
 * the credential's own resolved identity. That distinction is the whole
 * reason a node token cannot authorise a cross-owner read.
 */
export const CurrentFleetNode = createParamDecorator(
    (data: unknown, ctx: ExecutionContext): AuthenticatedFleetNode | undefined => {
        return ctx.switchToHttp().getRequest<FleetNodeRequest>().fleetNode;
    },
);
