import {
    Body,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    ParseUUIDPipe,
    Post,
    Put,
    Query,
    UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
    FLEET_CLIP_PASTE_RATE_LIMIT,
    type FleetClipPasteResult,
    type FleetClipViewState,
} from '@ever-works/contracts';
import { CurrentUser } from '../../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../../auth/types/auth.types';
import { FleetEnabledGuard } from '../guards/fleet-enabled.guard';
import { FleetMachineFactsEnabledGuard } from '../machine/fleet-machine-facts-enabled.guard';
import { FleetClipPasteDto, FleetClipSwitchDto, FleetClipViewQueryDto } from './dto/fleet-clip.dto';
import { FleetClipService } from './fleet-clip.service';

/**
 * Paste into a desktop (FL-11 P2, plan §5, CONTRACTS R-27) — the clipboard's
 * one sanctioned direction, under `/api/fleet/nodes/:id/desktop/*` (dark
 * unless `FLEET_ENABLED` and `FLEET_MACHINE_FACTS_ENABLED`):
 *
 *  - `GET` / `PUT paste-switch` — "Allow paste into this desktop" for one live
 *    view: off by default, never stored, gone when the view ends;
 *  - `POST paste` — text (≤ 256 KB) into the focused window of the view's
 *    machine, only while the view holds control and the switch is on; audited
 *    with the byte count only (`node.clip.paste`). Nothing is ever read back.
 */
@ApiTags('fleet')
@Controller('api/fleet')
@UseGuards(FleetEnabledGuard, FleetMachineFactsEnabledGuard)
export class FleetClipController {
    constructor(private readonly clip: FleetClipService) {}

    @Get('nodes/:id/desktop/paste-switch')
    @ApiOperation({
        summary: 'Whether paste is switched on for one of my live views on this computer.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 120, ttl: 60_000 } })
    getSwitch(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Query() query: FleetClipViewQueryDto,
    ): Promise<FleetClipViewState> {
        return this.clip.getSwitch(auth.userId, id, {
            viewId: query.viewId,
            agentId: query.agentId,
        });
    }

    @Put('nodes/:id/desktop/paste-switch')
    @ApiOperation({
        summary:
            'Switch paste on or off for one of my live views (off by default; it resets when the view ends and is never stored).',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: FLEET_CLIP_PASTE_RATE_LIMIT, ttl: 60_000 } })
    setSwitch(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: FleetClipSwitchDto,
    ): Promise<FleetClipViewState> {
        return this.clip.setSwitch(auth.userId, id, {
            viewId: body.viewId,
            agentId: body.agentId,
            allowed: body.allowed,
        });
    }

    @Post('nodes/:id/desktop/paste')
    @ApiOperation({
        summary:
            "Paste text (at most 256 KB) from my clipboard into the focused window of one of my live views — only while that view holds control and paste is switched on for it. The computer's clipboard is never read. Audited with the byte count only.",
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: FLEET_CLIP_PASTE_RATE_LIMIT, ttl: 60_000 } })
    paste(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: FleetClipPasteDto,
    ): Promise<FleetClipPasteResult> {
        return this.clip.paste(auth.userId, id, {
            viewId: body.viewId,
            agentId: body.agentId,
            text: body.text,
        });
    }
}
