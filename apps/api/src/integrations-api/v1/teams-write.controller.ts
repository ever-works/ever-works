import {
    Body,
    Controller,
    Delete,
    Headers,
    HttpCode,
    HttpStatus,
    Param,
    ParseUUIDPipe,
    Patch,
    Post,
    Put,
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
    IsIn,
    IsOptional,
    IsString,
    IsUUID,
    Length,
    Matches,
    MaxLength,
    ValidateNested,
} from 'class-validator';
import { TEAM_RESOURCE_TYPES, type TeamResourceType } from '@ever-works/agent/entities';
import { TeamResourcesService, TeamsService } from '@ever-works/agent/teams';
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
import { IntegrationExternalRefDto } from './tasks-write.controller';

/** `CreateTeam` (contract v1 requests.schema.json). */
export class IntegrationCreateTeamDto {
    @ApiProperty({ minLength: 1, maxLength: 200 })
    @IsString()
    @Length(1, 200)
    name!: string;

    @ApiProperty({ required: false })
    @IsOptional()
    @Matches(/^[a-z0-9][a-z0-9-]{0,99}$/)
    slug?: string;

    @ApiProperty({ required: false, nullable: true, maxLength: 5000 })
    @IsOptional()
    @IsString()
    @MaxLength(5000)
    description?: string | null;

    @ApiProperty({ required: false, format: 'uuid', nullable: true })
    @IsOptional()
    @IsUUID()
    parentTeamId?: string | null;

    @ApiProperty({ required: false, nullable: true, maxLength: 100 })
    @IsOptional()
    @IsString()
    @MaxLength(100)
    avatarIcon?: string | null;

    @ApiProperty({ required: false, type: () => IntegrationExternalRefDto })
    @IsOptional()
    @ValidateNested()
    @Type(() => IntegrationExternalRefDto)
    externalRef?: IntegrationExternalRefDto;
}

/** `UpdateTeam` (contract v1 requests.schema.json). */
export class IntegrationUpdateTeamDto {
    @ApiProperty({ required: false, minLength: 1, maxLength: 200 })
    @IsOptional()
    @IsString()
    @Length(1, 200)
    name?: string;

    @ApiProperty({ required: false, nullable: true, maxLength: 5000 })
    @IsOptional()
    @IsString()
    @MaxLength(5000)
    description?: string | null;

    @ApiProperty({ required: false, format: 'uuid', nullable: true })
    @IsOptional()
    @IsUUID()
    parentTeamId?: string | null;

    @ApiProperty({ required: false, nullable: true, maxLength: 100 })
    @IsOptional()
    @IsString()
    @MaxLength(100)
    avatarIcon?: string | null;
}

export class IntegrationTeamMemberRefDto {
    @ApiProperty({ enum: ['user', 'agent'] })
    @IsIn(['user', 'agent'])
    memberType!: 'user' | 'agent';

    @ApiProperty({ format: 'uuid' })
    @IsUUID()
    memberId!: string;

    @ApiProperty({ enum: ['lead', 'member'] })
    @IsIn(['lead', 'member'])
    role!: 'lead' | 'member';
}

export class PutTeamMembersDto {
    @ApiProperty({ type: () => IntegrationTeamMemberRefDto, isArray: true, maxItems: 500 })
    @IsArray()
    @ArrayMaxSize(500)
    @ValidateNested({ each: true })
    @Type(() => IntegrationTeamMemberRefDto)
    members!: IntegrationTeamMemberRefDto[];
}

export class IntegrationTeamResourceRefDto {
    @ApiProperty({
        description: '`goal` arrives with EW-P1-3. Consumers must ignore types they do not sync.',
    })
    @IsString()
    @MaxLength(32)
    resourceType!: string;

    @ApiProperty({ format: 'uuid' })
    @IsUUID()
    resourceId!: string;
}

export class PutTeamResourcesDto {
    @ApiProperty({ type: () => IntegrationTeamResourceRefDto, isArray: true, maxItems: 5000 })
    @IsArray()
    @ArrayMaxSize(5000)
    @ValidateNested({ each: true })
    @Type(() => IntegrationTeamResourceRefDto)
    resources!: IntegrationTeamResourceRefDto[];
}

type Response = IdempotentResponse;

interface TeamMemberRef {
    memberType: 'user' | 'agent';
    memberId: string;
    role: string;
}

