// The service's DI types come from `@ever-works/agent` barrels whose runtime
// graphs do not need to load here — every dependency is a stub. Only
// `buildPluginProviderId` is behaviour, so it is reproduced faithfully.
jest.mock('@ever-works/agent/facades', () => ({ ConnectionScopesFacadeService: class {} }));
jest.mock('@ever-works/agent/policy', () => ({
    ToolGrantService: class {},
    ToolGrantRepository: class {},
}));
jest.mock('@ever-works/agent/database', () => ({
    AuthAccountRepository: class {},
    buildPluginProviderId: (id: string) => `plugin:${id}`,
}));

import { BadRequestException, ConflictException } from '@nestjs/common';
import type { ConnectionScopePresetDeclaration } from '@ever-works/contracts';
import { ToolGrantPresetsService } from './tool-grant-presets.service';

const PRESETS: ConnectionScopePresetDeclaration[] = [
    { id: 'read', providerScopes: ['read:user', 'repo'], toolPatterns: [] },
    {
        id: 'write',
        providerScopes: ['read:user', 'repo', 'workflow'],
        toolPatterns: ['commitToRepo', 'openPullRequest'],
    },
];

const TARGET = {
    userId: 'user-1',
    providerId: 'github',
    scopeType: 'agent' as const,
    scopeId: '00000000-0000-4000-8000-000000000001',
};

type Row = { id: string; allow: string[] | null; deny: string[] | null; note: string | null };

function make(options: {
    presets?: ConnectionScopePresetDeclaration[];
    row?: Row | null;
    matrix?: { allow: string[]; deny: string[] };
    chain?: unknown[];
    account?: { accessToken?: string | null; scope?: string | null } | null;
    withAccounts?: boolean;
}) {
    let row: Row | null = options.row ?? null;
    const facade = {
        getPresets: jest.fn().mockResolvedValue(options.presets ?? PRESETS),
        listProviders: jest.fn().mockResolvedValue([{ providerId: 'github' }]),
    };
    const grants = { findOne: jest.fn(async () => row) };
    const toolGrants = {
        resolve: jest.fn(async () => {
            const deny = row?.deny ?? [];
            return {
                matrix: options.matrix ?? { allow: ['*'], deny },
                source: row ? 'agent' : 'default',
                chain: options.chain ?? [],
            };
        }),
        upsert: jest.fn(
            async (input: {
                grant: { allow?: string[]; deny?: string[] };
                note: string | null;
            }) => {
                row = {
                    id: row?.id ?? 'g1',
                    allow: input.grant.allow ?? null,
                    deny: input.grant.deny ?? null,
                    note: input.note,
                };
                return row;
            },
        ),
        remove: jest.fn(async () => {
            row = null;
            return true;
        }),
    };
    const accounts = {
        findProviderAccount: jest.fn().mockResolvedValue(options.account ?? null),
        hasRequiredScopes: jest.fn((account: { scope?: string }, needed: string[]) => {
            const granted = new Set((account.scope ?? '').split(/[ ,]+/).filter(Boolean));
            return needed.every((scope) => granted.has(scope));
        }),
    };
    const service = new ToolGrantPresetsService(
        facade as never,
        toolGrants as never,
        grants as never,
        options.withAccounts === false ? undefined : (accounts as never),
    );
    return { service, facade, grants, toolGrants, accounts, current: () => row };
}

