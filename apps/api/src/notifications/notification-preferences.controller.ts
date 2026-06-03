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
    ParseEnumPipe,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiParam, ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsIn, IsOptional, IsString, Matches } from 'class-validator';
import { CurrentUser, AuthSessionGuard } from '../auth';
import { AuthenticatedUser } from '@src/auth/types/auth.types';
import { NotificationPreferencesService } from './notification-preferences.service';
import { NotificationCategory } from '@ever-works/agent/entities';

// Security: DTO class (not interface) so class-validator decorators are enforced
// by the global ValidationPipe. Valid IANA time zones computed once at startup.
// `Intl.supportedValuesOf` is available on the Node 22 runtime but not in the
// project's TS lib typings; cast to access it without widening the lib target.
const VALID_TIMEZONES = new Set<string>(
    (Intl as typeof Intl & { supportedValuesOf(key: string): string[] }).supportedValuesOf(
        'timeZone',
    ),
);

// Security: HH:mm format — rejects arbitrary strings stored as quiet-hours times
const HH_MM_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

class QuietHoursBody {
    // Security: must match HH:mm to prevent arbitrary strings in DB
    @IsOptional()
    @IsString()
    @Matches(HH_MM_PATTERN, { message: 'quietHoursStart must be in HH:mm format' })
    quietHoursStart?: string | null;

    // Security: must match HH:mm to prevent arbitrary strings in DB
    @IsOptional()
    @IsString()
    @Matches(HH_MM_PATTERN, { message: 'quietHoursEnd must be in HH:mm format' })
    quietHoursEnd?: string | null;

    // Security: must be a valid IANA timezone to prevent RangeError in Intl.DateTimeFormat downstream
    @IsOptional()
    @IsString()
    @IsIn([...VALID_TIMEZONES], { message: 'timezone must be a valid IANA timezone identifier' })
    timezone?: string | null;
}

class MuteBody {
    // Security: restrict category to the known NotificationCategory enum values.
    // Explicit @ApiProperty({ enum }) gives Swagger a plain string-enum schema —
    // without it, Swagger reflects the enum type as a self-referential model and
    // OpenAPI generation throws "circular dependency detected (property key:
    // AI_CREDITS)".
    @ApiProperty({ enum: NotificationCategory, enumName: 'NotificationCategory' })
    @IsEnum(NotificationCategory, {
        message: `category must be one of: ${Object.values(NotificationCategory).join(', ')}`,
    })
    category: NotificationCategory;

    @IsOptional()
    @IsString()
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
        // Security: body.category is now validated as NotificationCategory by class-validator
        const mute = await this.service.muteCategory(auth.userId, body.category, mutedUntil);
        return { mute };
    }

    @Delete('preferences/mute/:category')
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiOperation({ summary: 'Unmute a category' })
    // Explicit @ApiParam({ enum }) gives Swagger a string-enum schema for the
    // path param; without it, Swagger reflects the enum type into a
    // self-referential model and OpenAPI generation throws a circular-dependency
    // error. Runtime validation is still enforced by the ParseEnumPipe below.
    @ApiParam({ name: 'category', enum: NotificationCategory, enumName: 'NotificationCategory' })
    async unmuteCategory(
        @CurrentUser() auth: AuthenticatedUser,
        // Security: ParseEnumPipe rejects path params not in NotificationCategory
        @Param('category', new ParseEnumPipe(NotificationCategory)) category: NotificationCategory,
    ) {
        await this.service.unmuteCategory(auth.userId, category);
    }
}
