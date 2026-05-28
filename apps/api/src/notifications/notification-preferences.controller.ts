import {
    Body,
    Controller,
    Delete,
    Get,
    Param,
    Post,
    Put,
    UseGuards,
    HttpCode,
    HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { CurrentUser, AuthSessionGuard } from '../auth';
import { AuthenticatedUser } from '@src/auth/types/auth.types';
import { NotificationPreferencesService } from './notification-preferences.service';

interface QuietHoursBody {
    quietHoursStart?: string | null;
    quietHoursEnd?: string | null;
    timezone?: string | null;
}

interface MuteBody {
    category: string;
    mutedUntil?: string | null;
}

/**
 * EW-664 / EW-678 — User notification preferences REST API.
 */
@ApiTags('Notification Preferences')
@ApiBearerAuth('JWT-auth')
@Controller('api/notifications')
@UseGuards(AuthSessionGuard)
export class NotificationPreferencesController {
    constructor(private readonly service: NotificationPreferencesService) {}

    @Get('event-types')
    @ApiOperation({ summary: 'List all registered notification event types' })
    async listEventTypes() {
        const eventTypes = await this.service.listEventTypes();
        return { eventTypes };
    }

    @Get('preferences')
    @ApiOperation({
        summary: 'Get my notification preferences (subscriptions + quiet hours + mutes)',
    })
    async getPreferences(@CurrentUser() auth: AuthenticatedUser) {
        return this.service.getPreferences(auth.userId);
    }

    @Put('preferences/event/:eventKey')
    @ApiOperation({ summary: 'Set channel selection for one event type' })
    async setEventSubscription(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('eventKey') eventKey: string,
        @Body() body: { channelIds: string[] },
    ) {
        const subscription = await this.service.setEventSubscription(
            auth.userId,
            eventKey,
            body.channelIds,
        );
        return { subscription };
    }

    @Put('preferences/quiet-hours')
    @ApiOperation({ summary: 'Set quiet hours window + timezone' })
    async setQuietHours(@CurrentUser() auth: AuthenticatedUser, @Body() body: QuietHoursBody) {
        const preference = await this.service.setQuietHours(
            auth.userId,
            body.quietHoursStart ?? null,
            body.quietHoursEnd ?? null,
            body.timezone ?? null,
        );
        return { preference };
    }

    @Post('preferences/mute')
    @ApiOperation({ summary: 'Mute a category until a given time (or indefinitely)' })
    async muteCategory(@CurrentUser() auth: AuthenticatedUser, @Body() body: MuteBody) {
        const mutedUntil = body.mutedUntil ? new Date(body.mutedUntil) : null;
        const mute = await this.service.muteCategory(auth.userId, body.category, mutedUntil);
        return { mute };
    }

    @Delete('preferences/mute/:category')
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiOperation({ summary: 'Unmute a category' })
    async unmuteCategory(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('category') category: string,
    ) {
        await this.service.unmuteCategory(auth.userId, category);
    }
}
