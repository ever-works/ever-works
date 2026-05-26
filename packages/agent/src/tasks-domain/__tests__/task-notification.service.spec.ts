import { TaskNotificationService } from '../task-notification.service';
import { NotificationCategory, NotificationType } from '../../entities/notification.types';

describe('TaskNotificationService', () => {
	let watchers: any;
	let notifications: any;
	let svc: TaskNotificationService;

	beforeEach(() => {
		watchers = { findByTaskId: jest.fn().mockResolvedValue([]) };
		notifications = { create: jest.fn().mockResolvedValue({}) };
		svc = new TaskNotificationService(watchers, notifications);
	});

	it('returns 0 when there are no recipients (no watchers, no explicit list)', async () => {
		const sent = await svc.emit('task_assigned', {
			taskId: 't1',
			taskSlug: 'T-1',
			taskTitle: 'Hi',
		});
		expect(sent).toBe(0);
		expect(notifications.create).not.toHaveBeenCalled();
	});

	it('emits to explicit recipient list', async () => {
		const sent = await svc.emit(
			'task_assigned',
			{ taskId: 't1', taskSlug: 'T-1', taskTitle: 'Hi', actorUserId: 'u-actor' },
			['u-target'],
		);
		expect(sent).toBe(1);
		expect(notifications.create).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: 'u-target',
				category: NotificationCategory.TASK,
				type: NotificationType.INFO,
				title: expect.stringContaining('Assigned: T-1'),
				actionUrl: '/tasks/t1',
			}),
		);
	});

	it('unions watchers + explicit recipients and dedupes', async () => {
		watchers.findByTaskId.mockResolvedValueOnce([
			{ userId: 'u-watcher' },
			{ userId: 'u-shared' },
		]);
		const sent = await svc.emit(
			'task_status_changed',
			{
				taskId: 't1',
				taskSlug: 'T-1',
				taskTitle: 'Hi',
				fromStatus: 'todo',
				toStatus: 'in_progress',
			},
			['u-shared', 'u-explicit'],
		);
		expect(sent).toBe(3);
		const userIds = notifications.create.mock.calls.map((c: any[]) => c[0].userId).sort();
		expect(userIds).toEqual(['u-explicit', 'u-shared', 'u-watcher']);
	});

	it('uses the correct NotificationType per event', async () => {
		watchers.findByTaskId.mockResolvedValueOnce([{ userId: 'u' }]);
		await svc.emit('task_blocked', { taskId: 't', taskSlug: 'T-1', taskTitle: 'x' });
		expect(notifications.create).toHaveBeenCalledWith(
			expect.objectContaining({ type: NotificationType.WARNING }),
		);
	});

	it('attaches a dedupKey scoped to (task, event)', async () => {
		await svc.emit(
			'task_mentioned',
			{ taskId: 't1', taskSlug: 'T-1', taskTitle: 'Hi' },
			['u'],
		);
		expect(notifications.create).toHaveBeenCalledWith(
			expect.objectContaining({ deduplicationKey: 'task:t1:task_mentioned' }),
		);
	});

	it('swallows a single recipient failure and continues', async () => {
		notifications.create
			.mockRejectedValueOnce(new Error('email down'))
			.mockResolvedValueOnce({});
		const sent = await svc.emit(
			'task_assigned',
			{ taskId: 't', taskSlug: 'T-1', taskTitle: 'x' },
			['u-a', 'u-b'],
		);
		expect(sent).toBe(1);
	});
});
