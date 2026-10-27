import {
    Body,
    Controller,
    Delete,
    Get,
    Header,
    HttpCode,
    HttpStatus,
    Param,
    ParseIntPipe,
    ParseUUIDPipe,
    Patch,
    Post,
    Query,
    StreamableFile,
    UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
    FLEET_DESKTOP_OPEN_RATE_LIMIT,
    isFleetDisplayId,
    type ComputerControlStateView,
    type FleetDesktopAttachGrant,
    type FleetDesktopAvailabilityView,
    type FleetDesktopControlResult,
    type FleetDesktopRecordingView,
    type FleetDesktopOpenResult,
    type FleetDesktopScreenshot,
    type FleetDesktopViewView,
    type FleetDisplayView,
} from '@ever-works/contracts';
import { CurrentUser } from '../../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../../auth/types/auth.types';
import { fleetLinkError } from '../../fleet-link/fleet-link.errors';
import { FleetEnabledGuard } from '../guards/fleet-enabled.guard';
import {
    AnswerFleetDesktopControlDto,
    DeleteFleetDesktopRecordingDto,
    FleetDesktopControlDto,
    OpenFleetDesktopViewDto,
    UpdateFleetDesktopViewDto,
} from './dto/fleet-desktop.dto';
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
 * Control (P2, FR-36 … FR-42), on a view, through AW-11's control arbiter:
 *
 *  - `GET views/:viewId/control` — who holds the computer, until when, any request;
 *  - `POST views/:viewId/control` — take it (`confirm: true`, class `confirm`;
 *    audited `node.desktop.control.take`) and re-attach with the `driver` grant
 *    it answers, or ask for it (`request: true`, `node.desktop.control.request`);
 *  - `DELETE views/:viewId/control` — give it back (a `viewer` grant answers);
 *  - `POST views/:viewId/control/{handover,keep,extend}`.
 *
 * A watcher's grant is always `viewer`; a `driver` grant goes only to the view
 * holding the computer's control lock.
 */
@ApiTags('fleet')
@Controller('api/fleet')
@UseGuards(FleetEnabledGuard, FleetDesktopEnabledGuard)
export class FleetDesktopController {
    constructor(private readonly desktop: FleetDesktopService) {}

    @Get('nodes/:id/desktop/availability')
    @ApiOperation({
        summary:
            "Whether this computer's desktop can be watched now, and if not the one reason and its fix.",
    })
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    availability(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<FleetDesktopAvailabilityView> {
        return this.desktop.availability(auth.userId, id);
    }

    @Get('nodes/:id/desktop/displays')
    @ApiOperation({
        summary: 'The displays this computer last reported (id, name, size, scale, primary).',
    })
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
        return this.desktop.openView(
            auth.userId,
            id,
            {
                ...(body.source ? { source: body.source } : {}),
                ...(body.displayId ? { displayId: body.displayId } : {}),
                ...(body.quality ? { quality: body.quality } : {}),
                ...(body.fleetSessionId ? { fleetSessionId: body.fleetSessionId } : {}),
            },
            controllerNameOf(auth),
        );
    }

    @Get('nodes/:id/desktop/views/:viewId')
    @ApiOperation({ summary: 'One of my desktop views on this computer.' })
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    view(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('viewId', ParseUUIDPipe) viewId: string,
    ): Promise<FleetDesktopViewView> {
        return this.desktop.view(auth.userId, id, viewId);
    }

