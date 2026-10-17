import {
    Body,
    Controller,
    Delete,
    Headers,
    HttpCode,
    HttpStatus,
    Optional,
    Param,
    ParseUUIDPipe,
    Patch,
    Post,
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
    IsInt,
    IsOptional,
    IsString,
    IsUUID,
    Length,
    Max,
    MaxLength,
    Min,
    ValidateIf,
    ValidateNested,
} from 'class-validator';
import { RecordVisibilityService } from '@ever-works/agent/record-visibility';
import { TasksService, TaskPriority, TaskStatus } from '@ever-works/agent/tasks-domain';
import { TeamResourcesService } from '@ever-works/agent/teams';
import {
    assertIfMatch,
    DuplicateExternalRefError,
    ExternalRecordLinksService,
    installationFromOrigin,
    IntegrationIdempotencyService,
    IntegrationResourcesService,
    parseIfMatch,
} from '@ever-works/agent/integrations-api';
import { CurrentUser } from '../../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../../auth/types/auth.types';
import { RequireScopes } from '../../auth/integration/integration.decorators';
import { IntegrationHttpException } from '../../auth/integration/integration-http.exception';
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
    linkSourceOf,
    pinnedOrganizationOf,
    principalOf,
    validationFailed,
    withExpectedVersion,
} from './integration-request';

const PRIORITIES = ['p0', 'p1', 'p2', 'p3', 'p4'] as const;

export class IntegrationExternalRefDto {
    @ApiProperty({ minLength: 1, maxLength: 100 })
    @IsString()
    @Length(1, 100)
    source!: string;

    @ApiProperty({
        required: false,
        nullable: true,
        maxLength: 200,
        description:
            'The integration installation (for Gauzy: the connection id), as in external_record_links. Optional; when omitted it is taken from X-Sync-Origin (`gauzy:<connectionId>` → `<connectionId>`), else null.',
    })
    @IsOptional()
    @IsString()
    @MaxLength(200)
    installationId?: string | null;

    @ApiProperty({ minLength: 1, maxLength: 200 })
    @IsString()
    @Length(1, 200)
    externalId!: string;

    @ApiProperty({ required: false, format: 'uri', nullable: true, maxLength: 2048 })
    @IsOptional()
    @IsString()
    @MaxLength(2048)
    externalUrl?: string | null;
}

export class IntegrationPrincipalRefDto {
    @ApiProperty({ enum: ['user', 'agent'] })
    @IsIn(['user', 'agent'])
    type!: 'user' | 'agent';

    @ApiProperty({ format: 'uuid' })
    @IsUUID()
    id!: string;
}

/** Contract v1 `requests.schema.json#/$defs/CreateTask`. */
export class IntegrationCreateTaskDto {
    @ApiProperty({ minLength: 1, maxLength: 200 })
    @IsString()
    @Length(1, 200)
    title!: string;

    @ApiProperty({ required: false, nullable: true, maxLength: 100000 })
    @IsOptional()
    @IsString()
    @MaxLength(100_000)
    description?: string | null;

    @ApiProperty({ required: false, enum: ['backlog', 'todo'] })
    @IsOptional()
    @IsIn(['backlog', 'todo'])
    status?: 'backlog' | 'todo';

    @ApiProperty({ required: false, enum: ['p0', 'p1', 'p2', 'p3', 'p4'] })
    @IsOptional()
    @IsIn(PRIORITIES)
    priority?: (typeof PRIORITIES)[number];

    @ApiProperty({ required: false, type: [String], maxItems: 50 })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(50)
    @IsString({ each: true })
    @Length(1, 80, { each: true })
    labels?: string[];

