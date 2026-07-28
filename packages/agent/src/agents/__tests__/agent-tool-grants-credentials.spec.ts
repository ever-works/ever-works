import { AgentToolService } from '../agent-tool.service';
import {
    AgentScope,
    AgentStatus,
    AgentAvatarMode,
    AgentIdleBehavior,
} from '../../entities/agent.entity';
import type { Agent, AgentPermissions } from '../../entities/agent.entity';
import type { AgentDomainToolSources } from '../agent-domain-tool-sources';
import { resolveToolGrantChain } from '../../policy/tool-grant';
import {
    checkToolCredentialDeclarations,
    TOOL_CREDENTIAL_REQUIREMENTS,
} from '../../policy/tool-credentials';
import { ENV_CREDENTIAL_PREFIX } from '../../policy/credential-resolver';

/**
 * Enforcement of the tool-grant matrix (G4) and `{{cred.key}}`
 * interpolation (G14) at the ONE tool-assembly point.
 *
 * The pure rules are tested in `policy/__tests__`; this file pins that
 * `AgentToolService` actually applies them — and that with neither
 * dependency wired the service behaves exactly as it did before.
 *
 * It also carries the CI check the audit asked for: every declared tool
 * credential requirement must name a tool the platform really builds and
 * a credential the catalog really defines.
 */

function makePerms(over: Partial<AgentPermissions> = {}): AgentPermissions {
    return {
        canCreateAgents: false,
        canAssignTasks: false,
        canEditSkills: false,
        canEditAgentFiles: false,
        canSpend: false,
        canCommitToRepo: false,
        canOpenPullRequests: false,
        canCallExternalTools: false,
        ...over,
    };
}

function makeAgent(over: Partial<Agent> = {}): Agent {
    return {
        id: 'a1',
        userId: 'u1',
        scope: AgentScope.WORK,
        missionId: null,
        ideaId: null,
        workId: 'w1',
        name: 'Operator',
        slug: 'operator',
        title: null,
        capabilities: null,
        aiProviderId: null,
        modelId: null,
        maxSkillContextTokens: 4000,
        status: AgentStatus.ACTIVE,
        permissions: makePerms(),
        targets: null,
        heartbeatCadence: null,
        idleBehavior: AgentIdleBehavior.PROPOSE,
        nextHeartbeatAt: null,
        lastRunAt: null,
        lastRunStatus: null,
        errorCount: 0,
        pauseAfterFailures: 3,
        avatarMode: AgentAvatarMode.INITIALS,
        avatarIcon: null,
        avatarImageUploadId: null,
        soulMd: '# Soul',
        agentsMd: null,
        heartbeatMd: null,
        toolsMd: null,
        agentYml: null,
        contentHash: null,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
        ...over,
    } as Agent;
}

const agentsRepo: any = { create: jest.fn(), findByIdAndUser: jest.fn() };
const agentsService: any = { create: jest.fn() };

function makeSvc(over: { toolGrants?: any; credentials?: any; sources?: any } = {}) {
    return new AgentToolService(
        agentsRepo,
        agentsService,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        over.sources as AgentDomainToolSources | undefined,
        over.toolGrants,
        over.credentials,
    );
}

