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
    IsBoolean,
    IsIn,
    IsOptional,
    IsString,
    IsUUID,
    Length,
    ValidateIf,
    ValidateNested,
} from 'class-validator';
import { GoalsService } from '@ever-works/agent/goals';
import {
    assertIfMatch,
    DuplicateExternalRefError,
    ExternalRecordLinksService,
    installationFromOrigin,
    IntegrationIdempotencyService,
    IntegrationResourcesService,
    type KeysetPage,
} from '@ever-works/agent/integrations-api';
import type { MissionOutcome } from '@ever-works/agent/entities';
import { MissionsService } from '@ever-works/agent/missions';
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
} from './integration-request';
import { IntegrationExternalRefDto } from './tasks-write.controller';

const WORK_RELATIONS = [
    'created',
    'improves',
    'operates',
    'markets',
    'researches',
    'retires',
] as const;
const OUTCOMES = ['succeeded', 'partially_succeeded', 'failed', 'cancelled', 'superseded'] as const;

/** Contract v1 `requests.schema.json#/$defs/CreateMission` (always created `paused`). */
export class IntegrationCreateMissionDto {
    @ApiProperty({ minLength: 1, maxLength: 200 })
    @IsString()
    @Length(1, 200)
    title!: string;

    @ApiProperty({ minLength: 1, maxLength: 100000 })
    @IsString()
    @Length(1, 100_000)
    description!: string;

    /** `one-shot` (default) or `scheduled` (needs `schedule`). Paused either way. */
    @ApiProperty({
        required: false,
        enum: ['one-shot', 'scheduled'],
        description:
            'Default one-shot. A scheduled Mission needs `schedule` and ticks only once a person resumes it.',
    })
    @IsOptional()
    @IsIn(['one-shot', 'scheduled'])
    type?: 'one-shot' | 'scheduled';

    /** The cron of a `scheduled` Mission; it ticks only once a person resumes it. */
    @ApiProperty({ required: false, nullable: true, minLength: 1, maxLength: 64 })
    @IsOptional()
    @ValidateIf((_, value) => value !== null)
    @IsString()
    @Length(1, 64)
    schedule?: string | null;

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
 * Contract v1 `requests.schema.json#/$defs/UpdateMission` (If-Match optional).
 * `status` may only pause, complete or fail a Mission; `active` answers `422 domain_rule`
 * (D9: only a person resumes a Mission in Ever Works).
 */
export class IntegrationUpdateMissionDto {
    @ApiProperty({ required: false, minLength: 1, maxLength: 200 })
    @IsOptional()
    @IsString()
    @Length(1, 200)
    title?: string;

    @ApiProperty({ required: false, minLength: 1, maxLength: 100000 })
    @IsOptional()
    @IsString()
    @Length(1, 100_000)
    description?: string;

    @ApiProperty({
        required: false,
        enum: ['paused', 'completed', 'failed'],
        description:
            '`active` answers 422 domain_rule: a person resumes a Mission in Ever Works (D9).',
    })
    @IsOptional()
    @IsString()
    status?: string;

    @ApiProperty({
        required: false,
        nullable: true,
        enum: ['succeeded', 'partially_succeeded', 'failed', 'cancelled', 'superseded'],
        description: "Only with status 'completed'.",
    })
    @IsOptional()
    @ValidateIf((_, value) => value !== null)
    @IsIn(OUTCOMES)
    outcome?: (typeof OUTCOMES)[number] | null;

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
}

export class IntegrationMissionGoalLinkDto {
    @ApiProperty({ format: 'uuid' })
    @IsUUID()
    goalId!: string;

    @ApiProperty({ required: false, type: Boolean })
    @IsOptional()
    @IsBoolean()
    isPrimary?: boolean;
}

/** `PUT /missions/:id/goals` — the full set of Goal links (at most one primary). */
export class IntegrationPutMissionGoalsDto {
    @ApiProperty({ type: () => [IntegrationMissionGoalLinkDto], maxItems: 100 })
    @IsArray()
    @ArrayMaxSize(100)
    @ValidateNested({ each: true })
    @Type(() => IntegrationMissionGoalLinkDto)
    goals!: IntegrationMissionGoalLinkDto[];
}

export class IntegrationMissionWorkLinkDto {
    @ApiProperty({ format: 'uuid' })
    @IsUUID()
    workId!: string;

