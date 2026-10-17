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
    UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
    ArrayMaxSize,
    ArrayMinSize,
    IsArray,
    IsIn,
    IsOptional,
    IsString,
    IsUUID,
    IsUrl,
    MaxLength,
} from 'class-validator';
import { AuthSessionGuard } from '../auth/guards/auth-session.guard';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { WebhooksService, WebhookSubscriptionView } from './webhooks.service';
import { WebhooksDeliveriesService, WebhookDeliveryView } from './webhooks-deliveries.service';

// Security: webhook delivery payloads carry business-sensitive data (workId,
// names, deployment URLs, error details) and the HMAC signature provides
// integrity, NOT confidentiality. In non-local envs require https:// so the
// payload is never sent in cleartext over the wire. Plain http:// stays
// allowed in dev/test so devs can point at ngrok / webhook.site / a local
// tunnel. NODE_ENV is fixed at process start, so reading it at module load
// (the decorator runs once when the class is defined) is correct and matches
// the codebase convention (see main.ts / oauth.controller.ts cookie `secure`).
const WEBHOOK_URL_PROTOCOLS: string[] = (() => {
    const env = process.env.NODE_ENV;
    const isLocalEnv = env === 'development' || env === 'test' || env === undefined || env === '';
    return isLocalEnv ? ['http', 'https'] : ['https'];
})();

class CreateWebhookSubscriptionDto {
    @IsUrl({ require_protocol: true, protocols: WEBHOOK_URL_PROTOCOLS })
    url: string;

    @IsOptional()
    @IsUUID()
    workId?: string;

    // ── Webhooks v2 (EW-P1-5): `events` + `organizationIds` make a v2 subscription ──

    /** Catalog types, `<prefix>.*` or `*` (task.runtime_updated only by exact name). */
    @IsOptional()
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(200)
    @IsString({ each: true })
    @MaxLength(64, { each: true })
    events?: string[];

    @IsOptional()
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(50)
    @IsUUID('all', { each: true })
    organizationIds?: string[];

    /** Events whose `origin.tag` is listed are not delivered (loop guard). */
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(20)
    @IsString({ each: true })
    @MaxLength(100, { each: true })
    excludeOriginTags?: string[];

    @IsOptional()
    @IsString()
    @MaxLength(500)
    description?: string | null;
}

class UpdateWebhookSubscriptionDto {
    /** `paused` pauses, `active` resumes (and resets the failure streak). */
    @IsOptional()
    @IsIn(['paused', 'active'])
    status?: 'paused' | 'active';

    // v2 subscriptions only:

    @IsOptional()
    @IsUrl({ require_protocol: true, protocols: WEBHOOK_URL_PROTOCOLS })
    url?: string;

    @IsOptional()
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(200)
    @IsString({ each: true })
    @MaxLength(64, { each: true })
    events?: string[];

    @IsOptional()
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(50)
    @IsUUID('all', { each: true })
    organizationIds?: string[];

    @IsOptional()
    @IsArray()
    @ArrayMaxSize(20)
    @IsString({ each: true })
    @MaxLength(100, { each: true })
    excludeOriginTags?: string[];

    @IsOptional()
    @IsString()
    @MaxLength(500)
    description?: string | null;
}

/**
 * Outbound webhook subscriptions — `/api/webhooks`.
 *
 * Lets an authenticated user register HTTPS endpoints to receive
 * platform events (work generation done, item published, etc.) via
 * HMAC-SHA256 signed POSTs. The delivery worker (out of scope for
 * this controller) consumes the active rows.
 *
 * Security gates:
 *  - Global AuthSessionGuard (no @Public)
 *  - URL must be https:// outside dev/test (http:// allowed only in
 *    local envs); javascript:/file:/data: rejected at DTO
 *  - At-most-25 active subscriptions per account (in service layer)
 *  - The raw signing secret appears in the response ONCE on create /
 *    rotate — never readable again
 *  - Cross-account access surfaces as 404 (not 403) to avoid
 *    enumeration
 *  - Throttled tighter than the global cap because subscription
 *    spam is a credible abuse vector
 */
@ApiTags('Webhooks')
@ApiBearerAuth('JWT-auth')
@Controller('api/webhooks')
@UseGuards(AuthSessionGuard)
export class WebhooksController {
    constructor(
        private readonly webhooks: WebhooksService,
        private readonly deliveries: WebhooksDeliveriesService,
    ) {}

    /**
     * Deliveries listing comes BEFORE `/:id` routes so the literal
     * `/api/webhooks/deliveries` doesn't get caught by `ParseUUIDPipe`
     * on the subscription routes below.
     */
    @Get('deliveries')
    @ApiOperation({
        summary: "List recent outbound deliveries against this account's subscriptions",
    })
    @ApiResponse({ status: 200, description: 'Array of delivery views (most-recent first)' })
    async listDeliveries(
        @CurrentUser() auth: AuthenticatedUser,
        @Query('subscriptionId', new ParseUUIDPipe({ optional: true })) subscriptionId?: string,
        @Query('limit') limit?: string,
    ): Promise<{ deliveries: WebhookDeliveryView[] }> {
        // Optional filters (Settings > Webhooks shows one subscription's deliveries).
        const parsed = limit === undefined ? undefined : Number.parseInt(limit, 10);
        const deliveries = await this.deliveries.list(auth.userId, {
            subscriptionId,
            limit: Number.isFinite(parsed) ? parsed : undefined,
        });
        return { deliveries };
    }

