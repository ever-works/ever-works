import {
    Body,
    Controller,
    Delete,
    Get,
    Headers,
    Inject,
    Optional,
    Param,
    Patch,
    Post,
    Query,
    Req,
    Res,
    UseGuards,
    HttpCode,
    HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { EmailFacadeService } from '@ever-works/agent/facades';
import {
    AGENT_INBOUND_EMAIL_DISPATCHER,
    type AgentInboundEmailDispatcher,
} from '@ever-works/agent/notifications';
import type { EmailAddressDirection } from '@ever-works/agent/entities';
import { CurrentUser, AuthSessionGuard, Public } from '../auth';
import { AuthenticatedUser } from '@src/auth/types/auth.types';
import {
    EmailService,
    CreateEmailAddressInput,
    UpdateEmailAddressInput,
    SendMessageInput,
} from './email.service';

/**
 * Minimal Response/Request surfaces for the SSE inbox stream + inbound
 * webhook. Mirrors the convention in usage.controller.ts /
 * openai-compat.controller.ts — avoids pulling the full
 * `import('express').Response` / `Request` type (not in the api tsconfig).
 */
type SseResponse = {
    setHeader(name: string, value: string): void;
    flushHeaders?(): void;
    write(chunk: string): void;
    on(event: 'close', listener: () => void): void;
};

type SseRequest = {
    on(event: 'close', listener: () => void): void;
};

type WebhookRequest = {
    body?: unknown;
    rawBody?: Buffer;
};

/**
 * EW-650 / EW-669 — Email surface REST API.
 *
 * Authenticated tenant-address CRUD + public webhook ingestion. Webhook
 * routes are rate-limited per plugin id (default 600/min) and require
 * the plugin's webhook-signature verification to pass.
 */
@ApiTags('Email')
@Controller('api/email')
export class EmailController {
    constructor(
        private readonly emailService: EmailService,
        private readonly emailFacade: EmailFacadeService,
        @Optional()
        @Inject(AGENT_INBOUND_EMAIL_DISPATCHER)
        private readonly inboundDispatcher?: AgentInboundEmailDispatcher,
    ) {}

    // -------------------------------------------------------------
    // Authenticated tenant-address CRUD
    // -------------------------------------------------------------

    @UseGuards(AuthSessionGuard)
    @ApiBearerAuth('JWT-auth')
    @Get('addresses')
    @ApiOperation({ summary: 'List tenant email addresses' })
    async listAddresses(
        @CurrentUser() auth: AuthenticatedUser,
        @Query('direction') direction?: EmailAddressDirection,
    ) {
        const addresses = await this.emailService.listAddresses(auth.userId, direction);
        return { addresses };
    }

    @UseGuards(AuthSessionGuard)
    @ApiBearerAuth('JWT-auth')
    @Post('addresses')
    @HttpCode(HttpStatus.CREATED)
    @ApiOperation({ summary: 'Register a new tenant email address' })
    async createAddress(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: CreateEmailAddressInput,
    ) {
        const address = await this.emailService.createAddress(auth.userId, body);
        return { address };
    }

    @UseGuards(AuthSessionGuard)
    @ApiBearerAuth('JWT-auth')
    @Patch('addresses/:id')
    @ApiOperation({ summary: 'Update a tenant email address' })
    async updateAddress(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Body() body: UpdateEmailAddressInput,
    ) {
        const address = await this.emailService.updateAddress(auth.userId, id, body);
        return { address };
    }

    @UseGuards(AuthSessionGuard)
    @ApiBearerAuth('JWT-auth')
    @Delete('addresses/:id')
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiOperation({ summary: 'Delete a tenant email address' })
    async deleteAddress(@CurrentUser() auth: AuthenticatedUser, @Param('id') id: string) {
        await this.emailService.deleteAddress(auth.userId, id);
    }

    @UseGuards(AuthSessionGuard)
    @ApiBearerAuth('JWT-auth')
    @Post('addresses/:id/verify')
    @ApiOperation({ summary: 'Trigger verification email for an address' })
    async triggerVerification(@CurrentUser() auth: AuthenticatedUser, @Param('id') id: string) {
        return this.emailService.triggerVerification(auth.userId, id);
    }

    @UseGuards(AuthSessionGuard)
    @ApiBearerAuth('JWT-auth')
    @Get('messages')
    @ApiOperation({ summary: 'List email messages (filterable by agent)' })
    async listMessages(
        @CurrentUser() auth: AuthenticatedUser,
        @Query('agentId') agentId: string,
        @Query('limit') limit = '50',
        @Query('offset') offset = '0',
    ) {
        const messages = await this.emailService.listMessagesForAgent(
            auth.userId,
            agentId,
            Number.parseInt(limit, 10),
            Number.parseInt(offset, 10),
        );
        return { messages };
    }

    /**
     * EW-681 / T34 — Server-Sent-Events stream of new inbound messages
     * for an agent. Poll-based (no Redis pub/sub infra): every 5s the
     * handler diffs the agent's recent messages against the ids already
     * sent on this connection and emits the new ones as `message`
     * events; a heartbeat comment keeps the connection alive. The client
     * `useInboxStream` hook calls the inbox hook's `mutate()` on each
     * event. Declared BEFORE `messages/:id` so `:id` doesn't capture
     * "stream".
     */
    @UseGuards(AuthSessionGuard)
    @ApiBearerAuth('JWT-auth')
    @Get('messages/stream')
    @ApiOperation({ summary: 'SSE stream of new inbound messages for an agent' })
    async streamMessages(
        @CurrentUser() auth: AuthenticatedUser,
        @Query('agentId') agentId: string,
        @Res() res: SseResponse,
        @Req() req: SseRequest,
    ): Promise<void> {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders?.();

        const seen = new Set<string>();
        let closed = false;
        let primed = false;

        const poll = async () => {
            if (closed) return;
            try {
                const rows = (await this.emailService.listMessagesForAgent(
                    auth.userId,
                    agentId,
                    50,
                    0,
                )) as { id: string }[];
                for (const row of rows) {
                    if (!seen.has(row.id)) {
                        seen.add(row.id);
                        // Skip the very first poll's backlog from being
                        // announced as "new" — only emit on subsequent diffs.
                        if (primed) {
                            res.write(`event: message\ndata: ${JSON.stringify(row)}\n\n`);
                        }
                    }
                }
                primed = true;
            } catch {
                // Swallow — the heartbeat keeps the stream open; the client
                // falls back to polling if the connection drops.
            }
        };

        await poll(); // prime the seen-set with the current backlog
        const pollTimer = setInterval(() => void poll(), 5000);
        const heartbeat = setInterval(() => {
            if (!closed) res.write(': ping\n\n');
        }, 15000);

        const cleanup = () => {
            closed = true;
            clearInterval(pollTimer);
            clearInterval(heartbeat);
        };
        req.on('close', cleanup);
        res.on('close', cleanup);
    }

    @UseGuards(AuthSessionGuard)
    @ApiBearerAuth('JWT-auth')
    @Get('messages/:id')
    @ApiOperation({ summary: 'Get a single email message by id' })
    async getMessage(@CurrentUser() auth: AuthenticatedUser, @Param('id') id: string) {
        const message = await this.emailService.getMessage(auth.userId, id);
        return { message };
    }

    @UseGuards(AuthSessionGuard)
    @ApiBearerAuth('JWT-auth')
    @Post('messages')
    @HttpCode(HttpStatus.CREATED)
    @ApiOperation({ summary: 'Compose + send an email from an agent outbound address' })
    async sendMessage(@CurrentUser() auth: AuthenticatedUser, @Body() body: SendMessageInput) {
        const result = await this.emailService.sendMessage(auth.userId, body);
        return { result };
    }

    // -------------------------------------------------------------
    // Public — address verification click-through
    // -------------------------------------------------------------

    @Public()
    @Get('verify/:token')
    @ApiOperation({ summary: 'Confirm an email address via verification token' })
    async confirmVerification(@Param('token') token: string) {
        return this.emailService.confirmVerification(token);
    }

    // -------------------------------------------------------------
    // Public — provider webhooks (signature-verified)
    // -------------------------------------------------------------

    @Public()
    @Post('inbound/:pluginId')
    @Throttle({ default: { ttl: 60_000, limit: 600 } })
    @HttpCode(HttpStatus.ACCEPTED)
    @ApiOperation({ summary: 'Provider inbound-email webhook' })
    async inboundWebhook(
        @Param('pluginId') pluginId: string,
        @Req() req: WebhookRequest,
        @Headers() headers: Record<string, string>,
    ) {
        const rawBody = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
        const message = await this.emailFacade.parseInbound(pluginId, rawBody, headers);

        // EW-670 / T25 — route the parsed inbound message to the agent
        // inbound dispatcher (resolves the destination agent + dispatch
        // mode, persists the email_messages row, spawns a task or appends
        // to a conversation). Optional: when the token isn't bound the
        // webhook still acks so the provider stops retrying.
        let dispatch: { handled: boolean; agentId?: string; mode?: string } | undefined;
        if (this.inboundDispatcher) {
            dispatch = await this.inboundDispatcher.dispatch({
                pluginId,
                providerMessageId: message.providerMessageId,
                from: message.from,
                to: [...message.to],
                subject: message.subject,
                bodyText: message.bodyText,
                bodyHtml: message.bodyHtml,
                receivedAt: message.receivedAt,
            });
        }

        return {
            received: true,
            providerMessageId: message.providerMessageId,
            handled: dispatch?.handled ?? false,
            agentId: dispatch?.agentId,
            mode: dispatch?.mode,
        };
    }

    @Public()
    @Post('events/:pluginId')
    @Throttle({ default: { ttl: 60_000, limit: 600 } })
    @HttpCode(HttpStatus.ACCEPTED)
    @ApiOperation({ summary: 'Provider delivery-event webhook (bounces, opens, clicks)' })
    async eventsWebhook(
        @Param('pluginId') pluginId: string,
        @Req() req: WebhookRequest,
        @Headers() headers: Record<string, string>,
    ) {
        const rawBody = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
        // Verify + decode the provider delivery-event payload, then fold
        // each event's outcome onto the matching email_messages row
        // (latest-status-wins). Always 202s so the provider stops
        // retrying; a signature failure throws (mapped to 401 by the
        // plugin's verifyWebhookSignature).
        const events = await this.emailFacade.parseEventWebhook(pluginId, rawBody, headers);
        const recorded = await this.emailFacade.recordDeliveryEvents(pluginId, events);
        return { received: true, pluginId, events: events.length, recorded };
    }
}