    @ApiProperty({ enum: ['created', 'improves', 'operates', 'markets', 'researches', 'retires'] })
    @IsIn(WORK_RELATIONS)
    relation!: (typeof WORK_RELATIONS)[number];
}

/** `PUT /missions/:id/works` — the full set of typed Work links. */
export class IntegrationPutMissionWorksDto {
    @ApiProperty({ type: () => [IntegrationMissionWorkLinkDto], maxItems: 100 })
    @IsArray()
    @ArrayMaxSize(100)
    @ValidateNested({ each: true })
    @Type(() => IntegrationMissionWorkLinkDto)
    works!: IntegrationMissionWorkLinkDto[];
}

interface ListQuery {
    readonly updatedSince?: string;
    readonly cursor?: string;
    readonly limit?: string;
}

type Response = IdempotentResponse & { setHeader(name: string, value: string): unknown };

/**
 * Missions of `/api/integrations/v1` (EW-P2-5, contract v1 B.6; plan D3b: an Ever
 * Works Mission is a Gauzy Strategic Initiative — Goals 1:N, Works M:N).
 *
 * Spend safety (D9): a Mission is created `paused` with no schedule and no
 * auto-build, and PATCH can pause or complete it but never set it `active` — only a
 * person resumes a Mission in Ever Works, which is what starts its ticks. There is
 * no run-now and no clone here.
 *
 * Writes act as the Mission's owner like the task writes (the key's owner, or
 * `X-Act-As-User`); someone else's Mission answers `404 not_found`. Linked Goals
 * and Works must be the caller's too.
 */
@ApiTags('Integrations API v1')
@Controller('api/integrations/v1')
@UseGuards(IntegrationOnlyGuard)
@UseFilters(IntegrationExceptionFilter)
export class IntegrationMissionsController {
    constructor(
        private readonly missions: MissionsService,
        private readonly goals: GoalsService,
        private readonly visibility: RecordVisibilityService,
        private readonly links: ExternalRecordLinksService,
        private readonly idempotency: IntegrationIdempotencyService,
        private readonly resources: IntegrationResourcesService,
        private readonly scope: ScopeContextService,
    ) {}

    @Get('missions')
    @RequireScopes('missions:read')
    @ApiOperation({ summary: 'Missions (team and organization visibility)' })
    async list(
        @CurrentUser() user: AuthenticatedUser,
        @Query() query: ListQuery,
    ): Promise<KeysetPage<Record<string, unknown>>> {
        return this.resources
            .list(
                'mission',
                this.organizationId(),
                {
                    updatedSince: parseUpdatedSince(query.updatedSince),
                    cursor: query.cursor || null,
                    limit: parseLimit(query.limit),
                },
                linkSourceOf(principalOf(user)),
            )
            .catch(rethrowCursor);
    }

    @Get('missions/:id')
    @RequireScopes('missions:read')
    @ApiOperation({ summary: 'One Mission (Goal and Work links embedded)' })
    async get(
        @CurrentUser() user: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Res({ passthrough: true }) res: Response,
    ): Promise<Record<string, unknown>> {
        return this.send(res, id, linkSourceOf(principalOf(user)));
    }

    @Post('missions')
    @RequireScopes('missions:write')
    @ApiOperation({
        summary:
            'Create a Mission (always paused; Idempotency-Key required; externalRef de-duplicates)',
    })
    async create(
        @CurrentUser() user: AuthenticatedUser,
        @Body() dto: IntegrationCreateMissionDto,
        @Headers('x-sync-origin') syncOrigin: string | undefined,
        @Req() req: IdempotentRequest,
        @Res({ passthrough: true }) res: Response,
    ): Promise<unknown> {
        const principal = principalOf(user);
        const organizationId = this.organizationId();
        const source = linkSourceOf(principal);
        assertWritableVisibility(dto.visibility);
        assertOwnLinkSource(dto.externalRef, source);
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
                    'mission',
                    dto.externalRef.externalId,
                );
                if (existing) {
                    return { status: 200, body: await this.dto(existing.entityId, source) };
                }
            }
            const externalRef = dto.externalRef;
            let mission: Awaited<ReturnType<MissionsService['createExternal']>>;
            try {
                mission = await this.missions.createExternal(
                    user.userId,
                    {
                        title: dto.title,
                        description: dto.description,
                        type: dto.type,
                        schedule: dto.schedule ?? null,
                        teamIds: dto.teamIds,
                        visibility: dto.visibility as 'team' | 'organization' | undefined,
                        createdBy: writeAttribution(user),
                    },
                    this.ownership(),
                    // T17a pattern — the Mission and its externalRef link commit together (one
                    // transaction): a lost race rolls the Mission back instead of leaving it to
                    // be undone, and a crash can no longer leave an unlinked Mission behind.
                    linkScope && externalRef
                        ? {
                              withinCreate: async (row, manager) => {
                                  await this.links.create(
                                      linkScope,
                                      {
                                          entityType: 'mission',
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
                        'mission',
                        externalRef.externalId,
                    );
                    if (winner) {
                        return { status: 200, body: await this.dto(winner.entityId, source) };
                    }
                }
                throw error;
            }
            const created = await this.resources.get('mission', organizationId, mission.id, source);
            if (created.etag) res.setHeader('ETag', created.etag);
            return { status: 201, body: created.dto };
        });
    }