    @Patch('nodes/:id/desktop/views/:viewId')
    @ApiOperation({
        summary:
            'Show another display (audited) or change the quality; answers a fresh viewer token to re-attach with.',
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
    ): Promise<void> {
        return this.desktop.endView(auth.userId, id, viewId);
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

    // ─── Control (P2) ──────────────────────────────────────────────────────

    @Get('nodes/:id/desktop/views/:viewId/control')
    @ApiOperation({
        summary:
            'Control of this computer as my view sees it: who holds it, until when, and any request.',
    })
    @Throttle({ long: { limit: 120, ttl: 60_000 } })
    controlState(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('viewId', ParseUUIDPipe) viewId: string,
    ): Promise<ComputerControlStateView> {
        return this.desktop.controlState(auth.userId, id, viewId);
    }

    @Post('nodes/:id/desktop/views/:viewId/control')
    @ApiOperation({
        summary:
            "Take control of this computer's mouse and keyboard from my view (confirm: true; audited) and re-attach with the driver grant it answers — or, with request: true, ask whoever holds it to hand it over.",
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 20, ttl: 60_000 } })
    takeControl(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('viewId', ParseUUIDPipe) viewId: string,
        @Body() body: FleetDesktopControlDto,
    ): Promise<FleetDesktopControlResult> {
        return this.desktop.takeControl(
            auth.userId,
            id,
            viewId,
            {
                ...(body?.request ? { request: true } : {}),
                ...(body?.confirm === true ? { confirm: true } : {}),
            },
            controllerNameOf(auth),
        );
    }

    @Delete('nodes/:id/desktop/views/:viewId/control')
    @ApiOperation({
        summary:
            'Give control back from my view (idempotent); answers the viewer grant to re-attach with.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    giveBackControl(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('viewId', ParseUUIDPipe) viewId: string,
    ): Promise<FleetDesktopControlResult> {
        return this.desktop.giveBackControl(auth.userId, id, viewId);
    }

    @Post('nodes/:id/desktop/views/:viewId/control/handover')
    @ApiOperation({
        summary: 'The view holding control answers a request: hand control over, or keep it.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 20, ttl: 60_000 } })
    answerControlRequest(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('viewId', ParseUUIDPipe) viewId: string,
        @Body() body: AnswerFleetDesktopControlDto,
    ): Promise<FleetDesktopControlResult> {
        return this.desktop.answerControlRequest(
            auth.userId,
            id,
            viewId,
            body.requestId,
            body.decision,
        );
    }

    @Post('nodes/:id/desktop/views/:viewId/control/keep')
    @ApiOperation({ summary: 'Keep control: push back the automatic give-back after inactivity.' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 20, ttl: 60_000 } })
    keepControl(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('viewId', ParseUUIDPipe) viewId: string,
    ): Promise<FleetDesktopControlResult> {
        return this.desktop.keepControl(auth.userId, id, viewId);
    }

    @Post('nodes/:id/desktop/views/:viewId/control/extend')
    @ApiOperation({ summary: 'Extend the current stretch of control once.' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 20, ttl: 60_000 } })
    extendControl(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('viewId', ParseUUIDPipe) viewId: string,
    ): Promise<FleetDesktopControlResult> {
        return this.desktop.extendControl(auth.userId, id, viewId);
    }

    // ─── Recordings (P2.C) ─────────────────────────────────────────────────

    @Get('nodes/:id/desktop/recordings')
    @ApiOperation({
        summary:
            "This computer's desktop recordings (people in its desktop audience): when, how long, how big, until when.",
    })
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    recordings(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<FleetDesktopRecordingView[]> {
        return this.desktop.recordings(auth.userId, id);
    }

    @Get('nodes/:id/desktop/recordings/:viewId')
    @ApiOperation({
        summary: 'One desktop recording with its chunks and control spans (for the player).',
    })
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    recording(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('viewId', ParseUUIDPipe) viewId: string,
    ): Promise<FleetDesktopRecordingView> {
        return this.desktop.recordingFor(auth.userId, id, viewId);
    }

    @Get('nodes/:id/desktop/recordings/:viewId/chunks/:seq')
    @ApiOperation({
        summary: 'One chunk of a desktop recording (an EWR1 container the player paints).',
    })
    @Header('X-Content-Type-Options', 'nosniff')
    @Header('Cache-Control', 'private, no-store')
    @Throttle({ long: { limit: 600, ttl: 60_000 } })
    async recordingChunk(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('viewId', ParseUUIDPipe) viewId: string,
        @Param('seq', ParseIntPipe) seq: number,
    ): Promise<StreamableFile> {
        const bytes = await this.desktop.recordingChunk(auth.userId, id, viewId, seq);
        return new StreamableFile(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), {
            type: 'application/octet-stream',
            disposition: `attachment; filename="desktop-recording-${seq}.ewrec"`,
            length: bytes.byteLength,
        });
    }

    @Delete('nodes/:id/desktop/recordings/:viewId')
    @ApiOperation({
        summary:
            'Delete a desktop recording now (confirm: true; audited). It cannot be brought back.',
    })
    @HttpCode(HttpStatus.NO_CONTENT)
    @Throttle({ long: { limit: 20, ttl: 60_000 } })
    deleteRecording(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('viewId', ParseUUIDPipe) viewId: string,
        @Body() body: DeleteFleetDesktopRecordingDto,
    ): Promise<void> {
        return this.desktop.deleteRecording(auth.userId, id, viewId, body?.confirm === true);
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
            throw fleetLinkError('invalid', 'displayId', {
                displayId: String(displayId).slice(0, 64),
            });
        }
        return this.desktop.screenshot(auth.userId, id, displayId ?? null);
    }
}

/** The name the machine's console prints while this person controls it — the username, never an email. */
function controllerNameOf(auth: AuthenticatedUser): string | null {
    return auth.username || null;
}