interface TeamResourceRef {
    resourceType: string;
    resourceId: string;
}

/**
 * Team writes of `/api/integrations/v1` (EW-P1-4, contract v1 B.6). Every
 * write goes through `TeamsService` / `TeamResourcesService` — the app's own
 * validation (members and resources must be in the organization, no parent
 * cycles), unique-slug `409` and `team.*` events. Teams are org-wide
 * (`visibility: organization`), so there is no visibility to set.
 */
@ApiTags('Integrations API v1')
@Controller('api/integrations/v1/teams')
@UseGuards(IntegrationOnlyGuard)
@UseFilters(IntegrationExceptionFilter)
export class IntegrationTeamsWriteController {
    constructor(
        private readonly teams: TeamsService,
        private readonly teamResources: TeamResourcesService,
        private readonly links: ExternalRecordLinksService,
        private readonly idempotency: IntegrationIdempotencyService,
        private readonly resources: IntegrationResourcesService,
        private readonly scope: ScopeContextService,
    ) {}

    @Post()
    @RequireScopes('teams:write')
    @ApiOperation({
        summary: 'Create a team (Idempotency-Key required; externalRef de-duplicates)',
    })
    async create(
        @CurrentUser() user: AuthenticatedUser,
        @Body() dto: IntegrationCreateTeamDto,
        @Headers('x-sync-origin') syncOrigin: string | undefined,
        @Req() req: IdempotentRequest,
        @Res({ passthrough: true }) res: Response,
    ): Promise<unknown> {
        const principal = principalOf(user);
        const organizationId = this.organizationId();
        const source = linkSourceOf(principal);
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
                    'team',
                    dto.externalRef.externalId,
                );
                if (existing) {
                    return {
                        status: 200,
                        body: await this.dto(organizationId, existing.entityId, source),
                    };
                }
            }
            const externalRef = dto.externalRef;
            let team: Awaited<ReturnType<TeamsService['create']>>;
            try {
                team = await this.teams.create(
                    user.userId,
                    organizationId,
                    {
                        name: dto.name,
                        slug: dto.slug,
                        description: dto.description ?? null,
                        parentTeamId: dto.parentTeamId ?? null,
                        avatarIcon: dto.avatarIcon ?? null,
                    },
                    // T17a — the team and its externalRef link commit together.
                    linkScope && externalRef
                        ? {
                              withinCreate: async (row, manager) => {
                                  await this.links.create(
                                      linkScope,
                                      {
                                          entityType: 'team',
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
                        'team',
                        externalRef.externalId,
                    );
                    if (winner) {
                        return {
                            status: 200,
                            body: await this.dto(organizationId, winner.entityId, source),
                        };
                    }
                }
                throw error;
            }
            const created = await this.resources.get('team', organizationId, team.id, source);
            if (created.etag) res.setHeader('ETag', created.etag);
            return { status: 201, body: created.dto };
        });
    }

    @Patch(':id')
    @RequireScopes('teams:write')
    @ApiOperation({ summary: 'Update a team (If-Match optional)' })
    async update(
        @CurrentUser() user: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() dto: IntegrationUpdateTeamDto,
        @Headers('if-match') ifMatch: string | undefined,
        @Res({ passthrough: true }) res: Response,
    ): Promise<Record<string, unknown>> {
        const organizationId = this.organizationId();
        const source = linkSourceOf(principalOf(user));
        const patch: Record<string, unknown> = {};
        for (const field of ['name', 'description', 'parentTeamId', 'avatarIcon'] as const) {
            if (dto[field] !== undefined) patch[field] = dto[field];
        }
        if (Object.keys(patch).length === 0) {
            throw validationFailed('body', 'must change at least one field');
        }
        const current = await this.resources.get('team', organizationId, id, source);
        const expected = expectedVersion(ifMatch);
        assertIfMatch(expected, Number(current.dto.version));
        await withExpectedVersion('team', id, expected, () =>
            this.teams.update(organizationId, id, patch),
        );
        return this.answer(organizationId, id, source, res);
    }

    @Delete(':id')
    @RequireScopes('teams:write')
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiOperation({ summary: 'Delete a team (If-Match optional)' })
    async remove(
        @CurrentUser() user: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Headers('if-match') ifMatch: string | undefined,
    ): Promise<void> {
        const organizationId = this.organizationId();
        const current = await this.resources.get(
            'team',
            organizationId,
            id,
            linkSourceOf(principalOf(user)),
        );
        const expected = expectedVersion(ifMatch);
        assertIfMatch(expected, Number(current.dto.version));
        await withExpectedVersion('team', id, expected, () =>
            this.teams.remove(organizationId, id),
        );
        await this.links.removeAllFor(organizationId, 'team', id);
    }

    @Put(':id/members')
    @RequireScopes('teams:write')
    @ApiOperation({ summary: "Set the team's members (the full set)" })
    async members(
        @CurrentUser() user: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() dto: PutTeamMembersDto,
        @Res({ passthrough: true }) res: Response,
    ): Promise<Record<string, unknown>> {
        const organizationId = this.organizationId();
        const source = linkSourceOf(principalOf(user));
        const current = await this.resources.get('team', organizationId, id, source);
        const key = (ref: TeamMemberRef) => `${ref.memberType}:${ref.memberId}:${ref.role}`;
        const have = (current.dto.members as TeamMemberRef[] | undefined) ?? [];
        const wanted = new Map(dto.members.map((ref) => [key(ref), ref]));
        // A role change is a remove and an add (the roster has no role update).
        for (const ref of have.filter((existing) => !wanted.has(key(existing)))) {
            await this.teams.removeMember(organizationId, id, ref.memberType, ref.memberId);
        }
        const kept = new Set(have.map(key));
        for (const ref of wanted.values()) {
            if (kept.has(key(ref))) continue;
            await this.teams.addMember(user.userId, organizationId, id, {
                memberType: ref.memberType,
                memberId: ref.memberId,
                role: ref.role,
            });
        }
        return this.answer(organizationId, id, source, res);
    }

    @Put(':id/resources')
    @RequireScopes('teams:write')
    @ApiOperation({ summary: "Set the team's resources (the full set)" })
    async resourcesSet(
        @CurrentUser() user: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() dto: PutTeamResourcesDto,
        @Res({ passthrough: true }) res: Response,
    ): Promise<Record<string, unknown>> {
        const organizationId = this.organizationId();
        const source = linkSourceOf(principalOf(user));
        dto.resources.forEach((ref, index) => {
            if (!(TEAM_RESOURCE_TYPES as readonly string[]).includes(ref.resourceType)) {
                throw validationFailed(
                    `resources[${index}].resourceType`,
                    `must be one of ${TEAM_RESOURCE_TYPES.join(', ')}`,
                );
            }
        });
        const current = await this.resources.get('team', organizationId, id, source);
        const key = (ref: TeamResourceRef) => `${ref.resourceType}:${ref.resourceId}`;
        const have = (current.dto.resources as TeamResourceRef[] | undefined) ?? [];
        const wanted = new Map(dto.resources.map((ref) => [key(ref), ref]));
        for (const ref of have.filter((existing) => !wanted.has(key(existing)))) {
            await this.teamResources.detach(
                organizationId,
                id,
                ref.resourceType as TeamResourceType,
                ref.resourceId,
            );
        }
        const kept = new Set(have.map(key));
        for (const ref of wanted.values()) {
            if (kept.has(key(ref))) continue;
            // Review 2026-10-17 F4: a private record answers 404 to an integration.
            await this.teamResources.attach(
                user.userId,
                organizationId,
                id,
                {
                    resourceType: ref.resourceType as TeamResourceType,
                    resourceId: ref.resourceId,
                },
                { viewer: { kind: 'integration' } },
            );
        }
        return this.answer(organizationId, id, source, res);
    }

    private organizationId(): string {
        return pinnedOrganizationOf(this.scope.getScope().organizationId);
    }

    private async dto(organizationId: string, id: string, source: string) {
        return (await this.resources.get('team', organizationId, id, source)).dto;
    }

    private async answer(organizationId: string, id: string, source: string, res: Response) {
        const team = await this.resources.get('team', organizationId, id, source);
        if (team.etag) res.setHeader('ETag', team.etag);
        return team.dto;
    }
}

function expectedVersion(header: string | undefined): number | null {
    const parsed = parseIfMatch(header);
    if (parsed === undefined)
        throw validationFailed('If-Match', 'must be the "<version>" ETag of the record');
    return parsed;
}
