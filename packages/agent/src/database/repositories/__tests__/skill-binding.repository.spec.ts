import { SkillBindingRepository, type ResolveActiveOptions } from '../skill-binding.repository';

/**
 * Skills feature — Phase 8.4 resolver tests.
 *
 * The query-builder dance in `resolveActive()` is the most subtle
 * piece of Skills: per-target OR filter, agent-vs-generator
 * inject toggles, priority sort, dedup by skillId. We mock the
 * Repository<SkillBinding> + its createQueryBuilder chain and
 * assert the right WHERE clauses are emitted + the right
 * post-processing happens.
 */

function makeRow(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        binding_id: 'b1',
        binding_skillId: 's1',
        binding_targetType: 'tenant',
        binding_targetId: null,
        binding_userId: 'u1',
        binding_injectIntoAgent: true,
        binding_injectIntoGenerator: false,
        binding_priority: 100,
        binding_createdAt: new Date('2026-01-01').toISOString(),
        skill_id: 's1',
        skill_userId: 'u1',
        skill_ownerType: 'tenant',
        skill_ownerId: 'u1',
        skill_slug: 'one',
        skill_title: 'First',
        skill_description: 'desc',
        skill_frontmatter: '{"name":"one","description":"desc"}',
        skill_instructionsMd: 'body',
        skill_contentHash: 'h',
        skill_version: '1.0.0',
        ...over,
    };
}

function makeQbMock(rawRows: Record<string, unknown>[]) {
    const calls: Record<string, unknown[]> = {
        where: [],
        andWhere: [],
        orderBy: [],
        addOrderBy: [],
    };
    const qb: any = {
        innerJoin: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn((...args: unknown[]) => {
            calls.where.push(args);
            return qb;
        }),
        andWhere: jest.fn((...args: unknown[]) => {
            calls.andWhere.push(args);
            return qb;
        }),
        orderBy: jest.fn((...args: unknown[]) => {
            calls.orderBy.push(args);
            return qb;
        }),
        addOrderBy: jest.fn((...args: unknown[]) => {
            calls.addOrderBy.push(args);
            return qb;
        }),
        getRawMany: jest.fn().mockResolvedValue(rawRows),
    };
    return { qb, calls };
}

describe('SkillBindingRepository.resolveActive', () => {
    function makeSvc(rawRows: Record<string, unknown>[]) {
        const { qb, calls } = makeQbMock(rawRows);
        const repo: any = { createQueryBuilder: jest.fn().mockReturnValue(qb) };
        const svc = new SkillBindingRepository(repo);
        return { svc, qb, calls };
    }

    it('returns empty when there are no bindings', async () => {
        const { svc } = makeSvc([]);
        const out = await svc.resolveActive({ userId: 'u1' });
        expect(out).toEqual([]);
    });

    it('joins skills + binding and orders by priority ASC', async () => {
        const { svc, calls } = makeSvc([
            makeRow({ binding_priority: 200, binding_id: 'b1' }),
            makeRow({ binding_priority: 50, binding_id: 'b0', skill_id: 's0' }),
        ]);
        await svc.resolveActive({ userId: 'u1', agentId: 'a1' });
        const orderArgs = calls.orderBy[0] as unknown[];
        expect(orderArgs[0]).toBe('binding.priority');
        expect(orderArgs[1]).toBe('ASC');
    });

    it('builds an OR target filter with tenant + agentId branches when agentId is supplied', async () => {
        const { svc, calls } = makeSvc([]);
        await svc.resolveActive({ userId: 'u1', agentId: 'a1' });
        const targetFilterCalls = (calls.andWhere as unknown[][]).filter((args) =>
            String(args[0]).includes('binding.targetType'),
        );
        expect(targetFilterCalls.length).toBeGreaterThan(0);
        const filter = String(targetFilterCalls[0][0]);
        expect(filter).toContain("'tenant'");
        expect(filter).toContain("'agent'");
    });

    it('dedups by skillId — first occurrence (highest priority) wins', async () => {
        const { svc } = makeSvc([
            makeRow({ binding_id: 'b-hi', binding_priority: 10, skill_id: 's1' }),
            makeRow({ binding_id: 'b-lo', binding_priority: 999, skill_id: 's1' }),
            makeRow({ binding_id: 'b-other', binding_priority: 100, skill_id: 's2' }),
        ]);
        const out = await svc.resolveActive({ userId: 'u1' });
        expect(out).toHaveLength(2);
        expect(out[0].binding.id).toBe('b-hi');
        expect(out.find((r) => r.skill.id === 's1')!.binding.priority).toBe(10);
    });

    it('honors forAgentRun=false → omits the injectIntoAgent filter', async () => {
        const { svc, calls } = makeSvc([]);
        await svc.resolveActive({
            userId: 'u1',
            forAgentRun: false,
            forGeneratorRun: true,
        } as ResolveActiveOptions);
        const injectAgentCalls = (calls.andWhere as unknown[][]).filter((args) =>
            String(args[0]).includes('binding.injectIntoAgent'),
        );
        expect(injectAgentCalls).toHaveLength(0);

        const injectGenCalls = (calls.andWhere as unknown[][]).filter((args) =>
            String(args[0]).includes('binding.injectIntoGenerator'),
        );
        expect(injectGenCalls.length).toBeGreaterThan(0);
    });

    it('safe-parses a malformed frontmatter JSON without throwing', async () => {
        const { svc } = makeSvc([makeRow({ skill_frontmatter: 'NOT JSON' })]);
        const out = await svc.resolveActive({ userId: 'u1' });
        expect(out[0].skill.frontmatter).toEqual({});
    });

    it('passes through frontmatter when already an object (e.g. postgres returned parsed jsonb)', async () => {
        const { svc } = makeSvc([
            makeRow({ skill_frontmatter: { name: 'one', description: 'd' } }),
        ]);
        const out = await svc.resolveActive({ userId: 'u1' });
        expect(out[0].skill.frontmatter.name).toBe('one');
    });
});
