import { BadRequestException, ConflictException } from '@nestjs/common';
import { SkillsService } from '../skills.service';

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
        invocationSlug: null,
        ...over,
    };
}

describe('SkillsService — invocation slugs', () => {
    let skills: any;
    let bindings: any;
    let svc: SkillsService;

    beforeEach(() => {
        skills = {
            findById: jest.fn(),
            findByIdAndUser: jest.fn(),
            findByOwnerSlug: jest.fn().mockResolvedValue(null),
            findByUserIdFiltered: jest.fn(),
            findByUserAndInvocationSlug: jest.fn().mockResolvedValue(null),
            findInvocableByUser: jest.fn().mockResolvedValue([]),
            create: jest.fn(async (data: any) => makeSkill(data)),
            updateByIdAndUser: jest.fn(),
            deleteByIdAndUser: jest.fn(),
        };
        bindings = { resolveActive: jest.fn().mockResolvedValue([]) };
        svc = new SkillsService(skills, bindings);
    });

    const createInput = (invocationSlug?: string | null) => ({
        ownerType: 'tenant' as const,
        ownerId: 'u1',
        title: 'One',
        description: 'd',
        instructionsMd: '# body',
        invocationSlug,
    });

    describe('create', () => {
        it('normalizes the slug (leading slash, case, whitespace) before storing', async () => {
            await svc.create('u1', createInput(' /Plan '));
            expect(skills.findByUserAndInvocationSlug).toHaveBeenCalledWith('u1', 'plan');
            expect(skills.create).toHaveBeenCalledWith(
                expect.objectContaining({ invocationSlug: 'plan' }),
            );
        });

        it('stores null when no slug (or an empty string) is supplied', async () => {
            await svc.create('u1', createInput(undefined));
            expect(skills.create).toHaveBeenCalledWith(
                expect.objectContaining({ invocationSlug: null }),
            );
            expect(skills.findByUserAndInvocationSlug).not.toHaveBeenCalled();

            await svc.create('u1', createInput('   '));
            expect(skills.create).toHaveBeenLastCalledWith(
                expect.objectContaining({ invocationSlug: null }),
            );
        });

        it('rejects invalid shapes with a 400', async () => {
            for (const bad of ['-lead', 'has space', 'under_score', 'a'.repeat(65)]) {
                await expect(svc.create('u1', createInput(bad))).rejects.toThrow(
                    BadRequestException,
                );
            }
        });

        it('409s on a per-user conflict, naming the conflicting skill', async () => {
            // Both create attempts must see the conflict (not Once — the
            // first create consumes a Once-mock before the second runs).
            skills.findByUserAndInvocationSlug.mockResolvedValue(
                makeSkill({ id: 'other', title: 'Planning Guide', invocationSlug: 'plan' }),
            );
            await expect(svc.create('u1', createInput('plan'))).rejects.toThrow(
                /already used by skill "Planning Guide"/,
            );
            await expect(
                svc.create('u1', { ...createInput('plan'), slug: undefined }),
            ).rejects.toBeInstanceOf(ConflictException);
        });
    });

    describe('update', () => {
        beforeEach(() => {
            skills.findByIdAndUser.mockResolvedValue(makeSkill({ invocationSlug: 'plan' }));
        });

        it('keeps its OWN slug without conflicting with itself', async () => {
            skills.findByUserAndInvocationSlug.mockResolvedValueOnce(
                makeSkill({ id: 'sk1', invocationSlug: 'plan' }),
            );
            await svc.update('u1', 'sk1', { invocationSlug: 'plan' });
            expect(skills.updateByIdAndUser).toHaveBeenCalledWith(
                'sk1',
                'u1',
                expect.objectContaining({ invocationSlug: 'plan' }),
            );
        });

        it('409s when ANOTHER skill of the same user holds the slug', async () => {
            skills.findByUserAndInvocationSlug.mockResolvedValueOnce(
                makeSkill({ id: 'sk2', title: 'Other', invocationSlug: 'plan' }),
            );
            await expect(svc.update('u1', 'sk1', { invocationSlug: 'plan' })).rejects.toThrow(
                ConflictException,
            );
        });

        it('null clears the slug; omitting the field leaves it untouched', async () => {
            await svc.update('u1', 'sk1', { invocationSlug: null });
            expect(skills.updateByIdAndUser).toHaveBeenCalledWith(
                'sk1',
                'u1',
                expect.objectContaining({ invocationSlug: null }),
            );

            skills.updateByIdAndUser.mockClear();
            await svc.update('u1', 'sk1', { title: 'Renamed' });
            const patch = skills.updateByIdAndUser.mock.calls[0][2];
            expect('invocationSlug' in patch).toBe(false);
        });
    });

    describe('resolveInvocation', () => {
        it('resolves a leading /slug through the user-scoped lookup', async () => {
            const match = makeSkill({ invocationSlug: 'plan' });
            skills.findByUserAndInvocationSlug.mockResolvedValueOnce(match);
            await expect(svc.resolveInvocation('u1', '/plan do the thing')).resolves.toBe(match);
            expect(skills.findByUserAndInvocationSlug).toHaveBeenCalledWith('u1', 'plan');
        });

        it('returns null for plain text and for unknown slugs (no error)', async () => {
            await expect(svc.resolveInvocation('u1', 'no slash here')).resolves.toBeNull();
            expect(skills.findByUserAndInvocationSlug).not.toHaveBeenCalled();

            skills.findByUserAndInvocationSlug.mockResolvedValueOnce(null);
            await expect(svc.resolveInvocation('u1', '/ghost')).resolves.toBeNull();
        });
    });

    it('listInvocable delegates to the user-scoped repository lookup', async () => {
        const rows = [makeSkill({ invocationSlug: 'plan' })];
        skills.findInvocableByUser.mockResolvedValueOnce(rows);
        await expect(svc.listInvocable('u1')).resolves.toBe(rows);
        expect(skills.findInvocableByUser).toHaveBeenCalledWith('u1');
    });
});
