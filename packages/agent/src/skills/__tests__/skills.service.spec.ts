import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { SkillsService } from '../skills.service';
import { ActivityActionType } from '../../entities/activity-log.types';

function makeSkill(over: any = {}) {
    return {
        id: 'sk1',
        userId: 'u1',
        ownerType: 'tenant',
        ownerId: 'u1',
        slug: 'one',
        title: 'One',
        description: 'desc',
        frontmatter: { name: 'one', description: 'desc' },
        instructionsMd: '# Hello',
        contentHash: 'abc',
        version: '1.0.0',
        sourceCatalogSlug: null,
        sourceCatalogVersion: null,
        sourcePath: null,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
        ...over,
    };
}

describe('SkillsService', () => {
    let skills: any;
    let bindings: any;
    let activity: any;
    let svc: SkillsService;

    beforeEach(() => {
        skills = {
            findById: jest.fn(),
            findByIdAndUser: jest.fn(),
            findByOwnerSlug: jest.fn(),
            findByUserIdFiltered: jest.fn(),
            create: jest.fn(),
            updateById: jest.fn(),
            deleteById: jest.fn(),
        };
        bindings = {
            findBySkillId: jest.fn().mockResolvedValue([]),
            findByIdAndUser: jest.fn(),
            create: jest.fn(),
            deleteById: jest.fn(),
            resolveActive: jest.fn().mockResolvedValue([]),
        };
        activity = { log: jest.fn().mockResolvedValue(undefined) };
        svc = new SkillsService(skills, bindings, activity);
    });

    describe('create', () => {
        it('rejects empty title (no slugifiable text)', async () => {
            await expect(
                svc.create('u1', {
                    ownerType: 'tenant',
                    ownerId: 'u1',
                    title: '   ',
                    description: 'd',
                    instructionsMd: 'x',
                }),
            ).rejects.toThrow(BadRequestException);
        });

        it('rejects secret-bearing body', async () => {
            skills.findByOwnerSlug.mockResolvedValueOnce(null);
            await expect(
                svc.create('u1', {
                    ownerType: 'tenant',
                    ownerId: 'u1',
                    title: 'X',
                    description: 'd',
                    instructionsMd: 'GH=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
                }),
            ).rejects.toThrow(/Secret-like/);
        });

        it('rejects 64KB+ body', async () => {
            skills.findByOwnerSlug.mockResolvedValueOnce(null);
            const huge = 'a'.repeat(64 * 1024 + 1);
            await expect(
                svc.create('u1', {
                    ownerType: 'tenant',
                    ownerId: 'u1',
                    title: 'X',
                    description: 'd',
                    instructionsMd: huge,
                }),
            ).rejects.toThrow(/max 64 KB/);
        });

        it('rejects on slug conflict in same scope', async () => {
            skills.findByOwnerSlug.mockResolvedValueOnce(makeSkill());
            await expect(
                svc.create('u1', {
                    ownerType: 'tenant',
                    ownerId: 'u1',
                    title: 'One',
                    description: 'd',
                    instructionsMd: 'x',
                }),
            ).rejects.toThrow(ConflictException);
        });

        it('happy path persists + sets contentHash', async () => {
            skills.findByOwnerSlug.mockResolvedValueOnce(null);
            skills.create.mockImplementationOnce((d: any) => Promise.resolve({ id: 'new', ...d }));
            const out = await svc.create('u1', {
                ownerType: 'tenant',
                ownerId: 'u1',
                title: 'New',
                description: 'd',
                instructionsMd: '# Body',
            });
            expect(out.id).toBe('new');
            expect(skills.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    slug: 'new',
                    title: 'New',
                    contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
                    frontmatter: expect.objectContaining({ name: 'new' }),
                }),
            );
        });
    });

    describe('update', () => {
        it('404s for cross-user', async () => {
            skills.findByIdAndUser.mockResolvedValueOnce(null);
            await expect(svc.update('u1', 'sk1', { title: 'New' })).rejects.toThrow(
                NotFoundException,
            );
        });

        it('recomputes contentHash when instructionsMd changes', async () => {
            skills.findByIdAndUser.mockResolvedValueOnce(makeSkill());
            skills.findById.mockResolvedValueOnce(makeSkill({ instructionsMd: '# New' }));
            await svc.update('u1', 'sk1', { instructionsMd: '# New' });
            expect(skills.updateById).toHaveBeenCalledWith(
                'sk1',
                expect.objectContaining({
                    instructionsMd: '# New',
                    contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
                }),
            );
        });
    });

    describe('installFromCatalog', () => {
        it('rejects when slug already installed in target scope', async () => {
            skills.findByOwnerSlug.mockResolvedValueOnce(makeSkill());
            await expect(
                svc.installFromCatalog('u1', {
                    catalogProviderId: 'everworks-skills',
                    catalogSlug: 'one',
                    ownerType: 'tenant',
                    ownerId: 'u1',
                    entry: {
                        slug: 'one',
                        title: 'One',
                        description: 'd',
                        frontmatter: { name: 'one', description: 'd' },
                        body: '# x',
                        version: '1.0.0',
                    },
                }),
            ).rejects.toThrow(ConflictException);
        });

        it('happy path emits SKILL_INSTALLED activity', async () => {
            skills.findByOwnerSlug.mockResolvedValueOnce(null);
            skills.create.mockResolvedValueOnce(makeSkill({ id: 'new' }));
            await svc.installFromCatalog('u1', {
                catalogProviderId: 'p',
                catalogSlug: 'one',
                ownerType: 'tenant',
                ownerId: 'u1',
                entry: {
                    slug: 'one',
                    title: 'One',
                    description: 'd',
                    frontmatter: { name: 'one', description: 'd' },
                    body: '# x',
                    version: '1.0.0',
                },
            });
            expect(activity.log).toHaveBeenCalledWith(
                expect.objectContaining({ actionType: ActivityActionType.SKILL_INSTALLED }),
            );
        });
    });

    describe('createBinding', () => {
        it('requires targetId for non-tenant types', async () => {
            skills.findByIdAndUser.mockResolvedValueOnce(makeSkill());
            await expect(
                svc.createBinding('u1', { skillId: 'sk1', targetType: 'agent' }),
            ).rejects.toThrow(BadRequestException);
        });

        it('allows targetId=null only for tenant scope', async () => {
            skills.findByIdAndUser.mockResolvedValueOnce(makeSkill());
            bindings.create.mockResolvedValueOnce({
                id: 'b1',
                skillId: 'sk1',
                targetType: 'tenant',
            });
            const out = await svc.createBinding('u1', { skillId: 'sk1', targetType: 'tenant' });
            expect(out.id).toBe('b1');
            expect(bindings.create).toHaveBeenCalledWith(
                expect.objectContaining({ targetType: 'tenant', targetId: null }),
            );
            expect(activity.log).toHaveBeenCalledWith(
                expect.objectContaining({ actionType: ActivityActionType.SKILL_ATTACHED_TO_AGENT }),
            );
        });
    });

    describe('removeBinding', () => {
        it('404s for cross-user', async () => {
            bindings.findByIdAndUser.mockResolvedValueOnce(null);
            await expect(svc.removeBinding('u1', 'b1')).rejects.toThrow(NotFoundException);
        });
    });
});
