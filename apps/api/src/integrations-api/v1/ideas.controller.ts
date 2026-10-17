import {
    Body,
    Controller,
    Get,
    Headers,
    HttpCode,
    HttpStatus,
    Param,
    ParseUUIDPipe,
    Patch,
    Post,
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
    IsOptional,
    IsString,
    IsUUID,
    Length,
    ValidateNested,
} from 'class-validator';
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
import { WorkProposalService, WorkProposalStatus } from '@ever-works/agent/user-research';
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

/** The Idea title limit (`work_proposals.title varchar(120)`). */
const IDEA_TITLE_MAX = 120;
/** The Idea description limit (same as a task's). */
const IDEA_DESCRIPTION_MAX = 100_000;

/** Contract v1 `requests.schema.json#/$defs/CreateIdea`. */
export class IntegrationCreateIdeaDto {
    @ApiProperty({ minLength: 1, maxLength: IDEA_TITLE_MAX })
    @IsString()
    @Length(1, IDEA_TITLE_MAX)
    title!: string;

    @ApiProperty({ minLength: 1, maxLength: IDEA_DESCRIPTION_MAX })
    @IsString()
    @Length(1, IDEA_DESCRIPTION_MAX)
    description!: string;

    @ApiProperty({
        required: false,
        nullable: true,
        format: 'uuid',
        description:
            "The caller's own non-private Mission of the pinned organization (404 otherwise).",
    })
    @IsOptional()
    @IsUUID()
    missionId?: string | null;

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

/** Contract v1 `requests.schema.json#/$defs/UpdateIdea` (no `status`: dismiss / restore). */
export class IntegrationUpdateIdeaDto {
    @ApiProperty({ required: false, minLength: 1, maxLength: IDEA_TITLE_MAX })
    @IsOptional()
    @IsString()
    @Length(1, IDEA_TITLE_MAX)
    title?: string;

    @ApiProperty({ required: false, minLength: 1, maxLength: IDEA_DESCRIPTION_MAX })
    @IsOptional()
    @IsString()
    @Length(1, IDEA_DESCRIPTION_MAX)
    description?: string;

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

interface ListQuery {
    readonly updatedSince?: string;
    readonly cursor?: string;
    readonly limit?: string;
}

type Response = IdempotentResponse & { setHeader(name: string, value: string): unknown };

/**
 * Ideas of `/api/integrations/v1` (EW-P2-1, contract v1 B.6). Ever Works Ideas
 * (`work_proposals`) are Gauzy tasks of issue type "Idea" (plan D4).
 *
 * - Reads: every `team` / `organization` Idea of the pinned organization
 *   (`private` ones are never served), as keyset pages and by id with `ETag`.
 * - `POST /ideas` (Idempotency-Key, `externalRef` de-duplication like tasks)
 *   always creates `source = 'external'`, `status = 'pending'`, whatever the
 *   body says, through `WorkProposalService.createExternal`.
 * - `PATCH /ideas/:id` edits the title and description (and `teamIds`,
 *   `visibility`), with an optional `If-Match`.
 * - `POST /ideas/:id/dismiss` (pending → dismissed) and `/restore`
 *   (dismissed → pending) are idempotent: a repeat answers the Idea as it is.
 *
 * Spend safety (D9): nothing here queues, builds or accepts an Idea — those
 * stay user actions in Ever Works. Writes act as the Idea's owner like the task
 * writes do (the key's owner, or `X-Act-As-User`): an Idea owned by someone
 * else answers `404 not_found`.
 */
@ApiTags('Integrations API v1')
@Controller('api/integrations/v1')
@UseGuards(IntegrationOnlyGuard)
@UseFilters(IntegrationExceptionFilter)
export class IntegrationIdeasController {
    constructor(
        private readonly ideas: WorkProposalService,
        private readonly visibility: RecordVisibilityService,
        private readonly links: ExternalRecordLinksService,
        private readonly idempotency: IntegrationIdempotencyService,
        private readonly resources: IntegrationResourcesService,
        private readonly scope: ScopeContextService,
    ) {}

