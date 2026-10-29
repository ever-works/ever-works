import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { TASK_DELIVERY_FILTER_GROUPS } from '@ever-works/contracts';
import {
    createDomainEventsDataSource,
    ORG_A,
    TENANT,
} from '../../../domain-events/__tests__/domain-events.test-helpers';
import { Task, TaskStatus } from '../../../entities/task.entity';
import { TaskRepository } from '../task.repository';

/**
 * APW-08 T24 — `GET /api/tasks?deliveryState=`: the App Work Tasks tab's **Delivery** filter, on
 * a real SQLite schema so the SQL itself is what is asserted.
 *
 *  - the tokens are OR-ed with each other and AND-ed with every other filter;
 *  - `waiting` is a change not merged yet: no delivery state AND an open (or draft) pull
 *    request — a Task with no pull request, or a closed one, is not waiting to merge;
 *  - the filter only narrows the caller's own list: another account's Task in the same state
 *    is never returned (owner-scoped like every other list filter).
 */
describe('TaskRepository.findByUserIdFiltered — deliveryState (APW-08 T24, SQLite)', () => {
    let dataSource: DataSource;
    let tasks: TaskRepository;
    const OWNER = randomUUID();
    const OTHER = randomUUID();
    const WORK = randomUUID();
    const scope = { tenantId: TENANT, organizationId: ORG_A };

    const makeTask = (title: string, overrides: Partial<Task> = {}) =>
        dataSource.getRepository(Task).save(
            dataSource.getRepository(Task).create({
                userId: OWNER,
                slug: `T-${randomUUID().slice(0, 6)}`,
                title,
                status: TaskStatus.IN_REVIEW,
                createdByType: 'user',
                createdById: OWNER,
                tenantId: TENANT,
                organizationId: ORG_A,
                workId: WORK,
                ...overrides,
            } as Partial<Task>),
        );

    const titles = async (filter: Parameters<TaskRepository['findByUserIdFiltered']>[1]) => {
        const { rows, total } = await tasks.findByUserIdFiltered(OWNER, filter, scope);
        expect(total).toBe(rows.length);
        return rows.map((row) => row.title).sort();
    };

    beforeAll(async () => {
        dataSource = await createDomainEventsDataSource();
        tasks = new TaskRepository(dataSource.getRepository(Task));
        await makeTask('open-pr', { prState: 'open', prNumber: 1 });
        await makeTask('draft-pr', { prState: 'draft', prNumber: 2 });
        await makeTask('closed-pr', { prState: 'closed', prNumber: 3 });
        await makeTask('no-pr', { status: TaskStatus.TODO });
        await makeTask('merged', { prState: 'merged', deliveryState: 'merged' });
        await makeTask('building', { prState: 'merged', deliveryState: 'building' });
        await makeTask('built', { prState: 'merged', deliveryState: 'built' });
        await makeTask('build-failed', { prState: 'merged', deliveryState: 'build_failed' });
        await makeTask('deploy-failed', { prState: 'merged', deliveryState: 'deploy_failed' });
        await makeTask('live', {
            prState: 'merged',
            deliveryState: 'live',
            status: TaskStatus.DONE,
        });
        await makeTask('closed', {
            prState: 'merged',
            deliveryState: 'closed_without_deploy',
            status: TaskStatus.DONE,
        });
        // Another account's Tasks in the same states: never part of OWNER's list.
        await makeTask('foreign-live', {
            userId: OTHER,
            createdById: OTHER,
            deliveryState: 'live',
        });
        await makeTask('foreign-open-pr', { userId: OTHER, createdById: OTHER, prState: 'open' });
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('without the filter the list is unchanged (every own Task)', async () => {
        expect(await titles({})).toHaveLength(11);
        expect(await titles({ deliveryState: [] })).toHaveLength(11);
    });

    it('one state returns exactly the Tasks in it', async () => {
        expect(await titles({ deliveryState: ['live'] })).toEqual(['live']);
        expect(await titles({ deliveryState: ['closed_without_deploy'] })).toEqual(['closed']);
    });

    it('several states are OR-ed', async () => {
        expect(await titles({ deliveryState: ['build_failed', 'deploy_failed'] })).toEqual([
            'build-failed',
            'deploy-failed',
        ]);
    });

    it('waiting = no delivery state and an open or draft pull request', async () => {
        expect(await titles({ deliveryState: ['waiting'] })).toEqual(['draft-pr', 'open-pr']);
    });

    it('waiting mixes with states and still AND-s with the other filters', async () => {
        expect(await titles({ deliveryState: ['waiting', 'merged'] })).toEqual([
            'draft-pr',
            'merged',
            'open-pr',
        ]);
        expect(
            await titles({ deliveryState: ['waiting', 'live'], status: TaskStatus.DONE }),
        ).toEqual(['live']);
    });

    it("never returns another account's Task in the same state", async () => {
        expect(await titles({ deliveryState: ['live', 'waiting'] })).toEqual([
            'draft-pr',
            'live',
            'open-pr',
        ]);
    });

    it('each Delivery select option returns its own Tasks, and the options cover every tracked Task once', async () => {
        const byGroup: Record<string, string[]> = {};
        for (const [group, tokens] of Object.entries(TASK_DELIVERY_FILTER_GROUPS)) {
            byGroup[group] = await titles({ deliveryState: [...tokens] });
        }
        expect(byGroup).toEqual({
            waiting: ['draft-pr', 'open-pr'],
            building: ['building', 'merged'],
            deploying: ['built'],
            live: ['live'],
            failed: ['build-failed', 'deploy-failed'],
            closed: ['closed'],
        });
    });
});
