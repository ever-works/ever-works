import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { WorkMemberService } from '../work-member.service';
import { WorkMemberRole, ASSIGNABLE_MEMBER_ROLES } from '@src/entities/types';
import type { WorkMember } from '@src/entities/work-member.entity';
import type { User } from '@src/entities/user.entity';
import type { Work } from '@src/entities';

describe('WorkMemberService', () => {
    let memberRepository: {
        findByWork: jest.Mock;
        findMember: jest.Mock;
        findById: jest.Mock;
        addMember: jest.Mock;
        updateRole: jest.Mock;
        removeMember: jest.Mock;
    };
    let userRepository: {
        findByEmail: jest.Mock;
        findById: jest.Mock;
    };
    let ownershipService: {
        ensureCanView: jest.Mock;
        ensureCanManageMembers: jest.Mock;
    };
    let service: WorkMemberService;

    beforeEach(() => {
        memberRepository = {
            findByWork: jest.fn(),
            findMember: jest.fn(),
            findById: jest.fn(),
            addMember: jest.fn(),
            updateRole: jest.fn(),
            removeMember: jest.fn(),
        };
        userRepository = {
            findByEmail: jest.fn(),
            findById: jest.fn(),
        };
        ownershipService = {
            ensureCanView: jest.fn().mockResolvedValue({ work: undefined, isCreator: false }),
            ensureCanManageMembers: jest.fn().mockResolvedValue({ work: undefined }),
        };
        service = new WorkMemberService(
            memberRepository as any,
            userRepository as any,
            ownershipService as any,
        );
    });

    const buildUser = (overrides: Partial<User> = {}): User =>
        ({
            id: 'u-1',
            username: 'user-one',
            email: 'user-one@example.com',
            avatar: 'https://example.com/avatar.png',
            ...overrides,
        }) as User;

    const buildWork = (overrides: Partial<Work> = {}): Work =>
        ({
            id: 'w-1',
            userId: 'creator-1',
            user: buildUser({ id: 'creator-1', username: 'creator', email: 'creator@example.com' }),
            ...overrides,
        }) as Work;

    const buildMember = (overrides: Partial<WorkMember> = {}): WorkMember =>
        ({
            id: 'm-1',
            workId: 'w-1',
            userId: 'u-2',
            role: WorkMemberRole.EDITOR,
            user: buildUser({ id: 'u-2', username: 'invitee', email: 'invitee@example.com' }),
            invitedBy: buildUser({ id: 'inviter-1', username: 'inviter' }),
            createdAt: new Date('2026-01-01T12:00:00.000Z'),
            ...overrides,
        }) as unknown as WorkMember;

    describe('listMembers', () => {
        it('runs ensureCanView before findByWork and maps to DTOs in order', async () => {
            const order: string[] = [];
            ownershipService.ensureCanView.mockImplementation(async () => {
                order.push('ensureCanView');
                return { isCreator: false };
            });
            memberRepository.findByWork.mockImplementation(async () => {
                order.push('findByWork');
                return [buildMember({ id: 'm-1' }), buildMember({ id: 'm-2', userId: 'u-3' })];
            });

            const result = await service.listMembers('w-1', 'u-1');

            expect(order).toEqual(['ensureCanView', 'findByWork']);
            expect(ownershipService.ensureCanView).toHaveBeenCalledWith('w-1', 'u-1');
            expect(memberRepository.findByWork).toHaveBeenCalledWith('w-1');
            expect(result).toHaveLength(2);
            expect(result[0]).toEqual({
                id: 'm-1',
                userId: 'u-2',
                username: 'invitee',
                email: 'invitee@example.com',
                avatar: 'https://example.com/avatar.png',
                role: WorkMemberRole.EDITOR,
                invitedBy: { id: 'inviter-1', username: 'inviter' },
                createdAt: '2026-01-01T12:00:00.000Z',
            });
        });

        it('short-circuits when ensureCanView rejects', async () => {
            const err = new ForbiddenException('forbidden');
            ownershipService.ensureCanView.mockRejectedValueOnce(err);

            await expect(service.listMembers('w-1', 'u-1')).rejects.toBe(err);
            expect(memberRepository.findByWork).not.toHaveBeenCalled();
        });

        it('returns empty array when no members exist', async () => {
            memberRepository.findByWork.mockResolvedValue([]);

            const result = await service.listMembers('w-1', 'u-1');

            expect(result).toEqual([]);
        });
    });

    describe('inviteMember', () => {
        it('happy path: ensureCanManageMembers → role-check → findByEmail → creator-check → existing-check → findById(inviter) → addMember → findById(member)', async () => {
            const order: string[] = [];
            const work = buildWork();
            ownershipService.ensureCanManageMembers.mockImplementation(async () => {
                order.push('ensureCanManageMembers');
                return { work };
            });
            const invitee = buildUser({ id: 'u-2', email: 'invitee@example.com' });
            userRepository.findByEmail.mockImplementation(async () => {
                order.push('findByEmail');
                return invitee;
            });
            memberRepository.findMember.mockImplementation(async () => {
                order.push('findMember');
                return null;
            });
            const inviter = buildUser({ id: 'u-1', username: 'inviter' });
            userRepository.findById.mockImplementation(async () => {
                order.push('findById(inviter)');
                return inviter;
            });
            const created = buildMember({ id: 'new-m', userId: 'u-2' });
            memberRepository.addMember.mockImplementation(async () => {
                order.push('addMember');
                return created;
            });
            const fullMember = buildMember({ id: 'new-m', userId: 'u-2' });
            memberRepository.findById.mockImplementation(async () => {
                order.push('findById(member)');
                return fullMember;
            });

            const result = await service.inviteMember('w-1', 'u-1', {
                email: 'invitee@example.com',
                role: WorkMemberRole.EDITOR,
            });

            expect(order).toEqual([
                'ensureCanManageMembers',
                'findByEmail',
                'findMember',
                'findById(inviter)',
                'addMember',
                'findById(member)',
            ]);
            expect(ownershipService.ensureCanManageMembers).toHaveBeenCalledWith('w-1', 'u-1');
            expect(userRepository.findByEmail).toHaveBeenCalledWith('invitee@example.com');
            expect(memberRepository.findMember).toHaveBeenCalledWith('w-1', 'u-2');
            expect(userRepository.findById).toHaveBeenCalledWith('u-1');
            expect(memberRepository.addMember).toHaveBeenCalledWith(
                'w-1',
                'u-2',
                WorkMemberRole.EDITOR,
                'u-1',
            );
            expect(memberRepository.findById).toHaveBeenCalledWith('new-m');
            expect(result.member.id).toBe('new-m');
            expect(result.invitee).toBe(invitee);
            expect(result.inviter).toBe(inviter);
            expect(result.work).toBe(work);
        });

        it('rejects with BadRequestException when role is OWNER (not assignable)', async () => {
            ownershipService.ensureCanManageMembers.mockResolvedValue({ work: buildWork() });

            await expect(
                service.inviteMember('w-1', 'u-1', {
                    email: 'x@example.com',
                    role: WorkMemberRole.OWNER,
                }),
            ).rejects.toBeInstanceOf(BadRequestException);
            expect(userRepository.findByEmail).not.toHaveBeenCalled();
            expect(memberRepository.addMember).not.toHaveBeenCalled();
        });

        it('rejects with BadRequestException when role is unknown / arbitrary string', async () => {
            ownershipService.ensureCanManageMembers.mockResolvedValue({ work: buildWork() });

            await expect(
                service.inviteMember('w-1', 'u-1', {
                    email: 'x@example.com',
                    role: 'admin' as WorkMemberRole,
                }),
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it.each([WorkMemberRole.MANAGER, WorkMemberRole.EDITOR, WorkMemberRole.VIEWER])(
            'accepts assignable role %s',
            async (role) => {
                ownershipService.ensureCanManageMembers.mockResolvedValue({ work: buildWork() });
                userRepository.findByEmail.mockResolvedValue(buildUser({ id: 'u-2' }));
                memberRepository.findMember.mockResolvedValue(null);
                userRepository.findById.mockResolvedValue(buildUser({ id: 'u-1' }));
                memberRepository.addMember.mockResolvedValue(buildMember({ id: 'new-m', role }));
                memberRepository.findById.mockResolvedValue(buildMember({ id: 'new-m', role }));

                const result = await service.inviteMember('w-1', 'u-1', {
                    email: 'x@example.com',
                    role,
                });

                expect(result.member.role).toBe(role);
            },
        );

        it('pins the assignable-role list (MANAGER, EDITOR, VIEWER — OWNER excluded)', () => {
            // Regression guard: a future OWNER inclusion would be a deliberate breaking change
            expect(ASSIGNABLE_MEMBER_ROLES).toEqual([
                WorkMemberRole.MANAGER,
                WorkMemberRole.EDITOR,
                WorkMemberRole.VIEWER,
            ]);
        });

        it('throws NotFoundException with email-interpolated message when invitee email is not registered', async () => {
            ownershipService.ensureCanManageMembers.mockResolvedValue({ work: buildWork() });
            userRepository.findByEmail.mockResolvedValue(null);

            await expect(
                service.inviteMember('w-1', 'u-1', {
                    email: 'missing@example.com',
                    role: WorkMemberRole.EDITOR,
                }),
            ).rejects.toMatchObject({
                response: {
                    status: 'error',
                    message: "User with email 'missing@example.com' not found",
                },
            });
            expect(memberRepository.findMember).not.toHaveBeenCalled();
        });

        it('throws BadRequestException when invitee is the work creator', async () => {
            const work = buildWork({ userId: 'creator-1' });
            ownershipService.ensureCanManageMembers.mockResolvedValue({ work });
            userRepository.findByEmail.mockResolvedValue(buildUser({ id: 'creator-1' }));

            await expect(
                service.inviteMember('w-1', 'u-1', {
                    email: 'creator@example.com',
                    role: WorkMemberRole.EDITOR,
                }),
            ).rejects.toMatchObject({
                response: {
                    status: 'error',
                    message: 'Cannot add the work creator as a member',
                },
            });
            expect(memberRepository.findMember).not.toHaveBeenCalled();
            expect(memberRepository.addMember).not.toHaveBeenCalled();
        });

        it('throws BadRequestException when invitee is already a member', async () => {
            ownershipService.ensureCanManageMembers.mockResolvedValue({ work: buildWork() });
            userRepository.findByEmail.mockResolvedValue(buildUser({ id: 'u-2' }));
            memberRepository.findMember.mockResolvedValue(buildMember({ id: 'existing' }));

            await expect(
                service.inviteMember('w-1', 'u-1', {
                    email: 'invitee@example.com',
                    role: WorkMemberRole.EDITOR,
                }),
            ).rejects.toMatchObject({
                response: {
                    status: 'error',
                    message: 'User is already a member of this work',
                },
            });
            expect(memberRepository.addMember).not.toHaveBeenCalled();
        });

        it('short-circuits when ensureCanManageMembers rejects', async () => {
            const err = new ForbiddenException('forbidden');
            ownershipService.ensureCanManageMembers.mockRejectedValueOnce(err);

            await expect(
                service.inviteMember('w-1', 'u-1', {
                    email: 'x@example.com',
                    role: WorkMemberRole.EDITOR,
                }),
            ).rejects.toBe(err);
            expect(userRepository.findByEmail).not.toHaveBeenCalled();
        });

        it('forwards positional (workId, inviteeId, role, inviterId) to addMember — pinned arg order', async () => {
            ownershipService.ensureCanManageMembers.mockResolvedValue({ work: buildWork() });
            userRepository.findByEmail.mockResolvedValue(buildUser({ id: 'u-2' }));
            memberRepository.findMember.mockResolvedValue(null);
            userRepository.findById.mockResolvedValue(buildUser({ id: 'u-1' }));
            memberRepository.addMember.mockResolvedValue(buildMember({ id: 'new-m' }));
            memberRepository.findById.mockResolvedValue(buildMember({ id: 'new-m' }));

            await service.inviteMember('w-1', 'u-1', {
                email: 'invitee@example.com',
                role: WorkMemberRole.MANAGER,
            });

            expect(memberRepository.addMember).toHaveBeenCalledWith(
                'w-1',
                'u-2',
                WorkMemberRole.MANAGER,
                'u-1',
            );
        });
    });

    describe('updateMemberRole', () => {
        it('happy path: ensureCanManageMembers → findById → role-check → updateRole', async () => {
            const order: string[] = [];
            ownershipService.ensureCanManageMembers.mockImplementation(async () => {
                order.push('ensureCanManageMembers');
                return { work: buildWork() };
            });
            const member = buildMember({ id: 'm-1', userId: 'u-2', workId: 'w-1' });
            memberRepository.findById.mockImplementation(async () => {
                order.push('findById');
                return member;
            });
            const updated = buildMember({ id: 'm-1', userId: 'u-2', role: WorkMemberRole.MANAGER });
            memberRepository.updateRole.mockImplementation(async () => {
                order.push('updateRole');
                return updated;
            });

            const result = await service.updateMemberRole('w-1', 'u-1', 'm-1', {
                role: WorkMemberRole.MANAGER,
            });

            expect(order).toEqual(['ensureCanManageMembers', 'findById', 'updateRole']);
            expect(ownershipService.ensureCanManageMembers).toHaveBeenCalledWith('w-1', 'u-1');
            expect(memberRepository.findById).toHaveBeenCalledWith('m-1');
            expect(memberRepository.updateRole).toHaveBeenCalledWith(
                'w-1',
                'u-2',
                WorkMemberRole.MANAGER,
            );
            expect(result.role).toBe(WorkMemberRole.MANAGER);
        });

        it('throws NotFoundException when member is missing', async () => {
            ownershipService.ensureCanManageMembers.mockResolvedValue({ work: buildWork() });
            memberRepository.findById.mockResolvedValue(null);

            await expect(
                service.updateMemberRole('w-1', 'u-1', 'm-missing', {
                    role: WorkMemberRole.EDITOR,
                }),
            ).rejects.toMatchObject({
                response: { status: 'error', message: 'Member not found' },
            });
            expect(memberRepository.updateRole).not.toHaveBeenCalled();
        });

        it('throws NotFoundException when memberId resolves to a different work (cross-work safety)', async () => {
            ownershipService.ensureCanManageMembers.mockResolvedValue({ work: buildWork() });
            memberRepository.findById.mockResolvedValue(
                buildMember({ id: 'm-1', workId: 'w-OTHER' }),
            );

            await expect(
                service.updateMemberRole('w-1', 'u-1', 'm-1', {
                    role: WorkMemberRole.EDITOR,
                }),
            ).rejects.toBeInstanceOf(NotFoundException);
            expect(memberRepository.updateRole).not.toHaveBeenCalled();
        });

        it('rejects with BadRequestException when role is OWNER (cannot promote a member to owner)', async () => {
            ownershipService.ensureCanManageMembers.mockResolvedValue({ work: buildWork() });
            memberRepository.findById.mockResolvedValue(buildMember({ workId: 'w-1' }));

            await expect(
                service.updateMemberRole('w-1', 'u-1', 'm-1', { role: WorkMemberRole.OWNER }),
            ).rejects.toBeInstanceOf(BadRequestException);
            expect(memberRepository.updateRole).not.toHaveBeenCalled();
        });

        it('rejects with BadRequestException when role is an arbitrary string', async () => {
            ownershipService.ensureCanManageMembers.mockResolvedValue({ work: buildWork() });
            memberRepository.findById.mockResolvedValue(buildMember({ workId: 'w-1' }));

            await expect(
                service.updateMemberRole('w-1', 'u-1', 'm-1', { role: 'admin' as WorkMemberRole }),
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('forwards (workId, member.userId, role) to updateRole — uses member.userId NOT memberId', async () => {
            ownershipService.ensureCanManageMembers.mockResolvedValue({ work: buildWork() });
            memberRepository.findById.mockResolvedValue(
                buildMember({ id: 'm-XYZ', userId: 'u-target', workId: 'w-1' }),
            );
            memberRepository.updateRole.mockResolvedValue(
                buildMember({ id: 'm-XYZ', userId: 'u-target', role: WorkMemberRole.VIEWER }),
            );

            await service.updateMemberRole('w-1', 'u-1', 'm-XYZ', {
                role: WorkMemberRole.VIEWER,
            });

            // Pinned: composite key uses (workId, userId), not memberId.
            expect(memberRepository.updateRole).toHaveBeenCalledWith(
                'w-1',
                'u-target',
                WorkMemberRole.VIEWER,
            );
        });

        it('short-circuits when ensureCanManageMembers rejects', async () => {
            const err = new ForbiddenException('forbidden');
            ownershipService.ensureCanManageMembers.mockRejectedValueOnce(err);

            await expect(
                service.updateMemberRole('w-1', 'u-1', 'm-1', {
                    role: WorkMemberRole.EDITOR,
                }),
            ).rejects.toBe(err);
            expect(memberRepository.findById).not.toHaveBeenCalled();
        });
    });

    describe('removeMember', () => {
        it('happy path: ensureCanManageMembers → findById → removeMember (composite key on workId+userId)', async () => {
            const order: string[] = [];
            ownershipService.ensureCanManageMembers.mockImplementation(async () => {
                order.push('ensureCanManageMembers');
                return { work: buildWork() };
            });
            memberRepository.findById.mockImplementation(async () => {
                order.push('findById');
                return buildMember({ id: 'm-1', userId: 'u-2', workId: 'w-1' });
            });
            memberRepository.removeMember.mockImplementation(async () => {
                order.push('removeMember');
                return true;
            });

            await service.removeMember('w-1', 'u-1', 'm-1');

            expect(order).toEqual(['ensureCanManageMembers', 'findById', 'removeMember']);
            expect(memberRepository.removeMember).toHaveBeenCalledWith('w-1', 'u-2');
        });

        it('throws NotFoundException when memberId is missing', async () => {
            ownershipService.ensureCanManageMembers.mockResolvedValue({ work: buildWork() });
            memberRepository.findById.mockResolvedValue(null);

            await expect(service.removeMember('w-1', 'u-1', 'm-missing')).rejects.toMatchObject({
                response: { status: 'error', message: 'Member not found' },
            });
            expect(memberRepository.removeMember).not.toHaveBeenCalled();
        });

        it('throws NotFoundException when memberId belongs to a different work', async () => {
            ownershipService.ensureCanManageMembers.mockResolvedValue({ work: buildWork() });
            memberRepository.findById.mockResolvedValue(
                buildMember({ id: 'm-1', workId: 'w-OTHER' }),
            );

            await expect(service.removeMember('w-1', 'u-1', 'm-1')).rejects.toBeInstanceOf(
                NotFoundException,
            );
            expect(memberRepository.removeMember).not.toHaveBeenCalled();
        });

        it('does NOT inspect the boolean returned by removeMember (fire-and-forget — unlike leaveWork)', async () => {
            // Pinned current behaviour: removeMember always returns void from the service
            // even when the row had already been deleted (returns false). This is asymmetric
            // with leaveWork which DOES throw on false. A future tightening would be deliberate.
            ownershipService.ensureCanManageMembers.mockResolvedValue({ work: buildWork() });
            memberRepository.findById.mockResolvedValue(buildMember({ id: 'm-1', workId: 'w-1' }));
            memberRepository.removeMember.mockResolvedValue(false);

            await expect(service.removeMember('w-1', 'u-1', 'm-1')).resolves.toBeUndefined();
        });

        it('short-circuits when ensureCanManageMembers rejects', async () => {
            const err = new ForbiddenException('forbidden');
            ownershipService.ensureCanManageMembers.mockRejectedValueOnce(err);

            await expect(service.removeMember('w-1', 'u-1', 'm-1')).rejects.toBe(err);
            expect(memberRepository.findById).not.toHaveBeenCalled();
        });
    });

    describe('leaveWork', () => {
        it('happy path: non-creator with membership → removeMember(workId, userId)', async () => {
            const order: string[] = [];
            ownershipService.ensureCanView.mockImplementation(async () => {
                order.push('ensureCanView');
                return { isCreator: false };
            });
            memberRepository.removeMember.mockImplementation(async () => {
                order.push('removeMember');
                return true;
            });

            await service.leaveWork('w-1', 'u-2');

            expect(order).toEqual(['ensureCanView', 'removeMember']);
            expect(ownershipService.ensureCanView).toHaveBeenCalledWith('w-1', 'u-2');
            expect(memberRepository.removeMember).toHaveBeenCalledWith('w-1', 'u-2');
        });

        it('rejects with BadRequestException when caller is the work creator', async () => {
            ownershipService.ensureCanView.mockResolvedValue({ isCreator: true });

            await expect(service.leaveWork('w-1', 'creator-1')).rejects.toMatchObject({
                response: {
                    status: 'error',
                    message: 'Work creator cannot leave the work',
                },
            });
            expect(memberRepository.removeMember).not.toHaveBeenCalled();
        });

        it('throws NotFoundException when removeMember returns false (caller had no membership row)', async () => {
            ownershipService.ensureCanView.mockResolvedValue({ isCreator: false });
            memberRepository.removeMember.mockResolvedValue(false);

            await expect(service.leaveWork('w-1', 'u-2')).rejects.toMatchObject({
                response: {
                    status: 'error',
                    message: 'You are not a member of this work',
                },
            });
        });

        it('short-circuits when ensureCanView rejects', async () => {
            const err = new ForbiddenException('forbidden');
            ownershipService.ensureCanView.mockRejectedValueOnce(err);

            await expect(service.leaveWork('w-1', 'u-2')).rejects.toBe(err);
            expect(memberRepository.removeMember).not.toHaveBeenCalled();
        });
    });

    describe('getMember', () => {
        it('happy path: ensureCanView → findById → toDto', async () => {
            const order: string[] = [];
            ownershipService.ensureCanView.mockImplementation(async () => {
                order.push('ensureCanView');
                return { isCreator: false };
            });
            memberRepository.findById.mockImplementation(async () => {
                order.push('findById');
                return buildMember({ id: 'm-1', workId: 'w-1' });
            });

            const result = await service.getMember('w-1', 'u-1', 'm-1');

            expect(order).toEqual(['ensureCanView', 'findById']);
            expect(memberRepository.findById).toHaveBeenCalledWith('m-1');
            expect(result.id).toBe('m-1');
        });

        it('throws NotFoundException when member is missing', async () => {
            memberRepository.findById.mockResolvedValue(null);

            await expect(service.getMember('w-1', 'u-1', 'm-missing')).rejects.toBeInstanceOf(
                NotFoundException,
            );
        });

        it('throws NotFoundException when member belongs to a different work', async () => {
            memberRepository.findById.mockResolvedValue(
                buildMember({ id: 'm-1', workId: 'w-OTHER' }),
            );

            await expect(service.getMember('w-1', 'u-1', 'm-1')).rejects.toBeInstanceOf(
                NotFoundException,
            );
        });

        it('short-circuits when ensureCanView rejects', async () => {
            const err = new ForbiddenException('forbidden');
            ownershipService.ensureCanView.mockRejectedValueOnce(err);

            await expect(service.getMember('w-1', 'u-1', 'm-1')).rejects.toBe(err);
            expect(memberRepository.findById).not.toHaveBeenCalled();
        });
    });

    describe('getWorkOwnerInfo', () => {
        it('returns full owner snapshot from work.user', async () => {
            const work = buildWork({
                user: buildUser({
                    id: 'creator-1',
                    username: 'creator',
                    email: 'creator@example.com',
                    avatar: 'https://example.com/c.png',
                }),
            });
            ownershipService.ensureCanView.mockResolvedValue({ work, isCreator: false });

            const result = await service.getWorkOwnerInfo('w-1', 'u-2');

            expect(ownershipService.ensureCanView).toHaveBeenCalledWith('w-1', 'u-2');
            expect(result).toEqual({
                id: 'creator-1',
                username: 'creator',
                email: 'creator@example.com',
                avatar: 'https://example.com/c.png',
            });
        });

        it('passes through undefined avatar', async () => {
            const work = buildWork({
                user: buildUser({
                    id: 'creator-1',
                    username: 'creator',
                    email: 'creator@example.com',
                    avatar: undefined,
                }),
            });
            ownershipService.ensureCanView.mockResolvedValue({ work, isCreator: false });

            const result = await service.getWorkOwnerInfo('w-1', 'u-2');

            expect(result.avatar).toBeUndefined();
        });

        it('short-circuits when ensureCanView rejects', async () => {
            const err = new ForbiddenException('forbidden');
            ownershipService.ensureCanView.mockRejectedValueOnce(err);

            await expect(service.getWorkOwnerInfo('w-1', 'u-2')).rejects.toBe(err);
        });
    });

    describe('toDto (observed via listMembers)', () => {
        it('falls back to "Unknown" username when member.user is missing', async () => {
            memberRepository.findByWork.mockResolvedValue([
                buildMember({ id: 'm-1', user: undefined as any }),
            ]);

            const [dto] = await service.listMembers('w-1', 'u-1');

            expect(dto.username).toBe('Unknown');
            expect(dto.email).toBe('');
            expect(dto.avatar).toBeUndefined();
        });

        it('falls back to "Unknown" / empty-string when user has falsy username/email (defensive)', async () => {
            memberRepository.findByWork.mockResolvedValue([
                buildMember({
                    id: 'm-1',
                    user: { id: 'u-x', username: '', email: '', avatar: undefined } as any,
                }),
            ]);

            const [dto] = await service.listMembers('w-1', 'u-1');

            // `user?.username || 'Unknown'` short-circuits empty-string to "Unknown" (NOT ?? — pinned)
            expect(dto.username).toBe('Unknown');
            expect(dto.email).toBe('');
        });

        it('omits invitedBy when member.invitedBy is undefined', async () => {
            memberRepository.findByWork.mockResolvedValue([
                buildMember({ id: 'm-1', invitedBy: undefined as any }),
            ]);

            const [dto] = await service.listMembers('w-1', 'u-1');

            expect(dto.invitedBy).toBeUndefined();
        });

        it('preserves invitedBy id+username only (not email/avatar — minimal projection)', async () => {
            memberRepository.findByWork.mockResolvedValue([
                buildMember({
                    id: 'm-1',
                    invitedBy: buildUser({
                        id: 'inv-1',
                        username: 'inviter',
                        email: 'inv@example.com',
                        avatar: 'https://example.com/inv.png',
                    }) as any,
                }),
            ]);

            const [dto] = await service.listMembers('w-1', 'u-1');

            expect(dto.invitedBy).toEqual({ id: 'inv-1', username: 'inviter' });
            expect(dto.invitedBy).not.toHaveProperty('email');
            expect(dto.invitedBy).not.toHaveProperty('avatar');
        });

        it('serialises createdAt via Date.toISOString()', async () => {
            memberRepository.findByWork.mockResolvedValue([
                buildMember({
                    id: 'm-1',
                    createdAt: new Date('2026-05-09T08:30:45.678Z'),
                }),
            ]);

            const [dto] = await service.listMembers('w-1', 'u-1');

            expect(dto.createdAt).toBe('2026-05-09T08:30:45.678Z');
        });
    });
});
