import {
    Body,
    Controller,
    Delete,
    Get,
    Headers,
    HttpCode,
    HttpStatus,
    Param,
    ParseUUIDPipe,
    Patch,
    Post,
    Put,
    Query,
    Req,
    Res,
    UseFilters,
    UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
    ArrayMaxSize,
    IsArray,
    IsDateString,
    IsIn,
    IsNumber,
    IsObject,
    IsOptional,
    IsString,
    IsUUID,
    Length,
    MaxLength,
    ValidateIf,
    ValidateNested,
} from 'class-validator';
import { INTEGRATION_EXTERNAL_METRIC_PLUGIN_ID } from '@ever-works/contracts';
import {
    GoalOrchestratorService,
    GoalsService,
    type CreateGoalInput,
    type GoalComparator,
    type GoalCriterion,
    type GoalDoDCriterion,
    type GoalWindow,
    type UpdateGoalInput,
} from '@ever-works/agent/goals';
import {
    assertIfMatch,
    DuplicateExternalRefError,
    ExternalRecordLinksService,
    installationFromOrigin,
    IntegrationIdempotencyService,
    IntegrationResourcesService,
    type KeysetPage,
} from '@ever-works/agent/integrations-api';
import { RecordVisibilityService } from '@ever-works/agent/record-visibility';
import { CurrentUser } from '../../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../../auth/types/auth.types';
import { RequireScopes } from '../../auth/integration/integration.decorators';
import { writeAttribution } from '../../auth/integration/integration-attribution';
import { ScopeContextService } from '../../scope/scope-context.service';
import { IntegrationOnlyGuard } from './integration-only.guard';
import { IntegrationExceptionFilter } from './integration-exception.filter';
import {
    runIdempotent,
    type IdempotentRequest,
    type IdempotentResponse,
} from './integration-idempotency';
import {
    assertOwnLinkSource,
    assertWritableVisibility,
    domainRule,
    expectedVersionOf,
    linkSourceOf,
    parseLimit,
    parseUpdatedSince,
    pinnedOrganizationOf,
    principalOf,
    rethrowCursor,
    validationFailed,
    withExpectedVersion,
    IsOptionalNonNull,
} from './integration-request';
import { IntegrationExternalRefDto } from './tasks-write.controller';

const COMPARATORS = ['gte', 'lte'] as const;
const WINDOWS = ['day', 'week', 'month', 'total', 'point'] as const;
const DOD_STATUSES = ['open', 'done', 'waived'] as const;

/** A metric Goal created without a source reads the external one (EW-P2-2). */
const DEFAULT_EXTERNAL_SOURCE = {
    pluginId: INTEGRATION_EXTERNAL_METRIC_PLUGIN_ID,
    metricId: 'value',
};

/** `requests.schema.json#/$defs/GoalMetricSource`: only `pluginId: 'external'` is accepted. */
export class IntegrationGoalMetricSourceDto {
    @ApiProperty({
        minLength: 1,
        maxLength: 100,
        description: "Integrations may only use 'external' (422 domain_rule otherwise).",
    })
    @IsString()
    @Length(1, 100)
    pluginId!: string;

    @ApiProperty({ minLength: 1, maxLength: 200 })
    @IsString()
    @Length(1, 200)
    metricId!: string;

    @ApiProperty({
        required: false,
        type: Object,
        description: 'Provider parameters (unused by the external source).',
    })
    @IsOptional()
    @IsObject()
    params?: Record<string, unknown>;
}

/** One weighted criterion (Gauzy: a numeric KeyResult). */
export class IntegrationGoalCriterionDto {
    @ApiProperty({ minLength: 1, maxLength: 64 })
    @IsString()
    @Length(1, 64)
    id!: string;

    @ApiProperty({ minLength: 1, maxLength: 200 })
    @IsString()
    @Length(1, 200)
    name!: string;

    @ApiProperty({ type: Number, description: 'Greater than 0.' })
    @IsNumber()
    weight!: number;

    @ApiProperty({ type: Number })
    @IsNumber()
    target!: number;

