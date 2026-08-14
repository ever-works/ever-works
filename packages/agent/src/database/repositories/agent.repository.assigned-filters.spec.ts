import { AgentRepository } from './agent.repository';

/**
 * The two "which Agents REACH this parent?" list filters —
 * `assignedWorkId` (Work header dropdown) and `assignedIdeaId` (Idea
 * detail rail). Both read `agent_memberships` through an EXISTS
 * subquery rather than scanning the `targets` JSON, and both must stay
 * usable in the SAME call: they were written twice from one template,
 * so a copied subquery alias or bind-parameter name would silently make
 * the second filter overwrite the first.
 */
describe('AgentRepository — assigned-target list filters', () => {
    /** The EXISTS fragments handed to `andWhere`, in order. */
    let predicates: string[];
    /** Every parameter bound via `setParameters`, merged. */
    let params: Record<string, unknown>;
    /** `from(Entity, alias)` aliases used by the subqueries, in order. */
    let subAliases: string[];

    let queryBuilder: Record<string, jest.Mock>;
    let agents: AgentRepository;

    function makeSubQuery() {
        const sub: Record<string, jest.Mock> = {
            select: jest.fn(() => sub),
            from: jest.fn((_entity: unknown, alias: string) => {
                subAliases.push(alias);
                return sub;
            }),
            where: jest.fn(() => sub),
            andWhere: jest.fn(() => sub),
            getQuery: jest.fn(() => `(SELECT 1 FROM ${subAliases[subAliases.length - 1]})`),
        };
        return sub;
    }

    beforeEach(() => {
        predicates = [];
        params = {};
        subAliases = [];

        queryBuilder = {
            where: jest.fn(() => queryBuilder),
            andWhere: jest.fn((arg: unknown) => {
                predicates.push(
                    typeof arg === 'function'
                        ? String((arg as (sub: unknown) => string)(queryBuilder))
                        : String(arg),
                );
                return queryBuilder;
            }),
            subQuery: jest.fn(() => makeSubQuery()),
            setParameters: jest.fn((next: Record<string, unknown>) => {
                Object.assign(params, next);
                return queryBuilder;
            }),
            orderBy: jest.fn(() => queryBuilder),
            take: jest.fn(() => queryBuilder),
            skip: jest.fn(() => queryBuilder),
            getCount: jest.fn().mockResolvedValue(0),
            getMany: jest.fn().mockResolvedValue([]),
        };

        agents = new AgentRepository({
            createQueryBuilder: jest.fn(() => queryBuilder),
        } as never);
    });

    it('matches Agents whose membership rows point at the Idea', async () => {
        await agents.findByUserIdScoped('u1', { assignedIdeaId: 'idea-1' });

        expect(predicates.some((p) => p.startsWith('EXISTS'))).toBe(true);
        expect(subAliases).toContain('ideaMembership');
        expect(params).toMatchObject({
            assignedIdeaTargetType: 'idea',
            assignedIdeaId: 'idea-1',
        });
    });

    it('does not confuse an Idea assignment with the scope-pinned `ideaId` filter', async () => {
        await agents.findByUserIdScoped('u1', { ideaId: 'idea-1' });

        // Scope pinning is a plain column predicate — no membership join.
        expect(predicates.some((p) => p.startsWith('EXISTS'))).toBe(false);
        expect(queryBuilder.andWhere).toHaveBeenCalledWith('agent.ideaId = :ideaId', {
            ideaId: 'idea-1',
        });
    });

    it('keeps both assigned filters independent when combined', async () => {
        await agents.findByUserIdScoped('u1', {
            assignedWorkId: 'work-1',
            assignedIdeaId: 'idea-1',
        });

        expect(predicates.filter((p) => p.startsWith('EXISTS'))).toHaveLength(2);
        expect(subAliases).toEqual(expect.arrayContaining(['membership', 'ideaMembership']));
        // Distinct bind names — a shared one would have the Idea filter
        // clobber the Work filter's target type and return the wrong rows.
        expect(params).toEqual({
            assignedTargetType: 'work',
            assignedWorkId: 'work-1',
            assignedIdeaTargetType: 'idea',
            assignedIdeaId: 'idea-1',
        });
    });
});
