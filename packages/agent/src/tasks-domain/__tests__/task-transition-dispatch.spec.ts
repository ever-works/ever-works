import { TaskTransitionService } from '../task-transition.service';
import { TaskStatus, TaskPriority } from '../../entities/task.entity';
import type { Task } from '../../entities/task.entity';

function makeTask(over: Partial<Task> = {}): Task {
	return {
		id: 't1',
		userId: 'u1',
		slug: 'T-1',
		title: 'Write the migration',
		description: null,
		status: TaskStatus.TODO,
		previousStatus: null,
		priority: TaskPriority.P3,
		labels: null,
		missionId: null,
		ideaId: null,
		workId: null,
		parentTaskId: null,
		createdByType: 'user',
		createdById: 'u1',
		requireAllApprovers: true,
		startedAt: null,
		completedAt: null,
		isRecurring: false,
		recurrenceOccurredCount: 0,
		createdAt: new Date('2026-01-01'),
		updatedAt: new Date('2026-01-01'),
		...over,
	} as Task;
}

describe('TaskTransitionService — Phase 15.3 agent dispatch hook', () => {
	let tasks: any;
	let blocks: any;
	let approvers: any;
	let assignees: any;
	let runs: any;
	let dispatcher: any;

	beforeEach(() => {
		tasks = {
			updateById: jest.fn().mockResolvedValue(undefined),
			findById: jest.fn(),
		};
		blocks = { findByTaskId: jest.fn().mockResolvedValue([]) };
		approvers = { allApproved: jest.fn().mockResolvedValue(true) };
		assignees = { findAgentAssignees: jest.fn().mockResolvedValue([]) };
		runs = { createQueued: jest.fn().mockResolvedValue({ id: 'r1' }) };
		dispatcher = { enqueue: jest.fn().mockResolvedValue({ runId: 'trd-1' }) };
	});

	function makeSvc() {
		return new TaskTransitionService(tasks, blocks, approvers, assignees, runs, dispatcher);
	}

	it('does NOT fan out when there are no Agent assignees', async () => {
		const svc = makeSvc();
		const task = makeTask({ status: TaskStatus.TODO });
		tasks.findById.mockResolvedValueOnce({ ...task, status: TaskStatus.IN_PROGRESS });
		assignees.findAgentAssignees.mockResolvedValueOnce([]);
		await svc.transition(task, TaskStatus.IN_PROGRESS);
		await new Promise((r) => setImmediate(r)); // flush microtasks
		expect(dispatcher.enqueue).not.toHaveBeenCalled();
	});

	it('fans out to every Agent assignee on → in_progress', async () => {
		const svc = makeSvc();
		const task = makeTask({ status: TaskStatus.TODO });
		tasks.findById.mockResolvedValueOnce({ ...task, status: TaskStatus.IN_PROGRESS });
		assignees.findAgentAssignees.mockResolvedValueOnce([
			{ assigneeType: 'agent', assigneeId: 'agent-a' },
			{ assigneeType: 'agent', assigneeId: 'agent-b' },
		]);
		await svc.transition(task, TaskStatus.IN_PROGRESS);
		await new Promise((r) => setImmediate(r));
		expect(dispatcher.enqueue).toHaveBeenCalledTimes(2);
		const firstCall = dispatcher.enqueue.mock.calls[0][0];
		expect(firstCall.taskId).toBe('t1');
		expect(firstCall.dedupKey).toMatch(/t1:agent-[ab]:1/);
	});

	it('pre-creates a queued AgentRun row before enqueuing the Trigger.dev run', async () => {
		const svc = makeSvc();
		const task = makeTask({ status: TaskStatus.TODO });
		tasks.findById.mockResolvedValueOnce({ ...task, status: TaskStatus.IN_PROGRESS });
		assignees.findAgentAssignees.mockResolvedValueOnce([
			{ assigneeType: 'agent', assigneeId: 'agent-a' },
		]);
		await svc.transition(task, TaskStatus.IN_PROGRESS);
		await new Promise((r) => setImmediate(r));
		expect(runs.createQueued).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: 'agent-a',
				userId: 'u1',
				triggerKind: 'task',
				taskId: 't1',
			}),
		);
	});

	it('dedupKey bumps with recurrenceOccurredCount + 1 on recurring instances', async () => {
		const svc = makeSvc();
		const task = makeTask({ status: TaskStatus.TODO, recurrenceOccurredCount: 4 });
		tasks.findById.mockResolvedValueOnce({ ...task, status: TaskStatus.IN_PROGRESS });
		assignees.findAgentAssignees.mockResolvedValueOnce([
			{ assigneeType: 'agent', assigneeId: 'agent-a' },
		]);
		await svc.transition(task, TaskStatus.IN_PROGRESS);
		await new Promise((r) => setImmediate(r));
		expect(dispatcher.enqueue).toHaveBeenCalledWith(
			expect.objectContaining({ dedupKey: 't1:agent-a:5' }),
		);
	});

	it('does NOT fan out on transitions to other states (e.g. in_progress → done)', async () => {
		const svc = makeSvc();
		const task = makeTask({ status: TaskStatus.IN_PROGRESS, requireAllApprovers: false });
		tasks.findById.mockResolvedValueOnce({ ...task, status: TaskStatus.DONE });
		assignees.findAgentAssignees.mockResolvedValueOnce([
			{ assigneeType: 'agent', assigneeId: 'agent-a' },
		]);
		await svc.transition(task, TaskStatus.DONE);
		await new Promise((r) => setImmediate(r));
		expect(dispatcher.enqueue).not.toHaveBeenCalled();
	});

	it('catches dispatcher failures so the transition still succeeds', async () => {
		const svc = makeSvc();
		dispatcher.enqueue.mockRejectedValueOnce(new Error('Trigger.dev down'));
		const task = makeTask({ status: TaskStatus.TODO });
		tasks.findById.mockResolvedValueOnce({ ...task, status: TaskStatus.IN_PROGRESS });
		assignees.findAgentAssignees.mockResolvedValueOnce([
			{ assigneeType: 'agent', assigneeId: 'agent-a' },
		]);
		const result = await svc.transition(task, TaskStatus.IN_PROGRESS);
		expect(result.status).toBe(TaskStatus.IN_PROGRESS); // transition itself succeeded
	});
});
