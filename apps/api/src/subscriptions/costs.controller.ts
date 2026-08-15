import {
    BadRequestException,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Query,
    UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { AuthSessionGuard, CurrentUser } from '@src/auth';
import { AuthenticatedUser } from '@src/auth/types/auth.types';
import {
    COSTS_TOP_RUNS_MAX_LIMIT,
    COSTS_WINDOW_DAYS,
    CostsSummaryService,
    InvalidCostsWindowError,
    type CostsByAgent,
    type CostsByModel,
    type CostsDaily,
    type CostsSummary,
    type CostsTopRuns,
} from '@ever-works/agent/subscriptions';

/**
 * Rolling window for every Costs panel. `windowDays` arrives as a query
 * string, so `@Type(() => Number)` runs BEFORE `@IsIn` — without it the
 * literal `'30'` never matches the numeric allow-list and every request
 * 400s.
 */
export class CostsWindowQueryDto {
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @IsIn(COSTS_WINDOW_DAYS as unknown as number[], {
        message: `windowDays must be one of ${COSTS_WINDOW_DAYS.join(', ')}`,
    })
    windowDays?: number;
}

/** Top-runs adds a bounded page size on top of the shared window. */
export class CostsTopRunsQueryDto extends CostsWindowQueryDto {
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(COSTS_TOP_RUNS_MAX_LIMIT)
    limit?: number;
}

/**
 * Costs dashboard (Settings → Usage & Credits → Costs) — read-only,
 * owner-scoped AI-spend aggregations.
 *
 * Every endpoint scopes to `@CurrentUser()` and NOTHING here accepts a
 * user/org id: spend is the most sensitive read on the platform, and a
 * caller-supplied scope param is exactly how a cross-account billing
 * read happens. The sibling admin surface
 * (`api/admin/usage`) stays the only cross-user view, behind
 * `IsPlatformAdminGuard`.
 *
 * Sits beside `CreditsController` rather than in `budgets/` because it
 * consumes `CostsSummaryService` from the agent's SubscriptionsModule,
 * which this module already imports.
 */
@ApiTags('Usage')
@ApiBearerAuth('JWT-auth')
@Controller('api/usage/costs')
@UseGuards(AuthSessionGuard)
export class CostsController {
    constructor(private readonly costsSummaryService: CostsSummaryService) {}

    @Get('summary')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Total AI spend, run count and average cost per run for a rolling window.',
        description: 'windowDays accepts 7, 30 or 90 (default 30). Owner-scoped.',
    })
    @ApiResponse({ status: 200, description: 'Headline cost totals' })
    @ApiResponse({ status: 400, description: 'Invalid windowDays' })
    async summary(
        @CurrentUser() auth: AuthenticatedUser,
        @Query() query: CostsWindowQueryDto,
    ): Promise<{ status: string } & CostsSummary> {
        return this.run(() => this.costsSummaryService.getSummary(auth.userId, query.windowDays));
    }

    @Get('daily')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Daily spend for the window, stacked by Agent.',
        description:
            'Dense day axis (zero-spend days included) so the chart never collapses gaps. ' +
            'Series beyond the top few Agents are folded into an "other" series; spend recorded ' +
            'outside any Agent run is its own "unattributed" series.',
    })
    @ApiResponse({ status: 200, description: 'Stacked daily series' })
    @ApiResponse({ status: 400, description: 'Invalid windowDays' })
    async daily(
        @CurrentUser() auth: AuthenticatedUser,
        @Query() query: CostsWindowQueryDto,
    ): Promise<{ status: string } & CostsDaily> {
        return this.run(() => this.costsSummaryService.getDaily(auth.userId, query.windowDays));
    }

    @Get('by-agent')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Per-Agent spend, run count and average cost per run.',
        description:
            'No cache-hit column: the metering path does not record cached-read tokens, and a ' +
            'derived percentage would be fabricated.',
    })
    @ApiResponse({ status: 200, description: 'Per-Agent rows, most expensive first' })
    @ApiResponse({ status: 400, description: 'Invalid windowDays' })
    async byAgent(
        @CurrentUser() auth: AuthenticatedUser,
        @Query() query: CostsWindowQueryDto,
    ): Promise<{ status: string } & CostsByAgent> {
        return this.run(() => this.costsSummaryService.getByAgent(auth.userId, query.windowDays));
    }

    @Get('by-model')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Per-model spend with each model share of the window total.',
        description:
            'A null modelId is honest, not missing data: search / screenshot / extractor calls ' +
            'never go through a model.',
    })
    @ApiResponse({ status: 200, description: 'Per-model rows, most expensive first' })
    @ApiResponse({ status: 400, description: 'Invalid windowDays' })
    async byModel(
        @CurrentUser() auth: AuthenticatedUser,
        @Query() query: CostsWindowQueryDto,
    ): Promise<{ status: string } & CostsByModel> {
        return this.run(() => this.costsSummaryService.getByModel(auth.userId, query.windowDays));
    }

    @Get('top-runs')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'The window most expensive Agent runs.',
        description:
            'Only runs with settled cost are listed: agent_runs.costCents is NULL until run-cost ' +
            `settlement stamps it, and NULL means "not attributable", not "free". limit defaults ` +
            `to 20 and is capped at ${COSTS_TOP_RUNS_MAX_LIMIT}.`,
    })
    @ApiResponse({ status: 200, description: 'Top runs by cost, descending' })
    @ApiResponse({ status: 400, description: 'Invalid windowDays or limit' })
    async topRuns(
        @CurrentUser() auth: AuthenticatedUser,
        @Query() query: CostsTopRunsQueryDto,
    ): Promise<{ status: string } & CostsTopRuns> {
        return this.run(() =>
            this.costsSummaryService.getTopRuns(auth.userId, query.windowDays, query.limit),
        );
    }

    /**
     * Defence-in-depth: the DTO allow-list already rejects a bad window,
     * but the service's stable-named error must still map to a 4xx —
     * never an unmapped 500 (billing PRD §6).
     */
    private async run<T>(load: () => Promise<T>): Promise<{ status: string } & T> {
        try {
            return { status: 'success', ...(await load()) };
        } catch (error) {
            if (error instanceof InvalidCostsWindowError) {
                throw new BadRequestException(error.message);
            }
            throw error;
        }
    }
}
