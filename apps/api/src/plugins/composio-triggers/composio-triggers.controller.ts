import { randomUUID } from 'node:crypto';
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
import {
    ComposioTriggerDto,
    ComposioTriggerListDto,
    CreateComposioTriggerDto,
} from './dto/composio-trigger.dto';
import type { ComposioTriggerSubscription } from '@ever-works/agent/entities';

@ApiTags('Composio Triggers')
@Controller('api/plugins/composio')
export class ComposioTriggersController {
    constructor(private readonly triggers: ComposioTriggersService) {}

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
            "Allocates a server-generated HMAC secret and stores the subscription. The created `webhookSecret` is returned in the response **once** — store it client-side if you need to register the same trigger on a different platform. Subsequent GETs never include it. (Follow-up PR will also call Composio's `POST /triggers` to enable the trigger upstream and persist the returned `tg_*` id.)",
    })
    @ApiResponse({ status: 201, type: ComposioTriggerDto })
    async create(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: CreateComposioTriggerDto,
    ): Promise<ComposioTriggerDto> {
        // Until the upstream Composio enable-trigger call is wired,
        // we mint a placeholder composioTriggerId so the row is uniquely
        // queryable. Once enabled, this is replaced with the real
        // `tg_*` returned by Composio in the same transaction.
        const placeholderTriggerId = `local_${randomUUID()}`;
        const row = await this.triggers.create(auth.userId, placeholderTriggerId, body);
        return { ...toDto(row), webhookSecret: row.webhookSecret };
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
        await this.triggers.remove(auth.userId, id);
    }

    @Public()
    @Post('webhook')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Composio webhook receiver',
        description:
            'Inbound Composio webhook deliveries land here. Composio signs the JSON body with HMAC-SHA256 of the per-subscription secret; the digest arrives as `x-composio-signature`. The handler resolves the subscription by the `tg_*` trigger id in the payload, verifies the signature in constant time, and records the outcome. Returns 200 even on no-op outcomes so Composio does not retry; 401 only when signature verification fails.',
    })
    async webhook(
        @Req() req: { rawBody?: string },
        @Body() body: ComposioWebhookPayload,
        @Headers('x-composio-signature') signature: string | undefined,
    ): Promise<{ ok: true }> {
        const triggerId = body?.trigger_id ?? body?.triggerId;
        if (!triggerId || typeof triggerId !== 'string') {
            throw new BadRequestException('Missing trigger_id in webhook payload');
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
            this.triggers.verifyDelivery(subscription, req.rawBody, signature);
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
    [key: string]: unknown;
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
