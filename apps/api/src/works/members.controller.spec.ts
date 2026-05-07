jest.mock('@ever-works/agent/services', () => ({}));
jest.mock('@ever-works/agent/activity-log', () => ({}));
jest.mock('@ever-works/agent/entities', () => ({
    ActivityActionType: {
        MEMBER_ROLE_CHANGED: 'MEMBER_ROLE_CHANGED',
        MEMBER_REMOVED: 'MEMBER_REMOVED',
    },
    ActivityStatus: { COMPLETED: 'COMPLETED' },
    ASSIGNABLE_MEMBER_ROLES: ['viewer', 'editor', 'manager'],
}));
jest.mock('../auth', () => ({
    AuthService: class {},
    AuthSessionGuard: class {},
    CurrentUser: () => () => undefined,
}));
jest.mock('../config/constants', () => ({
    config: {
        webAppUrl: jest.fn(() => 'https://app.example.com'),
    },
}));

import { MembersController } from './members.controller';
import { MemberInvitedEvent } from '../events';
import { ActivityActionType, ActivityStatus } from '@ever-works/agent/entities';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import type { WorkMemberService } from '@ever-works/agent/services';
import type { ActivityLogService } from '@ever-works/agent/activity-log';
import type { AuthService } from '../auth';
import type { EventEmitter2 } from '@nestjs/event-emitter';

