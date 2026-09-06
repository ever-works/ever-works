import {
    Body,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Post,
    Query,
    UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { QUEUED_REASON_KILL_SWITCH, RunDispatchGateService } from '@ever-works/agent/agents';
import { FleetAuditService, FleetKillSwitchService } from '@ever-works/agent/fleet';
import type { FleetAuditView, FleetKillSwitchChangeResult } from '@ever-works/contracts';
import { FLEET_AUDIT_DEFAULT_LIMIT } from '@ever-works/contracts';
import { CurrentUser } from '../auth/decorators/user.decorator';
import { IsPlatformAdminGuard } from '../auth/guards/platform-admin.guard';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { FleetAuditQueryDto, StopFleetKillSwitchDto } from './dto/fleet-kill-switch.dto';
import { FleetEnabledGuard } from './guards/fleet-enabled.guard';

/**
 * Panic controls (EW-778) — the PLATFORM-ADMIN half: the global stop flag.
 *
 *   POST   /api/fleet/kill-switch/stop    { reason? } — set the flag
 *   POST   /api/fleet/kill-switch/clear   clear it, then resume parked runs
 *   GET    /api/fleet/kill-switch/audit   ?limit — recent fleet_audit rows
 *
 * Two verbs rather than one boolean PUT: at 2am a fat-fingered `false`
 * must not be able to un-stop a fleet.
 *
 * Guard order matters: `FleetEnabledGuard` first, so a deployment with
 * the fleet off answers 404 here exactly as it does everywhere under
 * `/api/fleet` (never confirming the surface exists), then
 * `IsPlatformAdminGuard` (403 for everyone who is not the platform
 * owner). The read of the flag itself is deliberately NOT here — every
 * signed-in user may ask whether the platform is stopped
 * (`GET /api/fleet/kill-switch` on `FleetPanicController`), they just
 * never learn who stopped it.
 */
@ApiTags('fleet')
@ApiBearerAuth('JWT-auth')
@Controller('api/fleet/kill-switch')
@UseGuards(FleetEnabledGuard, IsPlatformAdminGuard)
export class FleetKillSwitchController {
    constructor(
        private readonly killSwitch: FleetKillSwitchService,
        private readonly audit: FleetAuditService,
        private readonly dispatchGate: RunDispatchGateService,
    ) {}

    @Post('stop')
    @ApiOperation({
        summary:
            'Set the platform-wide stop flag: no new agent run is dispatched, no run is routed to a fleet node, and no node is leased work until it is cleared. Running work is NOT cancelled. Writes an audit row with the actor.',
    })
    @ApiResponse({ status: 403, description: 'Caller is not a platform admin' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    async stop(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: StopFleetKillSwitchDto,
    ): Promise<FleetKillSwitchChangeResult> {
        return this.killSwitch.stop(auth.userId, body.reason ?? null);
    }

    @Post('clear')
    @ApiOperation({
        summary:
            'Clear the platform-wide stop flag and resume the runs it parked (best-effort, bounded). Writes an audit row with the actor.',
    })
    @ApiResponse({ status: 403, description: 'Caller is not a platform admin' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    async clear(@CurrentUser() auth: AuthenticatedUser): Promise<FleetKillSwitchChangeResult> {
        const result = await this.killSwitch.clear(auth.userId);
        // Resume the runs the flag parked. Fire-and-forget by design —
        // the flag is already off (that is what the caller asked for),
        // `promoteParked` never throws by contract, and a clear response
        // must not wait on up to 200 fresh dispatches. Same posture as
        // the cancel route's `drainForWork`.
        void this.dispatchGate.promoteParked(QUEUED_REASON_KILL_SWITCH).catch(() => undefined);
        return result;
    }

    @Get('audit')
    @ApiOperation({
        summary:
            'Recent fleet audit rows (every stop / clear / drain-all / cancel-in-flight, newest first) with actor and time.',
    })
    @ApiResponse({ status: 403, description: 'Caller is not a platform admin' })
    @HttpCode(HttpStatus.OK)
    async recentAudit(@Query() query: FleetAuditQueryDto): Promise<FleetAuditView[]> {
        return this.audit.recent(query.limit ?? FLEET_AUDIT_DEFAULT_LIMIT);
    }
}
