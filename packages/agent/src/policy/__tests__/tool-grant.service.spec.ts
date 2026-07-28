import { ToolGrantService } from '../tool-grant.service';

/**
 * Tool-grant matrix (audit item G4) — the I/O half.
 *
 * What matters here is the scope WALK (an agentId must pull in its Work,
 * organization and tenant layers), the owner scoping of every read, and
 * the fail-open-to-default posture on a broken lookup.
 */

function makeScopes(over: Partial<Record<string, any>> = {}) {
    return {
        findAgent: jest.fn().mockResolvedValue({
            id: 'a1',
            workId: 'w1',
            organizationId: 'o1',
            tenantId: 't1',
        }),
        findWork: jest.fn().mockResolvedValue({ id: 'w1', organizationId: 'o1', tenantId: 't1' }),
        findOrganization: jest.fn().mockResolvedValue({ id: 'o1', tenantId: 't1' }),
        findTenant: jest.fn().mockResolvedValue({ id: 't1' }),
        ...over,
    } as any;
}

function makeGrants(rows: any[] = []) {
    return {
        findForScopes: jest.fn().mockResolvedValue(rows),
        findOne: jest.fn(),
        findByIdAndUser: jest.fn(),
        listForUser: jest.fn().mockResolvedValue([]),
        upsert: jest.fn().mockImplementation(async (input) => ({ id: 'g1', ...input })),
        deleteByIdAndUser: jest.fn().mockResolvedValue(true),
    } as any;
}

describe('ToolGrantService.resolve', () => {
    it('walks UPWARD from an agentId and asks for all four scope layers', async () => {
        const scopes = makeScopes();
        const grants = makeGrants();
        const svc = new ToolGrantService(scopes, grants);

        await svc.resolve({ userId: 'u1', agentId: 'a1' });

        expect(grants.findForScopes).toHaveBeenCalledWith('u1', [
            { scopeType: 'tenant', scopeId: 't1' },
            { scopeType: 'organization', scopeId: 'o1' },
            { scopeType: 'work', scopeId: 'w1' },
            { scopeType: 'agent', scopeId: 'a1' },
        ]);
    });

    it('lets an explicit id win over the discovered one', async () => {
        const scopes = makeScopes();
        const svc = new ToolGrantService(scopes, makeGrants());

        await svc.resolve({ userId: 'u1', agentId: 'a1', workId: 'w-other' });

        expect(scopes.findWork).toHaveBeenCalledWith('w-other');
    });

    it('folds the loaded rows into the effective matrix', async () => {
        const svc = new ToolGrantService(
            makeScopes(),
            makeGrants([
                { scopeType: 'tenant', scopeId: 't1', allow: ['git_*', 'deploy_*'], deny: null },
                { scopeType: 'work', scopeId: 'w1', allow: ['git_*'], deny: ['git_push'] },
            ]),
        );

        const resolved = await svc.resolve({ userId: 'u1', agentId: 'a1' });

        expect(resolved.matrix.allow).toEqual(['git_*']);
        expect(resolved.matrix.deny).toEqual(['git_push']);
        expect(resolved.source).toBe('work');
    });

    it('resolves to the permissive default when nothing is stored', async () => {
        const svc = new ToolGrantService(makeScopes(), makeGrants());
        const resolved = await svc.resolve({ userId: 'u1', agentId: 'a1' });
        expect(resolved.matrix).toEqual({ allow: ['*'], deny: [] });
        expect(resolved.source).toBe('default');
    });

    it('contributes no layer for a scope row that does not exist', async () => {
        const scopes = makeScopes({ findOrganization: jest.fn().mockResolvedValue(null) });
        const grants = makeGrants();
        const svc = new ToolGrantService(scopes, grants);

        await svc.resolve({ userId: 'u1', workId: 'w1', organizationId: 'o-missing' });

        const refs = grants.findForScopes.mock.calls[0][1];
        expect(refs.map((r: any) => r.scopeType)).not.toContain('organization');
    });

    it('degrades to the platform default (never throws) when a lookup fails', async () => {
        const scopes = makeScopes({ findAgent: jest.fn().mockRejectedValue(new Error('db')) });
        const svc = new ToolGrantService(scopes, makeGrants());

        const resolved = await svc.resolve({ userId: 'u1', agentId: 'a1' });

        expect(resolved.matrix).toEqual({ allow: ['*'], deny: [] });
        expect(resolved.chain).toEqual([]);
    });
});

describe('ToolGrantService.decide', () => {
    it('answers one tool against the resolved matrix', async () => {
        const svc = new ToolGrantService(
            makeScopes(),
            makeGrants([{ scopeType: 'tenant', scopeId: 't1', allow: ['git_*'], deny: null }]),
        );

        await expect(svc.decide({ userId: 'u1', agentId: 'a1' }, 'git_commit')).resolves.toEqual(
            expect.objectContaining({ allowed: true }),
        );
        await expect(svc.decide({ userId: 'u1', agentId: 'a1' }, 'deploy_work')).resolves.toEqual(
            expect.objectContaining({ allowed: false, code: 'tool-not-granted' }),
        );
    });
});

describe('ToolGrantService writes', () => {
    it('sanitizes an override on the way in — junk patterns never reach the row', async () => {
        const grants = makeGrants();
        const svc = new ToolGrantService(makeScopes(), grants);

        await svc.upsert({
            userId: 'u1',
            scopeType: 'work',
            scopeId: 'w1',
            grant: { allow: ['git_*', 'not a pattern!', ''] as string[], deny: undefined },
        });

        expect(grants.upsert).toHaveBeenCalledWith(
            expect.objectContaining({ grant: { allow: ['git_*'] } }),
        );
    });

    it('scopes a delete to the owner', async () => {
        const grants = makeGrants();
        const svc = new ToolGrantService(makeScopes(), grants);
        await svc.remove('u1', 'g1');
        expect(grants.deleteByIdAndUser).toHaveBeenCalledWith('g1', 'u1');
    });
});
