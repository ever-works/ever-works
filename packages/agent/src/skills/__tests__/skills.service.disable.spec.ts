import { NotFoundException } from '@nestjs/common';
import { SkillsService } from '../skills.service';
import { ActivityActionType } from '../../entities/activity-log.types';

/**
 * Skills shelf — the workspace-level on/off switch and the write-path hooks
 * (tag reindex + readiness) on `SkillsService`.
 *
 * Pinned: the switch is idempotent, never reads or writes a binding (count,
 * target, priority and both inject flags are untouched), scopes its write by
 * owner, records direction + actor without the body; and every Skill write
 * re-derives tags (12 kept, the rest reported) and recomputes readiness
 * without ever failing the write that already succeeded.
 */
const BODY = '# Secret sauce instructions that must never reach the activity log';

function makeSkill(over: Record<string, unknown> = {}) {
    return {
        id: 'sk1',
        userId: 'u1',
        ownerType: 'tenant',
        ownerId: 'u1',
        slug: 'one',
        title: 'One',
        description: 'desc',
        frontmatter: { name: 'one', description: 'desc' },
        instructionsMd: BODY,
        contentHash: 'abc',
        version: '1.0.0',
        readiness: 'ready',
        disabledAt: null,
        reviewState: null,
        tenantId: null,
        organizationId: 'o1',
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
        ...over,
    };
}

function build() {
    const bindingRows = [
        {
            id: 'b1',
            skillId: 'sk1',
            targetType: 'agent',
            targetId: 'a1',
            priority: 5,
            injectIntoAgent: true,
            injectIntoGenerator: false,
        },
        {
            id: 'b2',
            skillId: 'sk1',
            targetType: 'tenant',
            targetId: null,
            priority: 100,
            injectIntoAgent: false,
            injectIntoGenerator: true,
        },
    ];
    const skills = {
        findByIdAndUser: jest.fn().mockResolvedValue(makeSkill()),
        findByOwnerSlug: jest.fn().mockResolvedValue(null),
        findByUserAndInvocationSlug: jest.fn().mockResolvedValue(null),
        create: jest.fn(async (data: Record<string, unknown>) =>
            makeSkill({ ...data, id: 'sk-new' }),
        ),
        updateByIdAndUser: jest.fn().mockResolvedValue(undefined),
        updateById: jest.fn().mockResolvedValue(undefined),
    };
    const bindings = {
        findBySkillId: jest.fn().mockResolvedValue(bindingRows),
        findByIdAndUser: jest.fn().mockResolvedValue(bindingRows[0]),
        create: jest.fn(async (data: Record<string, unknown>) => ({ id: 'b3', ...data })),
        deleteByIdAndUser: jest.fn().mockResolvedValue(undefined),
        deleteById: jest.fn(),
        deleteByTarget: jest.fn(),
    };
    const activity = { log: jest.fn().mockResolvedValue(undefined) };
    const agents = { findByIdAndUser: jest.fn().mockResolvedValue({ id: 'a1' }) };
    const skillTags = { replaceForSkill: jest.fn().mockResolvedValue(undefined) };
    const readiness = {
        refreshSkill: jest.fn().mockResolvedValue({ readiness: 'ready' }),
        refresh: jest.fn().mockResolvedValue(null),
    };
    const svc = new SkillsService(
        skills as never,
        bindings as never,
        activity as never,
        undefined, // missions
        agents as never,
        undefined, // works
        undefined, // ideas
        undefined, // tool grants
        skillTags as never,
        readiness as never,
    );
    jest.spyOn(
        (svc as never as { logger: { warn: () => void } }).logger,
        'warn',
    ).mockImplementation(() => undefined);
    return { svc, skills, bindings, activity, skillTags, readiness, bindingRows };
}

