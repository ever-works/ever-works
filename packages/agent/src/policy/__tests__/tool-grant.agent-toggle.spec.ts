import { ToolGrantService } from '../tool-grant.service';
import type { ToolGrant } from '../../entities/tool-grant.entity';

/**
 * Capabilities tab — agent-scope tool toggle, round trip.
 *
 * The tab's switches do not call a bespoke endpoint: they PUT the whole
 * agent-scope grant row through `ToolGrantService.upsert` and then re-read
 * `resolve`. What this spec pins is that sequence end to end against an
 * in-memory row store — write, re-resolve, observe the decision flip —
 * because the failure mode it guards is silent: a PUT that stores a row
 * the resolver then ignores (or narrows away) looks exactly like a
 * working toggle in the UI until someone checks what the agent can call.
 *
 * The layers below the agent are REAL layers here (tenant/org/Work), so
 * the narrowing rule is exercised rather than assumed: an agent row may
 * subtract, never add.
 */

const REFS = [
    { scopeType: 'tenant', scopeId: 't1' },
    { scopeType: 'organization', scopeId: 'o1' },
    { scopeType: 'work', scopeId: 'w1' },
    { scopeType: 'agent', scopeId: 'a1' },
];

function makeScopes() {
    return {
        findAgent: jest
            .fn()
            .mockResolvedValue({ id: 'a1', workId: 'w1', organizationId: 'o1', tenantId: 't1' }),
        findWork: jest.fn().mockResolvedValue({ id: 'w1', organizationId: 'o1', tenantId: 't1' }),
        findOrganization: jest.fn().mockResolvedValue({ id: 'o1', tenantId: 't1' }),
        findTenant: jest.fn().mockResolvedValue({ id: 't1' }),
    } as never;
}

/**
 * In-memory stand-in for `ToolGrantRepository` — upsert-by-scope plus the
 * owner-scoped reads the service uses. Deliberately NOT a jest.fn chain:
 * the point is that what `upsert` stores is what `resolve` later reads.
 */
function makeGrantStore(seed: Partial<ToolGrant>[] = []) {
    const rows = new Map<string, Partial<ToolGrant>>();
    for (const row of seed) rows.set(`${row.scopeType}:${row.scopeId}`, row);

    return {
        rows,
        repo: {
            findForScopes: jest.fn(async (userId: string, refs: typeof REFS) =>
                refs
                    .map((ref) => rows.get(`${ref.scopeType}:${ref.scopeId}`))
                    .filter((row): row is Partial<ToolGrant> => Boolean(row))
                    .filter((row) => row.userId === undefined || row.userId === userId),
            ),
            listForUser: jest.fn(async () => [...rows.values()]),
            upsert: jest.fn(async (input: never) => {
                const { scopeType, scopeId, grant, userId } = input as unknown as {
                    scopeType: string;
                    scopeId: string;
                    userId: string;
                    grant: { allow?: string[]; deny?: string[] };
                };
                const stored = {
                    id: `row-${scopeType}`,
                    userId,
                    scopeType,
                    scopeId,
                    allow: grant.allow ?? null,
                    deny: grant.deny ?? null,
                } as unknown as Partial<ToolGrant>;
                rows.set(`${scopeType}:${scopeId}`, stored);
                return stored;
            }),
            deleteByIdAndUser: jest.fn(async (id: string) => {
                for (const [key, row] of rows) {
                    if (row.id === id) {
                        rows.delete(key);
                        return true;
                    }
                }
                return false;
            }),
            findOne: jest.fn(),
            findByIdAndUser: jest.fn(),
        } as never,
    };
}

const put = (svc: ToolGrantService, grant: { allow?: string[]; deny?: string[] }) =>
    svc.upsert({ userId: 'u1', scopeType: 'agent', scopeId: 'a1', grant } as never);