    @Patch('missions/:id')
    @RequireScopes('missions:write')
    @ApiOperation({
        summary:
            'Update a Mission: title, description, teamIds, visibility, pause or complete it (never active)',
    })
    async update(
        @CurrentUser() user: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() dto: IntegrationUpdateMissionDto,
        @Headers('if-match') ifMatch: string | undefined,
        @Res({ passthrough: true }) res: Response,
    ): Promise<Record<string, unknown>> {
        if (Object.values(dto).every((value) => value === undefined)) {
            throw validationFailed('body', 'must change at least one field');
        }
        assertWritableVisibility(dto.visibility);
        if (dto.status !== undefined) assertWritableMissionStatus(dto.status);
        if (dto.outcome !== undefined && dto.status !== 'completed') {
            throw validationFailed('outcome', 'is only accepted with status "completed"');
        }
        const source = linkSourceOf(principalOf(user));
        const { expected, current } = await this.precondition(user, id, ifMatch, source);
        await withExpectedVersion('mission', id, expected, async () => {
            if (dto.title !== undefined || dto.description !== undefined) {
                await this.missions.update(
                    user.userId,
                    id,
                    { title: dto.title, description: dto.description },
                    this.ownership(),
                );
            }
            if (dto.teamIds !== undefined) {
                await this.visibility.setTeams('mission', id, dto.teamIds, user.userId);
            }
            if (dto.visibility !== undefined) {
                await this.visibility.setVisibility('mission', id, dto.visibility as never);
            }
            if (dto.status !== undefined) {
                await this.applyStatus(
                    user,
                    id,
                    String(current.status),
                    dto.status as 'paused' | 'completed' | 'failed',
                    dto.outcome,
                );
            }
        });
        return this.send(res, id, source);
    }

    @Put('missions/:id/goals')
    @RequireScopes('missions:write')
    @ApiOperation({ summary: "Replace a Mission's Goal links (at most one primary)" })
    async putGoals(
        @CurrentUser() user: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() dto: IntegrationPutMissionGoalsDto,
        @Headers('if-match') ifMatch: string | undefined,
        @Res({ passthrough: true }) res: Response,
    ): Promise<Record<string, unknown>> {
        const source = linkSourceOf(principalOf(user));
        if (dto.goals.filter((link) => link.isPrimary === true).length > 1) {
            throw domainRule('A Mission has at most one primary Goal.', { field: 'goals' });
        }
        const ids = dto.goals.map((link) => link.goalId);
        if (new Set(ids).size !== ids.length) {
            throw validationFailed('goals', 'must not repeat a goalId');
        }
        await this.precondition(user, id, ifMatch, source);
        const scope = this.ownership();
        const wanted = new Map(dto.goals.map((link) => [link.goalId, link.isPrimary === true]));
        // The links whose Goal the caller sees in this scope (a link to a Goal outside it
        // is neither disclosed nor touched), so no unlink 404s halfway through the set.
        const existing = (await this.goals.listForMission(user.userId, id, scope)).map((link) => ({
            goalId: link.goalId,
            isPrimary: link.isPrimary,
        }));
        // Every new Goal must be the caller's (404) BEFORE the first write.
        for (const goalId of wanted.keys()) {
            if (!existing.some((link) => link.goalId === goalId)) {
                await this.goals.getForUser(user.userId, goalId, scope);
            }
        }
        for (const link of existing) {
            if (!wanted.has(link.goalId)) {
                await this.goals.unlinkFromMission(user.userId, id, link.goalId, scope);
            }
        }
        // Demotions first (a non-primary link), then the primary, so the per-Mission
        // primary index never sees two.
        const ordered = [...wanted].sort(([, a], [, b]) => Number(a) - Number(b));
        for (const [goalId, isPrimary] of ordered) {
            const before = existing.find((link) => link.goalId === goalId);
            if (before && before.isPrimary === isPrimary) continue;
            await this.goals.linkToMission(user.userId, id, goalId, isPrimary, scope);
        }
        return this.send(res, id, source);
    }

