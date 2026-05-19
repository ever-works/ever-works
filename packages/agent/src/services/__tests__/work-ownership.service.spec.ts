import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { WorkOwnershipService } from '../work-ownership.service';
import { WorkMemberRole } from '@src/entities/types';

describe('WorkOwnershipService', () => {
    let workRepository: { findByIdForAccess: jest.Mock };
    let workMemberRepository: { findMember: jest.Mock };
    let service: WorkOwnershipService;

    beforeEach(() => {
        workRepository = { findByIdForAccess: jest.fn() };
        workMemberRepository = { findMember: jest.fn() };
        service = new WorkOwnershipService(workRepository as any, workMemberRepository as any);
    });

    const buildMember = (
        role: WorkMemberRole,
        overrides: Partial<{ hasRoleOrHigher: (r: WorkMemberRole) => boolean }> = {},
    ) => {
        const hierarchy: Record<WorkMemberRole, number> = {
            [WorkMemberRole.OWNER]: 4,
            [WorkMemberRole.MANAGER]: 3,
            [WorkMemberRole.EDITOR]: 2,
            [WorkMemberRole.VIEWER]: 1,
        };
        return {
            role,
            hasRoleOrHigher:
                overrides.hasRoleOrHigher ??
                jest.fn((r: WorkMemberRole) => hierarchy[role] >= hierarchy[r]),
        };
    };

    describe('ensureAccess', () => {
        it('throws NotFoundException with status:error envelope when work is missing', async () => {
            workRepository.findByIdForAccess.mockResolvedValue(null);

            await expect(service.ensureAccess('missing-id', 'user-1')).rejects.toBeInstanceOf(
                NotFoundException,
            );

            workRepository.findByIdForAccess.mockResolvedValue(null);
            await expect(service.ensureAccess('missing-id', 'user-1')).rejects.toMatchObject({
                response: {
                    status: 'error',
                    message: "Work with id 'missing-id' not found",
                },
            });
            expect(workMemberRepository.findMember).not.toHaveBeenCalled();
        });

        it('returns OWNER + isCreator:true when caller is the work creator and skips membership lookup', async () => {
            const work = { id: 'w-1', userId: 'user-1' };
            workRepository.findByIdForAccess.mockResolvedValue(work);

            const result = await service.ensureAccess('w-1', 'user-1');

            expect(result).toEqual({
                work,
                member: null,
                role: WorkMemberRole.OWNER,
                isCreator: true,
            });
            expect(workMemberRepository.findMember).not.toHaveBeenCalled();
        });

        it.each([
            WorkMemberRole.OWNER,
            WorkMemberRole.MANAGER,
            WorkMemberRole.EDITOR,
            WorkMemberRole.VIEWER,
        ])(
            'creator passes minimumRole=%s without invoking member.hasRoleOrHigher',
            async (minimumRole) => {
                const work = { id: 'w-1', userId: 'user-1' };
                workRepository.findByIdForAccess.mockResolvedValue(work);

                const result = await service.ensureAccess('w-1', 'user-1', minimumRole);

                expect(result.role).toBe(WorkMemberRole.OWNER);
                expect(result.isCreator).toBe(true);
                expect(result.member).toBeNull();
                expect(workMemberRepository.findMember).not.toHaveBeenCalled();
            },
        );

        it('throws ForbiddenException when non-creator has no membership row', async () => {
            workRepository.findByIdForAccess.mockResolvedValue({ id: 'w-1', userId: 'creator' });
            workMemberRepository.findMember.mockResolvedValue(null);

            await expect(service.ensureAccess('w-1', 'other-user')).rejects.toBeInstanceOf(
                ForbiddenException,
            );

            workRepository.findByIdForAccess.mockResolvedValue({ id: 'w-1', userId: 'creator' });
            workMemberRepository.findMember.mockResolvedValue(null);
            await expect(service.ensureAccess('w-1', 'other-user')).rejects.toMatchObject({
                response: {
                    status: 'error',
                    message: 'You do not have permission to access this work',
                },
            });
        });

        it('returns membership info when non-creator has a member row and no minimumRole', async () => {
            const work = { id: 'w-1', userId: 'creator' };
            const member = buildMember(WorkMemberRole.VIEWER);
            workRepository.findByIdForAccess.mockResolvedValue(work);
            workMemberRepository.findMember.mockResolvedValue(member);

            const result = await service.ensureAccess('w-1', 'other-user');

            expect(result).toEqual({
                work,
                member,
                role: WorkMemberRole.VIEWER,
                isCreator: false,
            });
            expect(workMemberRepository.findMember).toHaveBeenCalledWith('w-1', 'other-user');
            // No minimumRole supplied → hasRoleOrHigher must NOT be invoked.
            expect(member.hasRoleOrHigher).not.toHaveBeenCalled();
        });

        it('throws ForbiddenException with permission-level copy when membership role is below minimumRole', async () => {
            const work = { id: 'w-1', userId: 'creator' };
            const member = buildMember(WorkMemberRole.VIEWER);
            workRepository.findByIdForAccess.mockResolvedValue(work);
            workMemberRepository.findMember.mockResolvedValue(member);

            await expect(
                service.ensureAccess('w-1', 'other-user', WorkMemberRole.EDITOR),
            ).rejects.toMatchObject({
                response: {
                    status: 'error',
                    message: 'You do not have the required permission level for this action',
                },
            });
            expect(member.hasRoleOrHigher).toHaveBeenCalledWith(WorkMemberRole.EDITOR);
        });

        it('returns membership info when member.hasRoleOrHigher passes the minimumRole gate', async () => {
            const work = { id: 'w-1', userId: 'creator' };
            const member = buildMember(WorkMemberRole.MANAGER);
            workRepository.findByIdForAccess.mockResolvedValue(work);
            workMemberRepository.findMember.mockResolvedValue(member);

            const result = await service.ensureAccess('w-1', 'other-user', WorkMemberRole.EDITOR);

            expect(result.role).toBe(WorkMemberRole.MANAGER);
            expect(result.isCreator).toBe(false);
            expect(result.member).toBe(member);
            expect(member.hasRoleOrHigher).toHaveBeenCalledWith(WorkMemberRole.EDITOR);
        });

        it.each<[WorkMemberRole, WorkMemberRole, boolean]>([
            // member role | minimum required | should pass
            [WorkMemberRole.MANAGER, WorkMemberRole.MANAGER, true],
            [WorkMemberRole.MANAGER, WorkMemberRole.EDITOR, true],
            [WorkMemberRole.MANAGER, WorkMemberRole.VIEWER, true],
            [WorkMemberRole.EDITOR, WorkMemberRole.MANAGER, false],
            [WorkMemberRole.EDITOR, WorkMemberRole.EDITOR, true],
            [WorkMemberRole.EDITOR, WorkMemberRole.VIEWER, true],
            [WorkMemberRole.VIEWER, WorkMemberRole.MANAGER, false],
            [WorkMemberRole.VIEWER, WorkMemberRole.EDITOR, false],
            [WorkMemberRole.VIEWER, WorkMemberRole.VIEWER, true],
        ])(
            'member role hierarchy: %s vs minimum %s → passes=%s',
            async (role, minimum, shouldPass) => {
                const work = { id: 'w-1', userId: 'creator' };
                const member = buildMember(role);
                workRepository.findByIdForAccess.mockResolvedValue(work);
                workMemberRepository.findMember.mockResolvedValue(member);

                if (shouldPass) {
                    const result = await service.ensureAccess('w-1', 'other-user', minimum);
                    expect(result.role).toBe(role);
                } else {
                    await expect(
                        service.ensureAccess('w-1', 'other-user', minimum),
                    ).rejects.toBeInstanceOf(ForbiddenException);
                }
            },
        );
    });

    describe('ensureCanView / ensureCanEdit / ensureCanManageMembers / ensureIsOwner', () => {
        it('ensureCanView delegates to ensureAccess with VIEWER', async () => {
            const spy = jest.spyOn(service, 'ensureAccess').mockResolvedValue({} as any);
            await service.ensureCanView('w-1', 'u-1');
            expect(spy).toHaveBeenCalledWith('w-1', 'u-1', WorkMemberRole.VIEWER);
        });

        it('ensureCanEdit delegates to ensureAccess with EDITOR', async () => {
            const spy = jest.spyOn(service, 'ensureAccess').mockResolvedValue({} as any);
            await service.ensureCanEdit('w-1', 'u-1');
            expect(spy).toHaveBeenCalledWith('w-1', 'u-1', WorkMemberRole.EDITOR);
        });

        it('ensureCanManageMembers delegates to ensureAccess with MANAGER', async () => {
            const spy = jest.spyOn(service, 'ensureAccess').mockResolvedValue({} as any);
            await service.ensureCanManageMembers('w-1', 'u-1');
            expect(spy).toHaveBeenCalledWith('w-1', 'u-1', WorkMemberRole.MANAGER);
        });

        it('ensureIsOwner delegates to ensureAccess with OWNER', async () => {
            const spy = jest.spyOn(service, 'ensureAccess').mockResolvedValue({} as any);
            await service.ensureIsOwner('w-1', 'u-1');
            expect(spy).toHaveBeenCalledWith('w-1', 'u-1', WorkMemberRole.OWNER);
        });

        it('the four convenience methods propagate the underlying error verbatim', async () => {
            const err = new ForbiddenException('nope');
            jest.spyOn(service, 'ensureAccess').mockRejectedValue(err);

            await expect(service.ensureCanView('w-1', 'u-1')).rejects.toBe(err);
            await expect(service.ensureCanEdit('w-1', 'u-1')).rejects.toBe(err);
            await expect(service.ensureCanManageMembers('w-1', 'u-1')).rejects.toBe(err);
            await expect(service.ensureIsOwner('w-1', 'u-1')).rejects.toBe(err);
        });
    });

    describe('hasAccess', () => {
        it('returns true when ensureAccess resolves', async () => {
            jest.spyOn(service, 'ensureAccess').mockResolvedValue({} as any);

            await expect(service.hasAccess('w-1', 'u-1')).resolves.toBe(true);
        });

        it('returns false when ensureAccess throws NotFoundException', async () => {
            jest.spyOn(service, 'ensureAccess').mockRejectedValue(new NotFoundException());
            await expect(service.hasAccess('w-1', 'u-1')).resolves.toBe(false);
        });

        it('returns false when ensureAccess throws ForbiddenException', async () => {
            jest.spyOn(service, 'ensureAccess').mockRejectedValue(new ForbiddenException());
            await expect(service.hasAccess('w-1', 'u-1')).resolves.toBe(false);
        });

        it('swallows non-NestJS errors too (any throw → false)', async () => {
            jest.spyOn(service, 'ensureAccess').mockRejectedValue(new Error('database down'));
            await expect(service.hasAccess('w-1', 'u-1')).resolves.toBe(false);
        });

        it('forwards the workId + userId positional pair to ensureAccess WITHOUT a minimumRole', async () => {
            const spy = jest.spyOn(service, 'ensureAccess').mockResolvedValue({} as any);
            await service.hasAccess('w-1', 'u-1');
            expect(spy).toHaveBeenCalledWith('w-1', 'u-1');
            // Pin: hasAccess intentionally omits minimumRole so any access level returns true.
            expect(spy.mock.calls[0]).toHaveLength(2);
        });
    });

    describe('getUserRole', () => {
        it('returns null when work does not exist (without consulting member repo)', async () => {
            workRepository.findByIdForAccess.mockResolvedValue(null);

            await expect(service.getUserRole('missing', 'u-1')).resolves.toBeNull();
            expect(workMemberRepository.findMember).not.toHaveBeenCalled();
        });

        it('returns OWNER for the work creator without consulting member repo', async () => {
            workRepository.findByIdForAccess.mockResolvedValue({ id: 'w-1', userId: 'u-1' });

            await expect(service.getUserRole('w-1', 'u-1')).resolves.toBe(WorkMemberRole.OWNER);
            expect(workMemberRepository.findMember).not.toHaveBeenCalled();
        });

        it.each([WorkMemberRole.MANAGER, WorkMemberRole.EDITOR, WorkMemberRole.VIEWER])(
            'returns the member role (%s) for non-creators',
            async (role) => {
                workRepository.findByIdForAccess.mockResolvedValue({
                    id: 'w-1',
                    userId: 'creator',
                });
                workMemberRepository.findMember.mockResolvedValue(buildMember(role));

                await expect(service.getUserRole('w-1', 'other-user')).resolves.toBe(role);
                expect(workMemberRepository.findMember).toHaveBeenCalledWith('w-1', 'other-user');
            },
        );

        it('returns null when caller is neither creator nor member', async () => {
            workRepository.findByIdForAccess.mockResolvedValue({ id: 'w-1', userId: 'creator' });
            workMemberRepository.findMember.mockResolvedValue(null);

            await expect(service.getUserRole('w-1', 'other-user')).resolves.toBeNull();
        });

        it('coerces falsy member.role to null via the `||` short-circuit', async () => {
            workRepository.findByIdForAccess.mockResolvedValue({ id: 'w-1', userId: 'creator' });
            // Deliberately produce a member with a falsy role value (defensive — not a
            // shape the repository ever yields, but the `member?.role || null` fallback
            // documents that the contract is "non-empty role string OR null").
            workMemberRepository.findMember.mockResolvedValue({ role: '' });

            await expect(service.getUserRole('w-1', 'other-user')).resolves.toBeNull();
        });
    });
});