    @Post('deliveries/:deliveryId/redeliver')
    @HttpCode(HttpStatus.ACCEPTED)
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Re-enqueue a previous delivery by id',
        description:
            'Creates a fresh delivery row reusing the original payload + subscription. Returns the new delivery id and (when Trigger.dev is configured) the run id.',
    })
    @ApiParam({ name: 'deliveryId', description: 'Original webhook delivery id' })
    @ApiResponse({ status: 202, description: 'Redelivery enqueued' })
    @ApiResponse({ status: 404, description: 'Delivery not found (or not yours)' })
    async redeliver(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('deliveryId', ParseUUIDPipe) deliveryId: string,
    ) {
        return this.deliveries.redeliver(auth.userId, deliveryId);
    }

    @Get()
    @ApiOperation({
        summary: "List my account's webhook subscriptions (active, paused, failed or disabled)",
    })
    @ApiResponse({ status: 200, description: 'Array of subscription views (no secret material)' })
    async list(
        @CurrentUser() auth: AuthenticatedUser,
    ): Promise<{ subscriptions: WebhookSubscriptionView[] }> {
        const subscriptions = await this.webhooks.listForAccount(auth.userId);
        return { subscriptions };
    }

    @Post()
    @HttpCode(HttpStatus.CREATED)
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Create a webhook subscription',
        description:
            'Returns the subscription view plus the RAW signing secret. The secret is returned ONLY in this response — store it immediately.',
    })
    @ApiResponse({ status: 201, description: 'Subscription created; signingSecret returned once' })
    @ApiResponse({ status: 400, description: 'Validation failed (bad URL, at limit)' })
    async create(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() dto: CreateWebhookSubscriptionDto,
    ) {
        // Webhooks v2 (EW-P1-5): `events` + `organizationIds` subscribe to domain
        // events of those organizations; without them this is a v1 subscription.
        if (dto.events !== undefined || dto.organizationIds !== undefined) {
            if (!dto.events?.length || !dto.organizationIds?.length) {
                throw new BadRequestException(
                    'A v2 subscription needs both events and organizationIds',
                );
            }
            if (dto.workId) {
                throw new BadRequestException(
                    'workId applies to v1 subscriptions only; v2 subscriptions scope by organizationIds',
                );
            }
            return this.webhooks.createV2(auth.userId, {
                url: dto.url,
                events: dto.events,
                organizationIds: dto.organizationIds,
                excludeOriginTags: dto.excludeOriginTags,
                description: dto.description ?? null,
            });
        }
        return this.webhooks.create(auth.userId, { url: dto.url, workId: dto.workId });
    }

    @Patch(':id')
    @Throttle({ long: { limit: 20, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Pause / resume a subscription; change a v2 subscription',
        description:
            '`status: paused` pauses and `status: active` resumes (resetting the failure streak). `url`, `events`, `organizationIds`, `excludeOriginTags` and `description` change a v2 subscription only.',
    })
    @ApiParam({ name: 'id', description: 'Subscription ID' })
    @ApiResponse({ status: 200, description: 'Updated subscription view' })
    @ApiResponse({ status: 404, description: 'Not found (or not yours)' })
    async update(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() dto: UpdateWebhookSubscriptionDto,
    ): Promise<WebhookSubscriptionView> {
        // A v1 subscription changes only its status: URL / workId changes need a
        // fresh subscription, so the owner of the old endpoint gets a clear
        // signal (delivery stops) instead of a silent redirect. A v2 subscription
        // also takes url / events / organizationIds / excludeOriginTags /
        // description (integration contract v1 B.5, UpdateWebhook).
        const keys = Object.keys(dto).filter(
            (key) => (dto as Record<string, unknown>)[key] !== undefined,
        );
        if (keys.length === 0) {
            throw new BadRequestException('Nothing to update');
        }
        return this.webhooks.update(auth.userId, id, dto);
    }

    @Post(':id/test')
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 5, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Synchronously fire a test webhook to verify the URL',
        description:
            "POSTs a `webhook.test` event with the signed-body shape the customer's receiver will see in production. Returns the delivery outcome inline so the customer can verify before plugging into CI. Records the attempt in the deliveries log.",
    })
    @ApiParam({ name: 'id', description: 'Subscription ID' })
    @ApiResponse({ status: 200, description: 'Inline delivery result' })
    @ApiResponse({ status: 404, description: 'Subscription not found (or not yours)' })
    async testFire(@CurrentUser() auth: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
        return this.deliveries.testFire(auth.userId, id);
    }

    @Post(':id/rotate-secret')
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 5, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Rotate the signing secret',
        description:
            'Generates a new HMAC signing secret and returns the RAW secret ONCE. v1: the previous secret stops at once. v2: the previous secret keeps signing as a second `v1=` in `X-Ever-Works-Signature` for the grace window (WEBHOOK_SECRET_ROTATION_GRACE_HOURS, default 24 h).',
    })
    @ApiParam({ name: 'id', description: 'Subscription ID' })
    @ApiResponse({ status: 200, description: 'New signingSecret returned once' })
    async rotateSecret(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ) {
        return this.webhooks.rotateSecret(auth.userId, id);
    }

    @Delete(':id')
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiOperation({ summary: 'Delete a subscription (irreversible)' })
    @ApiParam({ name: 'id', description: 'Subscription ID' })
    @ApiResponse({ status: 204, description: 'Deleted' })
    @ApiResponse({ status: 404, description: 'Not found (or not yours)' })
    async remove(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<void> {
        await this.webhooks.remove(auth.userId, id);
    }
}

// Suppress unused import lint warning — class-validator only runs at runtime.
void IsString;