describe('ToolGrantPresetsService', () => {
    describe('getState', () => {
        it('reports read/write availability, the stored level and the effective level', async () => {
            const { service } = make({});
            await expect(service.getState(TARGET)).resolves.toEqual({
                providerId: 'github',
                scopeType: 'agent',
                scopeId: TARGET.scopeId,
                presets: ['read', 'write'],
                requested: 'write',
                effective: 'write',
                clampedBy: null,
            });
        });

        it('reports the scope that clamped a wider request', async () => {
            const { service } = make({
                matrix: { allow: ['*'], deny: ['openPullRequest'] },
                chain: [
                    { scope: 'default', id: null, allow: ['*'], deny: [], rejected: [] },
                    { scope: 'work', id: 'w1', allow: [], deny: ['openPullRequest'], rejected: [] },
                ],
            });
            const state = await service.getState(TARGET);
            expect(state.requested).toBe('write');
            expect(state.effective).toBe('read');
            expect(state.clampedBy).toBe('work');
        });

        it('refuses a provider that declares no levels', async () => {
            const { service } = make({ presets: [] });
            await expect(service.getState(TARGET)).rejects.toBeInstanceOf(BadRequestException);
        });
    });

    describe('apply', () => {
        it('narrowing to read writes deny patterns and never touches allow', async () => {
            const { service, toolGrants, current } = make({
                row: {
                    id: 'g1',
                    allow: ['search*', 'commitToRepo'],
                    deny: ['deploy_*'],
                    note: 'keep me',
                },
            });

            const state = await service.apply(TARGET, 'read');

            expect(toolGrants.upsert).toHaveBeenCalledWith({
                userId: 'user-1',
                scopeType: 'agent',
                scopeId: TARGET.scopeId,
                grant: {
                    allow: ['search*', 'commitToRepo'],
                    deny: ['deploy_*', 'commitToRepo', 'openPullRequest'],
                },
                note: 'keep me',
            });
            expect(current()?.note).toBe('keep me');
            expect(state.requested).toBe('read');
            expect(state.effective).toBe('read');
        });

        it('narrowing never asks for re-approval', async () => {
            const { service, accounts } = make({
                account: { accessToken: 't', scope: 'read:user' },
            });
            await service.apply(TARGET, 'read');
            expect(accounts.findProviderAccount).not.toHaveBeenCalled();
        });

        it('widening back removes only the preset-owned patterns', async () => {
            const { service, toolGrants } = make({
                row: {
                    id: 'g1',
                    allow: null,
                    deny: ['deploy_*', 'commitToRepo', 'openPullRequest'],
                    note: null,
                },
            });

            await service.apply(TARGET, 'write');

            expect(toolGrants.upsert).toHaveBeenCalledWith(
                expect.objectContaining({ grant: { deny: ['deploy_*'] } }),
            );
        });

        it('widening to a row with nothing left removes the row so the scope inherits', async () => {
            const { service, toolGrants, current } = make({
                row: {
                    id: 'g1',
                    allow: null,
                    deny: ['commitToRepo', 'openPullRequest'],
                    note: null,
                },
            });

            const state = await service.apply(TARGET, 'write');

            expect(toolGrants.remove).toHaveBeenCalledWith('user-1', 'g1');
            expect(toolGrants.upsert).not.toHaveBeenCalled();
            expect(current()).toBeNull();
            expect(state.requested).toBe('write');
        });

        it('choosing the level already stored with no row writes nothing', async () => {
            const { service, toolGrants } = make({});
            await service.apply(TARGET, 'write');
            expect(toolGrants.upsert).not.toHaveBeenCalled();
            expect(toolGrants.remove).not.toHaveBeenCalled();
        });

        it('widening refuses with preset_requires_reapproval and changes nothing when the account lacks permissions', async () => {
            const { service, toolGrants, accounts } = make({
                row: {
                    id: 'g1',
                    allow: null,
                    deny: ['commitToRepo', 'openPullRequest'],
                    note: null,
                },
                account: { accessToken: 'token', scope: 'read:user,repo' },
            });

            const error = await service.apply(TARGET, 'write').catch((err: unknown) => err);

            expect(error).toBeInstanceOf(ConflictException);
            expect((error as ConflictException).getResponse()).toEqual(
                expect.objectContaining({
                    code: 'preset_requires_reapproval',
                    providerId: 'github',
                }),
            );
            expect(accounts.findProviderAccount).toHaveBeenCalledWith('user-1', 'plugin:github');
            expect(toolGrants.upsert).not.toHaveBeenCalled();
            expect(toolGrants.remove).not.toHaveBeenCalled();
        });

        it('widening proceeds when the account already covers the wider level', async () => {
            const { service, toolGrants } = make({
                row: {
                    id: 'g1',
                    allow: null,
                    deny: ['commitToRepo', 'openPullRequest'],
                    note: null,
                },
                account: { accessToken: 'token', scope: 'read:user,repo,workflow' },
            });
            await service.apply(TARGET, 'write');
            expect(toolGrants.remove).toHaveBeenCalled();
        });

        it('widening proceeds when no account is connected, or it reports no permissions', async () => {
            for (const account of [
                null,
                { accessToken: 'token', scope: '' },
                { accessToken: null, scope: 'x' },
            ]) {
                const { service, toolGrants } = make({
                    row: {
                        id: 'g1',
                        allow: null,
                        deny: ['commitToRepo', 'openPullRequest'],
                        note: null,
                    },
                    account,
                });
                await service.apply(TARGET, 'write');
                expect(toolGrants.remove).toHaveBeenCalled();
            }
        });

        it('widening proceeds without an account repository bound', async () => {
            const { service, toolGrants } = make({
                row: {
                    id: 'g1',
                    allow: null,
                    deny: ['commitToRepo', 'openPullRequest'],
                    note: null,
                },
                withAccounts: false,
            });
            await service.apply(TARGET, 'write');
            expect(toolGrants.remove).toHaveBeenCalled();
        });

        it('refuses a level the provider does not declare', async () => {
            const { service, toolGrants } = make({ presets: [PRESETS[1]] });
            await expect(service.apply(TARGET, 'read')).rejects.toBeInstanceOf(BadRequestException);
            expect(toolGrants.upsert).not.toHaveBeenCalled();
        });

        it('resolves the chain at the scope that was written', async () => {
            const cases = [
                ['agent', { agentId: TARGET.scopeId }],
                ['work', { workId: TARGET.scopeId }],
                ['organization', { organizationId: TARGET.scopeId }],
                ['tenant', { tenantId: TARGET.scopeId }],
            ] as const;
            for (const [scopeType, expected] of cases) {
                const { service, toolGrants } = make({});
                await service.getState({ ...TARGET, scopeType });
                expect(toolGrants.resolve).toHaveBeenCalledWith({ userId: 'user-1', ...expected });
            }
        });
    });
});
