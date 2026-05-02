import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ActivityLogService } from '@ever-works/agent/activity-log';
import { WorkGenerationHistoryRepository } from '@ever-works/agent/database';
import { ActivityActionType, ActivityStatus } from '@ever-works/agent/entities';
import {
    UserCreatedEvent,
    UserConfirmedEvent,
    UserPasswordChangedEvent,
    MemberInvitedEvent,
} from '../events';
import {
    WorkCreatedEvent,
    WorkGenerationCompletedEvent,
    WorksConfigSyncFailedEvent,
} from '@ever-works/agent/events';

@Injectable()
export class ActivityLogListener {
    private readonly logger = new Logger(ActivityLogListener.name);

    constructor(
        private readonly activityLogService: ActivityLogService,
        private readonly generationHistoryRepository: WorkGenerationHistoryRepository,
    ) {}

    @OnEvent(WorkCreatedEvent.EVENT_NAME)
    async onWorkCreated(event: WorkCreatedEvent) {
        try {
            await this.activityLogService.log({
                userId: event.work.userId,
                workId: event.work.id,
                actionType: ActivityActionType.WORK_CREATED,
                action: 'work.created',
                status: ActivityStatus.COMPLETED,
                summary: `Created work: ${event.work.name}`,
            });
        } catch (error) {
            this.logger.error('Failed to log work created activity:', error);
        }
    }

    @OnEvent(WorkGenerationCompletedEvent.EVENT_NAME)
    async onGenerationCompleted(event: WorkGenerationCompletedEvent) {
        try {
            const work = event.work;
            const latestHistory =
                await this.generationHistoryRepository.findLatestCompletedByWork(work.id);
            const status = this.activityLogService.resolveGenerationActivityStatus(work);
            const summary = this.activityLogService.formatGenerationCompletionSummary(
                work,
                latestHistory,
            );

            const details = {
                itemsCount: latestHistory?.totalItemsCount ?? work.itemsCount ?? 0,
                newItemsCount: latestHistory?.newItemsCount ?? 0,
                updatedItemsCount: latestHistory?.updatedItemsCount ?? 0,
                generateStatus: work.generateStatus,
            };

            const inProgressEntry =
                await this.activityLogService.findLatestByUserWorkActionStatus({
                    userId: work.userId,
                    workId: work.id,
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
                userId: work.userId,
                workId: work.id,
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

    @OnEvent(WorksConfigSyncFailedEvent.EVENT_NAME)
    async onWorksConfigSyncFailed(event: WorksConfigSyncFailedEvent) {
        try {
            await this.activityLogService.log({
                userId: event.userId,
                workId: event.workId,
                actionType: ActivityActionType.WORKS_CONFIG_SYNC,
                action: 'works_config.sync_failed',
                status: ActivityStatus.FAILED,
                summary: `Failed to sync works.yml to ${event.repository}`,
                details: {
                    reason: event.reason,
                    repository: event.repository,
                    error: event.errorMessage,
                },
            });
        } catch (error) {
            this.logger.error('Failed to log works.yml sync failure activity:', error);
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
                workId: event.work.id,
                actionType: ActivityActionType.MEMBER_INVITED,
                action: 'member.invited',
                status: ActivityStatus.COMPLETED,
                summary: `Invited ${event.invitee.email} as ${event.role} to ${event.work.name}`,
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