describe('agent-scope tool toggle (Capabilities tab round trip)', () => {
    it('turning a tool OFF then ON flips the decision both ways', async () => {
        const store = makeGrantStore();
        const svc = new ToolGrantService(makeScopes(), store.repo);
        const where = { userId: 'u1', agentId: 'a1' };

        expect((await svc.decide(where, 'searchWeb')).allowed).toBe(true);

        // OFF — the switch writes the agent row's deny list.
        await put(svc, { deny: ['searchWeb'] });
        const off = await svc.decide(where, 'searchWeb');
        expect(off.allowed).toBe(false);
        expect(off.code).toBe('tool-denied');
        expect(off.source).toBe('agent');

        // Untouched tools stay reachable — the deny is not a blanket.
        expect((await svc.decide(where, 'createTask')).allowed).toBe(true);

        // ON — the switch re-PUTs the row without that entry.
        await put(svc, { deny: [] });
        expect((await svc.decide(where, 'searchWeb')).allowed).toBe(true);
    });

    it('"reset to inherited" deletes the row and restores the inherited decision', async () => {
        const store = makeGrantStore();
        const svc = new ToolGrantService(makeScopes(), store.repo);
        const where = { userId: 'u1', agentId: 'a1' };

        const row = await put(svc, { deny: ['searchWeb'] });
        expect((await svc.decide(where, 'searchWeb')).allowed).toBe(false);

        expect(await svc.remove('u1', (row as { id: string }).id)).toBe(true);
        const resolved = await svc.resolve(where);
        expect(resolved.matrix.deny).toEqual([]);
        expect(resolved.chain.find((entry) => entry.scope === 'agent')?.deny).toEqual([]);
        expect((await svc.decide(where, 'searchWeb')).allowed).toBe(true);
    });

    it('a parent deny survives an agent row that tries to allow the tool back', async () => {
        const store = makeGrantStore([
            {
                id: 'row-org',
                userId: 'u1',
                scopeType: 'organization',
                scopeId: 'o1',
                allow: null,
                deny: ['searchWeb'],
            } as unknown as Partial<ToolGrant>,
        ]);
        const svc = new ToolGrantService(makeScopes(), store.repo);
        const where = { userId: 'u1', agentId: 'a1' };

        await put(svc, { allow: ['*'], deny: [] });

        const decision = await svc.decide(where, 'searchWeb');
        expect(decision.allowed).toBe(false);
        expect(decision.source).toBe('organization');
    });

    it('an agent allow list narrows to itself and REPORTS what it could not widen', async () => {
        const store = makeGrantStore([
            {
                id: 'row-work',
                userId: 'u1',
                scopeType: 'work',
                scopeId: 'w1',
                allow: ['createTask', 'searchWeb'],
                deny: null,
            } as unknown as Partial<ToolGrant>,
        ]);
        const svc = new ToolGrantService(makeScopes(), store.repo);
        const where = { userId: 'u1', agentId: 'a1' };

        // The agent asks for one tool its Work grants and one it does not.
        await put(svc, { allow: ['createTask', 'commitToRepo'] });

        const resolved = await svc.resolve(where);
        expect(resolved.matrix.allow).toEqual(['createTask']);
        const agentLayer = resolved.chain.find((entry) => entry.scope === 'agent');
        expect(agentLayer?.allow).toEqual(['createTask']);
        expect(agentLayer?.rejected).toEqual(['commitToRepo']);

        expect((await svc.decide(where, 'createTask')).allowed).toBe(true);
        const notGranted = await svc.decide(where, 'searchWeb');
        expect(notGranted.allowed).toBe(false);
        expect(notGranted.code).toBe('tool-not-granted');
    });

    it('adding the tool to the agent allow list is what turns it back on', async () => {
        const store = makeGrantStore();
        const svc = new ToolGrantService(makeScopes(), store.repo);
        const where = { userId: 'u1', agentId: 'a1' };

        await put(svc, { allow: ['createTask'] });
        expect((await svc.decide(where, 'searchWeb')).allowed).toBe(false);

        // Exactly what `composeGrantForToggle` sends for an ON click when
        // the stored row carries an allow list.
        await put(svc, { allow: ['createTask', 'searchWeb'], deny: [] });
        expect((await svc.decide(where, 'searchWeb')).allowed).toBe(true);
    });
});
