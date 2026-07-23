import { TasksService } from '../tasks.service';

/**
 * Owner re-filing semantics on `update()` — pins the three defects the
 * adversarial review confirmed, so they cannot regress:
 *
 *   1. an explicit `parentTaskId: null` DETACHES — it must not fall back to
 *      the old parent and validate the move against the very parent being
 *      severed (`??` used to swallow the null);
 *   2. a combined "move owner + re-parent" validates the new parent against
 *      the POST-patch owner tuple, not the stale row;
 *   3. re-sending an owner's CURRENT value is a no-op — it must not trip
 *      the has-sub-tasks guard.
 */
function makeService(overrides: Record<string, unknown> = {}) {
    const repos = {
        tasks: {
            findByIdAndUser: jest.fn(),
            // `update()` re-fetches through findById after the write for the
            // activity diff; return a plausible row so `diffFor` has fields.
            findById: jest.fn().mockResolvedValue({ id: 'task-c', title: 'refetched' }),
            create: jest.fn(),
            updateById: jest.fn().mockResolvedValue(undefined),
            wouldCreateCycle: jest.fn().mockResolvedValue(false),
            findByUserIdFiltered: jest.fn().mockResolvedValue({ rows: [], total: 0 }),
        },
        assignees: { removeForTask: jest.fn() },
        reviewers: {},
        approvers: {},
        blocks: { removeForTask: jest.fn() },
        relations: {},
        counter: { nextSlug: jest.fn().mockResolvedValue(1) },
        transitions: { recheckUnblockFor: jest.fn().mockResolvedValue(undefined) },
        works: { findById: jest.fn() },
        missions: { findOne: jest.fn() },
        ideas: { findByIdForUser: jest.fn() },
        ...overrides,
    } as Record<string, any>;

    const service = new TasksService(
        repos.tasks,
        repos.assignees,
        repos.reviewers,
        repos.approvers,
        repos.blocks,
        repos.relations,
        repos.counter,
        repos.transitions,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        repos.works,
        repos.missions,
        repos.ideas,
    );

    return { service, repos };
}

const USER = 'user-1';

function task(overrides: Record<string, unknown> = {}) {
    return {
        id: 'task-c',
        userId: USER,
        title: 'Child',
        workId: 'work-a',
        missionId: null,
        ideaId: null,
        teamId: null,
        agentId: null,
        goalId: null,
        parentTaskId: null,
        ...overrides,
    };
}

describe('TasksService.update — owner re-filing', () => {
    it('detaching the parent while re-filing does not validate against the severed parent', async () => {
        const { service, repos } = makeService();
        const child = task({ parentTaskId: 'task-p', workId: 'work-a' });
        repos.tasks.findByIdAndUser.mockImplementation(async (id: string) =>
            id === 'task-c' ? child : null,
        );
        repos.works.findById.mockResolvedValue({ id: 'work-b', userId: USER });

        // Old behaviour: `input.parentTaskId ?? task.parentTaskId` resolved to
        // task-p, fetched it, and threw a scope mismatch — rejecting a
        // legitimate detach+move. Now: explicit null means no parent to check.
        await expect(
            service.update(USER, 'task-c', { parentTaskId: null, workId: 'work-b' }),
        ).resolves.toBeDefined();

        expect(repos.tasks.updateById).toHaveBeenCalledWith(
            'task-c',
            expect.objectContaining({ parentTaskId: null, workId: 'work-b' }),
        );
    });

    it('move + re-parent in one PATCH validates the parent against the POST-patch owners', async () => {
        const { service, repos } = makeService();
        const child = task({ workId: 'work-a' });
        const newParent = task({
            id: 'task-p2',
            title: 'Parent in B',
            workId: 'work-b',
        });
        repos.tasks.findByIdAndUser.mockImplementation(async (id: string) => {
            if (id === 'task-c') return child;
            if (id === 'task-p2') return newParent;
            return null;
        });
        repos.works.findById.mockResolvedValue({ id: 'work-b', userId: USER });

        // Old behaviour: the parent block compared the STALE row (workId
        // work-a) against the new parent (work-b) and threw — every coherent
        // "move to B and re-parent under a B parent" was rejected.
        await expect(
            service.update(USER, 'task-c', { workId: 'work-b', parentTaskId: 'task-p2' }),
        ).resolves.toBeDefined();

        expect(repos.tasks.updateById).toHaveBeenCalledWith(
            'task-c',
            expect.objectContaining({ workId: 'work-b', parentTaskId: 'task-p2' }),
        );
    });

    it('still rejects a re-parent whose scope disagrees with the post-patch owners', async () => {
        const { service, repos } = makeService();
        const child = task({ workId: 'work-a' });
        const wrongParent = task({ id: 'task-p3', workId: 'work-c' });
        repos.tasks.findByIdAndUser.mockImplementation(async (id: string) => {
            if (id === 'task-c') return child;
            if (id === 'task-p3') return wrongParent;
            return null;
        });
        repos.works.findById.mockResolvedValue({ id: 'work-b', userId: USER });

        await expect(
            service.update(USER, 'task-c', { workId: 'work-b', parentTaskId: 'task-p3' }),
        ).rejects.toThrow(/scope/i);
    });

    it('re-sending the current owner value is a no-op, even with sub-tasks present', async () => {
        const { service, repos } = makeService();
        const parent = task({ id: 'task-parent', workId: 'work-a' });
        repos.tasks.findByIdAndUser.mockImplementation(async (id: string) =>
            id === 'task-parent' ? parent : null,
        );
        // This task HAS children — the guard would throw if the no-op resend
        // were treated as an owner change.
        repos.tasks.findByUserIdFiltered.mockResolvedValue({ rows: [{}], total: 3 });

        await expect(
            service.update(USER, 'task-parent', { workId: 'work-a', title: 'Renamed' }),
        ).resolves.toBeDefined();

        expect(repos.tasks.updateById).toHaveBeenCalledWith(
            'task-parent',
            expect.objectContaining({ title: 'Renamed' }),
        );
        // And the owner key was NOT part of the patch (nothing changed).
        const patch = repos.tasks.updateById.mock.calls[0][1];
        expect('workId' in patch).toBe(false);
    });

    it('still refuses to move a parent that has sub-tasks', async () => {
        const { service, repos } = makeService();
        const parent = task({ id: 'task-parent', workId: 'work-a' });
        repos.tasks.findByIdAndUser.mockImplementation(async (id: string) =>
            id === 'task-parent' ? parent : null,
        );
        repos.works.findById.mockResolvedValue({ id: 'work-b', userId: USER });
        repos.tasks.findByUserIdFiltered.mockResolvedValue({ rows: [{}], total: 2 });

        await expect(service.update(USER, 'task-parent', { workId: 'work-b' })).rejects.toThrow(
            /sub-task/i,
        );
    });
});
