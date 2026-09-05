import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { FleetKillSwitchService } from '@ever-works/agent/fleet';
import type {
    FleetCancelInFlightResult,
    FleetDrainAllResult,
    FleetKillSwitchState,
} from '@ever-works/contracts';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { CancelFleetInFlightDto } from './dto/fleet-kill-switch.dto';
import { FleetPanicService } from './fleet-panic.service';
import { FleetEnabledGuard } from './guards/fleet-enabled.guard';

/**
 * Panic controls (EW-778) — the OWNER-scoped half.
 *
 *   POST   /api/fleet/drain-all          disable every node I own and
 *                                        requeue their in-flight claims
 *   POST   /api/fleet/cancel-in-flight   { includeQueued? } — cancel my
 *                                        running fleet jobs + their runs
 *   GET    /api/fleet/kill-switch        is the global stop flag set?
 *                                        (any session; actor not leaked)
 *
 * Drain-all and cancel-in-flight are two DIFFERENT decisions on two
 * different routes on purpose: stopping new work is not killing running
 * work, and the stop flag never implies the cancel. The admin half (set
 * / clear the flag, read the audit trail) lives on
 * `FleetKillSwitchController`.
 *
 * Same scoping rule as `FleetController`: the owner comes from the
 * session, never from the caller, and every service call is keyed by it.
 */
@ApiTags('fleet')
@Controller('api/fleet')
@UseGuards(FleetEnabledGuard)
export class FleetPanicController {
    constructor(
        private readonly panic: FleetPanicService,
        private readonly killSwitch: FleetKillSwitchService,
    ) {}

    @Post('drain-all')
    @ApiOperation({
        summary:
            'Drain EVERY node I own: disable each one and return its in-flight claims to the queue. Nodes still enrolling or already disabled are skipped. Nothing is cancelled — use cancel-in-flight for that.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    async drainAll(@CurrentUser() auth: AuthenticatedUser): Promise<FleetDrainAllResult> {
        return this.panic.drainAllForUser(auth.userId);
    }

    @Post('cancel-in-flight')
    @ApiOperation({
        summary:
            'Cancel my running fleet jobs and the agent runs behind them (an EXPLICIT second step — never implied by draining or by the global stop flag). A node learns of the cancel through its next refused heartbeat, so this is "cancel requested", not an instant kill.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    async cancelInFlight(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: CancelFleetInFlightDto,
    ): Promise<FleetCancelInFlightResult> {
        return this.panic.cancelInFlightForUser(auth.userId, {
            includeQueued: body.includeQueued === true,
        });
    }

    @Get('kill-switch')
    @ApiOperation({
        summary:
            'Whether the platform-wide stop flag is set (no new work is dispatched, routed or leased while it is). `unverified: true` means the flag could not be read and dispatch is refusing on that basis.',
    })
    @HttpCode(HttpStatus.OK)
    // Polled by the fleet page banner every 30s; sized like runner-status.
    @Throttle({ long: { limit: 120, ttl: 60_000 } })
    async killSwitchState(): Promise<FleetKillSwitchState> {
        return this.killSwitch.publicState();
    }
}
