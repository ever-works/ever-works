jest.mock('@ever-works/agent/activity-log', () => ({}));
jest.mock('@ever-works/agent/database', () => ({}));
jest.mock('@ever-works/agent/events', () => {
    class WorkCreatedEvent {
        static EVENT_NAME = 'work.created';
    }
    class WorkGenerationCompletedEvent {
        static EVENT_NAME = 'work.generation_completed';
    }
    class WorksConfigSyncFailedEvent {
        static EVENT_NAME = 'works_config.sync_failed';
    }
    class DeploymentDispatchedEvent {
        static EVENT_NAME = 'deployment.dispatched';
    }
    class DeploymentCompletedEvent {
        static EVENT_NAME = 'deployment.completed';
    }
    class DeploymentFailedEvent {
        static EVENT_NAME = 'deployment.failed';
    }
    return {
        WorkCreatedEvent,
        WorkGenerationCompletedEvent,
        WorksConfigSyncFailedEvent,
        DeploymentDispatchedEvent,
        DeploymentCompletedEvent,
        DeploymentFailedEvent,
    };
});

jest.mock('../events', () => {
    class UserCreatedEvent {
        static EVENT_NAME = 'user.created';
    }
    class UserConfirmedEvent {
        static EVENT_NAME = 'user.confirmed';
    }
    class UserPasswordChangedEvent {
        static EVENT_NAME = 'user.password_changed';
    }
    class MemberInvitedEvent {
        static EVENT_NAME = 'work.member_invited';
    }
    return {
        UserCreatedEvent,
        UserConfirmedEvent,
        UserPasswordChangedEvent,
        MemberInvitedEvent,
    };
});
jest.mock('@ever-works/agent/entities', () => ({
    ActivityActionType: {
        WORK_CREATED: 'WORK_CREATED',
        GENERATION: 'GENERATION',
        WORKS_CONFIG_SYNC: 'WORKS_CONFIG_SYNC',
        USER_SIGNUP: 'USER_SIGNUP',
        USER_LOGIN: 'USER_LOGIN',
        PASSWORD_CHANGED: 'PASSWORD_CHANGED',
        MEMBER_INVITED: 'MEMBER_INVITED',
        DEPLOYMENT: 'DEPLOYMENT',
    },
    ActivityStatus: {
        COMPLETED: 'completed',
        FAILED: 'failed',
        IN_PROGRESS: 'in_progress',
        CANCELLED: 'cancelled',
    },
}));

import { ActivityLogListener } from './activity-log.listener';
import { ActivityActionType, ActivityStatus } from '@ever-works/agent/entities';

// The event-class types are only used as TypeScript shapes here; the runtime
// objects we hand to the listener satisfy the same field surface but carry no
// real prototype, so we cast through `any`. Keeping the imports as type-only
// avoids dragging in the agent/events runtime tree (entity modules, etc.).
import type {
    UserCreatedEvent,
    UserConfirmedEvent,
    UserPasswordChangedEvent,
    MemberInvitedEvent,
} from '../events';
import type {
    WorkCreatedEvent,
    WorkGenerationCompletedEvent,
    WorksConfigSyncFailedEvent,
    DeploymentDispatchedEvent,
    DeploymentCompletedEvent,
    DeploymentFailedEvent,
} from '@ever-works/agent/events';

