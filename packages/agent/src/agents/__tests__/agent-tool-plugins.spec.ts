import { AgentToolService } from '../agent-tool.service';
import { AgentScope, AgentStatus, AgentAvatarMode, AgentIdleBehavior } from '../../entities/agent.entity';
import type { Agent, AgentPermissions } from '../../entities/agent.entity';
import type { AgentPluginToolsFacade } from '../agent-plugin-tools-facade';

/**
 * Agents/Skills/Tasks PR #1017 — Phase 16.10.
 *
 * Unit tests for the plugin pass-through tools (searchWeb / screenshot
 * / extractContent). All three share the `canCallExternalTools`
 * permission gate + the AGENT_PLUGIN_TOOLS_FACADE token presence.
 *
 * Coverage:
 *   - descriptor inclusion gated by permission AND token
 *   - happy invoke forwards semantic args to the facade (with agentId
 *     + workId attribution baked in)
 *   - required-field validation
 *   - adapter exceptions surface as `{error}`
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
		name: 'Researcher',
		slug: 'researcher',
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

describe('AgentToolService plugin pass-through tools (Phase 16.10)', () => {
	let agentsRepo: any;
	let pluginTools: jest.Mocked<AgentPluginToolsFacade>;
	let svc: AgentToolService;

	beforeEach(() => {
		agentsRepo = { create: jest.fn() };
		pluginTools = {
			searchWeb: jest.fn().mockResolvedValue({
				results: [{ title: 'r1', url: 'https://a.example/1', snippet: 's', score: 0.9 }],
			}),
			screenshot: jest.fn().mockResolvedValue({
				success: true,
				imageUrl: 'https://cdn/x.png',
				cacheUrl: null,
			}),
			extractContent: jest.fn().mockResolvedValue({
				url: 'https://a.example/page',
				content: 'cleaned body',
				contentLength: 12,
				providerId: 'firecrawl',
			}),
		};
		svc = new AgentToolService(agentsRepo, undefined, undefined, undefined, undefined, pluginTools);
	});

	it('registers none of the 3 tools when canCallExternalTools is false', () => {
		const tools = svc.resolveAllowedTools(makeAgent());
		expect(tools.find((t) => t.name === 'searchWeb')).toBeUndefined();
		expect(tools.find((t) => t.name === 'screenshot')).toBeUndefined();
		expect(tools.find((t) => t.name === 'extractContent')).toBeUndefined();
	});

	it('registers none of the 3 tools when token is unbound (even with permission)', () => {
		const bareSvc = new AgentToolService(agentsRepo);
		const tools = bareSvc.resolveAllowedTools(
			makeAgent({ permissions: makePerms({ canCallExternalTools: true }) }),
		);
		expect(tools.find((t) => t.name === 'searchWeb')).toBeUndefined();
		expect(tools.find((t) => t.name === 'screenshot')).toBeUndefined();
		expect(tools.find((t) => t.name === 'extractContent')).toBeUndefined();
	});

	it('registers all 3 tools when permission + facade are present', () => {
		const tools = svc.resolveAllowedTools(
			makeAgent({ permissions: makePerms({ canCallExternalTools: true }) }),
		);
		expect(tools.find((t) => t.name === 'searchWeb')).toBeDefined();
		expect(tools.find((t) => t.name === 'screenshot')).toBeDefined();
		expect(tools.find((t) => t.name === 'extractContent')).toBeDefined();
	});

	it('searchWeb invoke forwards semantic args (including agentId + workId for attribution)', async () => {
		const tools = svc.resolveAllowedTools(
			makeAgent({ permissions: makePerms({ canCallExternalTools: true }) }),
		);
		const tool = tools.find((t) => t.name === 'searchWeb')!;
		const result = await tool.invoke({ query: 'rust async', maxResults: 5 } as any);
		expect(pluginTools.searchWeb).toHaveBeenCalledWith({
			userId: 'u1',
			agentId: 'a1',
			workId: 'w1',
			query: 'rust async',
			maxResults: 5,
			includeDomains: undefined,
			excludeDomains: undefined,
		});
		expect(result).toEqual({
			results: [{ title: 'r1', url: 'https://a.example/1', snippet: 's', score: 0.9 }],
		});
	});

	it('searchWeb refuses on empty query', async () => {
		const tools = svc.resolveAllowedTools(
			makeAgent({ permissions: makePerms({ canCallExternalTools: true }) }),
		);
		const tool = tools.find((t) => t.name === 'searchWeb')!;
		const result = await tool.invoke({ query: '   ' } as any);
		expect(result).toEqual({ error: 'query is required.' });
		expect(pluginTools.searchWeb).not.toHaveBeenCalled();
	});

	it('searchWeb wraps facade exceptions into `{error}`', async () => {
		pluginTools.searchWeb.mockRejectedValueOnce(new Error('budget exceeded'));
		const tools = svc.resolveAllowedTools(
			makeAgent({ permissions: makePerms({ canCallExternalTools: true }) }),
		);
		const tool = tools.find((t) => t.name === 'searchWeb')!;
		const result = await tool.invoke({ query: 'x' } as any);
		expect(result).toEqual({ error: 'budget exceeded' });
	});

	it('screenshot invoke forwards semantic args + handles missing url', async () => {
		const tools = svc.resolveAllowedTools(
			makeAgent({ permissions: makePerms({ canCallExternalTools: true }) }),
		);
		const tool = tools.find((t) => t.name === 'screenshot')!;
		const result = await tool.invoke({
			url: 'https://x.example',
			viewportWidth: 1920,
			fullPage: true,
		} as any);
		expect(pluginTools.screenshot).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: 'u1',
				agentId: 'a1',
				workId: 'w1',
				url: 'https://x.example',
				viewportWidth: 1920,
				fullPage: true,
			}),
		);
		expect(result).toEqual({
			success: true,
			imageUrl: 'https://cdn/x.png',
			cacheUrl: null,
		});

		const noUrl = await tool.invoke({ url: '' } as any);
		expect(noUrl).toEqual({ error: 'url is required.' });
	});

	it('extractContent invoke forwards semantic args + handles missing url', async () => {
		const tools = svc.resolveAllowedTools(
			makeAgent({ permissions: makePerms({ canCallExternalTools: true }) }),
		);
		const tool = tools.find((t) => t.name === 'extractContent')!;
		const result = await tool.invoke({
			url: 'https://a.example/page',
			maxChars: 1000,
		} as any);
		expect(pluginTools.extractContent).toHaveBeenCalledWith({
			userId: 'u1',
			agentId: 'a1',
			workId: 'w1',
			url: 'https://a.example/page',
			maxChars: 1000,
		});
		expect(result).toEqual({
			url: 'https://a.example/page',
			content: 'cleaned body',
			contentLength: 12,
			providerId: 'firecrawl',
		});

		const noUrl = await tool.invoke({ url: '   ' } as any);
		expect(noUrl).toEqual({ error: 'url is required.' });
	});

	it('extractContent wraps facade exceptions into `{error}`', async () => {
		pluginTools.extractContent.mockRejectedValueOnce(new Error('extractor timeout'));
		const tools = svc.resolveAllowedTools(
			makeAgent({ permissions: makePerms({ canCallExternalTools: true }) }),
		);
		const tool = tools.find((t) => t.name === 'extractContent')!;
		const result = await tool.invoke({ url: 'https://a.example/page' } as any);
		expect(result).toEqual({ error: 'extractor timeout' });
	});
});
