import {
    Controller,
    Get,
    Post,
    Param,
    Query,
    HttpCode,
    HttpStatus,
    UseGuards,
    ParseBoolPipe,
    DefaultValuePipe,
    ParseIntPipe,
} from '@nestjs/common';
import { NotificationService } from '@packages/agent/notifications';
import { NotificationCategory } from '@packages/agent/entities';
import { CurrentUser, JwtAuthGuard } from '../auth';
import { AuthenticatedUser } from '@src/auth/types/jwt.types';

@Controller('api/notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
    constructor(private readonly notificationService: NotificationService) {}

    /**
     * Get all notifications for the current user
     */
    @Get()
    @HttpCode(HttpStatus.OK)
    async getNotifications(
        @CurrentUser() auth: AuthenticatedUser,
        @Query('unreadOnly', new DefaultValuePipe(false), ParseBoolPipe) unreadOnly: boolean,
        @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
        @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
        @Query('category') category?: NotificationCategory,
    ) {
        const notifications = await this.notificationService.getNotifications(auth.userId, {
            unreadOnly,
            limit: Math.min(limit, 100), // Cap at 100
            offset,
            category,
        });

        return { notifications };
    }

    /**
     * Get the count of unread notifications
     */
    @Get('unread-count')
    @HttpCode(HttpStatus.OK)
    async getUnreadCount(@CurrentUser() auth: AuthenticatedUser) {
        const count = await this.notificationService.getUnreadCount(auth.userId);
        return { count };
    }

    /**
     * Get persistent (critical) notifications that should be prominently displayed
     */
    @Get('persistent')
    @HttpCode(HttpStatus.OK)
    async getPersistentNotifications(@CurrentUser() auth: AuthenticatedUser) {
        const notifications = await this.notificationService.getPersistentNotifications(
            auth.userId,
        );
        return { notifications };
    }

    /**
     * Mark a specific notification as read
     */
    @Post(':id/read')
    @HttpCode(HttpStatus.OK)
    async markAsRead(@CurrentUser() auth: AuthenticatedUser, @Param('id') id: string) {
        await this.notificationService.markAsRead(auth.userId, id);
        return { success: true };
    }

    /**
     * Mark all notifications as read
     */
    @Post('read-all')
    @HttpCode(HttpStatus.OK)
    async markAllAsRead(@CurrentUser() auth: AuthenticatedUser) {
        await this.notificationService.markAllAsRead(auth.userId);
        return { success: true };
    }

    /**
     * Dismiss a notification (hides it from view)
     * Note: Persistent notifications cannot be dismissed
     */
    @Post(':id/dismiss')
    @HttpCode(HttpStatus.OK)
    async dismiss(@CurrentUser() auth: AuthenticatedUser, @Param('id') id: string) {
        await this.notificationService.dismiss(auth.userId, id);
        return { success: true };
    }
}
