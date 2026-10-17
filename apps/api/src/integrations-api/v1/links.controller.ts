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
    Put,
    Query,
    UseFilters,
    UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, IsUrl, Length, MaxLength } from 'class-validator';
import {
    EXTERNAL_LINK_ENTITY_TYPES,
    type ExternalLinkEntityType,
} from '@ever-works/agent/entities';
import {
    ExternalRecordLinksService,
    type ExternalRecordLinkDto,
    installationFromOrigin,
    IntegrationResourcesService,
    toExternalRecordLinkDto,
} from '@ever-works/agent/integrations-api';
import { CurrentUser } from '../../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../../auth/types/auth.types';
import { RequireScopes } from '../../auth/integration/integration.decorators';
import { ScopeContextService } from '../../scope/scope-context.service';
import { IntegrationOnlyGuard } from './integration-only.guard';
import { IntegrationExceptionFilter } from './integration-exception.filter';
import {
    linkSourceOf,
    pinnedOrganizationOf,
    principalOf,
    validationFailed,
} from './integration-request';

/** `PutLink` (contract v1 requests.schema.json). */
export class IntegrationPutLinkDto {
    @ApiProperty({ minLength: 1, maxLength: 200 })
    @IsString()
    @Length(1, 200)
    externalId!: string;

    @ApiProperty({ required: false, format: 'uri', nullable: true, maxLength: 2048 })
    @IsOptional()
    @IsUrl({ require_tld: false })
    @MaxLength(2048)
    externalUrl?: string | null;

    @ApiProperty({ required: false, nullable: true, maxLength: 200 })
    @IsOptional()
    @IsString()
    @MaxLength(200)
    installationId?: string | null;
}

/**
 * External record links of this source in the `X-Scope-Slug` organization
 * (contract v1 B.6): `GET /links?entityType=&externalId=`, and
 * `PUT` / `DELETE /links/:entityType/:entityId`. `source` is the key's
 * (`ever-gauzy` → `gauzy`); the installation is the body's `installationId`,
 * else `X-Sync-Origin: <source>:<installationId>`.
 */
@ApiTags('Integrations API v1')
@Controller('api/integrations/v1')
@UseGuards(IntegrationOnlyGuard)
@UseFilters(IntegrationExceptionFilter)
export class IntegrationLinksController {
    constructor(
        private readonly links: ExternalRecordLinksService,
        private readonly scope: ScopeContextService,
        private readonly resources: IntegrationResourcesService,
    ) {}

    @Get('links')
    @RequireScopes('links:write')
    @ApiOperation({
        summary: "This source's external record links (filter by entityType / externalId)",
    })
    async list(
        @CurrentUser() user: AuthenticatedUser,
        @Query('entityType') entityType?: string,
        @Query('externalId') externalId?: string,
    ): Promise<{ data: ExternalRecordLinkDto[] }> {
        const principal = principalOf(user);
        if (entityType !== undefined) assertEntityType(entityType);
        const rows = await this.links.list(
            {
                organizationId: pinnedOrganizationOf(this.scope.getScope().organizationId),
                source: linkSourceOf(principal),
            },
            {
                entityType: entityType as ExternalLinkEntityType | undefined,
                externalId: externalId || undefined,
            },
        );
        // A link to a private record would still reveal it (ids, external URL).
        const visible = await this.resources.withoutPrivateTargets(rows);
        return { data: visible.map(toExternalRecordLinkDto) };
    }

    @Put('links/:entityType/:entityId')
    @RequireScopes('links:write')
    @ApiOperation({ summary: "Set a record's link for this source (create or move it)" })
    async put(
        @CurrentUser() user: AuthenticatedUser,
        @Param('entityType') entityType: string,
        @Param('entityId', ParseUUIDPipe) entityId: string,
        @Body() dto: IntegrationPutLinkDto,
        @Headers('x-sync-origin') syncOrigin: string | undefined,
    ): Promise<ExternalRecordLinkDto> {
        const principal = principalOf(user);
        const type = assertEntityType(entityType);
        const organizationId = pinnedOrganizationOf(this.scope.getScope().organizationId);
        const source = linkSourceOf(principal);
        if (!(await this.resources.assertLinkTarget(type, organizationId, entityId, source))) {
            throw validationFailed('entityType', `${type} records are not served by v1 yet`);
        }
        const row = await this.links.put(
            {
                organizationId,
                tenantId: principal.tenantId,
                source,
                installationId: installationFromOrigin(dto.installationId, syncOrigin, source),
                integrationKeyId: principal.keyId,
            },
            {
                entityType: type,
                entityId,
                externalId: dto.externalId,
                externalUrl: dto.externalUrl ?? null,
            },
        );
        return toExternalRecordLinkDto(row);
    }

    @Delete('links/:entityType/:entityId')
    @RequireScopes('links:write')
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiOperation({
        summary:
            "Remove a record's link for this source (every installation unless ?installationId=)",
    })
    async remove(
        @CurrentUser() user: AuthenticatedUser,
        @Param('entityType') entityType: string,
        @Param('entityId', ParseUUIDPipe) entityId: string,
        @Query('installationId') installationId?: string,
    ): Promise<void> {
        const principal = principalOf(user);
        await this.links.remove(
            {
                organizationId: pinnedOrganizationOf(this.scope.getScope().organizationId),
                source: linkSourceOf(principal),
                ...(installationId ? { installationId } : {}),
            },
            assertEntityType(entityType),
            entityId,
        );
    }
}

function assertEntityType(entityType: string): ExternalLinkEntityType {
    if (!(EXTERNAL_LINK_ENTITY_TYPES as readonly string[]).includes(entityType)) {
        throw validationFailed(
            'entityType',
            `must be one of ${EXTERNAL_LINK_ENTITY_TYPES.join(', ')}`,
        );
    }
    return entityType as ExternalLinkEntityType;
}