    @ApiProperty({ enum: ['gte', 'lte'] })
    @IsIn(COMPARATORS)
    direction!: GoalComparator;

    @ApiProperty({ required: false, maxLength: 32 })
    @IsOptional()
    @IsString()
    @MaxLength(32)
    unit?: string;

    @ApiProperty({ required: false, type: () => IntegrationGoalMetricSourceDto })
    @IsOptional()
    @ValidateNested()
    @Type(() => IntegrationGoalMetricSourceDto)
    metricSource?: IntegrationGoalMetricSourceDto;

    @ApiProperty({ required: false, enum: ['day', 'week', 'month', 'total', 'point'] })
    @IsOptional()
    @IsIn(WINDOWS)
    window?: GoalWindow;
}

/** One Definition-of-Done item (Gauzy: a True/False KeyResult). */
export class IntegrationGoalDoDCriterionDto {
    @ApiProperty({ minLength: 1, maxLength: 64 })
    @IsString()
    @Length(1, 64)
    id!: string;

    @ApiProperty({ minLength: 1, maxLength: 500 })
    @IsString()
    @Length(1, 500)
    text!: string;

    @ApiProperty({ enum: ['open', 'done', 'waived'] })
    @IsIn(DOD_STATUSES)
    status!: (typeof DOD_STATUSES)[number];

    @ApiProperty({ required: false, nullable: true, maxLength: 1000 })
    @IsOptional()
    @IsString()
    @MaxLength(1000)
    evidence?: string | null;

    @ApiProperty({ required: false, nullable: true, maxLength: 500 })
    @IsOptional()
    @IsString()
    @MaxLength(500)
    note?: string | null;
}

/** Contract v1 `requests.schema.json#/$defs/CreateGoal` (always created `draft`). */
export class IntegrationCreateGoalDto {
    @ApiProperty({ minLength: 1, maxLength: 200 })
    @IsString()
    @Length(1, 200)
    title!: string;

    @ApiProperty({ required: false, nullable: true, maxLength: 100000 })
    @IsOptional()
    @IsString()
    @MaxLength(100_000)
    description?: string | null;

    @ApiProperty({ required: false, enum: ['metric', 'delivery'] })
    @IsOptional()
    @IsIn(['metric', 'delivery'])
    goalKind?: 'metric' | 'delivery';

    @ApiProperty({
        required: false,
        type: () => IntegrationGoalMetricSourceDto,
        description: "Default { pluginId: 'external', metricId: 'value' } for a metric Goal.",
    })
    @IsOptional()
    @ValidateNested()
    @Type(() => IntegrationGoalMetricSourceDto)
    metricSource?: IntegrationGoalMetricSourceDto;

    @ApiProperty({ required: false, enum: ['gte', 'lte'] })
    @IsOptional()
    @IsIn(COMPARATORS)
    comparator?: GoalComparator;

    @ApiProperty({ required: false, type: Number })
    @IsOptional()
    @IsNumber()
    targetValue?: number;

    @ApiProperty({ required: false, minLength: 1, maxLength: 32 })
    @IsOptional()
    @IsString()
    @Length(1, 32)
    unit?: string;

    @ApiProperty({ required: false, enum: ['day', 'week', 'month', 'total', 'point'] })
    @IsOptional()
    @IsIn(WINDOWS)
    window?: GoalWindow;

    @ApiProperty({ required: false, nullable: true, type: Number })
    @IsOptional()
    @ValidateIf((_, value) => value !== null)
    @IsNumber()
    baselineValue?: number | null;

    @ApiProperty({ required: false, nullable: true, format: 'date-time' })
    @IsOptional()
    @ValidateIf((_, value) => value !== null)
    @IsDateString()
    deadline?: string | null;

    @ApiProperty({ required: false, type: () => [IntegrationGoalCriterionDto], maxItems: 20 })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(20)
    @ValidateNested({ each: true })
    @Type(() => IntegrationGoalCriterionDto)
    criteria?: IntegrationGoalCriterionDto[];

