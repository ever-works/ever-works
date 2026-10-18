import { Body, Controller, Headers, Post, Req, Res, UseFilters, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
    ArrayMaxSize,
    IsArray,
    IsIn,
    IsOptional,
    IsString,
    IsUrl,
    IsUUID,
    Length,
    MaxLength,
    ValidateIf,
    ValidateNested,
} from 'class-validator';
import { config } from '@ever-works/agent/config';
import { UserRepository } from '@ever-works/agent/database';
import {
    DuplicateExternalRefError,
    ExternalRecordLinksService,
    installationFromOrigin,
    IntegrationIdempotencyService,
    IntegrationResourcesService,
} from '@ever-works/agent/integrations-api';
import { WorkLifecycleService, WorkQueryService } from '@ever-works/agent/services';
import { TeamResourcesService } from '@ever-works/agent/teams';
import { CurrentUser } from '../../auth/decorators/user.decorator';
import { writeAttribution } from '../../auth/integration/integration-attribution';
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
    assertWritableVisibility,
    domainRule,
    linkSourceOf,
    pinnedOrganizationOf,
    principalOf,
} from './integration-request';
import { IntegrationExternalRefDto } from './tasks-write.controller';

/** Contract v1 `requests.schema.json#/$defs/CreateWork` (Gauzy CR-6, EW-P2-4). */
export class IntegrationCreateWorkDto {
    /** The only kind an integration creates: the repo-less Project Work. */
    @ApiProperty({
        enum: ['project'],
        description: 'Only a repo-less Project Work (no repositories, deploy or generator; D9).',
    })
    @IsIn(['project'])
    kind!: 'project';

    @ApiProperty({ minLength: 1, maxLength: 255 })
    @IsString()
    @Length(1, 255)
    name!: string;

    @ApiProperty({ required: false, nullable: true, maxLength: 2000 })
    @IsOptional()
    @ValidateIf((_, value) => value !== null)
    @IsString()
    @MaxLength(2000)
    description?: string | null;

    @ApiProperty({ required: false, nullable: true, format: 'uri', maxLength: 2048 })
    @IsOptional()
    @ValidateIf((_, value) => value !== null)
    @IsUrl({ protocols: ['http', 'https'], require_protocol: true, require_tld: false })
    @MaxLength(2048)
    website?: string | null;

