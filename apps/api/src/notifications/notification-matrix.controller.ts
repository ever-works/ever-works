import {
    Body,
    Controller,
    Get,
    Header,
    HttpCode,
    HttpStatus,
    Post,
    UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsOptional, IsString, MaxLength } from 'class-validator';
import type {
    NotificationMatrixDto,
    NotificationMatrixResetResultDto,
} from '@ever-works/contracts';
import { AuthSessionGuard, CurrentUser } from '../auth';
import { AuthenticatedUser } from '@src/auth/types/auth.types';
import { NotificationMatrixService } from './notification-matrix.service';

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
 * Attention controls (AW-13) — the notification matrix API.
 *
 * Mounted on the existing `api/notifications` base so the notifications
 * surface stays one thing. Individual switches keep saving through the
 * existing `PUT /api/notifications/preferences/event/:eventKey`.
 */
@ApiTags('Notification Preferences')
@ApiBearerAuth('JWT-auth')
@Controller('api/notifications')
@UseGuards(AuthSessionGuard)
export class NotificationMatrixController {
    constructor(private readonly matrix: NotificationMatrixService) {}

    @Get('matrix')
    @Header('Cache-Control', 'private, no-store')
    @ApiOperation({
        summary:
            'Get my notification matrix: every event, its delivery targets, quiet hours and mutes, in one read',
    })
    async getMatrix(@CurrentUser() auth: AuthenticatedUser): Promise<NotificationMatrixDto> {
        return this.matrix.getMatrix(auth.userId);
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