    @ApiProperty({ required: false, type: () => [IntegrationGoalDoDCriterionDto], maxItems: 50 })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(50)
    @ValidateNested({ each: true })
    @Type(() => IntegrationGoalDoDCriterionDto)
    dodCriteria?: IntegrationGoalDoDCriterionDto[];

    @ApiProperty({
        required: false,
        type: [String],
        format: 'uuid',
        maxItems: 50,
        description:
            'The Teams of the pinned organization (team_resources rows). Non-empty means visibility `team` unless visibility was set by hand (D11).',
    })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(50)
    @IsUUID('all', { each: true })
    teamIds?: string[];

    @ApiProperty({
        required: false,
        enum: ['team', 'organization'],
        description:
            'Integrations may set team or organization only; `private` answers 422 domain_rule. Setting it marks visibilityExplicit=true.',
    })
    @IsOptional()
    @IsString()
    visibility?: string;

    @ApiProperty({ required: false, type: () => IntegrationExternalRefDto })
    @IsOptional()
    @ValidateNested()
    @Type(() => IntegrationExternalRefDto)
    externalRef?: IntegrationExternalRefDto;
}

/**
 * Contract v1 `requests.schema.json#/$defs/UpdateGoal` (If-Match optional). No
 * `status` / `outcome`: an integration never activates, resumes or completes a
 * Goal (D9); no `metricSource` / `goalKind` (the source stays external, the kind is
 * immutable).
 */
export class IntegrationUpdateGoalDto {
    @ApiProperty({ required: false, minLength: 1, maxLength: 200 })
    @IsOptionalNonNull()
    @IsString()
    @Length(1, 200)
    title?: string;

    @ApiProperty({ required: false, nullable: true, maxLength: 100000 })
    @IsOptional()
    @IsString()
    @MaxLength(100_000)
    description?: string | null;

    @ApiProperty({ required: false, enum: ['gte', 'lte'] })
    @IsOptionalNonNull()
    @IsIn(COMPARATORS)
    comparator?: GoalComparator;

    @ApiProperty({ required: false, type: Number })
    @IsOptionalNonNull()
    @IsNumber()
    targetValue?: number;

    @ApiProperty({ required: false, minLength: 1, maxLength: 32 })
    @IsOptionalNonNull()
    @IsString()
    @Length(1, 32)
    unit?: string;

    @ApiProperty({ required: false, enum: ['day', 'week', 'month', 'total', 'point'] })
    @IsOptionalNonNull()
    @IsIn(WINDOWS)
    window?: GoalWindow;

    @ApiProperty({ required: false, nullable: true, type: Number })
    @IsOptional()
    @ValidateIf((_, value) => value !== null)
    @IsNumber()
    baselineValue?: number | null;

    @ApiProperty({ required: false, nullable: true, format: 'date-time' })
    @IsOptional()
    @ValidateIf((_, value) => value !== null)
    @IsDateString()
    deadline?: string | null;

    @ApiProperty({
        required: false,
        type: [String],
        format: 'uuid',
        maxItems: 50,
        description:
            'The Teams of the pinned organization (team_resources rows). Non-empty means visibility `team` unless visibility was set by hand (D11).',
    })
    @IsOptionalNonNull()
    @IsArray()
    @ArrayMaxSize(50)
    @IsUUID('all', { each: true })
    teamIds?: string[];

    @ApiProperty({
        required: false,
        enum: ['team', 'organization'],
        description:
            'Integrations may set team or organization only; `private` answers 422 domain_rule. Setting it marks visibilityExplicit=true.',
    })
    @IsOptionalNonNull()
    @IsString()
    visibility?: string;
}

/** `PUT /goals/:id/criteria` — the full set (`[]` clears the weighted path). */
export class IntegrationPutGoalCriteriaDto {
    @ApiProperty({ type: () => [IntegrationGoalCriterionDto], maxItems: 20 })
    @IsArray()
    @ArrayMaxSize(20)
    @ValidateNested({ each: true })
    @Type(() => IntegrationGoalCriterionDto)
    criteria!: IntegrationGoalCriterionDto[];
}

