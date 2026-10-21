import {
    Body,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    ParseIntPipe,
    ParseUUIDPipe,
    Post,
    Query,
    UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { FleetPortsService, type FleetPortsActor } from '@ever-works/agent/fleet';
import type { FleetPortOpenResult, FleetPortsListResponse } from '@ever-works/contracts';
import { CurrentUser } from '../../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../../auth/types/auth.types';
import { FleetEnabledGuard } from '../guards/fleet-enabled.guard';
import { FleetMachineFactsEnabledGuard } from '../machine/fleet-machine-facts-enabled.guard';
import { ListFleetPortsQueryDto, OpenFleetPortDto } from './dto/fleet-ports.dto';

function actorOf(auth: AuthenticatedUser): FleetPortsActor {
    return { kind: 'user', userId: auth.userId, displayName: auth.username ?? null };
}

/**
 * Servers and ports (FL-10, plan §5, CONTRACTS §11.2) — the REST surface over
 * `FleetPortsService`.
 *
 * Gates, in order: `FleetEnabledGuard` (the whole fleet), then
 * `FleetMachineFactsEnabledGuard` (`FLEET_MACHINE_FACTS_ENABLED`, default off;
 * 404), then the session auth guard (no route here is public), then the
 * service's chain: existence and the family audience (`view` to list, `ports`
 * to open, `desktop` too for the desktop), the target's own conditions, the
 * node link's gate (kill switch, `--manage`, connected), the machine, one
 * `node.port.open` audit row per open. Every refusal is the CONTRACTS §8
 * envelope with its status.
 *
 * Phase 2 adds `POST|GET|DELETE /nodes/:id/ports/:port/preview` behind
 * `FLEET_PORT_TUNNEL_ENABLED`.
 */
@ApiTags('fleet')
@Controller('api/fleet')
@UseGuards(FleetEnabledGuard, FleetMachineFactsEnabledGuard)
export class FleetPortsController {
    constructor(private readonly ports: FleetPortsService) {}

    @Get('nodes/:id/ports')
    @ApiOperation({
        summary:
            "What a computer is listening on, read on the machine itself: web servers first (title, status, program or container), other ports folded, system ports hidden, watched ports waiting. Anyone in the computer's `view` audience may read it; nothing is stored or audited.",
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    list(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Query() query: ListFleetPortsQueryDto,
    ): Promise<FleetPortsListResponse> {
        return this.ports.list(id, actorOf(auth), { watch: query.watch });
    }

    @Post('nodes/:id/ports/:port/open')
    @ApiOperation({
        summary:
            "Open a computer's server ON the machine: in its default browser on its desktop (needs `--attend`), or in its preview browser — an owner-level browser profile no agent uses — whose picture this answer's attach token shows. Needs the `ports` audience; audited as `node.port.open`.",
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    open(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('port', ParseIntPipe) port: number,
        @Body() body: OpenFleetPortDto,
    ): Promise<FleetPortOpenResult> {
        return this.ports.open(id, port, actorOf(auth), {
            ...(body?.target ? { target: body.target } : {}),
            ...(body?.scheme ? { scheme: body.scheme } : {}),
        });
    }
}
