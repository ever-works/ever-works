import {
    Body,
    Controller,
    Delete,
    Get,
    Headers,
    Param,
    Patch,
    Post,
    Req,
    UseGuards,
    HttpCode,
    HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { CurrentUser, AuthSessionGuard, Public } from '../auth';
import { AuthenticatedUser } from '@src/auth/types/auth.types';
import {
    NotificationChannelsService,
    CreateChannelInput,
    UpdateChannelInput,
} from './notification-channels.service';

/**
 * EW-663 / EW-673 — Notification channel REST API.
 */
@ApiTags('Notification Channels')
@Controller('api/notification-channels')
export class NotificationChannelsController {
    constructor(private readonly service: NotificationChannelsService) {}

    @UseGuards(AuthSessionGuard)
    @ApiBearerAuth('JWT-auth')
    @Get()
    @ApiOperation({ summary: 'List my notification channels' })
    async list(@CurrentUser() auth: AuthenticatedUser) {
        const channels = await this.service.list(auth.userId);
        return { channels };
    }

    @UseGuards(AuthSessionGuard)
    @ApiBearerAuth('JWT-auth')
    @Post()
    @HttpCode(HttpStatus.CREATED)
    @ApiOperation({ summary: 'Add a notification channel' })
    async create(@CurrentUser() auth: AuthenticatedUser, @Body() body: CreateChannelInput) {
        const channel = await this.service.create(auth.userId, body);
        return { channel };
    }

    @UseGuards(AuthSessionGuard)
    @ApiBearerAuth('JWT-auth')
    @Patch(':id')
    @ApiOperation({ summary: 'Update a notification channel' })
    async update(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Body() body: UpdateChannelInput,
    ) {
        const channel = await this.service.update(auth.userId, id, body);
        return { channel };
    }

    @UseGuards(AuthSessionGuard)
    @ApiBearerAuth('JWT-auth')
    @Delete(':id')
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiOperation({ summary: 'Remove a notification channel' })
    async remove(@CurrentUser() auth: AuthenticatedUser, @Param('id') id: string) {
        await this.service.remove(auth.userId, id);
    }

    @UseGuards(AuthSessionGuard)
    @ApiBearerAuth('JWT-auth')
    @Post(':id/test')
    @ApiOperation({ summary: 'Send a test message via this channel' })
    async sendTest(@CurrentUser() auth: AuthenticatedUser, @Param('id') id: string) {
        return this.service.sendTest(auth.userId, id);
    }

    @Public()
    @Post('events/:pluginId')
    @Throttle({ default: { ttl: 60_000, limit: 600 } })
    @HttpCode(HttpStatus.ACCEPTED)
    @ApiOperation({ summary: 'Provider delivery-event webhook for channels' })
    async eventsWebhook(
        @Param('pluginId') pluginId: string,
        @Req() _req: Request,
        @Headers() _headers: Record<string, string>,
    ) {
        // Webhook ingestion follows the email pattern — full per-plugin
        // signature verification + event persistence lands in EW-673 P3.
        return { received: true, pluginId };
    }
}