/** `PUT /goals/:id/dod` — the full Definition of Done (`[]` clears it on a metric Goal). */
export class IntegrationPutGoalDodDto {
    @ApiProperty({ type: () => [IntegrationGoalDoDCriterionDto], maxItems: 50 })
    @IsArray()
    @ArrayMaxSize(50)
    @ValidateNested({ each: true })
    @Type(() => IntegrationGoalDoDCriterionDto)
    dodCriteria!: IntegrationGoalDoDCriterionDto[];
}

/** `POST /goals/:id/samples` — one externally measured value. */
export class IntegrationGoalSampleDto {
    @ApiProperty({
        required: false,
        nullable: true,
        minLength: 1,
        maxLength: 64,
        description: 'A criterion reading the external source; omitted: the Goal itself.',
    })
    @IsOptional()
    @IsString()
    @Length(1, 64)
    criterionId?: string | null;

    @ApiProperty({ type: Number })
    @IsNumber({ allowNaN: false, allowInfinity: false })
    value!: number;

    @ApiProperty({ format: 'date-time' })
    @IsDateString()
    sampledAt!: string;
}

interface ListQuery {
    readonly updatedSince?: string;
    readonly cursor?: string;
    readonly limit?: string;
    readonly includeArchived?: string;
}

type Response = IdempotentResponse & { setHeader(name: string, value: string): unknown };

/**
 * Goals of `/api/integrations/v1` (EW-P2-2, contract v1 B.6). An Ever Works Goal
 * is a Gauzy Goal plus key results (plan 01 §6): criteria ↔ numeric key results,
 * the Definition of Done ↔ True/False key results.
 *
 * Spend safety (D9) is structural: a Goal is created `draft`; PATCH carries no
 * status, outcome or metric source, so nothing here activates, resumes or completes
 * a Goal, starts its loop, or reads a (metered) metrics provider. A metric Goal
 * reads the EXTERNAL source and its values arrive through `POST
 * /goals/:id/samples`, which drive `currentValue` and the criterion scores.
 *
 * Writes act as the Goal's owner like the task writes (the key's owner, or
 * `X-Act-As-User`); a Goal owned by someone else answers `404 not_found`.
 */
@ApiTags('Integrations API v1')
@Controller('api/integrations/v1')
@UseGuards(IntegrationOnlyGuard)
@UseFilters(IntegrationExceptionFilter)
export class IntegrationGoalsController {
    constructor(
        private readonly goals: GoalsService,
        private readonly orchestrator: GoalOrchestratorService,
        private readonly visibility: RecordVisibilityService,
        private readonly links: ExternalRecordLinksService,
        private readonly idempotency: IntegrationIdempotencyService,
        private readonly resources: IntegrationResourcesService,
        private readonly scope: ScopeContextService,
    ) {}

    @Get('goals')
    @RequireScopes('goals:read')
    @ApiOperation({ summary: 'Goals (team and organization visibility; archived on request)' })
    async list(
        @CurrentUser() user: AuthenticatedUser,
        @Query() query: ListQuery,
    ): Promise<KeysetPage<Record<string, unknown>>> {
        return this.resources
            .list(
                'goal',
                this.organizationId(),
                {
                    updatedSince: parseUpdatedSince(query.updatedSince),
                    cursor: query.cursor || null,
                    limit: parseLimit(query.limit),
                    includeArchived: query.includeArchived === 'true',
                },
                linkSourceOf(principalOf(user)),
            )
            .catch(rethrowCursor);
    }

    @Get('goals/:id')
    @RequireScopes('goals:read')
    @ApiOperation({ summary: 'One Goal' })
    async get(
        @CurrentUser() user: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Res({ passthrough: true }) res: Response,
    ): Promise<Record<string, unknown>> {
        return this.send(res, id, linkSourceOf(principalOf(user)));
    }

