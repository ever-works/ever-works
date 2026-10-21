import {
    Controller,
    Delete,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    ParseIntPipe,
    ParseUUIDPipe,
    Post,
    UseGuards,
    UseInterceptors,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { FleetPortTunnelService, type FleetPortsActor } from '@ever-works/agent/fleet';
import type { FleetPortTunnelOpenResponse, FleetPortTunnelView } from '@ever-works/contracts';
import { CurrentUser } from '../../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../../auth/types/auth.types';
import { FleetEnabledGuard } from '../guards/fleet-enabled.guard';
import { FleetMachineFactsEnabledGuard } from '../machine/fleet-machine-facts-enabled.guard';
import { FleetPortTunnelEnabledGuard } from './fleet-port-tunnel-enabled.guard';
import { FleetPortTunnelTokens } from './fleet-port-tunnel-tokens';
import { FleetConfirmationInterceptor } from '../tools/fleet-confirmation.interceptor';

function actorOf(auth: AuthenticatedUser): FleetPortsActor {
    return { kind: 'user', userId: auth.userId, displayName: auth.username ?? null };
}

/**
 * Servers and ports, phase 2 (FL-10, plan §5, CONTRACTS R-17, §11.2) —
 * **Preview in my browser**: open, read and close the person's preview tunnel
 * to one port.
 *
 * Gates: `FleetEnabledGuard`, `FleetMachineFactsEnabledGuard`,
 * `FleetPortTunnelEnabledGuard` (`FLEET_PORT_TUNNEL_ENABLED` + a preview host;
 * 404 off), the session auth guard, then `FleetPortTunnelService`'s chain
 * (the `ports` audience, the kill switch, the four-tunnel limit, the machine).
 *
 * The answer to a person carries `openUrl`: the tunnel's address with a
 * 60-second, single-use hand-off token the preview host trades for its own
 * cookie (R-17's fallback; the web's session cookie never reaches the preview
 * host). A fresh one is minted on every read, so "Preview in my browser" on an
 * open tunnel opens it again.
 */
@ApiTags('fleet')
@Controller('api/fleet')
@UseGuards(FleetEnabledGuard, FleetMachineFactsEnabledGuard, FleetPortTunnelEnabledGuard)
// FL-19 (CONTRACTS §2.2) — one `confirmation_required` answer for every caller: the class from
// the catalogue, the hint that says what to send; token-style fields are ignored.
@UseInterceptors(FleetConfirmationInterceptor)
export class FleetPortTunnelsController {
    constructor(
        private readonly tunnels: FleetPortTunnelService,
        private readonly tokens: FleetPortTunnelTokens,
    ) {}

    @Post('nodes/:id/ports/:port/preview')
    @ApiOperation({
        summary:
            'Preview in my browser: an owner-only, time-boxed HTTP tunnel to one port on the computer (10 idle minutes, 60 minutes in all, four per person). Answers the tunnel and a one-time address to open it with. Audited once on open and once on close.',
    })
    @HttpCode(HttpStatus.CREATED)
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    async open(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('port', ParseIntPipe) port: number,
    ): Promise<FleetPortTunnelOpenResponse> {
        const { tunnel } = await this.tunnels.open(id, port, actorOf(auth));
        return this.withOpenUrl(tunnel, auth.userId);
    }

    @Get('nodes/:id/ports/:port/preview')
    @ApiOperation({
        summary:
            "The person's open preview tunnel to this port (404 when none), with a fresh one-time address.",
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    async current(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('port', ParseIntPipe) port: number,
    ): Promise<FleetPortTunnelOpenResponse> {
        const tunnel = await this.tunnels.current(id, port, actorOf(auth));
        return this.withOpenUrl(tunnel, auth.userId);
    }

    @Delete('nodes/:id/ports/:port/preview')
    @ApiOperation({ summary: "Close the person's preview tunnel to this port (reason `user`)." })
    @HttpCode(HttpStatus.NO_CONTENT)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async close(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('port', ParseIntPipe) port: number,
    ): Promise<void> {
        await this.tunnels.closeForUser(id, port, actorOf(auth));
    }

    private withOpenUrl(tunnel: FleetPortTunnelView, userId: string): FleetPortTunnelOpenResponse {
        const handoff = this.tokens.mintHandoff(tunnel.id, userId);
        return handoff ? { tunnel, openUrl: `${tunnel.url}?t=${encodeURIComponent(handoff)}` } : { tunnel };
    }
}
