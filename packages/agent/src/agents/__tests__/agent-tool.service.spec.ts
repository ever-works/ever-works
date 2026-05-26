import { AgentToolService } from '../agent-tool.service';
import { AgentAvatarMode, AgentIdleBehavior, AgentScope, AgentStatus } from '../../entities/agent.entity';
import type { Agent } from '../../entities/agent.entity';

function makeAgent(over: Partial<Agent> = {}): Agent {
	return {
		id: 'a1',
		userId: 'u1',
		scope: AgentScope.TENANT,
		missionId: null,
		ideaId: null,
		workId: null,
		name: 'CEO',
		slug: 'ceo',
		title: null,
		capabilities: null,
		aiProviderId: null,
		modelId: null,
		maxSkillContextTokens: 4000,
		status: AgentStatus.ACTIVE,
		permissions: {
			canCreateAgents: false,
			canAssignTasks: false,
			canEditSkills: false,
			canEditAgentFiles: false,
			canSpend: false,
			canCommitToRepo: false,
			canOpenPullRequests: false,
			canCallExternalTools: false,
		},
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
		createdAt: new Date('2026-01-01'),
		updatedAt: new Date('2026-01-01'),
		...over,
	} as Agent;
}

describe('AgentToolService.resolveAllowedTools', () => {
	let agents: any;
	let skills: any;
	let bindings: any;
	let files: any;
	let svc: AgentToolService;

	beforeEach(() => {
		agents = { create: jest.fn() };
		skills = { findByIdAndUser: jest.fn() };
		bindings = { resolveActive: jest.fn().mockResolvedValue([]) };
		files = { write: jest.fn() };
		svc = new AgentToolService(agents, skills, bindings, files);
	});

	it('always exposes the placeholder tools (getActivity + getKbDocument)', () => {
		const tools = svc.resolveAllowedTools(makeAgent());
		const names = tools.map((t) => t.name);
		expect(names).toContain('getActivity');
		expect(names).toContain('getKbDocument');
	});

	it('exposes getSkillBody when SkillRepository + SkillBindingRepository are wired', () => {
		const tools = svc.resolveAllowedTools(makeAgent());
		expect(tools.map((t) => t.name)).toContain('getSkillBody');
	});

	it('gates editAgentFile behind permissions.canEditAgentFiles', () => {
		const noPerm = svc.resolveAllowedTools(makeAgent());
		expect(noPerm.map((t) => t.name)).not.toContain('editAgentFile');

		const withPerm = svc.resolveAllowedTools(
			makeAgent({
				permissions: { ...makeAgent().permissions, canEditAgentFiles: true },
			}),
		);
		expect(withPerm.map((t) => t.name)).toContain('editAgentFile');
	});

	it('gates createSubAgent behind permissions.canCreateAgents', () => {
		const noPerm = svc.resolveAllowedTools(makeAgent());
		expect(noPerm.map((t) => t.name)).not.toContain('createSubAgent');

		const withPerm = svc.resolveAllowedTools(
			makeAgent({
				permissions: { ...makeAgent().permissions, canCreateAgents: true },
			}),
		);
		expect(withPerm.map((t) => t.name)).toContain('createSubAgent');
	});

	describe('editAgentFile tool — once-per-file-per-run cap', () => {
		it('rejects a second edit of the same file in the same run', async () => {
			files.write.mockResolvedValue({ newHash: 'h' });
			const tools = svc.resolveAllowedTools(
				makeAgent({
					permissions: { ...makeAgent().permissions, canEditAgentFiles: true },
				}),
				{ runId: 'r1', editsThisRunByFile: new Set() },
			);
			const tool = tools.find((t) => t.name === 'editAgentFile')!;
			const first = await tool.invoke({ name: 'SOUL.md', body: '# v1' });
			expect('newHash' in first && first.newHash).toBe('h');
			const second = await tool.invoke({ name: 'SOUL.md', body: '# v2' });
			expect('error' in second).toBe(true);
			expect((second as any).error).toMatch(/once per file per run/);
		});

		it('allows edits to DIFFERENT files in the same run', async () => {
			files.write.mockResolvedValue({ newHash: 'h' });
			const ctx = { runId: 'r1', editsThisRunByFile: new Set<string>() };
			const tools = svc.resolveAllowedTools(
				makeAgent({
					permissions: { ...makeAgent().permissions, canEditAgentFiles: true },
				}),
				ctx,
			);
			const tool = tools.find((t) => t.name === 'editAgentFile')!;
			const first = await tool.invoke({ name: 'SOUL.md', body: '# soul' });
			const second = await tool.invoke({ name: 'TOOLS.md', body: '# tools' });
			expect('newHash' in first).toBe(true);
			expect('newHash' in second).toBe(true);
		});
	});

	describe('createSubAgent tool', () => {
		it('always creates the sub-Agent in DRAFT with all permissions FALSE', async () => {
			agents.create.mockResolvedValueOnce({ id: 'sub-1', slug: 'helper' });
			const tools = svc.resolveAllowedTools(
				makeAgent({
					permissions: { ...makeAgent().permissions, canCreateAgents: true },
				}),
			);
			const tool = tools.find((t) => t.name === 'createSubAgent')!;
			await tool.invoke({ name: 'Helper' });
			const arg = agents.create.mock.calls[0][0];
			expect(arg.status).toBe('draft');
			expect(arg.permissions).toEqual({
				canCreateAgents: false,
				canAssignTasks: false,
				canEditSkills: false,
				canEditAgentFiles: false,
				canSpend: false,
				canCommitToRepo: false,
				canOpenPullRequests: false,
				canCallExternalTools: false,
			});
		});

		it('inherits the actor scope into the sub-Agent', async () => {
			agents.create.mockResolvedValueOnce({ id: 'sub-1', slug: 'helper' });
			const tools = svc.resolveAllowedTools(
				makeAgent({
					scope: AgentScope.MISSION,
					missionId: 'm1',
					permissions: { ...makeAgent().permissions, canCreateAgents: true },
				}),
			);
			const tool = tools.find((t) => t.name === 'createSubAgent')!;
			await tool.invoke({ name: 'Helper' });
			const arg = agents.create.mock.calls[0][0];
			expect(arg.scope).toBe(AgentScope.MISSION);
			expect(arg.missionId).toBe('m1');
		});

		it('requires a name', async () => {
			const tools = svc.resolveAllowedTools(
				makeAgent({
					permissions: { ...makeAgent().permissions, canCreateAgents: true },
				}),
			);
			const tool = tools.find((t) => t.name === 'createSubAgent')!;
			const out = await tool.invoke({} as any);
			expect('error' in out).toBe(true);
		});
	});
});
