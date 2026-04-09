import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ActivityLogService } from '@ever-works/agent/activity-log';
import { ActivityActionType, ActivityStatus } from '@ever-works/agent/entities';
import {
    UserCreatedEvent,
    UserConfirmedEvent,
    UserPasswordChangedEvent,
    MemberInvitedEvent,
} from '../events';
import { DirectoryCreatedEvent } from '@ever-works/agent/events';
import { DirectoryGenerationCompletedEvent } from '@ever-works/agent/events';

@Injectable()
export class ActivityLogListener {
    private readonly logger = new Logger(ActivityLogListener.name);

    constructor(private readonly activityLogService: ActivityLogService) {}

    @OnEvent(DirectoryCreatedEvent.EVENT_NAME)
    async onDirectoryCreated(event: DirectoryCreatedEvent) {
        try {
            await this.activityLogService.log({
                userId: event.directory.userId,
                directoryId: event.directory.id,
                actionType: ActivityActionType.DIRECTORY_CREATED,
                action: 'directory.created',
                status: ActivityStatus.COMPLETED,
                summary: `Created directory: ${event.directory.name}`,
            });
        } catch (error) {
            this.logger.error('Failed to log directory created activity:', error);
        }
    }

    @OnEvent(DirectoryGenerationCompletedEvent.EVENT_NAME)
    async onGenerationCompleted(event: DirectoryGenerationCompletedEvent) {
        try {
            const directory = event.directory;
            const itemCount = directory.itemsCount || 0;
            const status =
                directory.generateStatus?.status === 'error'
                    ? ActivityStatus.FAILED
                    : ActivityStatus.COMPLETED;
            const summary =
                status === ActivityStatus.FAILED
                    ? `Generation failed for ${directory.name}`
                    : `Generated ${itemCount} items for ${directory.name}`;
            const details = {
                itemsCount: itemCount,
                generateStatus: directory.generateStatus,
            };

            const inProgressEntry =
                await this.activityLogService.findLatestByUserDirectoryActionStatus({
                    userId: directory.userId,
                    directoryId: directory.id,
                    actionType: ActivityActionType.GENERATION,
                    status: ActivityStatus.IN_PROGRESS,
                });

            if (inProgressEntry) {
                await this.activityLogService.updateStatus(inProgressEntry.id, status, details, {
                    action: 'generation.completed',
                    summary,
                });
                return;
            }

            await this.activityLogService.log({
                userId: directory.userId,
                directoryId: directory.id,
                actionType: ActivityActionType.GENERATION,
                action: 'generation.completed',
                status,
                summary,
                details,
            });
        } catch (error) {
            this.logger.error('Failed to log generation completed activity:', error);
        }
    }

    @OnEvent(UserCreatedEvent.EVENT_NAME)
    async onUserCreated(event: UserCreatedEvent) {
        try {
            await this.activityLogService.log({
                userId: event.user.id,
                actionType: ActivityActionType.USER_SIGNUP,
                action: 'user.signup',
                status: ActivityStatus.COMPLETED,
                summary: 'Account created',
            });
        } catch (error) {
            this.logger.error('Failed to log user signup activity:', error);
        }
    }

    @OnEvent(UserConfirmedEvent.EVENT_NAME)
    async onUserConfirmed(event: UserConfirmedEvent) {
        try {
            await this.activityLogService.log({
                userId: event.user.id,
                actionType: ActivityActionType.USER_LOGIN,
                action: 'user.confirmed',
                status: ActivityStatus.COMPLETED,
                summary: `Signed in via ${event.user.registrationProvider || 'email'}`,
            });
        } catch (error) {
            this.logger.error('Failed to log user confirmed activity:', error);
        }
    }

    @OnEvent(UserPasswordChangedEvent.EVENT_NAME)
    async onPasswordChanged(event: UserPasswordChangedEvent) {
        try {
            await this.activityLogService.log({
                userId: event.user.id,
                actionType: ActivityActionType.PASSWORD_CHANGED,
                action: 'user.password_changed',
                status: ActivityStatus.COMPLETED,
                summary: 'Password changed',
                ipAddress: event.ipAddress,
            });
        } catch (error) {
            this.logger.error('Failed to log password changed activity:', error);
        }
    }

    @OnEvent(MemberInvitedEvent.EVENT_NAME)
    async onMemberInvited(event: MemberInvitedEvent) {
        try {
            await this.activityLogService.log({
                userId: event.inviter.id,
                directoryId: event.directory.id,
                actionType: ActivityActionType.MEMBER_INVITED,
                action: 'member.invited',
                status: ActivityStatus.COMPLETED,
                summary: `Invited ${event.invitee.email} as ${event.role} to ${event.directory.name}`,
                details: {
                    inviteeEmail: event.invitee.email,
                    role: event.role,
                },
            });
        } catch (error) {
            this.logger.error('Failed to log member invited activity:', error);
        }
    }
}
