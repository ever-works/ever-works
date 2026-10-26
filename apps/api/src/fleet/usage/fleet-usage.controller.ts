import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { FleetUsageScanService, FleetUsageViewService } from '@ever-works/agent/fleet';
import type {
    FleetUsagePricesView,
    FleetUsageRescanResult,
    FleetUsageTaskCostsView,
    FleetUsageView,
} from '@ever-works/contracts';
import { CurrentUser } from '../../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../../auth/types/auth.types';
import { FleetEnabledGuard } from '../guards/fleet-enabled.guard';
import { FleetUsageQueryDto, FleetUsageRescanDto, FleetUsageTaskCostsQueryDto } from './dto/fleet-usage.dto';
import { FleetUsageEnabledGuard } from './fleet-usage-enabled.guard';

/**
 * Usage & cost on the fleet (FL-20, plan §5, CONTRACTS §11.2 `/usage`) — the
 * read surface every Usage view renders, the owner's "scan now", and the
 * list prices in effect.
 *
 * Gates, in order: `FleetEnabledGuard` (the whole fleet), then
 * `FleetUsageEnabledGuard` (`FLEET_USAGE_SCAN_ENABLED`, default off; 404),
 * then the global auth guard (no route here is public), then the services'
 * own checks: computers through `FleetAccessService` (`view` audience; a
 * stranger reads the 404 of an unknown id), the scan consent, the kill switch.
 * Every refusal is the CONTRACTS §8 envelope with its status (FR-18).
 *
 * Nothing here writes `fleet_audit`: reads are reads, and a rescan only asks
 * for another read-only scan (FR-20).
 */
@ApiTags('fleet')
@Controller('api/fleet/usage')
@UseGuards(FleetEnabledGuard, FleetUsageEnabledGuard)
export class FleetUsageController {
    constructor(
        private readonly views: FleetUsageViewService,
        private readonly scans: FleetUsageScanService,
    ) {}

    @Get()
    @ApiOperation({
        summary:
            "What the model work on my computers would cost at list price over the last 1, 7, 30 or 90 days: totals, by model, by computer (with each one's last scan), busiest checkouts and sessions. `node` scopes it to one computer. List price — the machines' own sign-ins paid; Ever Works charged nothing.",
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    async view(@CurrentUser() auth: AuthenticatedUser, @Query() query: FleetUsageQueryDto): Promise<FleetUsageView> {
        return this.views.view(auth.userId, {
            days: query.days,
            nodeId: query.node ?? null,
            model: query.model ?? null,
            agentId: query.agent ?? null,
        });
    }

    @Get('tasks')
    @ApiOperation({
        summary:
            "What my recurring Tasks' Agent sessions cost at list price: each Task's newest Run and its last 30 days (the schedule rows). My own Runs only. Read-only.",
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    async tasks(
        @CurrentUser() auth: AuthenticatedUser,
        @Query() query: FleetUsageTaskCostsQueryDto,
    ): Promise<FleetUsageTaskCostsView> {
        return this.views.taskCosts(
            auth.userId,
            query.ids.split(',').map((id) => id.trim()),
        );
    }

    @Post('rescan')
    @ApiOperation({
        summary:
            "Ask one of my computers to scan its Claude Code and Codex records now (owner only). Counts only — never prompts, output or files. Answers the scan's job id; a scan already waiting is returned rather than doubled.",
    })
    @HttpCode(HttpStatus.ACCEPTED)
    @Throttle({ long: { limit: 6, ttl: 60 * 60_000 } })
    async rescan(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: FleetUsageRescanDto,
    ): Promise<FleetUsageRescanResult> {
        return this.scans.rescan(body.nodeId, auth.userId);
    }

    @Get('prices')
    @ApiOperation({
        summary:
            'The model list-price table fleet usage is priced at (per million tokens, four token classes) and its version history. Read-only.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    prices(): FleetUsagePricesView {
        return this.views.pricesView();
    }
}
