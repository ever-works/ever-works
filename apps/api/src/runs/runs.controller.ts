import {
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    NotFoundException,
    Optional,
    Param,
    ParseUUIDPipe,
    Query,
    UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { RunLedgerService, RunReceiptService } from '@ever-works/agent/agents';
import type {
    RunCalendarMonth,
    RunLedgerPage,
    RunReceipt,
    RunWindowStats,
} from '@ever-works/contracts';
import { AuthSessionGuard, CurrentUser } from '@src/auth';
import type { AuthenticatedUser } from '@src/auth/types/auth.types';
import { ScopeContextService } from '../scope';
import {
    ListRunsQueryDto,
    RunCalendarQueryDto,
    RunStatsQueryDto,
    toRunLedgerFilters,
} from './dto/run-ledger.dto';

/**
 * The one response body for "no such run" AND "not your run", so the
 * receipt endpoint can never be used to learn that a run id exists.
 */
const RUN_NOT_FOUND_MESSAGE = 'Run not found.';

/**
 * Runs ledger + run receipt (AW-09) — read-only.
 *
 *   GET /api/runs                    one cursor page of runs for a window
 *   GET /api/runs/stats              the window's headline numbers
 *   GET /api/runs/calendar           days with runs (and failures) in a month
 *   GET /api/runs/:runId/receipt     the itemised account of one run
 *
 * A calendar-shaped reader over the same `agent_runs` rows the Sessions
 * endpoints (`GET /api/agents/runs*`) serve; those keep their exact shape.
 *
 * Every read is scoped to `@CurrentUser()` plus the request's Organization
 * scope (`X-Scope-Slug`, resolved by `ScopeContextService`) inside the
 * repository. NOTHING here accepts a user, Organization or tenant id.
 *
 * Route order: the literal `stats` and `calendar` segments are declared
 * before `:runId/receipt`, so a literal never reaches `ParseUUIDPipe`.
 */
@ApiTags('Runs')
@ApiBearerAuth('JWT-auth')
@Controller('api/runs')
@UseGuards(AuthSessionGuard)
export class RunsController {
    constructor(
        private readonly ledger: RunLedgerService,
        private readonly receipts: RunReceiptService,
        @Optional() private readonly scopeContext?: ScopeContextService,
    ) {}

    @Get('stats')
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 120, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Headline numbers for one window of runs.',
        description:
            'Run count, success rate (completed ÷ terminal; null with no terminal run), error ' +
            'count, agent time, settled spend (null when no run in the window has a settled ' +
            'cost), token total and schedules that failed repeatedly. Same window and filters ' +
            'as GET /api/runs.',
    })
    @ApiResponse({ status: 200, description: 'Window statistics' })
    @ApiResponse({ status: 400, description: 'Invalid window or filter' })
    async stats(
        @CurrentUser() auth: AuthenticatedUser,
        @Query() query: RunStatsQueryDto,
    ): Promise<RunWindowStats> {
        return this.ledger.getStats(
            auth.userId,
            {
                granularity: query.granularity,
                date: query.date,
                timezone: query.timezone,
                filters: toRunLedgerFilters(query),
            },
            this.scopeContext?.getScope(),
        );
    }

    @Get('calendar')
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Days of one month that had runs, with how many failed.',
        description:
            'Days are calendar days in `timezone`. Only days with at least one run are listed.',
    })
    @ApiResponse({ status: 200, description: 'Calendar month' })
    @ApiResponse({ status: 400, description: 'Invalid month, timezone or filter' })
    async calendar(
        @CurrentUser() auth: AuthenticatedUser,
        @Query() query: RunCalendarQueryDto,
    ): Promise<RunCalendarMonth> {
        return this.ledger.getCalendar(
            auth.userId,
            { month: query.month, timezone: query.timezone, filters: toRunLedgerFilters(query) },
            this.scopeContext?.getScope(),
        );
    }

    @Get()
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 120, ttl: 60_000 } })
    @ApiOperation({
        summary: 'One page of runs for a Day, Week or Month window, newest first.',
        description:
            'The window is resolved server-side from granularity + date + timezone and clamped ' +
            'to 12 months back / 7 days forward (`window.clamped`). `limit` defaults to 50, max 200.',
    })
    @ApiResponse({ status: 200, description: 'Ledger page' })
    @ApiResponse({ status: 400, description: 'Invalid window, filter, limit or cursor' })
    async list(
        @CurrentUser() auth: AuthenticatedUser,
        @Query() query: ListRunsQueryDto,
    ): Promise<RunLedgerPage> {
        return this.ledger.listRuns(
            auth.userId,
            {
                granularity: query.granularity,
                date: query.date,
                timezone: query.timezone,
                filters: toRunLedgerFilters(query),
                limit: query.limit,
                cursor: query.cursor,
            },
            this.scopeContext?.getScope(),
        );
    }

    @Get(':runId/receipt')
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 120, ttl: 60_000 } })
    @ApiOperation({
        summary: 'The itemised receipt of one run.',
        description:
            'Ledger row, cost (settled total, metered usage lines, credits debited — the same ' +
            'figures the Costs dashboard reads), capture counts, files touched and Knowledge Base ' +
            'citations. A missing run and a run the caller cannot read return the same 404.',
    })
    @ApiResponse({ status: 200, description: 'Run receipt' })
    @ApiResponse({ status: 404, description: 'Run not found' })
    async receipt(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('runId', ParseUUIDPipe) runId: string,
    ): Promise<RunReceipt> {
        const receipt = await this.receipts.getReceipt(
            auth.userId,
            runId,
            this.scopeContext?.getScope(),
        );
        if (!receipt) {
            throw new NotFoundException(RUN_NOT_FOUND_MESSAGE);
        }
        return receipt;
    }
}
