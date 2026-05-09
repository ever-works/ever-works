import type { Repository } from 'typeorm';
import { In } from 'typeorm';
import { WorkMemberRepository } from '../work-member.repository';
import { WorkMember } from '../../../entities/work-member.entity';
import { WorkMemberRole } from '../../../entities/types';

type Mocked = jest.Mocked<
    Pick<
        Repository<WorkMember>,
        'create' | 'save' | 'findOne' | 'find' | 'count' | 'update' | 'delete'
    >
>;

describe('WorkMemberRepository', () => {
    let repository: Mocked;
    let service: WorkMemberRepository;

    beforeEach(() => {
        repository = {
            create: jest.fn(),
            save: jest.fn(),
            findOne: jest.fn(),
            find: jest.fn(),
            count: jest.fn(),
            update: jest.fn(),
            delete: jest.fn(),
        };
        service = new WorkMemberRepository(repository as unknown as Repository<WorkMember>);
    });

    describe('addMember', () => {
        it('forwards workId/userId/role/invitedById verbatim to create+save', async () => {
            const created = {} as WorkMember;
            const saved = { id: 'm1' } as WorkMember;
            repository.create.mockReturnValueOnce(created);
            repository.save.mockResolvedValueOnce(saved);

            const result = await service.addMember('w1', 'u1', WorkMemberRole.EDITOR, 'inviter-1');

            expect(result).toBe(saved);
            expect(repository.create).toHaveBeenCalledWith({
                workId: 'w1',
                userId: 'u1',
                role: WorkMemberRole.EDITOR,
                invitedById: 'inviter-1',
            });
            expect(repository.save).toHaveBeenCalledWith(created);
        });

        it('passes invitedById:undefined when omitted (NOT defaulted to null) so a future tightening to `?? null` would be a deliberate change', async () => {
            repository.create.mockReturnValueOnce({} as WorkMember);
            repository.save.mockResolvedValueOnce({} as WorkMember);

            await service.addMember('w1', 'u1', WorkMemberRole.MANAGER);

            expect(repository.create).toHaveBeenCalledWith({
                workId: 'w1',
                userId: 'u1',
                role: WorkMemberRole.MANAGER,
                invitedById: undefined,
            });
        });
    });

    describe('findMember', () => {
        it('queries by composite (workId, userId) with user/work/invitedBy joined', async () => {
            const row = { id: 'm1' } as WorkMember;
            repository.findOne.mockResolvedValueOnce(row);

            await expect(service.findMember('w1', 'u1')).resolves.toBe(row);

            expect(repository.findOne).toHaveBeenCalledWith({
                where: { workId: 'w1', userId: 'u1' },
                relations: ['user', 'work', 'invitedBy'],
            });
        });

        it('returns null when no row matches', async () => {
            repository.findOne.mockResolvedValueOnce(null);
            await expect(service.findMember('w1', 'u1')).resolves.toBeNull();
        });
    });

    describe('findById', () => {
        it('queries by id with the same three relations as findMember (so callers can pivot between lookups w/o re-fetching joins)', async () => {
            const row = { id: 'm1' } as WorkMember;
            repository.findOne.mockResolvedValueOnce(row);

            await expect(service.findById('m1')).resolves.toBe(row);

            expect(repository.findOne).toHaveBeenCalledWith({
                where: { id: 'm1' },
                relations: ['user', 'work', 'invitedBy'],
            });
        });
    });

    describe('findByWork', () => {
        it('lists members of a work ordered by createdAt:ASC (so the original invite order is preserved in the UI), joining user + invitedBy (NOT work — the caller already has it)', async () => {
            const rows = [{ id: 'm1' } as WorkMember];
            repository.find.mockResolvedValueOnce(rows);

            await expect(service.findByWork('w1')).resolves.toBe(rows);

            expect(repository.find).toHaveBeenCalledWith({
                where: { workId: 'w1' },
                relations: ['user', 'invitedBy'],
                order: { createdAt: 'ASC' },
            });
        });
    });

    describe('findByUser', () => {
        it('lists memberships for a user ordered by createdAt:DESC (so newest invites surface first in the dashboard) and joins work + work.user', async () => {
            const rows = [{ id: 'm1' } as WorkMember];
            repository.find.mockResolvedValueOnce(rows);

            await expect(service.findByUser('u1')).resolves.toBe(rows);

            expect(repository.find).toHaveBeenCalledWith({
                where: { userId: 'u1' },
                relations: ['work', 'work.user'],
                order: { createdAt: 'DESC' },
            });
        });
    });

    describe('getAccessibleWorkIds', () => {
        it('selects only workId column to keep the result lean (avoid pulling user/work joins into the dashboard auth check) and returns a fresh array', async () => {
            repository.find.mockResolvedValueOnce([
                { workId: 'w1' } as WorkMember,
                { workId: 'w2' } as WorkMember,
            ]);

            const result = await service.getAccessibleWorkIds('u1');

            expect(result).toEqual(['w1', 'w2']);
            expect(repository.find).toHaveBeenCalledWith({
                where: { userId: 'u1' },
                select: ['workId'],
            });
        });

        it('returns empty array when user has no memberships', async () => {
            repository.find.mockResolvedValueOnce([]);
            await expect(service.getAccessibleWorkIds('u1')).resolves.toEqual([]);
        });
    });

    describe('isMember', () => {
        it('returns true when count > 0', async () => {
            repository.count.mockResolvedValueOnce(1);
            await expect(service.isMember('w1', 'u1')).resolves.toBe(true);

            expect(repository.count).toHaveBeenCalledWith({
                where: { workId: 'w1', userId: 'u1' },
            });
        });

        it('returns false when count === 0', async () => {
            repository.count.mockResolvedValueOnce(0);
            await expect(service.isMember('w1', 'u1')).resolves.toBe(false);
        });
    });

    describe('hasRole', () => {
        it('returns false when no membership exists (skipping the hierarchy check entirely)', async () => {
            repository.findOne.mockResolvedValueOnce(null);

            await expect(service.hasRole('w1', 'u1', WorkMemberRole.EDITOR)).resolves.toBe(false);
        });

        it('delegates to member.hasRoleOrHigher when a row exists — MANAGER passes the EDITOR threshold', async () => {
            const member = {
                role: WorkMemberRole.MANAGER,
                hasRoleOrHigher: jest.fn().mockReturnValue(true),
            } as unknown as WorkMember;
            repository.findOne.mockResolvedValueOnce(member);

            await expect(service.hasRole('w1', 'u1', WorkMemberRole.EDITOR)).resolves.toBe(true);

            expect(member.hasRoleOrHigher).toHaveBeenCalledWith(WorkMemberRole.EDITOR);
        });

        it('VIEWER fails the EDITOR threshold (forwarded by hasRoleOrHigher returning false)', async () => {
            const member = {
                role: WorkMemberRole.VIEWER,
                hasRoleOrHigher: jest.fn().mockReturnValue(false),
            } as unknown as WorkMember;
            repository.findOne.mockResolvedValueOnce(member);

            await expect(service.hasRole('w1', 'u1', WorkMemberRole.EDITOR)).resolves.toBe(false);
        });
    });

    describe('updateRole', () => {
        it('updates by composite (workId, userId) then refetches via findMember so callers see the post-update relation tree', async () => {
            const refetched = { id: 'm1', role: WorkMemberRole.MANAGER } as WorkMember;
            repository.update.mockResolvedValueOnce({} as never);
            repository.findOne.mockResolvedValueOnce(refetched);

            const result = await service.updateRole('w1', 'u1', WorkMemberRole.MANAGER);

            expect(result).toBe(refetched);
            expect(repository.update).toHaveBeenCalledWith(
                { workId: 'w1', userId: 'u1' },
                { role: WorkMemberRole.MANAGER },
            );
            expect(repository.findOne).toHaveBeenCalledWith({
                where: { workId: 'w1', userId: 'u1' },
                relations: ['user', 'work', 'invitedBy'],
            });
        });

        it('returns null when the row vanished between update and refetch', async () => {
            repository.update.mockResolvedValueOnce({} as never);
            repository.findOne.mockResolvedValueOnce(null);

            await expect(service.updateRole('w1', 'u1', WorkMemberRole.EDITOR)).resolves.toBeNull();
        });
    });

    describe('removeMember', () => {
        it('deletes by composite key; affected===1 → true', async () => {
            repository.delete.mockResolvedValueOnce({ affected: 1 } as never);

            await expect(service.removeMember('w1', 'u1')).resolves.toBe(true);

            expect(repository.delete).toHaveBeenCalledWith({ workId: 'w1', userId: 'u1' });
        });

        it('affected===0 → false', async () => {
            repository.delete.mockResolvedValueOnce({ affected: 0 } as never);
            await expect(service.removeMember('w1', 'u1')).resolves.toBe(false);
        });

        it('affected===undefined → false via `(affected ?? 0) > 0` (nullish-coalesce; pinned so a future swap to `||` does not change the boundary for affected===0)', async () => {
            repository.delete.mockResolvedValueOnce({ affected: undefined } as never);
            await expect(service.removeMember('w1', 'u1')).resolves.toBe(false);
        });

        it('affected===null → false', async () => {
            repository.delete.mockResolvedValueOnce({ affected: null } as never);
            await expect(service.removeMember('w1', 'u1')).resolves.toBe(false);
        });
    });

    describe('removeAllMembers', () => {
        it('deletes by workId and returns the affected count (used when a work is being deleted)', async () => {
            repository.delete.mockResolvedValueOnce({ affected: 5 } as never);

            await expect(service.removeAllMembers('w1')).resolves.toBe(5);

            expect(repository.delete).toHaveBeenCalledWith({ workId: 'w1' });
        });

        it('coerces missing affected to 0 via `?? 0`', async () => {
            repository.delete.mockResolvedValueOnce({ affected: undefined } as never);
            await expect(service.removeAllMembers('w1')).resolves.toBe(0);
        });
    });

    describe('countMembers', () => {
        it('counts by workId only', async () => {
            repository.count.mockResolvedValueOnce(3);
            await expect(service.countMembers('w1')).resolves.toBe(3);

            expect(repository.count).toHaveBeenCalledWith({ where: { workId: 'w1' } });
        });
    });

    describe('findByRole', () => {
        it('queries by composite (workId, role) joining only user (NOT work/invitedBy — caller has work; invitedBy is irrelevant for the role filter)', async () => {
            const rows = [{ id: 'm1' } as WorkMember];
            repository.find.mockResolvedValueOnce(rows);

            await expect(service.findByRole('w1', WorkMemberRole.MANAGER)).resolves.toBe(rows);

            expect(repository.find).toHaveBeenCalledWith({
                where: { workId: 'w1', role: WorkMemberRole.MANAGER },
                relations: ['user'],
            });
        });
    });

    describe('findEditableMembers', () => {
        it('queries members with role IN (MANAGER, EDITOR) — VIEWER is intentionally excluded from "editable" so the per-work edit guard can use this list directly', async () => {
            const rows = [{ id: 'm1' } as WorkMember];
            repository.find.mockResolvedValueOnce(rows);

            await expect(service.findEditableMembers('w1')).resolves.toBe(rows);

            expect(repository.find).toHaveBeenCalledWith({
                where: {
                    workId: 'w1',
                    role: In([WorkMemberRole.MANAGER, WorkMemberRole.EDITOR]),
                },
                relations: ['user'],
            });
        });
    });

    describe('findManagers', () => {
        it('queries managers only (single-role, NOT In(...)) joining user', async () => {
            const rows = [{ id: 'm1' } as WorkMember];
            repository.find.mockResolvedValueOnce(rows);

            await expect(service.findManagers('w1')).resolves.toBe(rows);

            expect(repository.find).toHaveBeenCalledWith({
                where: { workId: 'w1', role: WorkMemberRole.MANAGER },
                relations: ['user'],
            });
        });
    });

    describe('getMemberRolesForWorks', () => {
        it('returns an empty Map when workIds is empty WITHOUT touching the repository (avoids `IN ()` SQL syntax error)', async () => {
            const result = await service.getMemberRolesForWorks('u1', []);

            expect(result).toBeInstanceOf(Map);
            expect(result.size).toBe(0);
            expect(repository.find).not.toHaveBeenCalled();
        });

        it('queries by (userId, workId IN [...]) selecting only workId+role, returns a Map<workId, role>', async () => {
            repository.find.mockResolvedValueOnce([
                { workId: 'w1', role: WorkMemberRole.MANAGER } as WorkMember,
                { workId: 'w2', role: WorkMemberRole.EDITOR } as WorkMember,
            ]);

            const result = await service.getMemberRolesForWorks('u1', ['w1', 'w2', 'w3']);

            expect(result).toBeInstanceOf(Map);
            expect(result.size).toBe(2);
            expect(result.get('w1')).toBe(WorkMemberRole.MANAGER);
            expect(result.get('w2')).toBe(WorkMemberRole.EDITOR);
            expect(result.has('w3')).toBe(false);

            expect(repository.find).toHaveBeenCalledWith({
                where: { userId: 'u1', workId: In(['w1', 'w2', 'w3']) },
                select: ['workId', 'role'],
            });
        });

        it('returns an empty Map when the user has no membership in any of the requested workIds (find returned [])', async () => {
            repository.find.mockResolvedValueOnce([]);

            const result = await service.getMemberRolesForWorks('u1', ['w1']);

            expect(result.size).toBe(0);
        });
    });
});