    @Post('goals')
    @RequireScopes('goals:write')
    @ApiOperation({
        summary:
            'Create a Goal (always draft; metric Goals read the external source; Idempotency-Key required)',
    })
    async create(
        @CurrentUser() user: AuthenticatedUser,
        @Body() dto: IntegrationCreateGoalDto,
        @Headers('x-sync-origin') syncOrigin: string | undefined,
        @Req() req: IdempotentRequest,
        @Res({ passthrough: true }) res: Response,
    ): Promise<unknown> {
        const principal = principalOf(user);
        const organizationId = this.organizationId();
        const source = linkSourceOf(principal);
        assertWritableVisibility(dto.visibility);
        assertOwnLinkSource(dto.externalRef, source);
        const goalKind = dto.goalKind ?? 'metric';
        const input: CreateGoalInput = {
            title: dto.title,
            description: dto.description ?? null,
            goalKind,
            ...(goalKind === 'metric'
                ? {
                      metricSource: dto.metricSource ?? DEFAULT_EXTERNAL_SOURCE,
                      comparator: dto.comparator,
                      targetValue: dto.targetValue,
                      unit: dto.unit,
                      window: dto.window ?? 'point',
                      baselineValue: dto.baselineValue ?? null,
                      criteria: (dto.criteria as GoalCriterion[] | undefined) ?? null,
                  }
                : {}),
            deadline: dto.deadline ? new Date(dto.deadline) : null,
            dodCriteria: (dto.dodCriteria as GoalDoDCriterion[] | undefined) ?? null,
            teamIds: dto.teamIds,
            visibility: dto.visibility as 'team' | 'organization' | undefined,
            createdBy: writeAttribution(user),
        };
        GoalsService.assertExternalSources(input);
        return runIdempotent(this.idempotency, principal, req, res, async () => {
            const linkScope = dto.externalRef
                ? {
                      organizationId,
                      tenantId: principal.tenantId,
                      source: dto.externalRef.source,
                      installationId: installationFromOrigin(
                          dto.externalRef.installationId,
                          syncOrigin,
                          dto.externalRef.source,
                      ),
                      integrationKeyId: principal.keyId,
                  }
                : null;
            if (linkScope && dto.externalRef) {
                const existing = await this.links.findByExternal(
                    linkScope,
                    'goal',
                    dto.externalRef.externalId,
                );
                if (existing) {
                    return { status: 200, body: await this.dto(existing.entityId, source) };
                }
            }
            const externalRef = dto.externalRef;
            let goal: Awaited<ReturnType<GoalsService['createExternal']>>;
            try {
                goal = await this.goals.createExternal(
                    user.userId,
                    input,
                    this.ownership(),
                    // T17a pattern — the Goal and its externalRef link commit together (one
                    // transaction): a lost race rolls the Goal back instead of leaving it to be
                    // undone, and a crash can no longer leave an unlinked Goal behind.
                    linkScope && externalRef
                        ? {
                              withinCreate: async (row, manager) => {
                                  await this.links.create(
                                      linkScope,
                                      {
                                          entityType: 'goal',
                                          entityId: row.id,
                                          externalId: externalRef.externalId,
                                          externalUrl: externalRef.externalUrl ?? null,
                                      },
                                      manager,
                                  );
                              },
                          }
                        : {},
                );
            } catch (error) {
                // A concurrent create with the same externalRef won (ours rolled back with
                // its link): answer theirs.
                if (
                    linkScope &&
                    externalRef &&
                    error instanceof DuplicateExternalRefError &&
                    error.side === 'external'
                ) {
                    const winner = await this.links.findByExternal(
                        linkScope,
                        'goal',
                        externalRef.externalId,
                    );
                    if (winner) {
                        return { status: 200, body: await this.dto(winner.entityId, source) };
                    }
                }
                throw error;
            }
            const created = await this.resources.get('goal', organizationId, goal.id, source);
            if (created.etag) res.setHeader('ETag', created.etag);
            return { status: 201, body: created.dto };
        });
    }

