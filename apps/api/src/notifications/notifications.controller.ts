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
import {
    ApiTags,
    ApiBearerAuth,
    ApiOperation,
    ApiResponse,
    ApiParam,
    ApiQuery,
} from '@nestjs/swagger';
import { NotificationService } from '@ever-works/agent/notifications';
import { NotificationCategory } from '@ever-works/agent/entities';
import { CurrentUser, JwtAuthGuard } from '../auth';
import { AuthenticatedUser } from '@src/auth/types/jwt.types';

@ApiTags('Notifications')
@ApiBearerAuth('JWT-auth')
@Controller('api/notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
    constructor(private readonly notificationService: NotificationService) {}

    /**
     * Get all notifications for the current user
     */
    @Get()
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Get notifications',
        description: 'Get all notifications for the current user',
    })
    @ApiQuery({
        name: 'unreadOnly',
        required: false,
        type: Boolean,
        description: 'Filter to unread only',
    })
    @ApiQuery({
        name: 'limit',
        required: false,
        type: Number,
        description: 'Maximum number of notifications to return',
    })
    @ApiQuery({
        name: 'offset',
        required: false,
        type: Number,
        description: 'Number of notifications to skip',
    })
    @ApiQuery({
        name: 'category',
        required: false,
        enum: ['ai_credits', 'subscription', 'generation', 'system', 'security'],
        description: 'Filter by notification category',
    })
    @ApiResponse({ status: 200, description: 'List of notifications' })
    async getNotifications(
        @CurrentUser() auth: AuthenticatedUser,
        @Query('unreadOnly', new DefaultValuePipe(false), ParseBoolPipe) unreadOnly: boolean,
        @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
        @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
        @Query('category') category?: string,
    ) {
        const notifications = await this.notificationService.getNotifications(auth.userId, {
            unreadOnly,
            limit: Math.min(limit, 100), // Cap at 100
            offset,
            category: category as NotificationCategory,
        });

        return { notifications };
    }

    /**
     * Get the count of unread notifications
     */
    @Get('unread-count')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Get unread count',
        description: 'Get the count of unread notifications',
    })
    @ApiResponse({ status: 200, description: 'Unread notification count' })
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
    @ApiOperation({ summary: 'Mark as read', description: 'Mark a specific notification as read' })
    @ApiParam({ name: 'id', description: 'Notification ID' })
    @ApiResponse({ status: 200, description: 'Notification marked as read' })
    async markAsRead(@CurrentUser() auth: AuthenticatedUser, @Param('id') id: string) {
        await this.notificationService.markAsRead(auth.userId, id);
        return { success: true };
    }

    /**
     * Mark all notifications as read
     */
    @Post('read-all')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Mark all as read', description: 'Mark all notifications as read' })
    @ApiResponse({ status: 200, description: 'All notifications marked as read' })
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
    @ApiOperation({
        summary: 'Dismiss notification',
        description: 'Dismiss a notification (hides it from view)',
    })
    @ApiParam({ name: 'id', description: 'Notification ID' })
    @ApiResponse({ status: 200, description: 'Notification dismissed' })
    async dismiss(@CurrentUser() auth: AuthenticatedUser, @Param('id') id: string) {
        await this.notificationService.dismiss(auth.userId, id);
        return { success: true };
    }
}
