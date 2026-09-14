import {
    Body,
    Controller,
    Get,
    Header,
    HttpCode,
    HttpStatus,
    Param,
    Post,
    Put,
    UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsOptional, IsString, MaxLength } from 'class-validator';
import {
    NOTIFICATION_CHOICE_ORIGIN_MATRIX,
    type NotificationMatrixDto,
    type NotificationMatrixResetResultDto,
} from '@ever-works/contracts';
import { AuthSessionGuard, CurrentUser } from '../auth';
import { AuthenticatedUser } from '@src/auth/types/auth.types';
import { NotificationMatrixService } from './notification-matrix.service';
import { NotificationPreferencesService } from './notification-preferences.service';

/** Registry keys are `varchar(120)`; the registry itself holds tens of rows. */
const MAX_RESET_KEYS = 500;

export class ResetNotificationMatrixBody {
    @ApiProperty({
        required: false,
        type: [String],
        description: 'Event keys to reset. Omit to reset every event.',
    })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(MAX_RESET_KEYS)
    @IsString({ each: true })
    @MaxLength(120, { each: true })
    eventKeys?: string[];
}

/**
 * Channel ids are `notification_channels` uuids or a built-in target id.
 * The count cap (and its message) stays in `NotificationPreferencesService`,
 * shared with the existing per-event write.
 */
const MAX_TARGET_ID_LENGTH = 120;

export class SetNotificationMatrixEventBody {
    @ApiProperty({
        type: [String],
        description:
            'The complete list of delivery targets for the event, as the matrix row shows it. An empty list means nothing; a list without in-app keeps the notification out of the bell.',
    })
    @IsArray()
    @IsString({ each: true })
    @MaxLength(MAX_TARGET_ID_LENGTH, { each: true })
    channelIds: string[];
}

/**
 * Attention controls (AW-13) — the notification matrix API.
 *
 * Mounted on the existing `api/notifications` base so the notifications
 * surface stays one thing. The matrix saves a switch through its own
 * `PUT matrix/event/:eventKey`, which stores the choice with the matrix
 * marker; the existing `PUT preferences/event/:eventKey` is unchanged and
 * keeps its original meaning for API callers and the chat assistant.
 */
@ApiTags('Notification Preferences')
@ApiBearerAuth('JWT-auth')
@Controller('api/notifications')
@UseGuards(AuthSessionGuard)
export class NotificationMatrixController {
    constructor(
        private readonly matrix: NotificationMatrixService,
        private readonly preferences: NotificationPreferencesService,
    ) {}

    @Get('matrix')
    @Header('Cache-Control', 'private, no-store')
    @ApiOperation({
        summary:
            'Get my notification matrix: every event, its delivery targets, quiet hours and mutes, in one read',
    })
    async getMatrix(@CurrentUser() auth: AuthenticatedUser): Promise<NotificationMatrixDto> {
        return this.matrix.getMatrix(auth.userId);
    }

    @Put('matrix/event/:eventKey')
    @ApiOperation({
        summary:
            'Save one row of my notification matrix: the complete list of delivery targets for one event',
    })
    async setEventTargets(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('eventKey') eventKey: string,
        @Body() body: SetNotificationMatrixEventBody,
    ) {
        const subscription = await this.preferences.setEventSubscription(
            auth.userId,
            eventKey,
            body.channelIds,
            NOTIFICATION_CHOICE_ORIGIN_MATRIX,
        );
        return { subscription };
    }

    @Post('matrix/reset')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Reset my notification choices to the recommended defaults' })
    async reset(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: ResetNotificationMatrixBody,
    ): Promise<NotificationMatrixResetResultDto> {
        return this.matrix.reset(auth.userId, body?.eventKeys);
    }
}