describe('MembersController', () => {
    let memberService: {
        listMembers: jest.Mock;
        getWorkOwnerInfo: jest.Mock;
        inviteMember: jest.Mock;
        getMember: jest.Mock;
        updateMemberRole: jest.Mock;
        removeMember: jest.Mock;
        leaveWork: jest.Mock;
    };
    let authService: { getUser: jest.Mock };
    let eventEmitter: { emit: jest.Mock };
    let activityLogService: { log: jest.Mock };
    let controller: MembersController;
    const auth: AuthenticatedUser = { userId: 'auth-1' } as any;

    beforeEach(() => {
        memberService = {
            listMembers: jest.fn(),
            getWorkOwnerInfo: jest.fn(),
            inviteMember: jest.fn(),
            getMember: jest.fn(),
            updateMemberRole: jest.fn(),
            removeMember: jest.fn(),
            leaveWork: jest.fn(),
        };
        authService = {
            getUser: jest.fn().mockResolvedValue({ id: 'user-1' }),
        };
        eventEmitter = { emit: jest.fn() };
        activityLogService = { log: jest.fn().mockResolvedValue(undefined) };
        controller = new MembersController(
            memberService as unknown as WorkMemberService,
            authService as unknown as AuthService,
            eventEmitter as unknown as EventEmitter2,
            activityLogService as unknown as ActivityLogService,
        );
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('listMembers', () => {
        it('returns members + owner with status:success and forwards user.id', async () => {
            memberService.listMembers.mockResolvedValue([{ id: 'm1' }]);
            memberService.getWorkOwnerInfo.mockResolvedValue({ id: 'owner' });

            const result = await controller.listMembers(auth, 'w-1');

            expect(authService.getUser).toHaveBeenCalledWith('auth-1');
            expect(memberService.listMembers).toHaveBeenCalledWith('w-1', 'user-1');
            expect(memberService.getWorkOwnerInfo).toHaveBeenCalledWith('w-1', 'user-1');
            expect(result).toEqual({
                status: 'success',
                members: [{ id: 'm1' }],
                owner: { id: 'owner' },
            });
        });

        it('propagates errors from authService.getUser', async () => {
            const err = new Error('user lookup failed');
            authService.getUser.mockRejectedValue(err);
            await expect(controller.listMembers(auth, 'w-1')).rejects.toBe(err);
            expect(memberService.listMembers).not.toHaveBeenCalled();
        });

        it('propagates errors from memberService.listMembers', async () => {
            memberService.listMembers.mockRejectedValue(new Error('not authorized'));
            await expect(controller.listMembers(auth, 'w-1')).rejects.toThrow('not authorized');
            expect(memberService.getWorkOwnerInfo).not.toHaveBeenCalled();
        });
    });

    describe('inviteMember', () => {
        it('invites the member, emits MemberInvitedEvent with the workUrl, and returns the new member', async () => {
            const invitee = { id: 'invitee', email: 'foo@bar.com' };
            const inviter = { id: 'inviter' };
            const work = { id: 'w-1' };
            const member = { id: 'm-new', role: 'editor' };
            memberService.inviteMember.mockResolvedValue({ invitee, inviter, work, member });

            const dto = { email: 'foo@bar.com', role: 'editor' } as any;
            const result = await controller.inviteMember(auth, 'w-1', dto);

            expect(memberService.inviteMember).toHaveBeenCalledWith('w-1', 'user-1', dto);
            expect(eventEmitter.emit).toHaveBeenCalledTimes(1);
            const [eventName, eventArg] = eventEmitter.emit.mock.calls[0];
            expect(eventName).toBe(MemberInvitedEvent.EVENT_NAME);
            expect(eventArg).toBeInstanceOf(MemberInvitedEvent);
            expect(eventArg.invitee).toBe(invitee);
            expect(eventArg.inviter).toBe(inviter);
            expect(eventArg.work).toBe(work);
            expect(eventArg.role).toBe('editor');
            expect(eventArg.workUrl).toBe('https://app.example.com/works/w-1');
            expect(result).toEqual({ status: 'success', member });
        });

        it('does not emit when inviteMember throws', async () => {
            const err = new Error('email taken');
            memberService.inviteMember.mockRejectedValue(err);
            await expect(
                controller.inviteMember(auth, 'w-1', {
                    email: 'a@b.c',
                    role: 'viewer',
                } as any),
            ).rejects.toBe(err);
            expect(eventEmitter.emit).not.toHaveBeenCalled();
        });
    });

    describe('getMember', () => {
        it('forwards workId, user.id, memberId and returns the member', async () => {
            memberService.getMember.mockResolvedValue({ id: 'm-2' });
            const result = await controller.getMember(auth, 'w-1', 'm-2');
            expect(memberService.getMember).toHaveBeenCalledWith('w-1', 'user-1', 'm-2');
            expect(result).toEqual({ status: 'success', member: { id: 'm-2' } });
        });

        it('propagates not-found errors from getMember', async () => {
            memberService.getMember.mockRejectedValue(new Error('not found'));
            await expect(controller.getMember(auth, 'w-1', 'm-2')).rejects.toThrow('not found');
        });
    });

    describe('updateMemberRole', () => {
        it('updates role, fire-and-forget activity log, returns the member', async () => {
            memberService.updateMemberRole.mockResolvedValue({ id: 'm-2', role: 'manager' });
            const dto = { role: 'manager' } as any;
            const result = await controller.updateMemberRole(auth, 'w-1', 'm-2', dto);

            expect(memberService.updateMemberRole).toHaveBeenCalledWith(
                'w-1',
                'user-1',
                'm-2',
                dto,
            );
            // Wait for the fire-and-forget activity log call
            await Promise.resolve();
            expect(activityLogService.log).toHaveBeenCalledWith({
                userId: 'auth-1',
                workId: 'w-1',
                actionType: ActivityActionType.MEMBER_ROLE_CHANGED,
                action: 'member.role_changed',
                status: ActivityStatus.COMPLETED,
                summary: 'Changed member role to manager',
                details: { memberId: 'm-2', role: 'manager' },
            });
            expect(result).toEqual({
                status: 'success',
                member: { id: 'm-2', role: 'manager' },
            });
        });

        it('still returns success when activityLogService.log rejects (catch swallows)', async () => {
            memberService.updateMemberRole.mockResolvedValue({ id: 'm-2', role: 'editor' });
            activityLogService.log.mockRejectedValue(new Error('activity-log down'));

            const result = await controller.updateMemberRole(auth, 'w-1', 'm-2', {
                role: 'editor',
            } as any);
            // ensure swallowed
            await Promise.resolve();
            await Promise.resolve();
            expect(result).toEqual({
                status: 'success',
                member: { id: 'm-2', role: 'editor' },
            });
        });

        it('propagates errors from updateMemberRole and does not log activity', async () => {
            memberService.updateMemberRole.mockRejectedValue(new Error('role denied'));
            await expect(
                controller.updateMemberRole(auth, 'w-1', 'm-2', {
                    role: 'manager',
                } as any),
            ).rejects.toThrow('role denied');
            expect(activityLogService.log).not.toHaveBeenCalled();
        });
    });

    describe('removeMember', () => {
        it('removes the member, fire-and-forget activity log, returns success message', async () => {
            memberService.removeMember.mockResolvedValue(undefined);
            const result = await controller.removeMember(auth, 'w-1', 'm-2');

            expect(memberService.removeMember).toHaveBeenCalledWith('w-1', 'user-1', 'm-2');
            await Promise.resolve();
            expect(activityLogService.log).toHaveBeenCalledWith({
                userId: 'auth-1',
                workId: 'w-1',
                actionType: ActivityActionType.MEMBER_REMOVED,
                action: 'member.removed',
                status: ActivityStatus.COMPLETED,
                summary: 'Removed member from work',
                details: { memberId: 'm-2' },
            });
            expect(result).toEqual({
                status: 'success',
                message: 'Member removed successfully',
            });
        });

        it('still returns success when activityLogService.log rejects', async () => {
            memberService.removeMember.mockResolvedValue(undefined);
            activityLogService.log.mockRejectedValue(new Error('activity-log down'));
            const result = await controller.removeMember(auth, 'w-1', 'm-2');
            await Promise.resolve();
            await Promise.resolve();
            expect(result).toEqual({
                status: 'success',
                message: 'Member removed successfully',
            });
        });

        it('propagates errors from removeMember and does not log activity', async () => {
            memberService.removeMember.mockRejectedValue(new Error('cannot remove owner'));
            await expect(controller.removeMember(auth, 'w-1', 'm-2')).rejects.toThrow(
                'cannot remove owner',
            );
            expect(activityLogService.log).not.toHaveBeenCalled();
        });
    });

    describe('leaveWork', () => {
        it('forwards workId + user.id and returns success message', async () => {
            memberService.leaveWork.mockResolvedValue(undefined);
            const result = await controller.leaveWork(auth, 'w-1');
            expect(memberService.leaveWork).toHaveBeenCalledWith('w-1', 'user-1');
            expect(result).toEqual({
                status: 'success',
                message: 'Successfully left the work',
            });
        });

        it('propagates errors from leaveWork', async () => {
            memberService.leaveWork.mockRejectedValue(new Error('cannot leave as owner'));
            await expect(controller.leaveWork(auth, 'w-1')).rejects.toThrow(
                'cannot leave as owner',
            );
        });
    });
});
