import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    ParseUUIDPipe,
    Patch,
    Post,
    Query,
    UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
    FLEET_DESKTOP_OPEN_RATE_LIMIT,
    isFleetDisplayId,
    type FleetDesktopAttachGrant,
    type FleetDesktopAvailabilityView,
    type FleetDesktopOpenResult,
    type FleetDesktopScreenshot,
    type FleetDesktopViewView,
    type FleetDisplayView,
} from '@ever-works/contracts';
import { CurrentUser } from '../../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../../auth/types/auth.types';
import { fleetLinkError } from '../../fleet-link/fleet-link.errors';
import { FleetEnabledGuard } from '../guards/fleet-enabled.guard';
import { OpenFleetDesktopViewDto, UpdateFleetDesktopViewDto } from './dto/fleet-desktop.dto';
import { FleetDesktopEnabledGuard } from './fleet-desktop-enabled.guard';
import { FleetDesktopService } from './fleet-desktop.service';

/**
 * Desktop view & control (FL-07, plan §5, CONTRACTS §11.2) —
 * `/api/fleet/nodes/:id/desktop/*` for the Desktop source (dark unless
 * `FLEET_ENABLED` and `FLEET_DESKTOP_ENABLED`; FL-11's paste routes under the
 * same prefix keep their own guard). Every refusal is the CONTRACTS §8 envelope
 * `{ error: { code, hint, details } }`; a computer the caller may not see is
 * the 404 of an unknown id.
 *
 *  - `GET availability` — may a view open, and if not the one reason (with the
 *    command or settings path that fixes it); the helper, the displays;
 *  - `GET displays` — the displays the machine last reported (`desktop` audience);
 *  - `POST views` — open a view: audited `node.desktop.view`, answered with the
 *    single-use 60-second viewer grant for `/ws/fleet/desktop/<viewId>`;
 *  - `GET` / `PATCH` / `DELETE views/:viewId` — read, switch display or quality
 *    (audited `node.desktop.display.set`, a fresh grant), end;
 *  - `POST views/:viewId/attach-token` — reconnect the same view;
 *  - `GET screenshot` — one Steady-width picture (the read-only Agent tool).
 *
 * Watching is read-only in this phase: every grant is role `viewer`.
 */
@ApiTags('fleet')
@Controller('api/fleet')
@UseGuards(FleetEnabledGuard, FleetDesktopEnabledGuard)
export class FleetDesktopController {
    constructor(private readonly desktop: FleetDesktopService) {}

    @Get('nodes/:id/desktop/availability')
    @ApiOperation({
        summary: "Whether this computer's desktop can be watched now, and if not the one reason and its fix.",
    })
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    availability(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<FleetDesktopAvailabilityView> {
        return this.desktop.availability(auth.userId, id);
    }

    @Get('nodes/:id/desktop/displays')
    @ApiOperation({ summary: 'The displays this computer last reported (id, name, size, scale, primary).' })
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    displays(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<FleetDisplayView[]> {
        return this.desktop.displays(auth.userId, id);
    }

    @Post('nodes/:id/desktop/views')
    @ApiOperation({
        summary:
            "Open a live view of this computer's desktop (watching only; audited). Answers the single-use viewer token for its socket.",
    })
    @HttpCode(HttpStatus.ACCEPTED)
    @Throttle({ long: { limit: FLEET_DESKTOP_OPEN_RATE_LIMIT, ttl: 60_000 } })
    open(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: OpenFleetDesktopViewDto,
    ): Promise<FleetDesktopOpenResult> {
        return this.desktop.openView(auth.userId, id, {
            ...(body.source ? { source: body.source } : {}),
            ...(body.displayId ? { displayId: body.displayId } : {}),
            ...(body.quality ? { quality: body.quality } : {}),
            ...(body.fleetSessionId ? { fleetSessionId: body.fleetSessionId } : {}),
        });
    }

    @Get('nodes/:id/desktop/views/:viewId')
    @ApiOperation({ summary: 'One of my desktop views on this computer.' })
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    view(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('viewId', ParseUUIDPipe) viewId: string,
    ): FleetDesktopViewView {
        return this.desktop.viewFor(auth.userId, id, viewId);
    }

    @Patch('nodes/:id/desktop/views/:viewId')
    @ApiOperation({
        summary: 'Show another display (audited) or change the quality; answers a fresh viewer token to re-attach with.',
    })
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    update(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('viewId', ParseUUIDPipe) viewId: string,
        @Body() body: UpdateFleetDesktopViewDto,
    ): Promise<FleetDesktopOpenResult> {
        return this.desktop.updateView(auth.userId, id, viewId, {
            ...(body.displayId ? { displayId: body.displayId } : {}),
            ...(body.quality ? { quality: body.quality } : {}),
        });
    }

    @Delete('nodes/:id/desktop/views/:viewId')
    @ApiOperation({ summary: 'End one of my desktop views (idempotent).' })
    @HttpCode(HttpStatus.NO_CONTENT)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    end(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('viewId', ParseUUIDPipe) viewId: string,
    ): void {
        this.desktop.endView(auth.userId, id, viewId);
    }

    @Post('nodes/:id/desktop/views/:viewId/attach-token')
    @ApiOperation({ summary: 'A fresh single-use viewer token for the same view (a reconnect).' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    attachToken(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('viewId', ParseUUIDPipe) viewId: string,
    ): Promise<FleetDesktopAttachGrant> {
        return this.desktop.attachToken(auth.userId, id, viewId);
    }

    @Get('nodes/:id/desktop/screenshot')
    @ApiOperation({
        summary:
            "One Steady-width picture of this computer's desktop (read-only; audited). What the Agent screenshot tool reads.",
    })
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    screenshot(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Query('displayId') displayId?: string,
    ): Promise<FleetDesktopScreenshot> {
        if (displayId !== undefined && !isFleetDisplayId(displayId)) {
            throw fleetLinkError('invalid', 'displayId', { displayId: String(displayId).slice(0, 64) });
        }
        return this.desktop.screenshot(auth.userId, id, displayId ?? null);
    }
}