describe('AgentToolService.resolveGrantedTools (audit item G4)', () => {
    it('returns every tool unchanged when no grant enforcer is wired', async () => {
        const svc = makeSvc();
        const sync = svc.resolveAllowedTools(makeAgent()).map((t) => t.name);
        const { tools, refused } = await svc.resolveGrantedTools(makeAgent());
        expect(tools.map((t) => t.name)).toEqual(sync);
        expect(refused).toEqual([]);
    });

    it('returns every tool when the matrix is the permissive default', async () => {
        const toolGrants = {
            resolve: jest.fn().mockResolvedValue(resolveToolGrantChain([])),
            decide: jest.fn(),
        };
        const { tools, refused } = await makeSvc({ toolGrants }).resolveGrantedTools(makeAgent());
        expect(tools.length).toBeGreaterThan(0);
        expect(refused).toEqual([]);
    });

    it('withholds a tool the matrix denies, and reports the refusal', async () => {
        const toolGrants = {
            resolve: jest
                .fn()
                .mockResolvedValue(
                    resolveToolGrantChain([
                        { scope: 'tenant', id: 't1', grant: { deny: ['getKbDocument'] } },
                    ]),
                ),
            decide: jest.fn(),
        };
        const { tools, refused } = await makeSvc({ toolGrants }).resolveGrantedTools(makeAgent());
        expect(tools.map((t) => t.name)).not.toContain('getKbDocument');
        expect(tools.map((t) => t.name)).toContain('getActivity');
        expect(refused.map((r) => r.toolName)).toEqual(['getKbDocument']);
    });

    it('resolves against the AGENT OWNER and the agent’s own scope tuple', async () => {
        const toolGrants = {
            resolve: jest.fn().mockResolvedValue(resolveToolGrantChain([])),
            decide: jest.fn(),
        };
        await makeSvc({ toolGrants }).resolveGrantedTools(
            makeAgent({ userId: 'owner-9', workId: 'w-7' }),
        );
        expect(toolGrants.resolve).toHaveBeenCalledWith(
            expect.objectContaining({ userId: 'owner-9', agentId: 'a1', workId: 'w-7' }),
        );
    });

    it('degrades to the permission gates when the grant lookup throws', async () => {
        const toolGrants = {
            resolve: jest.fn().mockRejectedValue(new Error('db down')),
            decide: jest.fn(),
        };
        const { tools, refused } = await makeSvc({ toolGrants }).resolveGrantedTools(makeAgent());
        // Failing CLOSED here would strip every Agent of every tool on a
        // transient blip — worse than not narrowing for a moment.
        expect(tools.length).toBeGreaterThan(0);
        expect(refused).toEqual([]);
    });
});

describe('`{{cred.key}}` interpolation at invoke time (audit item G14)', () => {
    const ORIGINAL = process.env[`${ENV_CREDENTIAL_PREFIX}API_TOKEN`];

    afterEach(() => {
        if (ORIGINAL === undefined) delete process.env[`${ENV_CREDENTIAL_PREFIX}API_TOKEN`];
        else process.env[`${ENV_CREDENTIAL_PREFIX}API_TOKEN`] = ORIGINAL;
    });

    /**
     * A service wired with one credential resolver. `getActivity` is used
     * as the probe because it is always registered and its invoke ignores
     * its arguments — so what is asserted is the WRAPPER, not the tool.
     */
    function svcWithEchoTool(credentials?: any) {
        const sources = {
            fleet: { service: { listForUser: jest.fn().mockResolvedValue([]) } },
        } as unknown as AgentDomainToolSources;
        return { svc: makeSvc({ credentials, sources }) };
    }

    it('leaves tools untouched when no resolver is wired', async () => {
        const { svc } = svcWithEchoTool();
        const tool = svc.resolveAllowedTools(makeAgent()).find((t) => t.name === 'getActivity')!;
        // No throw, no interpolation machinery in the way.
        await expect(tool.invoke({ limit: 1 })).resolves.toBeDefined();
    });

    it('refuses a call whose referenced credential cannot be resolved', async () => {
        const credentials = { resolve: jest.fn().mockResolvedValue(new Map()) };
        const { svc } = svcWithEchoTool(credentials);
        const tool = svc.resolveAllowedTools(makeAgent()).find((t) => t.name === 'getActivity')!;

        const result = (await tool.invoke({ note: '{{cred.api_token}}' })) as { error?: string };

        expect(result.error).toContain('{{cred.api_token}}');
        expect(result.error).toContain(`${ENV_CREDENTIAL_PREFIX}API_TOKEN`);
        // The refusal must never suggest pasting the secret into chat.
        expect(result.error).toContain('Do not ask the user to paste');
    });

    it('takes the fast path (no resolver call) when nothing references a credential', async () => {
        const credentials = { resolve: jest.fn().mockResolvedValue(new Map()) };
        const { svc } = svcWithEchoTool(credentials);
        const tool = svc.resolveAllowedTools(makeAgent()).find((t) => t.name === 'getActivity')!;

        await tool.invoke({ limit: 5 });

        expect(credentials.resolve).not.toHaveBeenCalled();
    });

    it('resolves for the agent owner, never a model-supplied identity', async () => {
        const credentials = {
            resolve: jest.fn().mockResolvedValue(new Map([['api_token', 'value-12345']])),
        };
        const { svc } = svcWithEchoTool(credentials);
        const tool = svc
            .resolveAllowedTools(makeAgent({ userId: 'owner-9' }))
            .find((t) => t.name === 'getActivity')!;

        await tool.invoke({ note: '{{cred.api_token}}', userId: 'someone-else' });

        expect(credentials.resolve).toHaveBeenCalledWith(
            expect.objectContaining({ userId: 'owner-9', agentId: 'a1' }),
            ['api_token'],
        );
    });

    it('does not mistake other mustache templates for credential references', async () => {
        const credentials = { resolve: jest.fn() };
        const { svc } = svcWithEchoTool(credentials);
        const tool = svc.resolveAllowedTools(makeAgent()).find((t) => t.name === 'getActivity')!;

        const result = (await tool.invoke({ note: '{{user.email}} {{secret.k}}' })) as {
            error?: string;
        };

        expect(result.error).toBeUndefined();
        expect(credentials.resolve).not.toHaveBeenCalled();
    });

    it('never surfaces the underlying error when the resolver throws', async () => {
        const credentials = {
            resolve: jest.fn().mockRejectedValue(new Error('vault said: value=hunter2')),
        };
        const { svc } = svcWithEchoTool(credentials);
        const tool = svc.resolveAllowedTools(makeAgent()).find((t) => t.name === 'getActivity')!;

        const result = (await tool.invoke({ note: '{{cred.api_token}}' })) as { error?: string };

        expect(result.error).toBe('Credential resolution failed.');
        expect(result.error).not.toContain('hunter2');
    });
});