describe('ActivityLogListener', () => {
    let activityLogService: any;
    let generationHistoryRepository: any;
    let listener: ActivityLogListener;
    let loggerErrorSpy: jest.SpyInstance;

    beforeEach(() => {
        activityLogService = {
            log: jest.fn().mockResolvedValue(undefined),
            updateStatus: jest.fn().mockResolvedValue(undefined),
            findLatestByUserWorkActionStatus: jest.fn().mockResolvedValue(null),
            resolveGenerationActivityStatus: jest.fn().mockReturnValue(ActivityStatus.COMPLETED),
            formatGenerationCompletionSummary: jest
                .fn()
                .mockReturnValue('Generated 12 items'),
        };
        generationHistoryRepository = {
            findLatestCompletedByWork: jest.fn().mockResolvedValue(null),
        };
        listener = new ActivityLogListener(activityLogService, generationHistoryRepository);

        loggerErrorSpy = jest
            .spyOn((listener as any).logger, 'error')
            .mockImplementation(() => undefined);
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('onWorkCreated', () => {
        it('logs a WORK_CREATED activity with the correct fields', async () => {
            const work: any = { id: 'w1', userId: 'u1', name: 'My Work' };
            await listener.onWorkCreated({ work } as WorkCreatedEvent);

            expect(activityLogService.log).toHaveBeenCalledWith({
                userId: 'u1',
                workId: 'w1',
                actionType: ActivityActionType.WORK_CREATED,
                action: 'work.created',
                status: ActivityStatus.COMPLETED,
                summary: 'Created work: My Work',
            });
        });

        it('swallows and logs errors from the service', async () => {
            activityLogService.log.mockRejectedValue(new Error('db error'));
            await expect(
                listener.onWorkCreated({ work: { id: 'w', userId: 'u', name: 'n' } } as any),
            ).resolves.toBeUndefined();
            expect(loggerErrorSpy).toHaveBeenCalled();
        });
    });

    describe('onGenerationCompleted', () => {
        const work: any = {
            id: 'w1',
            userId: 'u1',
            itemsCount: 12,
            generateStatus: { code: 'GENERATED' },
        };

        it('updates an existing in-progress entry when one exists', async () => {
            activityLogService.findLatestByUserWorkActionStatus.mockResolvedValue({ id: 'a-old' });
            generationHistoryRepository.findLatestCompletedByWork.mockResolvedValue({
                totalItemsCount: 15,
                newItemsCount: 3,
                updatedItemsCount: 5,
            });
            activityLogService.resolveGenerationActivityStatus.mockReturnValue(
                ActivityStatus.COMPLETED,
            );

            await listener.onGenerationCompleted({ work } as WorkGenerationCompletedEvent);

            expect(activityLogService.updateStatus).toHaveBeenCalledWith(
                'a-old',
                ActivityStatus.COMPLETED,
                expect.objectContaining({
                    itemsCount: 15,
                    newItemsCount: 3,
                    updatedItemsCount: 5,
                    generateStatus: work.generateStatus,
                }),
                expect.objectContaining({
                    action: 'generation.completed',
                    summary: 'Generated 12 items',
                }),
            );
            expect(activityLogService.log).not.toHaveBeenCalled();
        });

        it('creates a new entry when no in-progress entry exists', async () => {
            activityLogService.findLatestByUserWorkActionStatus.mockResolvedValue(null);
            generationHistoryRepository.findLatestCompletedByWork.mockResolvedValue(null);

            await listener.onGenerationCompleted({ work } as WorkGenerationCompletedEvent);

            expect(activityLogService.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: 'u1',
                    workId: 'w1',
                    actionType: ActivityActionType.GENERATION,
                    action: 'generation.completed',
                    status: ActivityStatus.COMPLETED,
                }),
            );
            expect(activityLogService.updateStatus).not.toHaveBeenCalled();
        });

        it('falls back to work.itemsCount when there is no completed history row', async () => {
            generationHistoryRepository.findLatestCompletedByWork.mockResolvedValue(null);
            await listener.onGenerationCompleted({ work } as WorkGenerationCompletedEvent);

            const details = activityLogService.log.mock.calls[0][0].details;
            expect(details.itemsCount).toBe(12);
            expect(details.newItemsCount).toBe(0);
            expect(details.updatedItemsCount).toBe(0);
        });

        it('swallows errors thrown anywhere in the handler', async () => {
            generationHistoryRepository.findLatestCompletedByWork.mockRejectedValue(
                new Error('repo down'),
            );
            await expect(
                listener.onGenerationCompleted({ work } as WorkGenerationCompletedEvent),
            ).resolves.toBeUndefined();
            expect(loggerErrorSpy).toHaveBeenCalled();
        });
    });

    describe('onWorksConfigSyncFailed', () => {
        const event: any = {
            userId: 'u1',
            workId: 'w1',
            repository: 'org/repo',
            reason: 'permission_denied',
            errorMessage: 'No access token',
        };

        it('logs a WORKS_CONFIG_SYNC failure activity', async () => {
            await listener.onWorksConfigSyncFailed(event as WorksConfigSyncFailedEvent);
            expect(activityLogService.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    actionType: ActivityActionType.WORKS_CONFIG_SYNC,
                    action: 'works_config.sync_failed',
                    status: ActivityStatus.FAILED,
                    summary: 'Failed to sync works.yml to org/repo',
                    details: {
                        reason: 'permission_denied',
                        repository: 'org/repo',
                        error: 'No access token',
                    },
                }),
            );
        });

        it('swallows service errors', async () => {
            activityLogService.log.mockRejectedValue(new Error('boom'));
            await expect(
                listener.onWorksConfigSyncFailed(event as WorksConfigSyncFailedEvent),
            ).resolves.toBeUndefined();
            expect(loggerErrorSpy).toHaveBeenCalled();
        });
    });

    describe('onUserCreated', () => {
        it('logs a USER_SIGNUP activity', async () => {
            await listener.onUserCreated({
                user: { id: 'u1' },
            } as UserCreatedEvent);
            expect(activityLogService.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: 'u1',
                    actionType: ActivityActionType.USER_SIGNUP,
                    action: 'user.signup',
                    status: ActivityStatus.COMPLETED,
                    summary: 'Account created',
                }),
            );
        });

        it('swallows service errors', async () => {
            activityLogService.log.mockRejectedValue(new Error('x'));
            await expect(
                listener.onUserCreated({ user: { id: 'u1' } } as any),
            ).resolves.toBeUndefined();
            expect(loggerErrorSpy).toHaveBeenCalled();
        });
    });

    describe('onUserConfirmed', () => {
        it('uses the registration provider when present', async () => {
            await listener.onUserConfirmed({
                user: { id: 'u1', registrationProvider: 'github' },
            } as UserConfirmedEvent);
            expect(activityLogService.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    summary: 'Signed in via github',
                    actionType: ActivityActionType.USER_LOGIN,
                    action: 'user.confirmed',
                }),
            );
        });

        it('falls back to "email" when registration provider is missing', async () => {
            await listener.onUserConfirmed({
                user: { id: 'u1', registrationProvider: null },
            } as any);
            expect(activityLogService.log).toHaveBeenCalledWith(
                expect.objectContaining({ summary: 'Signed in via email' }),
            );
        });

        it('swallows service errors', async () => {
            activityLogService.log.mockRejectedValue(new Error('x'));
            await expect(
                listener.onUserConfirmed({ user: { id: 'u1' } } as any),
            ).resolves.toBeUndefined();
            expect(loggerErrorSpy).toHaveBeenCalled();
        });
    });

    describe('onPasswordChanged', () => {
        it('logs a PASSWORD_CHANGED activity with the IP address', async () => {
            await listener.onPasswordChanged({
                user: { id: 'u1' },
                ipAddress: '127.0.0.1',
            } as UserPasswordChangedEvent);
            expect(activityLogService.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: 'u1',
                    actionType: ActivityActionType.PASSWORD_CHANGED,
                    action: 'user.password_changed',
                    status: ActivityStatus.COMPLETED,
                    summary: 'Password changed',
                    ipAddress: '127.0.0.1',
                }),
            );
        });

        it('swallows service errors', async () => {
            activityLogService.log.mockRejectedValue(new Error('x'));
            await expect(
                listener.onPasswordChanged({ user: { id: 'u1' } } as any),
            ).resolves.toBeUndefined();
            expect(loggerErrorSpy).toHaveBeenCalled();
        });
    });

    describe('onMemberInvited', () => {
        const event = {
            inviter: { id: 'inviter' },
            invitee: { email: 'new@example.com' },
            work: { id: 'w1', name: 'My Work' },
            role: 'editor',
        } as any as MemberInvitedEvent;

        it('logs a MEMBER_INVITED activity', async () => {
            await listener.onMemberInvited(event);
            expect(activityLogService.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: 'inviter',
                    workId: 'w1',
                    actionType: ActivityActionType.MEMBER_INVITED,
                    action: 'member.invited',
                    status: ActivityStatus.COMPLETED,
                    summary: 'Invited new@example.com as editor to My Work',
                    details: { inviteeEmail: 'new@example.com', role: 'editor' },
                }),
            );
        });

        it('swallows service errors', async () => {
            activityLogService.log.mockRejectedValue(new Error('x'));
            await expect(listener.onMemberInvited(event)).resolves.toBeUndefined();
            expect(loggerErrorSpy).toHaveBeenCalled();
        });
    });

    describe('onDeploymentDispatched', () => {
        const event = {
            payload: {
                work: { id: 'w1', name: 'My Work' },
                userId: 'u1',
                providerId: 'vercel',
                providerName: 'Vercel',
            },
        } as DeploymentDispatchedEvent;

        it('logs an IN_PROGRESS deployment activity', async () => {
            await listener.onDeploymentDispatched(event);
            expect(activityLogService.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: 'u1',
                    workId: 'w1',
                    actionType: ActivityActionType.DEPLOYMENT,
                    action: 'deployment.dispatched',
                    status: ActivityStatus.IN_PROGRESS,
                    summary: 'Dispatched deployment workflow for My Work via Vercel',
                    details: { providerId: 'vercel', providerName: 'Vercel' },
                }),
            );
        });

        it('swallows service errors', async () => {
            activityLogService.log.mockRejectedValue(new Error('x'));
            await expect(listener.onDeploymentDispatched(event)).resolves.toBeUndefined();
            expect(loggerErrorSpy).toHaveBeenCalled();
        });
    });

    describe('onDeploymentCompleted', () => {
        const baseEvent = {
            payload: {
                work: { id: 'w1', name: 'My Work' },
                userId: 'u1',
                providerId: 'vercel',
                providerName: 'Vercel',
                url: 'https://my-work.vercel.app',
            },
        } as DeploymentCompletedEvent;

        it('uses the URL in the summary when available', async () => {
            await listener.onDeploymentCompleted(baseEvent);
            expect(activityLogService.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    action: 'deployment.succeeded',
                    status: ActivityStatus.COMPLETED,
                    summary: 'Deployed My Work to https://my-work.vercel.app',
                }),
            );
        });

        it('falls back to provider name when URL is missing', async () => {
            const eventNoUrl = {
                payload: { ...baseEvent.payload, url: undefined },
            } as DeploymentCompletedEvent;
            await listener.onDeploymentCompleted(eventNoUrl);
            expect(activityLogService.log).toHaveBeenCalledWith(
                expect.objectContaining({ summary: 'Deployed My Work via Vercel' }),
            );
        });

        it('swallows service errors', async () => {
            activityLogService.log.mockRejectedValue(new Error('x'));
            await expect(listener.onDeploymentCompleted(baseEvent)).resolves.toBeUndefined();
            expect(loggerErrorSpy).toHaveBeenCalled();
        });
    });

    describe('onDeploymentFailed', () => {
        const buildEvent = (terminalState: 'FAILED' | 'CANCELED' = 'FAILED') =>
            ({
                payload: {
                    work: { id: 'w1', name: 'My Work' },
                    userId: 'u1',
                    providerId: 'vercel',
                    providerName: 'Vercel',
                    terminalState,
                    error: 'Build failed',
                },
            }) as DeploymentFailedEvent;

        it('uses cancelled action+status when terminalState is CANCELED', async () => {
            await listener.onDeploymentFailed(buildEvent('CANCELED'));
            expect(activityLogService.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    action: 'deployment.cancelled',
                    status: ActivityStatus.CANCELLED,
                    summary: 'Deployment canceled for My Work via Vercel',
                }),
            );
        });

        it('uses failed action+status when terminalState is FAILED', async () => {
            await listener.onDeploymentFailed(buildEvent('FAILED'));
            expect(activityLogService.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    action: 'deployment.failed',
                    status: ActivityStatus.FAILED,
                    summary: 'Deployment failed for My Work via Vercel',
                }),
            );
        });

        it('swallows service errors', async () => {
            activityLogService.log.mockRejectedValue(new Error('x'));
            await expect(listener.onDeploymentFailed(buildEvent())).resolves.toBeUndefined();
            expect(loggerErrorSpy).toHaveBeenCalled();
        });
    });
});
