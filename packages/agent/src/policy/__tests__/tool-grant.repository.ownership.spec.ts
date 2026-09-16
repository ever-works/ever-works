import { ToolGrantRepository } from '../tool-grant.repository';
import { ToolGrantService } from '../tool-grant.service';

/**
 * AW-15 — the access-level control's ownership record on `tool_grants`.
 *
 * Only the control passes `presetOwnership`. Every other writer (the raw
 * `PUT /api/tool-grants`, the per-tool switches) leaves it out, and the stored
 * record is pruned to patterns still in the new `deny` — so an operator who
 * removes a pattern by hand, then adds it back, owns it.
 */
type Row = {
    id: string;
    userId: string;
    scopeType: string;
    scopeId: string;
    allow: string[] | null;
    deny: string[] | null;
    note: string | null;
    presetOwnership: unknown;
};

function makeTypeorm(initial: Row | null) {
    let row: Row | null = initial;
    return {
        current: () => row,
        typeorm: {
            findOne: jest.fn(async () => row),
            update: jest.fn(async (_where: unknown, patch: Partial<Row>) => {
                row = { ...(row as Row), ...patch };
            }),
            create: jest.fn((data: Partial<Row>) => ({ id: 'g-new', ...data })),
            save: jest.fn(async (data: Row) => {
                row = data;
                return data;
            }),
        },
    };
}

const REF = { userId: 'u1', scopeType: 'agent' as const, scopeId: 'a1' };

describe('ToolGrantRepository.upsert — preset ownership', () => {
    it('a write from another path prunes the record to patterns still denied', async () => {
        const { typeorm, current } = makeTypeorm({
            id: 'g1',
            ...REF,
            allow: null,
            deny: ['commitToRepo', 'openPullRequest'],
            note: null,
            presetOwnership: {
                github: { preset: 'read', deny: ['commitToRepo', 'openPullRequest'] },
            },
        });
        const repo = new ToolGrantRepository(typeorm as never);

        // The operator flips commitToRepo back on by hand.
        await repo.upsert({ ...REF, grant: { deny: ['openPullRequest'] } });

        expect(current()?.presetOwnership).toEqual({
            github: { preset: 'read', deny: ['openPullRequest'] },
        });
    });

    it('a raw write that re-sends the same deny list keeps the record intact', async () => {
        const ownership = { github: { preset: 'read', deny: ['commitToRepo'] } };
        const { typeorm, current } = makeTypeorm({
            id: 'g1',
            ...REF,
            allow: null,
            deny: ['deploy_*', 'commitToRepo'],
            note: null,
            presetOwnership: ownership,
        });
        const repo = new ToolGrantRepository(typeorm as never);

        await repo.upsert({ ...REF, grant: { deny: ['deploy_*', 'commitToRepo', 'x_*'] } });

        expect(current()?.presetOwnership).toEqual(ownership);
    });

    it('rows the control never touched stay without a record', async () => {
        const { typeorm, current } = makeTypeorm({
            id: 'g1',
            ...REF,
            allow: null,
            deny: ['commitToRepo'],
            note: null,
            presetOwnership: null,
        });
        const repo = new ToolGrantRepository(typeorm as never);
        await repo.upsert({ ...REF, grant: { deny: ['commitToRepo', 'x_*'] } });
        expect(current()?.presetOwnership).toBeNull();

        const fresh = makeTypeorm(null);
        await new ToolGrantRepository(fresh.typeorm as never).upsert({
            ...REF,
            grant: { deny: ['commitToRepo'] },
        });
        expect(fresh.current()?.presetOwnership).toBeNull();
    });

    it('the control writes its record verbatim', async () => {
        const { typeorm, current } = makeTypeorm(null);
        const repo = new ToolGrantRepository(typeorm as never);
        const ownership = { github: { preset: 'read' as const, deny: ['openPullRequest'] } };

        await repo.upsert({
            ...REF,
            grant: { deny: ['commitToRepo', 'openPullRequest'] },
            presetOwnership: ownership,
        });

        expect(current()?.presetOwnership).toEqual(ownership);
    });
});

describe('ToolGrantService.upsert — preset ownership', () => {
    it('shape-checks a record the control passes; other writers pass none', async () => {
        const grants = { upsert: jest.fn(async (input: unknown) => input) };
        const svc = new ToolGrantService({} as never, grants as never);

        await svc.upsert({
            ...REF,
            grant: { deny: ['commitToRepo'] },
            presetOwnership: {
                github: { preset: 'read', deny: ['commitToRepo', 'not a pattern!'] },
                junk: { preset: 'admin', deny: ['x'] },
            } as never,
        });
        await svc.upsert({ ...REF, grant: { deny: ['commitToRepo'] } });

        expect(grants.upsert.mock.calls[0][0]).toEqual(
            expect.objectContaining({
                presetOwnership: { github: { preset: 'read', deny: ['commitToRepo'] } },
            }),
        );
        expect(grants.upsert.mock.calls[1][0]).not.toHaveProperty('presetOwnership');
    });
});