    @Patch('goals/:id')
    @RequireScopes('goals:write')
    @ApiOperation({
        summary:
            'Update a Goal (title, description, target, unit, window, baseline, deadline, teamIds, visibility; never its status)',
    })
    async update(
        @CurrentUser() user: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() dto: IntegrationUpdateGoalDto,
        @Headers('if-match') ifMatch: string | undefined,
        @Res({ passthrough: true }) res: Response,
    ): Promise<Record<string, unknown>> {
        if (Object.values(dto).every((value) => value === undefined)) {
            throw validationFailed('body', 'must change at least one field');
        }
        assertWritableVisibility(dto.visibility);
        const source = linkSourceOf(principalOf(user));
        const expected = await this.precondition(user, id, ifMatch, source);
        const patch: UpdateGoalInput = {};
        if (dto.title !== undefined) patch.title = dto.title;
        if (dto.description !== undefined) patch.description = dto.description;
        if (dto.comparator !== undefined) patch.comparator = dto.comparator;
        if (dto.targetValue !== undefined) patch.targetValue = dto.targetValue;
        if (dto.unit !== undefined) patch.unit = dto.unit;
        if (dto.window !== undefined) patch.window = dto.window;
        if (dto.baselineValue !== undefined) patch.baselineValue = dto.baselineValue;
        if (dto.deadline !== undefined) {
            patch.deadline = dto.deadline === null ? null : new Date(dto.deadline);
        }
        // Every Team must be one of the pinned organization's (404 otherwise) BEFORE the
        // first write, so a foreign Team never leaves a half-applied PATCH behind.
        for (const teamId of dto.teamIds ?? []) {
            await this.resources.get('team', this.organizationId(), teamId, source);
        }
        await withExpectedVersion('goal', id, expected, async () => {
            if (Object.keys(patch).length > 0) {
                await this.goals.update(user.userId, id, patch, this.ownership());
            }
            if (dto.teamIds !== undefined) {
                await this.visibility.setTeams('goal', id, dto.teamIds, user.userId);
            }
            if (dto.visibility !== undefined) {
                await this.visibility.setVisibility('goal', id, dto.visibility as never);
            }
        });
        return this.send(res, id, source);
    }

    @Put('goals/:id/criteria')
    @RequireScopes('goals:write')
    @ApiOperation({ summary: "Replace a metric Goal's weighted criteria (external source only)" })
    async putCriteria(
        @CurrentUser() user: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() dto: IntegrationPutGoalCriteriaDto,
        @Headers('if-match') ifMatch: string | undefined,
        @Res({ passthrough: true }) res: Response,
    ): Promise<Record<string, unknown>> {
        const source = linkSourceOf(principalOf(user));
        const expected = await this.precondition(user, id, ifMatch, source);
        const criteria = dto.criteria as GoalCriterion[];
        // A criterion without its own source reads the Goal's: on an app-created Goal that
        // reads a provider it would add metered reads per evaluation tick (D9), so every
        // criterion's RESOLVED source must be the external one.
        const goal = await this.goals.getForUser(user.userId, id, this.ownership());
        GoalsService.assertExternalSources({
            criteria: criteria.map((criterion) => ({
                metricSource: criterion.metricSource ?? goal.metricSource ?? undefined,
            })),
        });
        await withExpectedVersion('goal', id, expected, () =>
            this.goals.update(
                user.userId,
                id,
                { criteria: criteria.length > 0 ? criteria : null },
                this.ownership(),
            ),
        );
        return this.send(res, id, source);
    }

    @Put('goals/:id/dod')
    @RequireScopes('goals:write')
    @ApiOperation({ summary: "Replace a Goal's Definition of Done" })
    async putDod(
        @CurrentUser() user: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() dto: IntegrationPutGoalDodDto,
        @Headers('if-match') ifMatch: string | undefined,
        @Res({ passthrough: true }) res: Response,
    ): Promise<Record<string, unknown>> {
        const source = linkSourceOf(principalOf(user));
        const expected = await this.precondition(user, id, ifMatch, source);
        // The Definition of Done an integration writes is the operator's own (approved,
        // `source: operator`): it mirrors key results a person keeps in Gauzy.
        const criteria = dto.dodCriteria.map((entry) => ({
            id: entry.id,
            text: entry.text,
            status: entry.status,
            evidence: entry.evidence ?? null,
            note: entry.note ?? null,
        })) as GoalDoDCriterion[];
        // Gauzy CR-12 — a planner proposal (`proposed: true`) the body does not name is
        // kept: editing one key result never drops the proposals still awaiting a person.
        // A proposal the body names is written as the integration sent it (approved).
        const current = await this.goals.getForUser(user.userId, id, this.ownership());
        const named = new Set(criteria.map((entry) => entry.id));
        for (const entry of current.dodCriteria ?? []) {
            if (entry.proposed === true && !named.has(entry.id)) criteria.push(entry);
        }
        await withExpectedVersion('goal', id, expected, () =>
            this.orchestrator.setDodCriteria(
                user.userId,
                id,
                criteria.length > 0 ? criteria : null,
            ),
        );
        return this.send(res, id, source);
    }