    @Get('ideas')
    @RequireScopes('ideas:read')
    @ApiOperation({ summary: 'Ideas (team and organization visibility)' })
    async list(
        @CurrentUser() user: AuthenticatedUser,
        @Query() query: ListQuery,
    ): Promise<KeysetPage<Record<string, unknown>>> {
        const principal = principalOf(user);
        return this.resources
            .list(
                'idea',
                this.organizationId(),
                {
                    updatedSince: parseUpdatedSince(query.updatedSince),
                    cursor: query.cursor || null,
                    limit: parseLimit(query.limit),
                },
                linkSourceOf(principal),
            )
            .catch(rethrowCursor);
    }

    @Get('ideas/:id')
    @RequireScopes('ideas:read')
    @ApiOperation({ summary: 'One Idea' })
    async get(
        @CurrentUser() user: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Res({ passthrough: true }) res: Response,
    ): Promise<Record<string, unknown>> {
        return this.send(res, id, linkSourceOf(principalOf(user)));
    }

    @Post('ideas')
    @RequireScopes('ideas:write')
    @ApiOperation({
        summary:
            'Create an Idea (always source external + status pending; Idempotency-Key required; externalRef de-duplicates)',
    })
    async create(
        @CurrentUser() user: AuthenticatedUser,
        @Body() dto: IntegrationCreateIdeaDto,
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
                    'idea',
                    dto.externalRef.externalId,
                );
                if (existing) {
                    return { status: 200, body: await this.dto(existing.entityId, source) };
                }
            }

            const externalRef = dto.externalRef;
            let idea: Awaited<ReturnType<WorkProposalService['createExternal']>>;
            try {
                idea = await this.ideas.createExternal(
                    {
                        userId: user.userId,
                        tenantId: this.scope.getScope().tenantId ?? principal.tenantId ?? null,
                        organizationId,
                        title: dto.title,
                        description: dto.description,
                        missionId: dto.missionId ?? null,
                        teamIds: dto.teamIds,
                        visibility: dto.visibility as 'team' | 'organization' | undefined,
                        integrationKeyId: principal.keyId,
                        createdBy: writeAttribution(user),
                    },
                    // T17a pattern — the Idea and its externalRef link commit together (one
                    // transaction): a lost race rolls the Idea back instead of leaving it to be
                    // undone, and a crash can no longer leave an unlinked Idea behind.
                    linkScope && externalRef
                        ? {
                              withinCreate: async (row, manager) => {
                                  await this.links.create(
                                      linkScope,
                                      {
                                          entityType: 'idea',
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
                        'idea',
                        externalRef.externalId,
                    );
                    if (winner) {
                        return { status: 200, body: await this.dto(winner.entityId, source) };
                    }
                }
                throw error;
            }
            const created = await this.resources.get('idea', organizationId, idea.id, source);
            if (created.etag) res.setHeader('ETag', created.etag);
            return { status: 201, body: created.dto };
        });
    }

    @Patch('ideas/:id')
    @RequireScopes('ideas:write')
    @ApiOperation({
        summary: 'Update an Idea: title, description, teamIds, visibility (If-Match optional)',
    })
    async update(
        @CurrentUser() user: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() dto: IntegrationUpdateIdeaDto,
        @Headers('if-match') ifMatch: string | undefined,
        @Res({ passthrough: true }) res: Response,
    ): Promise<Record<string, unknown>> {
        const principal = principalOf(user);
        const organizationId = this.organizationId();
        const source = linkSourceOf(principal);
        if (Object.values(dto).every((value) => value === undefined)) {
            throw validationFailed('body', 'must change at least one field');
        }
        assertWritableVisibility(dto.visibility);
        const current = await this.resources.get('idea', organizationId, id, source);
        const expected = expectedVersionOf(ifMatch);
        assertIfMatch(expected, Number(current.dto.version));
        await this.owned(user, id);
        // Every Team must be one of the pinned organization's (404 otherwise) BEFORE the
        // first write, so a foreign Team never leaves a half-applied PATCH behind.
        for (const teamId of dto.teamIds ?? []) {
            await this.resources.get('team', organizationId, teamId, source);
        }

        await withExpectedVersion('idea', id, expected, async () => {
            if (dto.title !== undefined || dto.description !== undefined) {
                await this.ideas.updateContent(user.userId, id, {
                    title: dto.title,
                    description: dto.description,
                });
            }
            if (dto.teamIds !== undefined) {
                await this.visibility.setTeams('idea', id, dto.teamIds, user.userId);
            }
            if (dto.visibility !== undefined) {
                await this.visibility.setVisibility('idea', id, dto.visibility as never);
            }
        });
        return this.send(res, id, source);
    }

