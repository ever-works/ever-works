import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { E2eSeedEnabledGuard } from '../app-launcher/e2e-seed.controller';
import { E2eTaskSeedController } from './e2e-task-seed.controller';

/**
 * APW-08 T29 — `POST /api/e2e/app-works/task-seed`: the gate it shares with the APW-11 seed
 * route, the App Work check, and that a `guard` body records the REAL guard's refusal.
 */
describe('E2eTaskSeedController', () => {
    const TASK_ID = '00000000-0000-4000-8000-000000000001';
    const WORK_ID = '00000000-0000-4000-8000-000000000002';
    const USER = { userId: 'user-1' } as never;

    function build(kind: string | null = 'app') {
        const task = {
            id: TASK_ID,
            slug: 'T-7',
            workId: WORK_ID,
            prNumber: null,
            branchRef: null,
            deliveryDeploymentId: null,
            tenantId: null,
            organizationId: null,
        };
        let stored: Record<string, unknown> = { ...task };
        const tasksService = { getOne: jest.fn().mockResolvedValue(task) };
        const taskRows = {
            update: jest.fn(async (_where: unknown, patch: Record<string, unknown>) => {
                stored = { ...stored, ...patch };
            }),
            findOne: jest.fn(async () => stored),
        };
        const workRows = {
            findOne: jest
                .fn()
                .mockResolvedValue(kind ? { id: WORK_ID, kind, tenantId: null } : null),
        };
        const deploymentRows = {
            create: jest.fn((row: Record<string, unknown>) => row),
            save: jest.fn(async (row: Record<string, unknown>) => ({ ...row, id: 'dep-1' })),
        };
        const scope = { getScope: jest.fn().mockReturnValue(undefined) };
        const controller = new E2eTaskSeedController(
            tasksService as never,
            taskRows as never,
            workRows as never,
            deploymentRows as never,
            scope as never,
        );
        return { controller, tasksService, taskRows, deploymentRows };
    }

    it('is guarded by the APW-11 seed gate (404 before the handler when it is closed)', () => {
        const guards = Reflect.getMetadata(GUARDS_METADATA, E2eTaskSeedController) as unknown[];
        expect(guards).toContain(E2eSeedEnabledGuard);
        const previous = process.env.E2E_APP_LAUNCHER_SEED;
        delete process.env.E2E_APP_LAUNCHER_SEED;
        try {
            expect(() => new E2eSeedEnabledGuard().canActivate()).toThrow(NotFoundException);
        } finally {
            if (previous === undefined) delete process.env.E2E_APP_LAUNCHER_SEED;
            else process.env.E2E_APP_LAUNCHER_SEED = previous;
        }
    });

    it('refuses a Task that is not on an App Work (422 notAppWork) and writes nothing', async () => {
        const { controller, taskRows } = build('website');
        await expect(
            controller.seed(USER, { taskId: TASK_ID, delivery: { state: 'merged' } } as never),
        ).rejects.toBeInstanceOf(UnprocessableEntityException);
        expect(taskRows.update).not.toHaveBeenCalled();
    });

    it('reads the Task through the owner-scoped service (another account’s Task is its 404)', async () => {
        const { controller, tasksService } = build();
        tasksService.getOne.mockRejectedValueOnce(new NotFoundException());
        await expect(
            controller.seed(USER, { taskId: TASK_ID, delivery: { state: 'merged' } } as never),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(tasksService.getOne).toHaveBeenCalledWith('user-1', TASK_ID, undefined);
    });

    it('writes the delivery columns and the deciding Deployment carrying the merge commit', async () => {
        const { controller, taskRows, deploymentRows } = build();
        const merge = 'a'.repeat(40);
        const answer = await controller.seed(USER, {
            taskId: TASK_ID,
            delivery: {
                state: 'deploy_failed',
                mergeCommitSha: merge,
                prNumber: 9,
                deployment: { state: 'ROLLED_BACK' },
            },
        } as never);
        expect(deploymentRows.save).toHaveBeenCalledWith(
            expect.objectContaining({ workId: WORK_ID, state: 'ROLLED_BACK', commitSha: merge }),
        );
        expect(taskRows.update).toHaveBeenCalledWith(
            { id: TASK_ID },
            expect.objectContaining({
                deliveryState: 'deploy_failed',
                mergeCommitSha: merge,
                deliveryDeploymentId: 'dep-1',
                prNumber: 9,
                prState: 'merged',
            }),
        );
        expect(answer).toMatchObject({
            deliveryState: 'deploy_failed',
            deliveryDeploymentId: 'dep-1',
        });
    });

    it('records the real AppChangeGuard refusal on the branch, and writes nothing for an allowed change', async () => {
        const refused = build();
        const answer = await refused.controller.seed(USER, {
            taskId: TASK_ID,
            guard: {
                protectedPaths: ['apps/web/public/brand/**'],
                files: [{ path: 'apps/web/public/brand/logo.svg', additions: 1 }],
            },
        } as never);
        expect(answer.guard).toMatchObject({
            allowed: false,
            code: 'protectedPath',
            paths: ['apps/web/public/brand/logo.svg'],
        });
        const patch = refused.taskRows.update.mock.calls[0][1] as Record<string, string>;
        expect(patch.branchState).toBe('pushed');
        expect(patch.branchRef).toBe('task/t-7-e2e');
        expect(patch.branchGuardRefusal).toContain(answer.guard!.message!);
        expect(patch.branchGuardRefusal).toContain('- `apps/web/public/brand/logo.svg`');

        const allowed = build();
        const ok = await allowed.controller.seed(USER, {
            taskId: TASK_ID,
            guard: { sizeGuidance: 400, files: [{ path: 'src/a.ts', additions: 612 }] },
        } as never);
        expect(ok.guard).toMatchObject({ allowed: true, changedLines: 612 });
        expect(ok.guard?.note).toContain('612');
        expect(allowed.taskRows.update).not.toHaveBeenCalled();
    });
});
