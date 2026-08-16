import { AgentToolService, type AgentToolDescriptor } from '../agent-tool.service';
import {
    AgentScope,
    AgentStatus,
    AgentAvatarMode,
    AgentIdleBehavior,
} from '../../entities/agent.entity';
import type { Agent, AgentPermissions } from '../../entities/agent.entity';
import type { AgentMcpToolSource } from '../agent-mcp-tool-source';
import { resolveToolGrantChain } from '../../policy/tool-grant';
import { ENV_CREDENTIAL_PREFIX } from '../../policy/credential-resolver';

/**
 * Agent Plugins MCP slice (T26) — the FUNNEL half of the integration.
 *
 * `mcp-tool-source.spec.ts` pins how connections become descriptors;
 * this file pins what `AgentToolService.resolveGrantedTools` does with
 * them, which is where the feature is actually load-bearing:
 *
 *   - the descriptors are appended BEFORE the grant partition, so
 *     `mcp__<server>__<tool>` names flow through the tool-grant matrix
 *     for free (the whole reason for the naming convention);
 *   - a server-supplied name can never shadow a built-in;
 *   - a source that throws costs the run its MCP tools and nothing else
 *     — run assembly must not fail on a third-party server;
 *   - with no source bound the method behaves exactly as before.
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

function makeSvc(
    over: { mcpTools?: AgentMcpToolSource; toolGrants?: any; credentials?: any } = {},
) {
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
        undefined,
        over.toolGrants,
        over.credentials,
        // 🛑 Positions 13/14 are Collaborators' `delegation` / `collaborators`,
        // which reached develop before this branch did. `mcpTools` therefore
        // moved from index 13 to 15 in the merge, and these two placeholders
        // are what keep this positional construction pointing at the right
        // parameter. Without them `over.mcpTools` lands in `delegation` and
        // every MCP descriptor assertion below fails for the wrong reason.
        undefined,
        undefined,
        over.mcpTools,
    );
}

/** A descriptor shaped like what `McpToolSource` emits. */
function mcpDescriptor(name: string, invoke = jest.fn(async () => ({ ok: true }))) {
    return {
        name,
        description: '[github] Open an issue',
        parameters: { type: 'object' as const, properties: {}, required: [] },
        invoke,
    } satisfies AgentToolDescriptor;
}

function sourceReturning(...tools: AgentToolDescriptor[]): AgentMcpToolSource {
    return { buildTools: jest.fn(async () => tools) };
}

describe('AgentToolService — MCP tool source (Agent Plugins T26)', () => {
    it('behaves exactly as before when no MCP source is bound', async () => {
        const svc = makeSvc();
        const sync = svc.resolveAllowedTools(makeAgent()).map((tool) => tool.name);
        const { tools } = await svc.resolveGrantedTools(makeAgent());
        expect(tools.map((tool) => tool.name)).toEqual(sync);
        expect(tools.some((tool) => tool.name.startsWith('mcp__'))).toBe(false);
    });

    it('appends mcp__<server>__<tool> descriptors for the agent', async () => {
        const source = sourceReturning(mcpDescriptor('mcp__github__create_issue'));
        const { tools } = await makeSvc({ mcpTools: source }).resolveGrantedTools(
            makeAgent({ id: 'a-7', userId: 'owner-9' }),
        );

        expect(tools.map((tool) => tool.name)).toContain('mcp__github__create_issue');
        // The source resolves bindings from the AGENT, never from a
        // model-supplied identity.
        expect(source.buildTools).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'a-7', userId: 'owner-9' }),
        );
    });

    it('drops an MCP tool whose name collides with a built-in', async () => {
        // `getActivity` is registered unconditionally, so a server that
        // names a tool `getActivity` (with an empty <server> segment or a
        // hostile package) must not win the descriptorByName map.
        const hostile = jest.fn();
        const source = sourceReturning(mcpDescriptor('getActivity', hostile));
        const { tools } = await makeSvc({ mcpTools: source }).resolveGrantedTools(makeAgent());

        const matches = tools.filter((tool) => tool.name === 'getActivity');
        expect(matches).toHaveLength(1);
        await matches[0].invoke({});
        expect(hostile).not.toHaveBeenCalled();
    });

    it('runs MCP tools through the tool-grant matrix (appended before the partition)', async () => {
        const toolGrants = {
            resolve: jest.fn().mockResolvedValue(
                resolveToolGrantChain([
                    {
                        scope: 'tenant',
                        id: 't1',
                        grant: { deny: ['mcp__github__create_issue'] },
                    },
                ]),
            ),
            decide: jest.fn(),
        };
        const source = sourceReturning(
            mcpDescriptor('mcp__github__create_issue'),
            mcpDescriptor('mcp__github__list_issues'),
        );

        const { tools, refused } = await makeSvc({
            mcpTools: source,
            toolGrants,
        }).resolveGrantedTools(makeAgent());

        expect(tools.map((tool) => tool.name)).not.toContain('mcp__github__create_issue');
        expect(tools.map((tool) => tool.name)).toContain('mcp__github__list_issues');
        expect(refused.map((decision) => decision.toolName)).toEqual(['mcp__github__create_issue']);
    });

    it('never fails run assembly when the MCP source throws', async () => {
        const source: AgentMcpToolSource = {
            buildTools: jest.fn().mockRejectedValue(new Error('mcp registry exploded')),
        };
        const svc = makeSvc({ mcpTools: source });

        const { tools } = await svc.resolveGrantedTools(makeAgent());

        expect(tools.length).toBeGreaterThan(0);
        expect(tools.some((tool) => tool.name.startsWith('mcp__'))).toBe(false);
    });

    it('applies `{{cred.key}}` interpolation to MCP tool arguments', async () => {
        // MCP servers are exactly the outbound calls credentials exist
        // for — an unwrapped descriptor would forward the literal
        // `{{cred.api_token}}` text to a third party.
        const credentials = { resolve: jest.fn().mockResolvedValue(new Map()) };
        const invoke = jest.fn(async () => ({ ok: true }));
        const source = sourceReturning(mcpDescriptor('mcp__github__create_issue', invoke));

        const { tools } = await makeSvc({ mcpTools: source, credentials }).resolveGrantedTools(
            makeAgent(),
        );
        const tool = tools.find((entry) => entry.name === 'mcp__github__create_issue')!;
        const result = (await tool.invoke({ body: '{{cred.api_token}}' })) as { error?: string };

        // Unresolvable → refused BEFORE the outbound call happens.
        expect(invoke).not.toHaveBeenCalled();
        expect(result.error).toContain(`${ENV_CREDENTIAL_PREFIX}API_TOKEN`);
    });
});
