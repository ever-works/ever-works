import { ForbiddenException } from '@nestjs/common';
import { ReservedTaskLabelError, TasksService, assertReservedLabelsUnchanged } from '../tasks.service';

/**
 * Works-security (2026-10-18) — reserved Task labels.
 *
 * `awaiting-owner` (a binding hold), `app-provision`, `provision-attempt-*`
 * (the provisioning loop's cap) and `release:*` (forces a human approval on a
 * promotion / revert) are control signals. A RESTRICTED caller — a fleet-run
 * token, an integration key, an agent tool — may neither add nor remove them;
 * a person and platform code keep full control.
 */
function makeService(current: Record<string, unknown>) {
    const repos = {
        tasks: {
            findByIdAndUser: jest.fn().mockResolvedValue(current),
            findById: jest.fn().mockResolvedValue(current),
            create: jest.fn(async (row: Record<string, unknown>) => ({ id: 'new', ...row })),
            updateById: jest.fn().mockResolvedValue(undefined),
            wouldCreateCycle: jest.fn().mockResolvedValue(false),
            findByUserIdFiltered: jest.fn().mockResolvedValue({ rows: [], total: 0 }),
        },
        counter: { nextSlug: jest.fn().mockResolvedValue(7) },
        transitions: { recheckUnblockFor: jest.fn().mockResolvedValue(undefined) },
    } as Record<string, any>;
    const service = new TasksService(
        repos.tasks,
        { removeForTask: jest.fn() } as never,
        {} as never,
        {} as never,
        { removeForTask: jest.fn() } as never,
        {} as never,
        repos.counter,
        repos.transitions,
    );
    return { service, repos };
}

const USER = 'user-1';
const held = { id: 't1', userId: USER, title: 'From email', labels: ['awaiting-owner', 'bug'] };
const fleet = { restrictReservedLabels: { who: 'A fleet-run credential' } };

describe('TasksService — reserved labels', () => {
    const previous = process.env.TASK_RESERVED_LABELS_ENFORCED;
    afterEach(() => {
        if (previous === undefined) delete process.env.TASK_RESERVED_LABELS_ENFORCED;
        else process.env.TASK_RESERVED_LABELS_ENFORCED = previous;
    });

    it('refuses a restricted caller that strips awaiting-owner, and writes nothing', async () => {
        const { service, repos } = makeService(held);
        await expect(service.update(USER, 't1', { labels: ['bug'] }, undefined, fleet)).rejects.toThrow(
            /cannot remove "awaiting-owner"/,
        );
        await expect(
            service.update(USER, 't1', { labels: ['bug'] }, undefined, fleet),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(repos.tasks.updateById).not.toHaveBeenCalled();
    });

    it('refuses a restricted caller that adds app-provision or a release label', async () => {
        const { service } = makeService({ id: 't1', userId: USER, title: 'x', labels: [] });
        await expect(
            service.update(USER, 't1', { labels: ['app-provision'] }, undefined, fleet),
        ).rejects.toBeInstanceOf(ReservedTaskLabelError);
        await expect(
            service.update(USER, 't1', { labels: ['release:revert:stage-to-main'] }, undefined, fleet),
        ).rejects.toBeInstanceOf(ReservedTaskLabelError);
    });

    it('lets a restricted caller edit ordinary labels while the reserved ones stay', async () => {
        const { service, repos } = makeService(held);
        await service.update(USER, 't1', { labels: ['p1', 'awaiting-owner'] }, undefined, fleet);
        expect(repos.tasks.updateById).toHaveBeenCalled();
    });

    it('a person (no restriction) keeps full control', async () => {
        const { service, repos } = makeService(held);
        await service.update(USER, 't1', { labels: ['bug'] });
        expect(repos.tasks.updateById).toHaveBeenCalled();
    });

    it('refuses a restricted create carrying a reserved label', async () => {
        const { service, repos } = makeService(held);
        await expect(
            service.create(
                USER,
                {
                    title: 'Injected',
                    labels: ['provision-attempt-1'],
                    createdByType: 'agent',
                    createdById: 'agent-1',
                },
                undefined,
                fleet,
            ),
        ).rejects.toBeInstanceOf(ReservedTaskLabelError);
        expect(repos.tasks.create).not.toHaveBeenCalled();
    });

    it('is switched off only by TASK_RESERVED_LABELS_ENFORCED=false', () => {
        process.env.TASK_RESERVED_LABELS_ENFORCED = 'false';
        expect(() =>
            assertReservedLabelsUnchanged(['awaiting-owner'], [], fleet.restrictReservedLabels),
        ).not.toThrow();
        delete process.env.TASK_RESERVED_LABELS_ENFORCED;
        expect(() =>
            assertReservedLabelsUnchanged(['awaiting-owner'], [], fleet.restrictReservedLabels),
        ).toThrow(ReservedTaskLabelError);
    });

    it('origin is written only from the server-side create input', async () => {
        const { service, repos } = makeService(held);
        await service.create(USER, {
            title: 'Provision',
            createdByType: 'user',
            createdById: USER,
            origin: 'app-provisioning',
        });
        expect(repos.tasks.create.mock.calls[0][0].origin).toBe('app-provisioning');
        await service.create(USER, { title: 'Plain', createdByType: 'user', createdById: USER });
        expect(repos.tasks.create.mock.calls[1][0].origin).toBeNull();
    });
});
