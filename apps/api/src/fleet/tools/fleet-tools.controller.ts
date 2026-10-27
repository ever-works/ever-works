import {
    BadRequestException,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Query,
    UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { FleetStatusView, FleetToolsGateView } from '@ever-works/contracts';
import { CurrentUser } from '../../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../../auth/types/auth.types';
import { FleetEnabledGuard } from '../guards/fleet-enabled.guard';
import { FleetStatusService } from './fleet-status.service';
import { FleetToolsGateService } from './fleet-tools-gate.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * FL-19 — the two reads the Agent, MCP and CLI surface adds (plan §5):
 *
 *  - `GET /api/fleet/status` — "how is my fleet?" in one call: computers,
 *    Needs-a-look, the kill switch, the server time (`fleet_status`,
 *    `ever-works fleet status`). Read-only, 60/min.
 *  - `GET /api/fleet/tools/gate?agentId=` — what one of my Agents may read
 *    and do in each fleet tool family, and which gate refuses when it may
 *    not (the Agent's Capabilities "Fleet tools" block). An Agent that is
 *    not mine answers 404.
 *
 * Both are the caller's own reads (no audit row, CONTRACTS §2.3) and dark
 * unless `FLEET_ENABLED`.
 */
@ApiTags('Fleet')
@Controller('api/fleet')
@UseGuards(FleetEnabledGuard)
export class FleetToolsController {
    constructor(
        private readonly status: FleetStatusService,
        private readonly gate: FleetToolsGateService,
    ) {}

    @Get('status')
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    @ApiOperation({
        summary:
            'How is my fleet, in one read: every computer I may see (name, status, platform, consents, CPU / memory / disk, live sessions), what needs a look on them with the fix for each, whether the fleet kill switch is on, and the server time. Read-only.',
    })
    fleetStatus(@CurrentUser() auth: AuthenticatedUser): Promise<FleetStatusView> {
        return this.status.status(auth.userId);
    }

    @Get('tools/gate')
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    @ApiQuery({ name: 'agentId', required: true, description: 'One of my Agents.' })
    @ApiOperation({
        summary:
            "What one of my Agents may read and do on my computers, per fleet tool family: read yes/no, the trust-ladder rung of its acts, and when it may not, the gate that refuses (kill switch, pause, tool grant, ladder, a computer's owner, a missing consent) and where to change it. Read-only.",
    })
    toolsGate(
        @CurrentUser() auth: AuthenticatedUser,
        @Query('agentId') agentId?: string,
    ): Promise<FleetToolsGateView> {
        if (typeof agentId !== 'string' || !UUID.test(agentId)) {
            throw new BadRequestException({
                error: { code: 'invalid', hint: 'agentId must be an Agent id' },
            });
        }
        return this.gate.gateFor(auth.userId, agentId);
    }
}
