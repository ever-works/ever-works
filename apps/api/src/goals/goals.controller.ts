import {
    BadRequestException,
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
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
    GoalStatus,
    GoalsService,
    type GoalDto,
    type GoalEvaluationEntry,
    type GoalMetricSampleDto,
} from '@ever-works/agent/goals';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { CreateGoalDto, UpdateGoalDto } from './dto/goal.dto';

/**
 * Goals & Metrics — PR-8 (spec FR-9..FR-14). User-owned measurable
 * targets evaluated against `metrics-provider` plugins (PR-7).
 *
 * Endpoints:
 *   GET    /api/me/goals                   list mine
 *   POST   /api/me/goals                   create (status=draft)
 *   GET    /api/me/goals/:id               get one
 *   GET    /api/me/goals/:id/samples       observation history
 *   PATCH  /api/me/goals/:id               partial update (incl. outcome override)
 *   DELETE /api/me/goals/:id               delete (cascades samples + links)
 *   POST   /api/me/goals/:id/activate      (draft|paused|completed) → active
 *   POST   /api/me/goals/:id/pause         active → paused
 *   POST   /api/me/goals/:id/evaluate-now  manual tick (bypasses nextCheckAt,
 *                                          NOT the budget guard)
 *
 * Mission link/unlink lives on the MissionsController
 * (`/api/me/missions/:id/goals`). Same throttling posture as
 * Missions: 30/min writes, 10/min for evaluate-now (it hits an
 * upstream metrics provider).
 */
@ApiTags('goals')
@Controller('api/me/goals')
export class GoalsController {
    constructor(private readonly service: GoalsService) {}

    @Get()
    @ApiOperation({ summary: 'List my goals' })
    @HttpCode(HttpStatus.OK)
    async list(
        @CurrentUser() auth: AuthenticatedUser,
        @Query('status') status?: string,
        @Query('limit') limit?: string,
        @Query('offset') offset?: string,
    ): Promise<GoalDto[]> {
        return this.service.listForUser(auth.userId, {
            status: this.parseStatus(status),
            limit: this.parseIntParam(limit, 'limit', 1, 101),
            offset: this.parseIntParam(offset, 'offset', 0),
        });
    }

    @Post()
    @ApiOperation({ summary: 'Create a goal (status=draft; activate to start evaluation)' })
    @HttpCode(HttpStatus.CREATED)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async create(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: CreateGoalDto,
    ): Promise<GoalDto> {
        return this.service.create(auth.userId, {
            title: body.title,
            description: body.description ?? null,
            metricSource: body.metricSource,
            comparator: body.comparator,
            targetValue: body.targetValue,
            unit: body.unit,
            window: body.window,
            baselineValue: body.baselineValue ?? null,
            deadline: this.parseDeadline(body.deadline),
            checkFrequencyMinutes: body.checkFrequencyMinutes,
        });
    }

    @Get(':id')
    @ApiOperation({ summary: 'Get one goal' })
    @HttpCode(HttpStatus.OK)
    async getOne(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<GoalDto> {
        return this.service.getForUser(auth.userId, id);
    }

    @Get(':id/samples')
    @ApiOperation({ summary: 'Observation history (append-only samples, newest first)' })
    @HttpCode(HttpStatus.OK)
    async samples(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Query('limit') limit?: string,
    ): Promise<GoalMetricSampleDto[]> {
        return this.service.listSamples(
            auth.userId,
            id,
            this.parseIntParam(limit, 'limit', 1, 500) ?? 100,
        );
    }

    @Patch(':id')
    @ApiOperation({
        summary:
            'Update goal fields (partial). Setting a non-null `outcome` is the human override (completes the goal); `outcome: null` clears an auto-set outcome.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async update(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: UpdateGoalDto,
    ): Promise<GoalDto> {
        return this.service.update(auth.userId, id, {
            title: body.title,
            description: body.description,
            metricSource: body.metricSource,
            comparator: body.comparator,
            targetValue: body.targetValue,
            unit: body.unit,
            window: body.window,
            baselineValue: body.baselineValue,
            deadline: body.deadline === undefined ? undefined : this.parseDeadline(body.deadline),
            checkFrequencyMinutes: body.checkFrequencyMinutes,
            outcome: body.outcome,
        });
    }

    @Delete(':id')
    @ApiOperation({ summary: 'Delete a goal (cascades samples + mission links)' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async remove(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<{ deleted: true }> {
        return this.service.delete(auth.userId, id);
    }

    @Post(':id/activate')
    @ApiOperation({
        summary:
            'Activate a goal ((draft|paused|completed) → active). Requires metricSource pluginId + metricId; reactivating a completed goal clears its outcome.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async activate(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<GoalDto> {
        return this.service.activate(auth.userId, id);
    }

    @Post(':id/pause')
    @ApiOperation({ summary: 'Pause a goal (active → paused)' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async pause(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<GoalDto> {
        return this.service.pause(auth.userId, id);
    }

    @Post(':id/evaluate-now')
    @ApiOperation({
        summary:
            'Evaluate immediately (manual tick). Bypasses the nextCheckAt schedule but NOT the plugin budget guard.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    async evaluateNow(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<{ entry: GoalEvaluationEntry; goal: GoalDto }> {
        return this.service.evaluateNow(auth.userId, id);
    }

    private parseStatus(value?: string): GoalStatus | undefined {
        if (!value) return undefined;
        if (!Object.values(GoalStatus).includes(value as GoalStatus)) {
            throw new BadRequestException(`Invalid status filter: ${value}`);
        }
        return value as GoalStatus;
    }

    private parseIntParam(
        value: string | undefined,
        name: string,
        min: number,
        max?: number,
    ): number | undefined {
        if (!value) return undefined;
        const n = Number(value);
        if (!Number.isInteger(n)) {
            throw new BadRequestException(`${name} must be an integer.`);
        }
        const clamped = Math.max(min, n);
        return max !== undefined ? Math.min(max, clamped) : clamped;
    }

    private parseDeadline(value: string | null | undefined): Date | null {
        if (value === undefined || value === null || value === '') return null;
        const ms = Date.parse(value);
        if (!Number.isFinite(ms)) {
            throw new BadRequestException('deadline must be an ISO-8601 date string.');
        }
        return new Date(ms);
    }
}
