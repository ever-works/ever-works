import {
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
    UseFilters,
    UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import {
    ArrayMaxSize,
    ArrayMinSize,
    IsArray,
    IsIn,
    IsOptional,
    IsString,
    IsUrl,
    IsUUID,
    MaxLength,
} from 'class-validator';
import { CurrentUser } from '../../auth/decorators/user.decorator';
import type { AuthenticatedUser, IntegrationPrincipal } from '../../auth/types/auth.types';
import {
    IntegrationOrgOptional,
    RequireScopes,
} from '../../auth/integration/integration.decorators';
import { IntegrationHttpException } from '../../auth/integration/integration-http.exception';
import { WebhooksDeliveriesService } from '../../webhooks/webhooks-deliveries.service';
import { WebhooksService, type WebhookSubscriptionView } from '../../webhooks/webhooks.service';
import { IntegrationOnlyGuard } from './integration-only.guard';
import { IntegrationExceptionFilter } from './integration-exception.filter';
import { principalOf, validationFailed } from './integration-request';

/** `CreateWebhook` (contract v1 requests.schema.json). */
export class IntegrationCreateWebhookDto {
    @ApiProperty({ format: 'uri', maxLength: 2048 })
    @IsUrl({ require_tld: false, protocols: ['http', 'https'] })
    @MaxLength(2048)
    url!: string;

    @ApiProperty({ type: [String], minItems: 1, maxItems: 200 })
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(200)
    @IsString({ each: true })
    @MaxLength(64, { each: true })
    events!: string[];

    @ApiProperty({ type: [String], format: 'uuid', minItems: 1 })
    @IsArray()
    @ArrayMinSize(1)
    @IsUUID('all', { each: true })
    organizationIds!: string[];

    @ApiProperty({ required: false, type: [String], maxItems: 20 })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(20)
    @IsString({ each: true })
    @MaxLength(100, { each: true })
    excludeOriginTags?: string[];

    @ApiProperty({ required: false, nullable: true, maxLength: 500 })
    @IsOptional()
    @IsString()
    @MaxLength(500)
    description?: string | null;
}

/** `UpdateWebhook` (contract v1 requests.schema.json). */
export class IntegrationUpdateWebhookDto {
    @ApiProperty({ required: false, format: 'uri', maxLength: 2048 })
    @IsOptional()
    @IsUrl({ require_tld: false, protocols: ['http', 'https'] })
    @MaxLength(2048)
    url?: string;

    @ApiProperty({ required: false, type: [String], minItems: 1, maxItems: 200 })
    @IsOptional()
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(200)
    @IsString({ each: true })
    @MaxLength(64, { each: true })
    events?: string[];

    @ApiProperty({ required: false, type: [String], format: 'uuid', minItems: 1 })
    @IsOptional()
    @IsArray()
    @ArrayMinSize(1)
    @IsUUID('all', { each: true })
    organizationIds?: string[];

    @ApiProperty({ required: false, type: [String], maxItems: 20 })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(20)
    @IsString({ each: true })
    @MaxLength(100, { each: true })
    excludeOriginTags?: string[];

    @ApiProperty({ required: false, nullable: true, maxLength: 500 })
    @IsOptional()
    @IsString()
    @MaxLength(500)
    description?: string | null;

    @ApiProperty({ required: false, enum: ['active', 'paused'] })
    @IsOptional()
    @IsIn(['active', 'paused'])
    status?: 'active' | 'paused';
}

/** Contract v1 `webhook-subscription.schema.json` (`secret` only on create / rotate). */
export interface IntegrationWebhookDto {
    id: string;
    url: string;
    description: string | null;
    events: string[];
    organizationIds: string[];
    excludeOriginTags: string[];
    status: WebhookSubscriptionView['status'];
    version: 2;
    consecutiveFailures: number;
    lastDeliveryAt: string | null;
    createdAt: string;
    updatedAt: string;
    secret?: string;
}

export function toIntegrationWebhookDto(
    view: WebhookSubscriptionView,
    secret?: string,
): IntegrationWebhookDto {
    const dto: IntegrationWebhookDto = {
        id: view.id,
        url: view.url,
        description: view.description ?? null,
        events: view.events ?? [],
        organizationIds: view.organizationIds ?? [],
        excludeOriginTags: view.excludeOriginTags ?? [],
        status: view.status,
        version: 2,
        consecutiveFailures: view.consecutiveFailures,
        lastDeliveryAt: view.lastDeliveryAt ? new Date(view.lastDeliveryAt).toISOString() : null,
        createdAt: new Date(view.createdAt).toISOString(),
        updatedAt: new Date(view.updatedAt).toISOString(),
    };
    if (secret) dto.secret = secret;
    return dto;
}

/**
 * Webhooks v2 for integration keys — `/api/integrations/v1/webhooks`
 * (EW-P1-5, contract v1 B.5). A subscription created here is OWNED BY THE KEY
 * (`ownerType: integration_key`): it may name only the key's pinned
 * organizations, only this key sees and changes it, and it is disabled when
 * the key is revoked. The account is the key's owner, so the per-account
 * limit and the organization access rules are the same as in Settings.
 */
@ApiTags('Integrations API v1')
@Controller('api/integrations/v1/webhooks')
@UseGuards(IntegrationOnlyGuard)
@UseFilters(IntegrationExceptionFilter)
export class IntegrationWebhooksController {
    constructor(
        private readonly webhooks: WebhooksService,
        private readonly deliveries: WebhooksDeliveriesService,
    ) {}

    @Get()
    @RequireScopes('webhooks:manage')
    @IntegrationOrgOptional()
    @ApiOperation({ summary: "This key's webhook subscriptions" })
    async list(@CurrentUser() user: AuthenticatedUser): Promise<{ data: IntegrationWebhookDto[] }> {
        const principal = principalOf(user);
        const rows = await this.webhooks.listForOwner(principal.ownerUserId, ownerOf(principal));
        return { data: rows.map((row) => toIntegrationWebhookDto(row)) };
    }

    @Post()
    // Review 2026-10-17 F12: a subscription delivers the change feed, so it needs the
    // feed's own scope too (`GET /events` answers 403 scope_missing without it).
    @RequireScopes('webhooks:manage', 'events:read')
    @IntegrationOrgOptional()
    @HttpCode(HttpStatus.CREATED)
    @ApiOperation({ summary: 'Subscribe to domain events (the secret is returned once)' })
    async create(
        @CurrentUser() user: AuthenticatedUser,
        @Body() dto: IntegrationCreateWebhookDto,
    ): Promise<IntegrationWebhookDto> {
        const principal = principalOf(user);
        assertPinned(principal, dto.organizationIds);
        const { subscription, signingSecret } = await this.webhooks.createV2(
            principal.ownerUserId,
            {
                url: dto.url,
                events: dto.events,
                organizationIds: dto.organizationIds,
                excludeOriginTags: dto.excludeOriginTags,
                description: dto.description ?? null,
            },
            ownerOf(principal),
        );
        return toIntegrationWebhookDto(subscription, signingSecret);
    }

    @Patch(':id')
    @RequireScopes('webhooks:manage', 'events:read')
    @IntegrationOrgOptional()
    @ApiOperation({
        summary: 'Change, pause (status: paused) or resume (status: active) a subscription',
    })
    async update(
        @CurrentUser() user: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() dto: IntegrationUpdateWebhookDto,
    ): Promise<IntegrationWebhookDto> {
        const principal = principalOf(user);
        if (Object.keys(dto).length === 0) {
            throw validationFailed('body', 'must change at least one field');
        }
        if (dto.organizationIds) assertPinned(principal, dto.organizationIds);
        await this.webhooks.findOwnedBy(principal.ownerUserId, id, ownerOf(principal));
        return toIntegrationWebhookDto(await this.webhooks.update(principal.ownerUserId, id, dto));
    }

    @Post(':id/rotate-secret')
    @RequireScopes('webhooks:manage')
    @IntegrationOrgOptional()
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary:
            'Rotate the signing secret (returned once; the previous one keeps signing for the grace window)',
    })
    async rotate(
        @CurrentUser() user: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<IntegrationWebhookDto> {
        const principal = principalOf(user);
        await this.webhooks.findOwnedBy(principal.ownerUserId, id, ownerOf(principal));
        const { subscription, signingSecret } = await this.webhooks.rotateSecret(
            principal.ownerUserId,
            id,
        );
        return toIntegrationWebhookDto(subscription, signingSecret);
    }

    @Post(':id/test')
    @RequireScopes('webhooks:manage')
    @IntegrationOrgOptional()
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Send a signed test event to the subscription now' })
    async test(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
        const principal = principalOf(user);
        await this.webhooks.findOwnedBy(principal.ownerUserId, id, ownerOf(principal));
        return this.deliveries.testFire(principal.ownerUserId, id);
    }

    @Delete(':id')
    @RequireScopes('webhooks:manage')
    @IntegrationOrgOptional()
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiOperation({ summary: 'Delete a subscription' })
    async remove(
        @CurrentUser() user: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<void> {
        const principal = principalOf(user);
        await this.webhooks.findOwnedBy(principal.ownerUserId, id, ownerOf(principal));
        await this.webhooks.remove(principal.ownerUserId, id);
    }
}

function ownerOf(principal: IntegrationPrincipal): { type: 'integration_key'; id: string } {
    return { type: 'integration_key', id: principal.keyId };
}

/** A key subscribes only to organizations it is pinned to (`403 org_not_pinned`). */
function assertPinned(principal: IntegrationPrincipal, organizationIds: readonly string[]): void {
    const pinned = new Set(principal.allowedOrganizationIds);
    const outside = organizationIds.filter((id) => !pinned.has(id));
    if (outside.length > 0) {
        throw new IntegrationHttpException(
            403,
            'org_not_pinned',
            'A webhook may name only the organizations this key is pinned to.',
            { organizationIds: outside },
        );
    }
}