    @Put('missions/:id/works')
    @RequireScopes('missions:write')
    @ApiOperation({ summary: "Replace a Mission's typed Work links" })
    async putWorks(
        @CurrentUser() user: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() dto: IntegrationPutMissionWorksDto,
        @Headers('if-match') ifMatch: string | undefined,
        @Res({ passthrough: true }) res: Response,
    ): Promise<Record<string, unknown>> {
        const source = linkSourceOf(principalOf(user));
        await this.precondition(user, id, ifMatch, source);
        await this.missions.setWorks(user.userId, id, dto.works, this.ownership());
        return this.send(res, id, source);
    }

    @Delete('missions/:id')
    @RequireScopes('missions:write')
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiOperation({
        summary: 'Delete a Mission (If-Match optional; its Ideas and clones are kept)',
    })
    async remove(
        @CurrentUser() user: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Headers('if-match') ifMatch: string | undefined,
    ): Promise<void> {
        const organizationId = this.organizationId();
        const source = linkSourceOf(principalOf(user));
        const { expected } = await this.precondition(user, id, ifMatch, source);
        await withExpectedVersion('mission', id, expected, () =>
            this.missions.delete(user.userId, id, this.ownership()),
        );
        await this.links.removeAllFor(organizationId, 'mission', id);
    }

    /**
     * `status: paused` pauses an active Mission; `status: completed` completes an
     * active or paused one with its `outcome`. Already there = no-op; anything else is
     * `422 domain_rule` (a failed or completed Mission is a person's call in Ever Works).
     */
    private async applyStatus(
        user: AuthenticatedUser,
        id: string,
        from: string,
        to: 'paused' | 'completed' | 'failed',
        outcome: (typeof OUTCOMES)[number] | null | undefined,
    ): Promise<void> {
        if (from === to) return;
        if (to === 'paused') {
            if (from !== 'active') {
                throw domainRule('Only an active Mission can be paused.', { status: from });
            }
            await this.missions.pause(user.userId, id, this.ownership());
            return;
        }
        if (from !== 'active' && from !== 'paused') {
            throw domainRule(`Only an active or paused Mission can be ${to}.`, {
                status: from,
            });
        }
        if (to === 'failed') {
            // Stops the ticks like a fatal tick failure would; a person can resume it.
            await this.missions.fail(user.userId, id, this.ownership());
            return;
        }
        await this.missions.complete(
            user.userId,
            id,
            (outcome ?? null) as MissionOutcome | null,
            this.ownership(),
        );
    }

    private organizationId(): string {
        return pinnedOrganizationOf(this.scope.getScope().organizationId);
    }

    private ownership(): { tenantId: string | null; organizationId: string } {
        return {
            tenantId: this.scope.getScope().tenantId ?? null,
            organizationId: this.organizationId(),
        };
    }

    /**
     * The Mission must be one the caller sees (404) and owns (404: writes act as the
     * owner); `If-Match` is pre-checked here and re-checked at the version bump.
     */
    private async precondition(
        user: AuthenticatedUser,
        id: string,
        ifMatch: string | undefined,
        source: string,
    ): Promise<{ expected: number | null; current: Record<string, unknown> }> {
        const current = await this.resources.get('mission', this.organizationId(), id, source);
        const expected = expectedVersionOf(ifMatch);
        assertIfMatch(expected, Number(current.dto.version));
        await this.missions.getForUser(user.userId, id, this.ownership());
        return { expected, current: current.dto };
    }

    private async dto(id: string, source: string): Promise<Record<string, unknown>> {
        return (await this.resources.get('mission', this.organizationId(), id, source)).dto;
    }

    private async send(
        res: Response,
        id: string,
        source: string,
    ): Promise<Record<string, unknown>> {
        const resource = await this.resources.get('mission', this.organizationId(), id, source);
        if (resource.etag) res.setHeader('ETag', resource.etag);
        return resource.dto;
    }
}

/** PATCH may pause, complete or fail a Mission; `active` (or anything else) is refused. */
function assertWritableMissionStatus(
    status: string,
): asserts status is 'paused' | 'completed' | 'failed' {
    if (status === 'active') {
        throw domainRule(
            'An integration cannot set a Mission active: a person resumes it in Ever Works.',
            { field: 'status' },
        );
    }
    if (status !== 'paused' && status !== 'completed' && status !== 'failed') {
        throw validationFailed('status', 'must be paused, completed or failed');
    }
}