    @Post('ideas/:id/dismiss')
    @RequireScopes('ideas:write')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Dismiss a pending Idea (idempotent)' })
    async dismiss(
        @CurrentUser() user: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Res({ passthrough: true }) res: Response,
    ): Promise<Record<string, unknown>> {
        const source = linkSourceOf(principalOf(user));
        await this.resources.get('idea', this.organizationId(), id, source);
        const idea = await this.owned(user, id);
        if (idea.status !== WorkProposalStatus.DISMISSED) {
            if (idea.status !== WorkProposalStatus.PENDING) {
                throw domainRule('Only a pending Idea can be dismissed.', { status: idea.status });
            }
            const moved = await this.ideas.dismiss(user.userId, id);
            if (!moved) await this.assertNowIn(user, id, WorkProposalStatus.DISMISSED, 'dismissed');
        }
        return this.send(res, id, source);
    }

    @Post('ideas/:id/restore')
    @RequireScopes('ideas:write')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Restore a dismissed Idea to pending (idempotent)' })
    async restore(
        @CurrentUser() user: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Res({ passthrough: true }) res: Response,
    ): Promise<Record<string, unknown>> {
        const source = linkSourceOf(principalOf(user));
        await this.resources.get('idea', this.organizationId(), id, source);
        const idea = await this.owned(user, id);
        if (idea.status !== WorkProposalStatus.PENDING) {
            if (idea.status !== WorkProposalStatus.DISMISSED) {
                throw domainRule('Only a dismissed Idea can be restored.', { status: idea.status });
            }
            const moved = await this.ideas.restore(user.userId, id);
            if (!moved) await this.assertNowIn(user, id, WorkProposalStatus.PENDING, 'restored');
        }
        return this.send(res, id, source);
    }

    private organizationId(): string {
        return pinnedOrganizationOf(this.scope.getScope().organizationId);
    }

    /** The caller's own Idea: writes act as its owner (`404` for someone else's). */
    private async owned(user: AuthenticatedUser, id: string) {
        const idea = await this.ideas.getForUser(user.userId, id);
        if (!idea) {
            throw new IntegrationHttpException(404, 'not_found', `idea ${id} not found`);
        }
        return idea;
    }

    /** After a refused guarded move: a concurrent request may have made the same move. */
    private async assertNowIn(
        user: AuthenticatedUser,
        id: string,
        status: WorkProposalStatus,
        verb: string,
    ): Promise<void> {
        const now = await this.owned(user, id);
        if (now.status !== status) {
            throw domainRule(`The Idea could not be ${verb}: it changed meanwhile.`, {
                status: now.status,
            });
        }
    }

    private async dto(id: string, source: string): Promise<Record<string, unknown>> {
        return (await this.resources.get('idea', this.organizationId(), id, source)).dto;
    }

    private async send(
        res: Response,
        id: string,
        source: string,
    ): Promise<Record<string, unknown>> {
        const resource = await this.resources.get('idea', this.organizationId(), id, source);
        if (resource.etag) res.setHeader('ETag', resource.etag);
        return resource.dto;
    }
}
