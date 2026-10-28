import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { ActivityLogService } from '../../activity-log/activity-log.service';
import { ENTITIES } from '../../database/_entities-inventory';
import type { OwnershipScope } from '../../database/ownership-scope';
import { ActivityLogRepository } from '../../database/repositories/activity-log.repository';
import {
    TaskApproverRepository,
    TaskAssigneeRepository,
    TaskBlockRepository,
    TaskChatMessageRepository,
    TaskKbMentionRepository,
    TaskRelationRepository,
    TaskReviewerRepository,
    UserTaskCounterRepository,
} from '../../database/repositories/task-side.repositories';
import { TaskRepository } from '../../database/repositories/task.repository';
import { WorkRepository } from '../../database/repositories/work.repository';
import { ActivityLog } from '../../entities/activity-log.entity';
import { ActivityActionType } from '../../entities/activity-log.types';
import { Task } from '../../entities/task.entity';
import { TaskApprover } from '../../entities/task-approver.entity';
import { TaskAssignee } from '../../entities/task-assignee.entity';
import { TaskBlock } from '../../entities/task-block.entity';
import { TaskChatMessage } from '../../entities/task-chat-message.entity';
import { TaskKbMention } from '../../entities/task-kb-mention.entity';
import { TaskRelation } from '../../entities/task-relation.entity';
import { TaskReviewer } from '../../entities/task-reviewer.entity';
import { UserTaskCounter } from '../../entities/user-task-counter.entity';
import { Work } from '../../entities/work.entity';
import { TaskChatService } from '../task-chat.service';
import { TaskTransitionService } from '../task-transition.service';
import { TasksService } from '../tasks.service';

/**
 * C-2 (Ever Works #45): a Task's own Activity rows live in the TASK's workspace.
 *
 * `TasksService` and `TaskChatService` used to write their `task_created` /
 * `task_commented` rows with no `tenantId` / `organizationId`, leaving the stamp to the
 * API's scope subscriber, which copies the REQUEST's workspace. A Task filed by the
 * worker through the remote proxy (an upstream-conflict Task, 5ffb336d5) runs under an
 * empty request scope, so its Task row carried the org Work's scope while its own
 * Activity rows landed null/null — missing from the org feed, and shown in the owner's
 * personal one instead.
 *
 * These cases reproduce exactly that: no request scope at all (this DataSource has no
 * stamping subscriber, so an unstamped row stays null/null, as the subscriber would
 * write it from an empty scope), the real services, and the feed read back through the
 * REAL `ActivityLogRepository.findFeedPage` scope predicate the Live Feed uses.
 */