describe('CI check — tool credential declarations (audit item G14)', () => {
    it('every declared requirement names a real tool and a defined credential', () => {
        const svc = makeSvc();
        const knownToolNames = svc
            .resolveAllowedTools(
                makeAgent({
                    permissions: makePerms({
                        canCreateAgents: true,
                        canAssignTasks: true,
                        canEditAgentFiles: true,
                        canCommitToRepo: true,
                        canOpenPullRequests: true,
                        canCallExternalTools: true,
                    }),
                }),
            )
            .map((tool) => tool.name);

        expect(checkToolCredentialDeclarations({ knownToolNames })).toEqual([]);
    });

    it('the requirement table is a plain object of string arrays', () => {
        for (const [tool, keys] of Object.entries(TOOL_CREDENTIAL_REQUIREMENTS)) {
            expect(typeof tool).toBe('string');
            expect(Array.isArray(keys)).toBe(true);
        }
    });

    describe('the checker itself', () => {
        it('CATCHES a requirement naming a tool that does not exist', () => {
            const problems = checkToolCredentialDeclarations({
                knownToolNames: ['realTool'],
                catalog: { k: { description: 'x', envVar: `${ENV_CREDENTIAL_PREFIX}K` } },
                requirements: { ghostTool: ['k'] },
            });
            expect(problems.map((p) => p.kind)).toContain('unknown-tool');
        });

        it('CATCHES a requirement naming a credential no catalog entry defines', () => {
            const problems = checkToolCredentialDeclarations({
                knownToolNames: ['realTool'],
                catalog: {},
                requirements: { realTool: ['missing_key'] },
            });
            expect(problems.map((p) => p.kind)).toContain('unknown-credential-key');
        });

        it('CATCHES a catalog entry whose env var does not match the resolver', () => {
            const problems = checkToolCredentialDeclarations({
                catalog: { api_token: { description: 'x', envVar: 'API_TOKEN' } },
                requirements: {},
            });
            expect(problems.map((p) => p.kind)).toContain('env-var-mismatch');
        });

        it('CATCHES a malformed catalog key', () => {
            const problems = checkToolCredentialDeclarations({
                catalog: { 'not a key!': { description: 'x', envVar: 'X' } },
                requirements: {},
            });
            expect(problems.map((p) => p.kind)).toContain('malformed-credential-key');
        });

        it('CATCHES an empty requirement', () => {
            const problems = checkToolCredentialDeclarations({
                knownToolNames: ['realTool'],
                catalog: {},
                requirements: { realTool: [] },
            });
            expect(problems.map((p) => p.kind)).toContain('empty-requirement');
        });

        it('ACCEPTS a coherent declaration', () => {
            const problems = checkToolCredentialDeclarations({
                knownToolNames: ['realTool'],
                catalog: {
                    api_token: {
                        description: 'x',
                        envVar: `${ENV_CREDENTIAL_PREFIX}API_TOKEN`,
                    },
                },
                requirements: { realTool: ['api_token'] },
            });
            expect(problems).toEqual([]);
        });
    });
});
