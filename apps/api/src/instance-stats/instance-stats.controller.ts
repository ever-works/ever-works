import {
    Body,
    Controller,
    Get,
    Header,
    HttpCode,
    HttpException,
    HttpStatus,
    Post,
    Put,
    Res,
    UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { UserRepository } from '@ever-works/agent/database';
import type {
    InstanceStatsReportView,
    InstanceStatsStatus,
    StatsSendResult,
    WorksStatsV1Report,
} from '@ever-works/contracts';
import { CurrentUser } from '../auth/decorators/user.decorator';
import { IsPlatformAdminGuard } from '../auth/guards/platform-admin.guard';
import { SessionOnlyGuard } from '../auth/guards/session-only.guard';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { InstanceStatsToggleDto } from './dto/instance-stats.dto';
import {
    InstanceStatsResetRefusedError,
    InstanceStatsSendNowRefusedError,
    InstanceStatsService,
} from './instance-stats.service';

/**
 * Anonymous usage statistics — the operator routes behind Settings → Ever
 * Platform → Anonymous usage statistics.
 *
 *   GET  /api/instance-stats/status          any signed-in person: `{enabled, managedBy}`;
 *                                             the platform admin: the full status
 *   POST /api/instance-stats/preview         admin: what would be sent now
 *   GET  /api/instance-stats/last            admin: the exact last payload
 *   POST /api/instance-stats/send-now        admin: one send (1 per 10 min)
 *   PUT  /api/instance-stats/toggle          admin: the switch
 *   POST /api/instance-stats/reset-identity  admin: new instance id and key
 *
 * Every route needs a signed-in caller (the global guard); none is public and
 * none is called by Ever Platform (see `ever-connect.routes.json`). The three
 * operator CONTROLS — the switch, *Send now* and *Reset instance identity* —
 * also need the admin's interactive session (`SessionOnlyGuard`): an API key
 * or a fleet-run credential acting as the admin is refused with 403, so an
 * automation can never switch statistics back on, send or reset the identity.
 * The module is not loaded at all with `EVER_STATS_ENABLED=false`, so every
 * route then answers 404. Responses are never cached.
 */
@ApiTags('instance-stats')
@ApiBearerAuth('JWT-auth')
@Controller('api/instance-stats')
export class InstanceStatsController {
    constructor(
        private readonly stats: InstanceStatsService,
        private readonly users: UserRepository,
    ) {}

    @Get('status')
    @Header('Cache-Control', 'no-store')
    @ApiOperation({
        summary:
            'Whether this installation sends anonymous usage statistics and who manages them. A platform admin also gets the reason, the next send, the endpoint and the last attempt; anyone else gets {enabled, managedBy} only.',
    })
    async status(@CurrentUser() auth: AuthenticatedUser): Promise<InstanceStatsStatus> {
        const user = auth?.userId ? await this.users.findById(auth.userId) : null;
        if (user?.isPlatformAdmin === true) return this.stats.operatorStatus();
        return this.stats.publicStatus();
    }

    @Post('preview')
    @HttpCode(HttpStatus.OK)
    @UseGuards(IsPlatformAdminGuard)
    @Header('Cache-Control', 'no-store')
    @ApiOperation({
        summary: 'The report that would be sent now, built from live numbers (never sent).',
    })
    @ApiResponse({ status: 403, description: 'Caller is not a platform admin' })
    async preview(): Promise<WorksStatsV1Report> {
        return this.stats.preview();
    }

    @Get('last')
    @UseGuards(IsPlatformAdminGuard)
    @Header('Cache-Control', 'no-store')
    @ApiOperation({ summary: 'The last attempt with the exact bytes that were posted.' })
    @ApiResponse({ status: 403, description: 'Caller is not a platform admin' })
    async last(): Promise<{ report: InstanceStatsReportView | null }> {
        return { report: await this.stats.last() };
    }

    @Post('send-now')
    @HttpCode(HttpStatus.OK)
    @UseGuards(SessionOnlyGuard, IsPlatformAdminGuard)
    @Header('Cache-Control', 'no-store')
    @Throttle({ long: { limit: 5, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Send one report now (at most once per 10 minutes; refused while switched off).',
    })
    @ApiResponse({
        status: 403,
        description: 'Caller is not a platform admin, or not in an interactive session',
    })
    @ApiResponse({
        status: 409,
        description: 'Statistics are switched off, or a send is in progress',
    })
    @ApiResponse({ status: 429, description: 'Less than 10 minutes since the last Send now' })
    async sendNow(
        @CurrentUser() auth: AuthenticatedUser,
        @Res({ passthrough: true }) response: { setHeader(name: string, value: string): void },
    ): Promise<{ results: StatsSendResult[] }> {
        try {
            const outcome = await this.stats.sendNow(auth.userId);
            return { results: outcome.ran ? outcome.results : [] };
        } catch (error) {
            if (!(error instanceof InstanceStatsSendNowRefusedError)) throw error;
            if (error.reason === 'rate_limited') {
                if (error.retryAfterS !== null)
                    response.setHeader('Retry-After', String(error.retryAfterS));
                throw new HttpException(
                    {
                        status: 'error',
                        code: 'rate_limited',
                        message: 'Send now is allowed once per 10 minutes',
                    },
                    HttpStatus.TOO_MANY_REQUESTS,
                );
            }
            throw new HttpException(
                {
                    status: 'error',
                    code: error.reason === 'ui' ? 'stats_disabled' : 'send_in_progress',
                    reason: error.reason,
                    message:
                        error.reason === 'ui'
                            ? 'Anonymous usage statistics are switched off'
                            : 'A report is being sent right now',
                },
                HttpStatus.CONFLICT,
            );
        }
    }

    @Put('toggle')
    @UseGuards(SessionOnlyGuard, IsPlatformAdminGuard)
    @Header('Cache-Control', 'no-store')
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    @ApiOperation({
        summary:
            'Switch anonymous usage statistics on or off for this installation. Off: no request is made at all. Writes an Activity row with the actor and the action only.',
    })
    @ApiResponse({
        status: 403,
        description: 'Caller is not a platform admin, or not in an interactive session',
    })
    async toggle(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: InstanceStatsToggleDto,
    ): Promise<{ enabled: boolean }> {
        return { enabled: await this.stats.setEnabled(auth.userId, body.enabled) };
    }

    @Post('reset-identity')
    @HttpCode(HttpStatus.OK)
    @UseGuards(SessionOnlyGuard, IsPlatformAdminGuard)
    @Header('Cache-Control', 'no-store')
    @Throttle({ long: { limit: 5, ttl: 60_000 } })
    @ApiOperation({
        summary:
            'Give this installation a new instance id and a new statistics key, so future reports cannot be joined to past ones. Writes an Activity row with the actor and the action only.',
    })
    @ApiResponse({
        status: 403,
        description: 'Caller is not a platform admin, or not in an interactive session',
    })
    @ApiResponse({ status: 409, description: 'A report is being sent right now' })
    async resetIdentity(
        @CurrentUser() auth: AuthenticatedUser,
    ): Promise<{ instanceId: string; resetCount: number }> {
        try {
            return await this.stats.resetIdentity(auth.userId);
        } catch (error) {
            if (!(error instanceof InstanceStatsResetRefusedError)) throw error;
            throw new HttpException(
                {
                    status: 'error',
                    code: 'send_in_progress',
                    message: 'A report is being sent right now',
                },
                HttpStatus.CONFLICT,
            );
        }
    }
}