describe('Task Activity rows take the Task workspace (C-2)', () => {
    const OWNER = randomUUID();
    const TENANT_ID = '33333333-3333-4333-8333-333333333345';
    const ORG_ID = '44444444-4444-4444-8444-444444444445';
    const ORG_SCOPE: OwnershipScope = { tenantId: TENANT_ID, organizationId: ORG_ID };
    const PERSONAL_SCOPE: OwnershipScope = { tenantId: TENANT_ID, organizationId: null };

    let dataSource: DataSource;
    let activityRepository: ActivityLogRepository;
    let tasks: TasksService;
    let chat: TaskChatService;

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
            logging: false,
        });
        await dataSource.initialize();
        // The owning User row is not under test; `works.userId` and friends carry real
        // FKs to `users.id`, which would only force a User fixture onto every case.
        await dataSource.query('PRAGMA foreign_keys = OFF');

        const taskRepo = new TaskRepository(dataSource.getRepository(Task));
        const assignees = new TaskAssigneeRepository(dataSource.getRepository(TaskAssignee));
        const reviewers = new TaskReviewerRepository(dataSource.getRepository(TaskReviewer));
        const approvers = new TaskApproverRepository(dataSource.getRepository(TaskApprover));
        const blocks = new TaskBlockRepository(dataSource.getRepository(TaskBlock));
        const relations = new TaskRelationRepository(dataSource.getRepository(TaskRelation));
        const counter = new UserTaskCounterRepository(dataSource.getRepository(UserTaskCounter));
        const works = new WorkRepository(dataSource.getRepository(Work));
        activityRepository = new ActivityLogRepository(dataSource.getRepository(ActivityLog));
        const activityLog = new ActivityLogService(
            activityRepository,
            works,
            undefined as never, // generation history: not read by `log`
        );
        const transitions = new TaskTransitionService(taskRepo, blocks, approvers, assignees);
        const u = undefined;
        tasks = new TasksService(
            taskRepo,
            assignees,
            reviewers,
            approvers,
            blocks,
            relations,
            counter,
            transitions,
            activityLog,
            u, // attachments
            u, // agents
            u, // notifications
            u, // workUploads
            works,
        );
        chat = new TaskChatService(
            taskRepo,
            new TaskChatMessageRepository(dataSource.getRepository(TaskChatMessage)),
            new TaskKbMentionRepository(dataSource.getRepository(TaskKbMention)),
            activityLog,
        );
    });

    beforeEach(async () => {
        for (const table of [
            'activity_log',
            'tasks',
            'task_chat_messages',
            'user_task_counter',
            'works',
        ]) {
            await dataSource.query(`DELETE FROM "${table}"`);
        }
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    async function seedWork(scope: OwnershipScope): Promise<Work> {
        const repository = dataSource.getRepository(Work);
        const id = randomUUID();
        return repository.save(
            repository.create({
                id,
                name: 'Helpdesk',
                slug: `helpdesk-${id.slice(0, 8)}`,
                description: 'An app Work',
                userId: OWNER,
                kind: 'app',
                tenantId: scope.tenantId,
                organizationId: scope.organizationId,
            } as Partial<Work>),
        );
    }

    /** What the Live Feed of one workspace lists for the owner: `[actionType, taskId]`. */
    async function feedOf(scope: OwnershipScope): Promise<Array<[string, unknown]>> {
        const { rows } = await activityRepository.findFeedPage(
            { userId: OWNER, since: new Date(0), limit: 50 },
            scope,
        );
        return rows
            .map(
                (row) =>
                    [row.actionType, (row.details as Record<string, unknown>)?.resourceId] as [
                        string,
                        unknown,
                    ],
            )
            .sort(([a], [b]) => a.localeCompare(b));
    }

    /**
     * File the Task and comment on it the way `AppUpstreamStateService.recordConflict`
     * does from the worker: the Work's scope is passed as an argument, and nothing else
     * carries a workspace.
     */
    async function fileAndComment(work: Work, scope: OwnershipScope): Promise<Task> {
        const task = await tasks.create(
            OWNER,
            {
                title: 'Resolve the upstream conflict',
                workId: work.id,
                createdByType: 'user',
                createdById: OWNER,
            },
            scope,
        );
        await chat.post(
            OWNER,
            { taskId: task.id, authorType: 'user', authorId: OWNER, body: 'The conflict is back.' },
            {},
            scope,
        );
        return task;
    }

    it("shows an org Work's Task created and commented rows in the org feed only", async () => {
        const work = await seedWork(ORG_SCOPE);

        const task = await fileAndComment(work, ORG_SCOPE);

        expect(task).toMatchObject({ tenantId: TENANT_ID, organizationId: ORG_ID });
        const rows = await dataSource.getRepository(ActivityLog).find();
        expect(rows).toHaveLength(2);
        for (const row of rows) {
            expect(row).toMatchObject({ tenantId: TENANT_ID, organizationId: ORG_ID });
        }
        expect(await feedOf(ORG_SCOPE)).toEqual([
            [ActivityActionType.TASK_COMMENTED, task.id],
            [ActivityActionType.TASK_CREATED, task.id],
        ]);
        // The owner's personal workspace (same tenant) does not see the org Task's rows.
        expect(await feedOf(PERSONAL_SCOPE)).toEqual([]);
    });

    it("keeps a personal Work's Task rows in the personal feed, out of the org one", async () => {
        const work = await seedWork(PERSONAL_SCOPE);

        const task = await fileAndComment(work, PERSONAL_SCOPE);

        expect(await feedOf(PERSONAL_SCOPE)).toEqual([
            [ActivityActionType.TASK_COMMENTED, task.id],
            [ActivityActionType.TASK_CREATED, task.id],
        ]);
        expect(await feedOf(ORG_SCOPE)).toEqual([]);
    });

    it('stamps the Task scope on its later rows too (a worker-side transition)', async () => {
        const work = await seedWork(ORG_SCOPE);
        const task = await fileAndComment(work, ORG_SCOPE);

        // A transition with NO scope argument — the shape of a worker-side call that
        // carries no workspace at all. The Task is still the org one.
        await tasks.update(OWNER, task.id, { title: 'Resolve the upstream conflict (again)' });

        const updated = await dataSource
            .getRepository(ActivityLog)
            .findOneByOrFail({ actionType: ActivityActionType.TASK_UPDATED });
        expect(updated).toMatchObject({ tenantId: TENANT_ID, organizationId: ORG_ID });
        expect(await feedOf(PERSONAL_SCOPE)).toEqual([]);
    });
});
