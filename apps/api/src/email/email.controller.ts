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
    UseGuards,
    HttpCode,
    HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
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
        @Req() req: Request,
        @Headers() headers: Record<string, string>,
    ) {
        const rawBody = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
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
    async eventsWebhook(@Param('pluginId') pluginId: string) {
        // Per spec §7: events go through the facade's parseEventWebhook
        // hook on the inbound plugin; for now we accept + return 202 so
        // providers stop retrying while the full impl lands.
        return { received: true, pluginId };
    }
}
