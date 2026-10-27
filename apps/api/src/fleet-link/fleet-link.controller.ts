import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    HttpStatus,
    NotFoundException,
    Param,
    Post,
    Query,
    UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { config } from '@ever-works/agent/config';
import {
    FLEET_OPERATION_STATES,
    isFleetLinkId,
    type FleetOperationCancelResult,
    type FleetOperationState,
    type FleetOperationView,
} from '@ever-works/contracts';
import { Public } from '../auth/decorators/public.decorator';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { CurrentFleetNode } from '../fleet/decorators/fleet-node.decorator';
import { FleetJobNodeCredentialDto } from '../fleet/dto/fleet-job.dto';
import { FleetEnabledGuard } from '../fleet/guards/fleet-enabled.guard';
import {
    FleetNodeAuthGuard,
    type AuthenticatedFleetNode,
} from '../fleet/guards/fleet-node-auth.guard';
import { fleetLinkError } from './fleet-link.errors';
import { FleetLinkTokenService, type FleetLinkTokenGrant } from './fleet-link-token.service';
import { FleetOperationsService } from './fleet-operations.service';

/**
 * Fleet node link — the HTTP half (FL-02, CONTRACTS §11.2):
 *
 *   POST   /api/fleet/link-token        node credential → a 5-minute, single-use link token
 *   GET    /api/fleet/operations/:id    a long operation's progress and result
 *   DELETE /api/fleet/operations/:id    ask the node to cancel it (`operation.cancel`)
 *
 * The token route is the node channel's: `@Public()`, authenticated by the
 * node credential through the fleet's own `FleetNodeAuthGuard` (one
 * undifferentiated 401), and answering 404 while this deployment does not
 * accept links — which is how a node learns to wait five minutes. The
 * operation routes are the signed-in owner's; an operation that is not
 * theirs is `not_found`.
 */
@ApiTags('Fleet')
@Controller('api/fleet')
@UseGuards(FleetEnabledGuard)
export class FleetLinkController {
    constructor(
        private readonly tokens: FleetLinkTokenService,
        private readonly operations: FleetOperationsService,
    ) {}

    @Public()
    @UseGuards(FleetNodeAuthGuard)
    @Post('link-token')
    @HttpCode(HttpStatus.CREATED)
    @Throttle({ long: { limit: 20, ttl: 60_000 } })
    @ApiOperation({
        summary:
            "Mint this node's single-use, five-minute token for its one outbound link socket (/ws/fleet/link). Node-credential authenticated; 404 while the deployment does not accept node links.",
    })
    async mintLinkToken(
        @CurrentFleetNode() node: AuthenticatedFleetNode,
        // Validated so the credential body has the one shape every node route accepts.
        @Body() _credential: FleetJobNodeCredentialDto,
    ): Promise<FleetLinkTokenGrant> {
        if (!config.fleet.isNodeLinkEnabled()) throw new NotFoundException();
        // Works-security (run-token scope) — bound to the node's current
        // credential generation, so a rotation refuses it at hello.
        return this.tokens.mintForNode(node.id);
    }

    /**
     * FL-19 — my recent long operations (`fleet_operations_list`, `ever-works fleet
     * operations list`): newest first, kept one hour after they end. An unknown
     * `state` or a malformed `nodeId` is `invalid`.
     */
    @Get('operations')
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    @ApiOperation({
        summary:
            'My recent long operations on my computers (running, done, failed, cancelled or interrupted), newest first; optionally one state or one computer. Kept one hour after they end.',
    })
    listOperations(
        @CurrentUser() auth: AuthenticatedUser,
        @Query('state') state?: string,
        @Query('nodeId') nodeId?: string,
        @Query('limit') limit?: string,
    ): FleetOperationView[] {
        if (!config.fleet.isNodeLinkEnabled()) return [];
        if (state !== undefined && !(FLEET_OPERATION_STATES as readonly string[]).includes(state)) {
            throw fleetLinkError(
                'invalid',
                'state is running, done, failed, cancelled or interrupted',
            );
        }
        if (nodeId !== undefined && !/^[0-9a-f-]{36}$/i.test(nodeId)) {
            throw fleetLinkError('invalid', 'nodeId must be a computer id');
        }
        const parsed = limit === undefined ? undefined : Number(limit);
        return this.operations.listForUser(auth.userId, {
            ...(state ? { state: state as FleetOperationState } : {}),
            ...(nodeId ? { nodeId } : {}),
            ...(parsed !== undefined && Number.isFinite(parsed) ? { limit: parsed } : {}),
        });
    }

    @Get('operations/:id')
    @ApiOperation({
        summary:
            'A long operation on one of your computers: its state, progress, and result or error. Kept one hour after it ends.',
    })
    getOperation(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
    ): FleetOperationView {
        if (!config.fleet.isNodeLinkEnabled() || !isFleetLinkId(id))
            throw fleetLinkError('not_found', 'no such operation');
        return this.operations.get(id, auth.userId);
    }

    @Delete('operations/:id')
    @HttpCode(HttpStatus.ACCEPTED)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    @ApiOperation({
        summary:
            'Ask the computer to cancel a running operation. The operation then reads cancelled; one that already ended is returned as it is.',
    })
    async cancelOperation(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
    ): Promise<FleetOperationCancelResult> {
        if (!config.fleet.isNodeLinkEnabled() || !isFleetLinkId(id))
            throw fleetLinkError('not_found', 'no such operation');
        return this.operations.requestCancel(id, auth.userId);
    }
}