describe('SkillsService — on/off switch', () => {
    it('disable stamps disabledAt through the ownership-scoped update and reports the disabled card', async () => {
        const { svc, skills } = build();
        const result = await svc.disable('u1', 'sk1');
        expect(result.cardState).toBe('disabled');
        expect(result.changed).toBe(true);
        expect(result.disabledAt).toBeInstanceOf(Date);
        expect(skills.updateByIdAndUser).toHaveBeenCalledWith('sk1', 'u1', {
            disabledAt: result.disabledAt,
        });
        expect(skills.updateById).not.toHaveBeenCalled();
    });

    it('disable is idempotent — an already-off Skill succeeds and writes nothing', async () => {
        const { svc, skills, activity } = build();
        const offSince = new Date('2026-09-01');
        skills.findByIdAndUser.mockResolvedValue(makeSkill({ disabledAt: offSince }));
        const result = await svc.disable('u1', 'sk1');
        expect(result).toEqual({
            id: 'sk1',
            cardState: 'disabled',
            disabledAt: offSince,
            changed: false,
        });
        expect(skills.updateByIdAndUser).not.toHaveBeenCalled();
        expect(activity.log).not.toHaveBeenCalled();
    });

    it('enable clears disabledAt and restores the stored verdict', async () => {
        const { svc, skills } = build();
        skills.findByIdAndUser.mockResolvedValue(
            makeSkill({ disabledAt: new Date('2026-09-01'), readiness: 'missing_requirements' }),
        );
        const result = await svc.enable('u1', 'sk1');
        expect(result).toEqual({
            id: 'sk1',
            cardState: 'missing_requirements',
            disabledAt: null,
            changed: true,
        });
        expect(skills.updateByIdAndUser).toHaveBeenCalledWith('sk1', 'u1', { disabledAt: null });
    });

    it('enable is idempotent on an already-on Skill', async () => {
        const { svc, skills } = build();
        const result = await svc.enable('u1', 'sk1');
        expect(result.changed).toBe(false);
        expect(result.cardState).toBe('ready');
        expect(skills.updateByIdAndUser).not.toHaveBeenCalled();
    });

    it('never reads or writes a binding — count, target, priority and both inject flags are untouched', async () => {
        const { svc, bindings, bindingRows } = build();
        const snapshot = JSON.parse(JSON.stringify(bindingRows));
        await svc.disable('u1', 'sk1');
        await svc.enable('u1', 'sk1');
        expect(bindings.create).not.toHaveBeenCalled();
        expect(bindings.deleteByIdAndUser).not.toHaveBeenCalled();
        expect(bindings.deleteById).not.toHaveBeenCalled();
        expect(bindings.deleteByTarget).not.toHaveBeenCalled();
        expect(JSON.parse(JSON.stringify(bindingRows))).toEqual(snapshot);
    });

    it('records the actor and direction, and never the body', async () => {
        const { svc, activity } = build();
        await svc.disable('u1', 'sk1');
        const [entry] = activity.log.mock.calls[0];
        expect(entry.userId).toBe('u1');
        expect(entry.actionType).toBe(ActivityActionType.SKILL_DISABLED);
        expect(JSON.stringify(entry)).not.toContain('Secret sauce');
    });

    it('records SKILL_ENABLED when switched back on', async () => {
        const { svc, skills, activity } = build();
        skills.findByIdAndUser.mockResolvedValue(makeSkill({ disabledAt: new Date() }));
        await svc.enable('u1', 'sk1');
        expect(activity.log.mock.calls[0][0].actionType).toBe(ActivityActionType.SKILL_ENABLED);
    });

    it('answers not found for another user’s Skill on both verbs', async () => {
        const { svc, skills } = build();
        skills.findByIdAndUser.mockResolvedValue(null);
        await expect(svc.disable('u2', 'sk1')).rejects.toThrow(NotFoundException);
        await expect(svc.enable('u2', 'sk1')).rejects.toThrow(NotFoundException);
        expect(skills.updateByIdAndUser).not.toHaveBeenCalled();
    });
});

