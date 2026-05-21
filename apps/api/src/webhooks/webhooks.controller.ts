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
    UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsIn, IsOptional, IsString, IsUUID, IsUrl } from 'class-validator';
import { AuthSessionGuard } from '../auth/guards/auth-session.guard';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { WebhooksService, WebhookSubscriptionView } from './webhooks.service';
import { WebhooksDeliveriesService, WebhookDeliveryView } from './webhooks-deliveries.service';

class CreateWebhookSubscriptionDto {
    @IsUrl({ require_protocol: true, protocols: ['http', 'https'] })
    url: string;

    @IsOptional()
    @IsUUID()
    workId?: string;
}

class UpdateWebhookSubscriptionDto {
    @IsOptional()
    @IsIn(['paused', 'active'])
    status?: 'paused' | 'active';
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
 *  - URL must be http(s); javascript:/file:/data: rejected at DTO
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
    ): Promise<{ deliveries: WebhookDeliveryView[] }> {
        const deliveries = await this.deliveries.list(auth.userId);
        return { deliveries };
    }

    @Post('deliveries/:deliveryId/redeliver')
    @HttpCode(HttpStatus.ACCEPTED)
    @Throttle({ default: { limit: 10, ttl: 60_000 } })
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
    @ApiOperation({ summary: "List my account's active webhook subscriptions" })
    @ApiResponse({ status: 200, description: 'Array of subscription views (no secret material)' })
    async list(
        @CurrentUser() auth: AuthenticatedUser,
    ): Promise<{ subscriptions: WebhookSubscriptionView[] }> {
        const subscriptions = await this.webhooks.listForAccount(auth.userId);
        return { subscriptions };
    }

    @Post()
    @HttpCode(HttpStatus.CREATED)
    @Throttle({ default: { limit: 10, ttl: 60_000 } })
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
        return this.webhooks.create(auth.userId, { url: dto.url, workId: dto.workId });
    }

    @Patch(':id')
    @Throttle({ default: { limit: 20, ttl: 60_000 } })
    @ApiOperation({ summary: 'Pause / resume a subscription' })
    @ApiParam({ name: 'id', description: 'Subscription ID' })
    @ApiResponse({ status: 200, description: 'Updated subscription view' })
    @ApiResponse({ status: 404, description: 'Not found (or not yours)' })
    async update(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() dto: UpdateWebhookSubscriptionDto,
    ): Promise<WebhookSubscriptionView> {
        // Only `status` transitions are supported through this endpoint.
        // URL / workId changes require a fresh subscription so the
        // owner of the old endpoint receives a clear signal (delivery
        // stops) instead of a silent redirect.
        if (dto.status === 'paused') {
            return this.webhooks.pause(auth.userId, id);
        }
        if (dto.status === 'active') {
            // Resuming is a no-op for now since list-active only
            // returns 'active' rows; status transitions other than
            // pause require a follow-up endpoint. Surface as 400 to
            // avoid the silent no-op smell.
            throw new BadRequestException(
                'Resuming a paused subscription is not supported yet; recreate the subscription',
            );
        }
        throw new BadRequestException('status must be one of: paused');
    }

    @Post(':id/test')
    @HttpCode(HttpStatus.OK)
    @Throttle({ default: { limit: 5, ttl: 60_000 } })
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
    @Throttle({ default: { limit: 5, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Rotate the signing secret',
        description:
            'Generates a new HMAC signing secret. The previous secret is irretrievable after this call. Returns the new RAW secret ONCE.',
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
