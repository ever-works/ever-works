import {
    BadRequestException,
    Body,
    Controller,
    Delete,
    Get,
    Headers,
    HttpCode,
    HttpStatus,
    NotFoundException,
    Param,
    ParseUUIDPipe,
    Post,
    Req,
    UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AuthSessionGuard, CurrentUser } from '../../auth';
import { Public } from '@src/auth/decorators/public.decorator';
import type { AuthenticatedUser } from '@src/auth/types/auth.types';
import { ComposioTriggersService } from './composio-triggers.service';
import { ComposioService } from '../composio/composio.service';
import {
    ComposioTriggerDto,
    ComposioTriggerListDto,
    CreateComposioTriggerDto,
} from './dto/composio-trigger.dto';
import type { ComposioTriggerSubscription } from '@ever-works/agent/entities';

@ApiTags('Composio Triggers')
@Controller('api/plugins/composio')
export class ComposioTriggersController {
    constructor(
        private readonly triggers: ComposioTriggersService,
        private readonly composio: ComposioService,
    ) {}

    @Get('triggers')
    @ApiBearerAuth('JWT-auth')
    @UseGuards(AuthSessionGuard)
    @ApiOperation({ summary: "List the caller's Composio triggers" })
    @ApiResponse({ status: 200, type: ComposioTriggerListDto })
    async list(@CurrentUser() auth: AuthenticatedUser): Promise<ComposioTriggerListDto> {
        const rows = await this.triggers.list(auth.userId);
        return { items: rows.map((row) => toDto(row)) };
    }

    @Post('triggers')
    @ApiBearerAuth('JWT-auth')
    @UseGuards(AuthSessionGuard)
    @HttpCode(HttpStatus.CREATED)
    @ApiOperation({
        summary: 'Create a Composio trigger subscription',
        description:
            'Enables the trigger upstream on Composio (`triggers.create` via the official SDK) and stores the subscription keyed by the returned `tg_*` id. Composio signs inbound deliveries with the project webhook secret (configured under Settings → Plugins → Composio), which the `/webhook` endpoint verifies via the SDK.',
    })
    @ApiResponse({ status: 201, type: ComposioTriggerDto })
    async create(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: CreateComposioTriggerDto,
    ): Promise<ComposioTriggerDto> {
        // Enable the trigger upstream on Composio first, then persist the
        // row keyed by the real `tg_*` id so webhook deliveries (which
        // carry that id) resolve back to this subscription.
        const { triggerId } = await this.composio.createTrigger(auth.userId, {
            triggerSlug: body.triggerSlug,
            connectedAccountId: body.composioConnectedAccountId,
            config: body.config ?? undefined,
        });
        const row = await this.triggers.create(auth.userId, triggerId, body);
        return toDto(row);
    }

    @Delete('triggers/:id')
    @ApiBearerAuth('JWT-auth')
    @UseGuards(AuthSessionGuard)
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiOperation({ summary: 'Delete a Composio trigger subscription' })
    async remove(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', new ParseUUIDPipe()) id: string,
    ): Promise<void> {
        const composioTriggerId = await this.triggers.remove(auth.userId, id);
        // Best-effort upstream teardown — the local row is already gone; a
        // failed upstream delete (e.g. trigger already removed) is logged
        // and swallowed inside the service.
        if (composioTriggerId) {
            await this.composio.deleteTrigger(auth.userId, composioTriggerId);
        }
    }

    @Public()
    @Post('webhook')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Composio webhook receiver',
        description:
            'Inbound Composio webhook deliveries land here. The handler resolves the subscription by the `tg_*` trigger id in the payload, then verifies the delivery via the official Composio SDK (`triggers.verifyWebhook`) using the project webhook secret + the `webhook-id` / `webhook-signature` / `webhook-timestamp` headers. Returns 200 on accept so Composio does not retry; 401 when verification fails, 404 for an unknown trigger.',
    })
    async webhook(
        @Req() req: { rawBody?: string },
        @Body() body: ComposioWebhookPayload,
        @Headers() headers: Record<string, string>,
    ): Promise<{ ok: true }> {
        const triggerId = extractComposioTriggerId(body);
        if (!triggerId) {
            throw new BadRequestException('Missing trigger id in webhook payload');
        }
        if (!req.rawBody) {
            throw new BadRequestException('Missing raw webhook payload');
        }

        const subscription = await this.triggers.findByComposioTriggerId(triggerId);
        if (!subscription) {
            // Hide trigger existence — return 404 without a body. Composio
            // treats 4xx as a permanent failure and will not retry.
            throw new NotFoundException();
        }

        try {
            // Verify against the OWNING user's project webhook secret — the
            // webhook is @Public(), so the user is resolved from the trigger
            // id, not an auth token. Fails closed when no secret is set.
            await this.composio.verifyWebhook(subscription.userId, {
                id: headers['webhook-id'] ?? '',
                rawBody: req.rawBody,
                signature: headers['webhook-signature'] ?? '',
                timestamp: headers['webhook-timestamp'] ?? '',
            });
        } catch (error) {
            await this.triggers.recordDelivery(subscription.id, 'rejected');
            throw error;
        }

        await this.triggers.recordDelivery(subscription.id, 'accepted');
        // Hand-off to downstream fanout happens in a follow-up PR. For now
        // the row's `lastFiredAt` + `deliveriesReceived` counters give the
        // UI enough to render an "active" state.
        return { ok: true };
    }
}

interface ComposioWebhookPayload {
    trigger_id?: string;
    triggerId?: string;
    metadata?: { trigger_id?: string };
    [key: string]: unknown;
}

/**
 * Extract the `tg_*` trigger id from a Composio webhook payload. V3
 * nests it under `metadata.trigger_id`; legacy V1/V2 carry it top-level
 * as `trigger_id` / `triggerId`.
 */
function extractComposioTriggerId(body: ComposioWebhookPayload | undefined): string | undefined {
    const candidate = body?.metadata?.trigger_id ?? body?.trigger_id ?? body?.triggerId;
    return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined;
}

function toDto(row: ComposioTriggerSubscription): ComposioTriggerDto {
    return {
        id: row.id,
        toolkitSlug: row.toolkitSlug,
        triggerSlug: row.triggerSlug,
        composioTriggerId: row.composioTriggerId,
        composioConnectedAccountId: row.composioConnectedAccountId,
        enabled: row.enabled,
        deliveriesReceived: row.deliveriesReceived,
        deliveriesRejected: row.deliveriesRejected,
        lastFiredAt: row.lastFiredAt ? row.lastFiredAt.toISOString() : null,
        createdAt: row.createdAt.toISOString(),
    };
}
