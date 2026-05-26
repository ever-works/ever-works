import { AgentsSkillsTasksExportService } from './agents-skills-tasks-export.service';

function makeSvc(over: any = {}) {
	const agents = { findByUserIdScoped: jest.fn().mockResolvedValue({ rows: [], total: 0 }) };
	const agentExport = { exportOne: jest.fn() };
	const skills = { findByUserIdFiltered: jest.fn().mockResolvedValue({ rows: [], total: 0 }) };
	const bindings = { findBySkillId: jest.fn().mockResolvedValue([]) };
	const tasks = { findByUserIdFiltered: jest.fn().mockResolvedValue({ rows: [], total: 0 }) };
	const assignees = { findByTaskId: jest.fn().mockResolvedValue([]) };
	const reviewers = { findByTaskId: jest.fn().mockResolvedValue([]) };
	const approvers = { findByTaskId: jest.fn().mockResolvedValue([]) };
	const chat = { findByTaskId: jest.fn().mockResolvedValue([]) };
	const deps = { agents, agentExport, skills, bindings, tasks, assignees, reviewers, approvers, chat, ...over };
	const svc = new AgentsSkillsTasksExportService(
		deps.agents,
		deps.agentExport as any,
		deps.skills,
		deps.bindings,
		deps.tasks,
		deps.assignees,
		deps.reviewers,
		deps.approvers,
		deps.chat,
	);
	return { svc, ...deps };
}

describe('AgentsSkillsTasksExportService.exportTail', () => {
	it('returns empty tail when no toggles are set', async () => {
		const { svc } = makeSvc();
		const tail = await svc.exportTail('u1');
		expect(tail).toEqual({});
	});

	it('skips features when their toggle is false', async () => {
		const { svc, agents, skills, tasks } = makeSvc();
		await svc.exportTail('u1', { includeAgents: false, includeSkills: false, includeTasks: false });
		expect(agents.findByUserIdScoped).not.toHaveBeenCalled();
		expect(skills.findByUserIdFiltered).not.toHaveBeenCalled();
		expect(tasks.findByUserIdFiltered).not.toHaveBeenCalled();
	});

	it('exports Agents when toggle is true — uses AgentExportService.exportOne', async () => {
		const { svc, agents, agentExport } = makeSvc();
		agents.findByUserIdScoped.mockResolvedValueOnce({
			rows: [{ id: 'a1' }, { id: 'a2' }],
			total: 2,
		});
		agentExport.exportOne.mockResolvedValue({
			version: 1,
			identity: { name: 'X', slug: 'x', title: null, capabilities: null, scope: 'tenant' },
		});
		const tail = await svc.exportTail('u1', { includeAgents: true });
		expect(tail.agents).toHaveLength(2);
		expect(tail.agents?.[0].__kind).toBe('agent');
		expect(agentExport.exportOne).toHaveBeenCalledTimes(2);
	});

	it('exports Skills with bindings, normalizing targetId → targetSlug for non-tenant types', async () => {
		const { svc, skills, bindings } = makeSvc();
		skills.findByUserIdFiltered.mockResolvedValueOnce({
			rows: [
				{
					id: 's1',
					ownerType: 'tenant',
					ownerId: 'u1',
					slug: 'cron',
					title: 'Cron',
					description: 'd',
					frontmatter: { name: 'cron', description: 'd' },
					instructionsMd: '# UTC',
					sourceCatalogSlug: null,
					sourceCatalogVersion: null,
					version: '1.0.0',
				},
			],
			total: 1,
		});
		bindings.findBySkillId.mockResolvedValueOnce([
			{
				targetType: 'tenant',
				targetId: null,
				priority: 100,
				injectIntoAgent: true,
				injectIntoGenerator: false,
			},
			{
				targetType: 'agent',
				targetId: 'agent-a',
				priority: 50,
				injectIntoAgent: true,
				injectIntoGenerator: false,
			},
		]);
		const tail = await svc.exportTail('u1', { includeSkills: true });
		expect(tail.skills).toHaveLength(1);
		const bindingsOut = tail.skills![0].bindings;
		expect(bindingsOut[0].targetSlug).toBeNull();
		expect(bindingsOut[1].targetSlug).toBe('agent-a');
	});

	it('exports Tasks and rewrites parentTaskId → parentTaskSlug', async () => {
		const { svc, tasks } = makeSvc();
		tasks.findByUserIdFiltered.mockResolvedValueOnce({
			rows: [
				{
					id: 't1',
					slug: 'T-1',
					title: 'parent',
					description: null,
					status: 'todo',
					priority: 'p3',
					labels: null,
					missionId: null,
					ideaId: null,
					workId: null,
					parentTaskId: null,
					isRecurring: false,
					recurrenceRule: null,
					recurrenceTimezone: null,
					recurrenceEndsAt: null,
					recurrenceMaxOccurrences: null,
					parentRecurringTaskId: null,
					requireAllApprovers: true,
					createdAt: new Date(),
					startedAt: null,
					completedAt: null,
				},
				{
					id: 't2',
					slug: 'T-2',
					title: 'child',
					description: null,
					status: 'backlog',
					priority: 'p3',
					labels: null,
					missionId: null,
					ideaId: null,
					workId: null,
					parentTaskId: 't1',
					isRecurring: false,
					recurrenceRule: null,
					recurrenceTimezone: null,
					recurrenceEndsAt: null,
					recurrenceMaxOccurrences: null,
					parentRecurringTaskId: null,
					requireAllApprovers: true,
					createdAt: new Date(),
					startedAt: null,
					completedAt: null,
				},
			],
			total: 2,
		});
		const tail = await svc.exportTail('u1', { includeTasks: true });
		expect(tail.tasks).toHaveLength(2);
		const child = tail.tasks!.find((t) => t.slug === 'T-2')!;
		expect(child.parentTaskSlug).toBe('T-1');
	});

	it('omits chat by default; includes it when toggle set', async () => {
		const { svc, tasks, chat } = makeSvc();
		tasks.findByUserIdFiltered.mockResolvedValue({
			rows: [
				{
					id: 't1',
					slug: 'T-1',
					title: 'x',
					description: null,
					status: 'todo',
					priority: 'p3',
					labels: null,
					missionId: null,
					ideaId: null,
					workId: null,
					parentTaskId: null,
					isRecurring: false,
					recurrenceRule: null,
					recurrenceTimezone: null,
					recurrenceEndsAt: null,
					recurrenceMaxOccurrences: null,
					parentRecurringTaskId: null,
					requireAllApprovers: true,
					createdAt: new Date(),
					startedAt: null,
					completedAt: null,
				},
			],
			total: 1,
		});
		chat.findByTaskId.mockResolvedValue([
			{
				authorType: 'user',
				authorId: 'u1',
				body: 'hello',
				createdAt: new Date(),
			},
		]);
		const noChat = await svc.exportTail('u1', { includeTasks: true });
		expect(noChat.tasks?.[0].chat).toBeUndefined();
		const withChat = await svc.exportTail('u1', { includeTasks: true, includeTaskChat: true });
		expect(withChat.tasks?.[0].chat).toHaveLength(1);
	});
});
