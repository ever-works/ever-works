import {
    Body,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    ParseUUIDPipe,
    Post,
    Query,
    Req,
    UseGuards,
    UseInterceptors,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { fleetMachineError, FleetMachineActionsService } from '@ever-works/agent/fleet';
import {
    isFleetServiceAction,
    isFleetServiceName,
    type FleetOperationRef,
    type FleetServiceActionResult,
    type FleetServicesListResult,
} from '@ever-works/contracts';
import { CurrentUser } from '../../auth/decorators/user.decorator';
import {
    refuseMachinePrincipalAction,
    type MachinePrincipalRequest,
} from '../../auth/machine-principal';
import type { AuthenticatedUser } from '../../auth/types/auth.types';
import { FleetEnabledGuard } from '../guards/fleet-enabled.guard';
import {
    confirmFieldsOf,
    FleetServiceActionDto,
    ListFleetServicesQueryDto,
} from './dto/fleet-machine.dto';
import { FleetMachineFactsEnabledGuard } from './fleet-machine-facts-enabled.guard';
import { FleetConfirmationInterceptor } from '../tools/fleet-confirmation.interceptor';

/**
 * Services on computers (FL-09 P1, plan §5, CONTRACTS §11.2) — the REST
 * surface over `FleetMachineActionsService`.
 *
 * Gates, in order: `FleetEnabledGuard` (the whole fleet), then
 * `FleetMachineFactsEnabledGuard` (`FLEET_MACHINE_FACTS_ENABLED`, default
 * off; 404), then the session global auth guard (no route here is public),
 * then the service's chain: the link's gate (existence, kill switch,
 * `--manage`, the `view` family to list and the `services` family to act),
 * the CONTRACTS §2.2 confirmation, the machine (blast radius, the root rule,
 * its own node), and one `fleet_audit` row per act. Every refusal is the
 * CONTRACTS §8 envelope with its status, passed through untouched.
 *
 * A fleet-run credential never acts on a machine's services through REST: an
 * Agent acts through its tools, where a blast-radius act is held for its
 * owner (FR-22).
 */
@ApiTags('fleet')
@Controller('api/fleet')
@UseGuards(FleetEnabledGuard, FleetMachineFactsEnabledGuard)
// FL-19 (CONTRACTS §2.2) — one `confirmation_required` answer for every caller: the class from
// the catalogue, the hint that says what to send; token-style fields are ignored.
@UseInterceptors(FleetConfirmationInterceptor)
export class FleetServicesController {
    constructor(private readonly machine: FleetMachineActionsService) {}

    @Get('nodes/:id/services')
    @ApiOperation({
        summary:
            'A computer’s services — systemd system and user units, launchd and Homebrew services, or Windows services — failed first, with CPU and memory for running ones, the acts each supports, how each act is confirmed, and what stopping it could cut off. Needs `--manage` on the computer.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    async list(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Query() query: ListFleetServicesQueryDto,
    ): Promise<FleetServicesListResult> {
        return this.machine.listServices(
            id,
            { kind: 'user', userId: auth.userId },
            {
                ...(query.scope ? { scope: query.scope } : {}),
                ...(query.find ? { find: query.find } : {}),
            },
        );
    }

    @Post('nodes/:id/services/:name/:action')
    @ApiOperation({
        summary:
            'Start, stop, restart, or turn at boot on (`enable`) or off (`disable`) one service. Send `confirm: true`; an act that could cut the computer off from Ever Works also needs `acknowledgeBlastRadius: true` (409 `confirmation_required` carries the sentence). An act that needs root runs only when the computer already allows it without a password; otherwise 409 `root_required` with the exact command to run there as the hint.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async act(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('name') name: string,
        @Param('action') action: string,
        @Body() body: FleetServiceActionDto,
        // Appended LAST so positional callers (specs) keep their meaning.
        @Req() req?: MachinePrincipalRequest,
    ): Promise<FleetServiceActionResult | FleetOperationRef> {
        refuseMachinePrincipalAction(
            auth,
            req,
            'change a computer’s services',
            'an Agent changes them through its tools, where a risky act waits for its owner.',
        );
        if (!isFleetServiceName(name)) {
            throw fleetMachineError('invalid', 'that is not a service name Ever Works acts on', {
                field: 'name',
            });
        }
        if (!isFleetServiceAction(action)) {
            throw fleetMachineError(
                'invalid',
                'action must be start, stop, restart, enable or disable',
                { field: 'action' },
            );
        }
        return this.machine.serviceAction(
            id,
            { kind: 'user', userId: auth.userId },
            {
                name,
                action,
                ...(body.scope ? { scope: body.scope } : {}),
                ...(body.manager ? { manager: body.manager } : {}),
                fields: confirmFieldsOf(body),
            },
        );
    }
}