    @Post('goals/:id/samples')
    @RequireScopes('goals:write')
    @ApiOperation({
        summary:
            'Push one externally measured value (drives currentValue and the criterion scores; Idempotency-Key required)',
    })
    async sample(
        @CurrentUser() user: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() dto: IntegrationGoalSampleDto,
        @Req() req: IdempotentRequest,
        @Res({ passthrough: true }) res: Response,
    ): Promise<unknown> {
        const principal = principalOf(user);
        const source = linkSourceOf(principal);
        await this.resources.get('goal', this.organizationId(), id, source);
        return runIdempotent(this.idempotency, principal, req, res, async () => {
            await this.goals.recordExternalSample(
                user.userId,
                id,
                {
                    criterionId: dto.criterionId ?? null,
                    value: dto.value,
                    sampledAt: new Date(dto.sampledAt),
                },
                this.ownership(),
            );
            const goal = await this.resources.get('goal', this.organizationId(), id, source);
            if (goal.etag) res.setHeader('ETag', goal.etag);
            return { status: 200, body: goal.dto };
        });
    }

    @Delete('goals/:id')
    @RequireScopes('goals:write')
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiOperation({ summary: 'Delete a Goal (If-Match optional; never one whose loop is running)' })
    async remove(
        @CurrentUser() user: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Headers('if-match') ifMatch: string | undefined,
    ): Promise<void> {
        const organizationId = this.organizationId();
        const source = linkSourceOf(principalOf(user));
        const current = await this.resources.get('goal', organizationId, id, source);
        const expected = expectedVersionOf(ifMatch);
        assertIfMatch(expected, Number(current.dto.version));
        const loop = current.dto.loop as { status?: string | null } | undefined;
        if (loop?.status === 'running') {
            throw domainRule('A Goal whose execution loop is running cannot be deleted.', {
                loopStatus: 'running',
            });
        }
        await withExpectedVersion('goal', id, expected, () =>
            this.goals.delete(user.userId, id, this.ownership()),
        );
        await this.links.removeAllFor(organizationId, 'goal', id);
    }

    private organizationId(): string {
        return pinnedOrganizationOf(this.scope.getScope().organizationId);
    }

    /** The pinned organization as the Goal services' ownership scope. */
    private ownership(): { tenantId: string | null; organizationId: string } {
        return {
            tenantId: this.scope.getScope().tenantId ?? null,
            organizationId: this.organizationId(),
        };
    }

    /**
     * The Goal must be one the caller sees (404) and owns (404: writes act as the
     * owner); `If-Match` is pre-checked here and re-checked at the version bump.
     */
    private async precondition(
        user: AuthenticatedUser,
        id: string,
        ifMatch: string | undefined,
        source: string,
    ): Promise<number | null> {
        const current = await this.resources.get('goal', this.organizationId(), id, source);
        const expected = expectedVersionOf(ifMatch);
        assertIfMatch(expected, Number(current.dto.version));
        await this.goals.getForUser(user.userId, id, this.ownership());
        return expected;
    }

    private async dto(id: string, source: string): Promise<Record<string, unknown>> {
        return (await this.resources.get('goal', this.organizationId(), id, source)).dto;
    }

    private async send(
        res: Response,
        id: string,
        source: string,
    ): Promise<Record<string, unknown>> {
        const resource = await this.resources.get('goal', this.organizationId(), id, source);
        if (resource.etag) res.setHeader('ETag', resource.etag);
        return resource.dto;
    }
}