    @ApiProperty({
        required: false,
        type: [String],
        format: 'uuid',
        maxItems: 50,
        description:
            'team_resources rows (type work); a Work derives its visibility from them (CR-1).',
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
            'Only validated (a Work derives its visibility from its Teams); `private` answers 422 domain_rule.',
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

type Response = IdempotentResponse & { setHeader(name: string, value: string): unknown };

/**
 * `POST /api/integrations/v1/works` (Gauzy CR-6; plan D3 / EW-P2-4: "Create in Ever
 * Works" for a Gauzy project). Only `kind: 'project'`: a repo-less Project Work —
 * no repositories, no deploy, no generator — so nothing here provisions anything or
 * starts spend (D9). Through the app's own `WorkLifecycleService.createProjectWork`,
 * which records `work.created`.
 *
 * - Behind `EVER_WORKS_PROJECT_WORKS_ENABLED`: off answers `422 domain_rule` with
 *   `details.reason: 'project_works_disabled'`.
 * - Owned by the act-as user, else the key's owner; the slug is derived from `name`
 *   like the session route (`<slug>-N` when taken).
 * - `teamIds` become `team_resources` rows (type `work`); a Work's visibility is
 *   derived from them (contract CR-1), so `visibility` is only validated (`private`
 *   → 422).
 * - `Idempotency-Key` required; a repeated `externalRef` answers `200` with the
 *   existing Work.
 */
@ApiTags('Integrations API v1')
@Controller('api/integrations/v1')
@UseGuards(IntegrationOnlyGuard)
@UseFilters(IntegrationExceptionFilter)
export class IntegrationWorksWriteController {
    constructor(
        private readonly lifecycle: WorkLifecycleService,
        private readonly workQuery: WorkQueryService,
        private readonly users: UserRepository,
        private readonly teamResources: TeamResourcesService,
        private readonly links: ExternalRecordLinksService,
        private readonly idempotency: IntegrationIdempotencyService,
        private readonly resources: IntegrationResourcesService,
        private readonly scope: ScopeContextService,
    ) {}

    @Post('works')
    @RequireScopes('works:write')
    @ApiOperation({
        summary:
            "Create a repo-less Project Work (kind 'project' only; Idempotency-Key required; externalRef de-duplicates)",
    })
    async create(
        @CurrentUser() user: AuthenticatedUser,
        @Body() dto: IntegrationCreateWorkDto,
        @Headers('x-sync-origin') syncOrigin: string | undefined,
        @Req() req: IdempotentRequest,
        @Res({ passthrough: true }) res: Response,
    ): Promise<unknown> {
        const principal = principalOf(user);
        const organizationId = pinnedOrganizationOf(this.scope.getScope().organizationId);
        const source = linkSourceOf(principal);
        assertWritableVisibility(dto.visibility);
        assertOwnLinkSource(dto.externalRef, source);
        if (!config.everWorks.projectWorks.enabled()) {
            throw domainRule(
                'Project Works are not enabled on this installation (EVER_WORKS_PROJECT_WORKS_ENABLED).',
                { reason: 'project_works_disabled' },
            );
        }
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
                    'work',
                    dto.externalRef.externalId,
                );
                if (existing) {
                    const found = await this.resources.get(
                        'work',
                        organizationId,
                        existing.entityId,
                        source,
                    );
                    return { status: 200, body: found.dto };
                }
            }

            // Every Team must be one of the pinned organization's (404) BEFORE the Work is
            // created, so a foreign Team never leaves an orphan Project Work behind.
            const teamIds = [...new Set(dto.teamIds ?? [])];
            for (const teamId of teamIds) {
                await this.resources.get('team', organizationId, teamId, source);
            }
            const owner = await this.users.findById(user.userId);
            if (!owner) throw domainRule('The Work owner is not an active user.');
            const name = dto.name.trim();
            const availability = await this.workQuery.checkSlugAvailability(name, owner);
            const slug = availability.available
                ? availability.slug
                : (availability.suggestion ?? null);
            if (!slug) {
                throw domainRule('Could not derive a free slug for this project.', {
                    reason: 'slug_unavailable',
                });
            }
            const externalRef = dto.externalRef;
            const createdBy = writeAttribution(user);
            let work: Awaited<ReturnType<WorkLifecycleService['createProjectWork']>>;
            try {
                work = await this.lifecycle.createProjectWork(
                    owner,
                    {
                        name,
                        slug,
                        description: dto.description?.trim() || undefined,
                        website: dto.website ?? null,
                    },
                    // EW-P1-2 — attributed to the integration key (the DTO's `createdBy`), or to
                    // the act-as person, as for tasks, ideas, goals and missions.
                    // T17a pattern — the Project Work, its `work.created` event and its
                    // externalRef link commit together (one transaction): a lost race rolls
                    // the Work back instead of leaving a stray bare Project Work behind.
                    linkScope && externalRef
                        ? {
                              createdBy,
                              withinCreate: async (row, manager) => {
                                  await this.links.create(
                                      linkScope,
                                      {
                                          entityType: 'work',
                                          entityId: row.id,
                                          externalId: externalRef.externalId,
                                          externalUrl: externalRef.externalUrl ?? null,
                                      },
                                      manager,
                                  );
                              },
                          }
                        : { createdBy },
                );
            } catch (error) {
                // A concurrent create with the same externalRef won (ours rolled back with
                // its link): answer the winner's.
                if (
                    linkScope &&
                    externalRef &&
                    error instanceof DuplicateExternalRefError &&
                    error.side === 'external'
                ) {
                    const winner = await this.links.findByExternal(
                        linkScope,
                        'work',
                        externalRef.externalId,
                    );
                    if (winner) {
                        const found = await this.resources.get(
                            'work',
                            organizationId,
                            winner.entityId,
                            source,
                        );
                        return { status: 200, body: found.dto };
                    }
                }
                throw error;
            }
            for (const teamId of teamIds) {
                await this.teamResources.attach(user.userId, organizationId, teamId, {
                    resourceType: 'work',
                    resourceId: work.id,
                });
            }
            const created = await this.resources.get('work', organizationId, work.id, source);
            if (created.etag) res.setHeader('ETag', created.etag);
            return { status: 201, body: created.dto };
        });
    }
}