describe('SkillsService — tags and readiness on every write', () => {
    it('creating a Skill with 15 tags stores 12, normalised, and recomputes readiness', async () => {
        const { svc, skillTags, readiness } = build();
        const declared = Array.from({ length: 15 }, (_, i) => `Tag ${i}`);
        const created = await svc.create('u1', {
            ownerType: 'tenant',
            ownerId: 'u1',
            title: 'Invoices',
            description: 'd',
            instructionsMd: '# body',
            frontmatter: { name: 'invoices', description: 'd', tags: declared },
        });
        const [skillId, userId, tags, scope] = skillTags.replaceForSkill.mock.calls[0];
        expect(skillId).toBe(created.id);
        expect(userId).toBe('u1');
        expect(tags).toHaveLength(12);
        expect(tags[0]).toBe('tag-0');
        expect(tags).not.toContain('tag-12');
        expect(scope).toEqual({ tenantId: null, organizationId: 'o1' });
        expect(readiness.refreshSkill).toHaveBeenCalledWith(created);
    });

    it('update re-derives tags from the new definition', async () => {
        const { svc, skills, skillTags } = build();
        skills.findByIdAndUser.mockResolvedValue(
            makeSkill({ frontmatter: { name: 'one', description: 'd', tags: ['Email', 'email'] } }),
        );
        await svc.update('u1', 'sk1', {
            frontmatter: { name: 'one', description: 'd', tags: ['Email', 'email'] },
        });
        expect(skillTags.replaceForSkill).toHaveBeenCalledWith(
            'sk1',
            'u1',
            ['email'],
            expect.any(Object),
        );
    });

    it('installing from the catalogue indexes tags and readiness', async () => {
        const { svc, skillTags, readiness } = build();
        await svc.installFromCatalog('u1', {
            catalogProviderId: 'provider',
            catalogSlug: 'billing',
            ownerType: 'tenant',
            ownerId: 'u1',
            entry: {
                slug: 'billing',
                title: 'Billing',
                description: 'd',
                frontmatter: { name: 'billing', description: 'd', tags: ['billing'] },
                body: '# body',
                version: '1.0.0',
            },
        });
        expect(skillTags.replaceForSkill.mock.calls[0][2]).toEqual(['billing']);
        expect(readiness.refreshSkill).toHaveBeenCalledTimes(1);
    });

    it('a failing tag reindex or readiness refresh never fails the write', async () => {
        const { svc, skillTags, readiness } = build();
        skillTags.replaceForSkill.mockRejectedValue(new Error('db blip'));
        readiness.refreshSkill.mockRejectedValue(new Error('db blip'));
        await expect(
            svc.create('u1', {
                ownerType: 'tenant',
                ownerId: 'u1',
                title: 'Still created',
                description: 'd',
                instructionsMd: '# body',
            }),
        ).resolves.toMatchObject({ id: 'sk-new' });
    });

    it('creating or removing a binding recomputes the Skill’s readiness', async () => {
        const { svc, readiness } = build();
        await svc.createBinding('u1', { skillId: 'sk1', targetType: 'agent', targetId: 'a1' });
        expect(readiness.refresh).toHaveBeenLastCalledWith('u1', 'sk1');
        await svc.removeBinding('u1', 'b1');
        expect(readiness.refresh).toHaveBeenCalledTimes(2);
        expect(readiness.refresh).toHaveBeenLastCalledWith('u1', 'sk1');
    });

    it('without the shelf dependencies wired, writes behave exactly as before', async () => {
        const { skills, bindings, activity } = build();
        const bare = new SkillsService(skills as never, bindings as never, activity as never);
        await expect(
            bare.create('u1', {
                ownerType: 'tenant',
                ownerId: 'u1',
                title: 'Plain',
                description: 'd',
                instructionsMd: '# body',
            }),
        ).resolves.toMatchObject({ id: 'sk-new' });
    });
});
