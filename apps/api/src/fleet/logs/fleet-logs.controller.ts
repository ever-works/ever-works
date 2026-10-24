import {
    Body,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    ParseUUIDPipe,
    Post,
    UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
    FLEET_LOGS_READ_RATE_LIMIT,
    FLEET_LOGS_SOURCES_RATE_LIMIT,
    FLEET_LINK_VIEWER_TOKEN_RATE_LIMIT,
    type FleetLogSourcesResponse,
    type FleetLogsAttachGrant,
    type FleetLogsReadResult,
} from '@ever-works/contracts';
import { CurrentUser } from '../../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../../auth/types/auth.types';
import { FleetEnabledGuard } from '../guards/fleet-enabled.guard';
import { FleetMachineFactsEnabledGuard } from '../machine/fleet-machine-facts-enabled.guard';
import { FleetLogsAttachDto, FleetLogsReadDto } from './dto/fleet-logs.dto';
import { FleetLogsService } from './fleet-logs.service';

/**
 * Logs on computers (FL-08, plan §5, CONTRACTS §11.2) — three routes under
 * `/api/fleet`, dark (404) unless `FLEET_ENABLED` and
 * `FLEET_MACHINE_FACTS_ENABLED` are both on (FR-34):
 *
 *  - `GET  /nodes/:id/logs/sources` — what the computer can show: System,
 *    Files, Containers, Services (FR-1 … FR-11);
 *  - `POST /nodes/:id/logs/attach-token` — a 60-second viewer token for the
 *    log viewer socket (`/ws/fleet/logs/<id>`), the first 500 lines then live;
 *  - `POST /nodes/:id/logs/read` — one batch of at most 500 scanned lines,
 *    never a follow (the MCP / CLI / Agent read).
 *
 * Every route is the `logs` action family (CONTRACTS §2.1, default audience
 * `owner`), needs `--manage` on the machine, is refused `kill_switch` while
 * all computers are stopped, and answers the CONTRACTS §8 envelope on
 * refusal. Reads and follows are audited (`node.logs.read`,
 * `node.logs.follow`); nothing else is stored.
 */
@ApiTags('fleet')
@Controller('api/fleet')
@UseGuards(FleetEnabledGuard, FleetMachineFactsEnabledGuard)
export class FleetLogsController {
    constructor(private readonly logs: FleetLogsService) {}

    @Get('nodes/:id/logs/sources')
    @ApiOperation({
        summary:
            "The log sources of one computer, in four groups: System (journal and kernel on Linux, the unified log on macOS, System / Application / Security event logs on Windows), Files (log files under the standard log folders and the folders the computer shares, newest first, 200 per folder; root-only files are listed but cannot be opened), Containers (every Docker container) and Services (running and failed, failed first). Needs the computer to run with --manage and the `logs` family; 404 for a computer I cannot see.",
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: FLEET_LOGS_SOURCES_RATE_LIMIT, ttl: 60_000 } })
    sources(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<FleetLogSourcesResponse> {
        return this.logs.sourcesForUser(auth.userId, id);
    }

    @Post('nodes/:id/logs/attach-token')
    @ApiOperation({
        summary:
            'A 60-second, single-use token for the log viewer socket (`wsPath`): it opens the source (or up to 12 merged sources), shows its last lines (default 500) and, with follow, the new ones live at up to 1 MiB/s. Every line is secret-scanned on the computer. Refused `limit_exceeded` when I already have 8 logs open on that computer. Audited (`node.logs.read`, `node.logs.follow`).',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: FLEET_LINK_VIEWER_TOKEN_RATE_LIMIT, ttl: 60_000 } })
    attachToken(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: FleetLogsAttachDto,
    ): Promise<FleetLogsAttachGrant> {
        return this.logs.mintForUser(auth.userId, id, {
            source: body.source,
            ...(body.sources ? { sources: body.sources } : {}),
            ...(body.lines !== undefined ? { lines: body.lines } : {}),
            follow: body.follow !== false,
        });
    }

    @Post('nodes/:id/logs/read')
    @ApiOperation({
        summary:
            "Read the last lines (at most 500) of one log source once — no follow — optionally keeping only the lines that contain `filter` (case-insensitive). Lines are secret-scanned on the computer; a file outside the computer's shared folders and standard log directories is refused `invalid`. Audited (`node.logs.read`).",
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: FLEET_LOGS_READ_RATE_LIMIT, ttl: 60_000 } })
    read(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: FleetLogsReadDto,
    ): Promise<FleetLogsReadResult> {
        return this.logs.readForUser(auth.userId, id, {
            source: body.source,
            ...(body.lines !== undefined ? { lines: body.lines } : {}),
            filter: body.filter?.trim() || null,
        });
    }
}