    @ApiProperty({
        required: false,
        type: [String],
        format: 'uuid',
        description:
            'teamId plus the team_resources rows, as one set. Writable on POST/PATCH; the first id is stored as teamId where the entity has that column. Non-empty means visibility `team` unless visibilityExplicit (D11).',
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

    @ApiProperty({ required: false, format: 'uuid', nullable: true })
    @IsOptional()
    @IsUUID()
    workId?: string | null;

    @ApiProperty({ required: false, format: 'uuid', nullable: true })
    @IsOptional()
    @IsUUID()
    missionId?: string | null;

    @ApiProperty({ required: false, format: 'uuid', nullable: true })
    @IsOptional()
    @IsUUID()
    ideaId?: string | null;

    @ApiProperty({ required: false, format: 'uuid', nullable: true })
    @IsOptional()
    @IsUUID()
    parentTaskId?: string | null;

    @ApiProperty({
        required: false,
        type: () => IntegrationPrincipalRefDto,
        isArray: true,
        maxItems: 50,
    })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(50)
    @ValidateNested({ each: true })
    @Type(() => IntegrationPrincipalRefDto)
    assignees?: IntegrationPrincipalRefDto[];

    @ApiProperty({ required: false, type: () => IntegrationExternalRefDto })
    @IsOptional()
    @ValidateNested()
    @Type(() => IntegrationExternalRefDto)
    externalRef?: IntegrationExternalRefDto;

    /** EW-P2-3 — when the task is due (ISO datetime; planning only). */
    @ApiProperty({
        required: false,
        format: 'date-time',
        nullable: true,
        description: 'EW-P2-3 — when the Task is due (planning only).',
    })
    @IsOptional()
    @ValidateIf((_, value) => value !== null)
    @IsDateString()
    dueAt?: string | null;

    /** EW-P2-3 — planned start (ISO datetime; never after dueAt). */
    @ApiProperty({
        required: false,
        format: 'date-time',
        nullable: true,
        description: 'EW-P2-3 — planned start; never after dueAt.',
    })
    @IsOptional()
    @ValidateIf((_, value) => value !== null)
    @IsDateString()
    startAt?: string | null;

    /** EW-P2-3 — estimated effort in whole minutes (0..525600). */
    @ApiProperty({
        required: false,
        nullable: true,
        minimum: 0,
        maximum: 525600,
        description: 'EW-P2-3 — estimated effort in whole minutes.',
    })
    @IsOptional()
    @ValidateIf((_, value) => value !== null)
    @IsInt()
    @Min(0)
    @Max(525600)
    estimateMinutes?: number | null;
}

/** Contract v1 `requests.schema.json#/$defs/TransitionTask`. */
export class IntegrationTransitionTaskDto {
    @ApiProperty({
        enum: ['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled'],
    })
    @IsIn(Object.values(TaskStatus))
    to!: TaskStatus;

    @ApiProperty({ enum: ['sync'] })
    @IsIn(['sync'])
    mode!: 'sync';
}

/** Contract v1 `requests.schema.json#/$defs/UpdateTask` (no `status`: use /transition). */
export class IntegrationUpdateTaskDto {
    @ApiProperty({ required: false, minLength: 1, maxLength: 200 })
    @IsOptional()
    @IsString()
    @Length(1, 200)
    title?: string;

    @ApiProperty({ required: false, nullable: true, maxLength: 100000 })
    @IsOptional()
    @IsString()
    @MaxLength(100_000)
    description?: string | null;

    @ApiProperty({ required: false, enum: ['p0', 'p1', 'p2', 'p3', 'p4'] })
    @IsOptional()
    @IsIn(PRIORITIES)
    priority?: (typeof PRIORITIES)[number];

    @ApiProperty({ required: false, type: [String], maxItems: 50 })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(50)
    @IsString({ each: true })
    @Length(1, 80, { each: true })
    labels?: string[];

    @ApiProperty({
        required: false,
        type: [String],
        format: 'uuid',
        description:
            'teamId plus the team_resources rows, as one set. Writable on POST/PATCH; the first id is stored as teamId where the entity has that column. Non-empty means visibility `team` unless visibilityExplicit (D11).',
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

    @ApiProperty({ required: false, format: 'uuid', nullable: true })
    @IsOptional()
    @IsUUID()
    workId?: string | null;

    @ApiProperty({ required: false, format: 'uuid', nullable: true })
    @IsOptional()
    @IsUUID()
    parentTaskId?: string | null;

    /** EW-P2-3 — when the task is due (ISO datetime; planning only). */
    @ApiProperty({
        required: false,
        format: 'date-time',
        nullable: true,
        description: 'EW-P2-3 — when the Task is due (planning only).',
    })
    @IsOptional()
    @ValidateIf((_, value) => value !== null)
    @IsDateString()
    dueAt?: string | null;

    /** EW-P2-3 — planned start (ISO datetime; never after dueAt). */
    @ApiProperty({
        required: false,
        format: 'date-time',
        nullable: true,
        description: 'EW-P2-3 — planned start; never after dueAt.',
    })
    @IsOptional()
    @ValidateIf((_, value) => value !== null)
    @IsDateString()
    startAt?: string | null;

    /** EW-P2-3 — estimated effort in whole minutes (0..525600). */
    @ApiProperty({
        required: false,
        nullable: true,
        minimum: 0,
        maximum: 525600,
        description: 'EW-P2-3 — estimated effort in whole minutes.',
    })
    @IsOptional()
    @ValidateIf((_, value) => value !== null)
    @IsInt()
    @Min(0)
    @Max(525600)
    estimateMinutes?: number | null;
}

type Response = IdempotentResponse & { setHeader(name: string, value: string): unknown };

/**
 * Task writes of `/api/integrations/v1` (EW-P1-4, contract v1 B.6). They call
 * the same domain service as the app (`TasksService`), so every rule, event
 * and notification is the app's own:
 *
 * - `POST /tasks` needs an `Idempotency-Key`; `externalRef` links the new task
 *   to its external record, and a repeat with the same `externalRef` answers
 *   `200` with the existing task instead of a duplicate. A task starts in
 *   `backlog` (default) or `todo`; moves go through `/transition`.
 * - `PATCH` / `DELETE /tasks/:id` take an optional `If-Match: "<version>"`
 *   (`412 version_mismatch` when stale).
 * - Writes are attributed to the integration (`createdByType: integration`)
 *   unless `X-Act-As-User` names a person, and carry `X-Sync-Origin` into the
 *   events' `origin.tag`.
 * - `visibility`: `private` answers `422 domain_rule`; `team` / `organization`
 *   are accepted and applied by record visibility (D11) — the task's teams
 *   decide it.
 */
@ApiTags('Integrations API v1')
@Controller('api/integrations/v1')
@UseGuards(IntegrationOnlyGuard)
@UseFilters(IntegrationExceptionFilter)
export class IntegrationTasksWriteController {
    constructor(
        private readonly tasks: TasksService,
        private readonly teamResources: TeamResourcesService,
        private readonly links: ExternalRecordLinksService,
        private readonly idempotency: IntegrationIdempotencyService,
        private readonly resources: IntegrationResourcesService,
        private readonly scope: ScopeContextService,
        // Record visibility (EW-P1-3): a hand-picked `team` / `organization`.
        // Appended LAST + @Optional; absent, `visibility` is validated only.
        @Optional() private readonly visibility?: RecordVisibilityService,
    ) {}

    @Post('tasks')
    @RequireScopes('tasks:write')
    @ApiOperation({
        summary: 'Create a task (Idempotency-Key required; externalRef de-duplicates)',
    })
    async create(
        @CurrentUser() user: AuthenticatedUser,
        @Body() dto: IntegrationCreateTaskDto,
        @Headers('x-sync-origin') syncOrigin: string | undefined,
        @Req() req: IdempotentRequest,
        @Res({ passthrough: true }) res: Response,
    ): Promise<unknown> {
        const principal = principalOf(user);
        const organizationId = pinnedOrganizationOf(this.scope.getScope().organizationId);
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
                    'task',
                    dto.externalRef.externalId,
                );
                if (existing) {
                    return {
                        status: 200,
                        body: (
                            await this.resources.get(
                                'task',
                                organizationId,
                                existing.entityId,
                                source,
                            )
                        ).dto,
                    };
                }
            }

            const [teamId, ...extraTeams] = dto.teamIds ?? [];
            const createdBy = writeAttribution(user);
            const externalRef = dto.externalRef;
            let task: Awaited<ReturnType<TasksService['create']>>;
            try {
                task = await this.tasks.create(
                    user.userId,
                    {
                        title: dto.title,
                        description: dto.description ?? null,
                        status: dto.status === 'todo' ? TaskStatus.TODO : TaskStatus.BACKLOG,
                        priority: dto.priority as TaskPriority | undefined,
                        labels: dto.labels ?? null,
                        teamId: teamId ?? null,
                        workId: dto.workId ?? null,
                        missionId: dto.missionId ?? null,
                        ideaId: dto.ideaId ?? null,
                        parentTaskId: dto.parentTaskId ?? null,
                        createdByType: createdBy.type,
                        createdById: createdBy.id,
                        // EW-P2-3 — planning dates + estimate (contract v1 B.6).
                        dueAt: dto.dueAt ? new Date(dto.dueAt) : null,
                        startAt: dto.startAt ? new Date(dto.startAt) : null,
                        estimateMinutes: dto.estimateMinutes ?? null,
                    },
                    this.scope.getScope() as never,
                    // T17a — the task and its externalRef link commit together (one
                    // transaction): a lost race rolls the task back instead of
                    // leaving it to be undone, and a crash can no longer leave an
                    // unlinked task behind.
                    linkScope && externalRef
                        ? {
                              withinCreate: async (row, manager) => {
                                  await this.links.create(
                                      linkScope,
                                      {
                                          entityType: 'task',
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
                // A concurrent create with the same externalRef won (ours rolled
                // back with its link): answer theirs.
                if (
                    linkScope &&
                    externalRef &&
                    error instanceof DuplicateExternalRefError &&
                    error.side === 'external'
                ) {
                    const winner = await this.links.findByExternal(
                        linkScope,
                        'task',
                        externalRef.externalId,
                    );
                    if (winner) {
                        return {
                            status: 200,
                            body: (
                                await this.resources.get(
                                    'task',
                                    organizationId,
                                    winner.entityId,
                                    source,
                                )
                            ).dto,
                        };
                    }
                }
                throw error;
            }
            for (const extra of extraTeams) {
                await this.teamResources.attach(user.userId, organizationId, extra, {
                    resourceType: 'task',
                    resourceId: task.id,
                });
            }
            for (const assignee of dto.assignees ?? []) {
                await this.tasks.addAssignee(
                    user.userId,
                    task.id,
                    assignee.type,
                    assignee.id,
                    this.scope.getScope() as never,
                );
            }
            if (dto.visibility !== undefined) {
                await this.visibility?.setVisibility('task', task.id, dto.visibility as never);
            }
            const created = await this.resources.get('task', organizationId, task.id, source);
            if (created.etag) res.setHeader('ETag', created.etag);
            return { status: 201, body: created.dto };
        });
    }

    @Patch('tasks/:id')
    @RequireScopes('tasks:write')
    @ApiOperation({ summary: 'Update a task (If-Match optional; no status — use /transition)' })
    async update(
        @CurrentUser() user: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() dto: IntegrationUpdateTaskDto,
        @Headers('if-match') ifMatch: string | undefined,
        @Res({ passthrough: true }) res: Response,
    ): Promise<Record<string, unknown>> {
        const principal = principalOf(user);
        const organizationId = pinnedOrganizationOf(this.scope.getScope().organizationId);
        const source = linkSourceOf(principal);
        if (Object.keys(dto).length === 0)
            throw validationFailed('body', 'must change at least one field');
        assertWritableVisibility(dto.visibility);
        const current = await this.resources.get('task', organizationId, id, source);
        const expected = expectedVersion(ifMatch);
        assertIfMatch(expected, Number(current.dto.version));

        const patch: Record<string, unknown> = {};
        if (dto.title !== undefined) patch.title = dto.title;
        if (dto.description !== undefined) patch.description = dto.description;
        if (dto.priority !== undefined) patch.priority = dto.priority;
        if (dto.labels !== undefined) patch.labels = dto.labels;
        if (dto.workId !== undefined) patch.workId = dto.workId;
        if (dto.parentTaskId !== undefined) patch.parentTaskId = dto.parentTaskId;
        if (dto.teamIds !== undefined) patch.teamId = dto.teamIds[0] ?? null;
        // EW-P2-3 — absent leaves untouched, null clears.
        if (dto.dueAt !== undefined) patch.dueAt = dto.dueAt === null ? null : new Date(dto.dueAt);
        if (dto.startAt !== undefined) {
            patch.startAt = dto.startAt === null ? null : new Date(dto.startAt);
        }
        if (dto.estimateMinutes !== undefined) patch.estimateMinutes = dto.estimateMinutes;
        await withExpectedVersion('task', id, expected, async () => {
            if (Object.keys(patch).length > 0) {
                await this.tasks.update(user.userId, id, patch, this.scope.getScope() as never);
            }
            if (dto.teamIds !== undefined) {
                await this.syncExtraTeams(user.userId, organizationId, id, dto.teamIds.slice(1));
            }
            if (dto.visibility !== undefined) {
                await this.visibility?.setVisibility('task', id, dto.visibility as never);
            }
        });
        const updated = await this.resources.get('task', organizationId, id, source);
        if (updated.etag) res.setHeader('ETag', updated.etag);
        return updated.dto;
    }

    @Post('tasks/:id/transition')
    @RequireScopes('tasks:write')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary:
            "Move a task to a status along the shortest legal path (mode 'sync'; gates → 409 transition_blocked)",
    })
    async transition(
        @CurrentUser() user: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() dto: IntegrationTransitionTaskDto,
        @Res({ passthrough: true }) res: Response,
    ): Promise<Record<string, unknown>> {
        const principal = principalOf(user);
        const organizationId = pinnedOrganizationOf(this.scope.getScope().organizationId);
        const source = linkSourceOf(principal);
        // The task must be one the caller sees (404 otherwise).
        await this.resources.get('task', organizationId, id, source);
        // EW-P1-6: one gated hop at a time, no agent work started (D9), never
        // `force` — the approver gate stands for integrations.
        await this.tasks.syncTransition(
            user.userId,
            id,
            dto.to,
            { force: false },
            this.scope.getScope() as never,
        );
        const moved = await this.resources.get('task', organizationId, id, source);
        if (moved.etag) res.setHeader('ETag', moved.etag);
        return moved.dto;
    }

    @Delete('tasks/:id')
    @RequireScopes('tasks:write')
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiOperation({ summary: 'Delete a task (If-Match optional)' })
    async remove(
        @CurrentUser() user: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Headers('if-match') ifMatch: string | undefined,
    ): Promise<void> {
        const principal = principalOf(user);
        const organizationId = pinnedOrganizationOf(this.scope.getScope().organizationId);
        const current = await this.resources.get(
            'task',
            organizationId,
            id,
            linkSourceOf(principal),
        );
        const expected = expectedVersion(ifMatch);
        assertIfMatch(expected, Number(current.dto.version));
        await withExpectedVersion('task', id, expected, () =>
            this.tasks.remove(user.userId, id, this.scope.getScope() as never),
        );
        await this.links.removeAllFor(organizationId, 'task', id);
    }

    /**
     * `teamIds[1..]` are `team_resources` links: attach the new ones, detach the
     * dropped ones. The current links are read from `team_resources` itself: a
     * task with no primary `teamId` can still have links, so they are not
     * `teamIds` minus its first entry.
     */
    private async syncExtraTeams(
        userId: string,
        organizationId: string,
        taskId: string,
        wanted: string[],
    ): Promise<void> {
        const currentLinks = (
            await this.teamResources.listTeamsForResource(organizationId, 'task', taskId)
        ).map((team) => team.teamId);
        for (const teamId of wanted.filter((team) => !currentLinks.includes(team))) {
            await this.teamResources.attach(userId, organizationId, teamId, {
                resourceType: 'task',
                resourceId: taskId,
            });
        }
        for (const teamId of currentLinks.filter((team) => !wanted.includes(team))) {
            await this.teamResources.detach(organizationId, teamId, 'task', taskId);
        }
    }
}

/** `If-Match` → version | null (`400 validation_failed` when not one this API issued). */
function expectedVersion(header: string | undefined): number | null {
    const parsed = parseIfMatch(header);
    if (parsed === undefined)
        throw validationFailed('If-Match', 'must be the "<version>" ETag of the record');
    return parsed;
}

/** Integrations may set `team` or `organization` only (contract v1 §1.3). */
function assertWritableVisibility(visibility: string | undefined): void {
    if (visibility === undefined) return;
    if (visibility === 'private') {
        throw new IntegrationHttpException(
            422,
            'domain_rule',
            'An integration cannot make a record private.',
            {
                field: 'visibility',
            },
        );
    }
    if (visibility !== 'team' && visibility !== 'organization') {
        throw validationFailed('visibility', 'must be team or organization');
    }
}
