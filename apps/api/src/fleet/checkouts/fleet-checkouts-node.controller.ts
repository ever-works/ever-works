import {
    Body,
    Controller,
    HttpCode,
    HttpStatus,
    Param,
    ParseUUIDPipe,
    Post,
    Req,
    UnauthorizedException,
    UnprocessableEntityException,
    UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { FleetCheckoutCredentialResponse } from '@ever-works/contracts';
import { Public } from '../../auth/decorators/public.decorator';
import { FleetEnabledGuard } from '../guards/fleet-enabled.guard';
import {
    FLEET_NODE_UNAUTHORIZED_MESSAGE,
    FleetNodeAuthGuard,
    type FleetNodeRequest,
} from '../guards/fleet-node-auth.guard';
import { FleetCheckoutCredentialDto } from './dto/fleet-checkout.dto';
import {
    FleetCheckoutCredentialRefusal,
    FleetCheckoutCredentialService,
} from './fleet-checkout-credential.service';
import { FleetCheckoutsEnabledGuard } from './fleet-checkouts-enabled.guard';

/**
 * Checkouts on computers (FL-14 P2, spec FR-17) — the node-facing half:
 * `POST /api/fleet/checkouts/:id/credential`, node-credential authenticated
 * (public to the session guard, `FleetNodeAuthGuard` at the edge), beside the
 * job channel's `POST /api/fleet/jobs/:id/push-credential` it mirrors.
 *
 * A separate controller from `FleetCheckoutsController` on purpose: people
 * (session-authenticated) and machines (node-authenticated) are two trust
 * boundaries and never share a class. A refusal answers 422 with a STABLE
 * reason only; an unknown or foreign node the same undifferentiated 401 every
 * node route answers.
 */
@ApiTags('fleet')
@Controller('api/fleet/checkouts')
@UseGuards(FleetEnabledGuard, FleetCheckoutsEnabledGuard, FleetNodeAuthGuard)
export class FleetCheckoutsNodeController {
    constructor(private readonly credentials: FleetCheckoutCredentialService) {}

    @Public()
    @Post(':id/credential')
    @ApiOperation({
        summary:
            'Mint a repository-scoped, short-lived git credential for one operation on a checkout Ever Works created on this node (public, node-secret-authenticated). Read for clone/fetch/pull; write only while a push runs. Returned once; never stored; the node revokes it when the operation ends.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    async credential(
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: FleetCheckoutCredentialDto,
        @Req() request: FleetNodeRequest,
    ): Promise<FleetCheckoutCredentialResponse> {
        const node = request.fleetNode;
        if (!node) throw new UnauthorizedException(FLEET_NODE_UNAUTHORIZED_MESSAGE);
        try {
            return await this.credentials.mint(node.id, id, body.access);
        } catch (error) {
            if (error instanceof FleetCheckoutCredentialRefusal) {
                throw new UnprocessableEntityException({ reason: error.reason });
            }
            throw error;
        }
    }
}
