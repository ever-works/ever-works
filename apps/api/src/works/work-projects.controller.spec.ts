// Short-circuit the transitive `@ever-works/agent/*` import chains (house
// pattern — mirrors work-campaigns.controller.spec.ts).
jest.mock('@ever-works/agent/services', () => ({
    __esModule: true,
    WorkLifecycleService: class {},
    WorkQueryService: class {},
}));
jest.mock('../auth', () => ({
    __esModule: true,
    AuthService: class {},
    AuthSessionGuard: class {},
    CurrentUser: () => () => undefined,
}));

import { BadRequestException } from '@nestjs/common';
import { WorkProjectsController } from './work-projects.controller';

/**
 * EW-P2-4 — `POST /api/works/projects`, the only path that mints a repo-less
 * Project Work. The controller resolves the ACTING user, resolves the slug,
 * and hands the rest to `WorkLifecycleService.createProjectWork` (which owns
 * the `EVER_WORKS_PROJECT_WORKS_ENABLED` switch).
 */
describe('WorkProjectsController', () => {
    const auth = { userId: 'u1' } as never;
    const user = { id: 'u1', username: 'founder' };

    let authService: { getUser: jest.Mock };
    let lifecycle: { createProjectWork: jest.Mock };
    let query: { checkSlugAvailability: jest.Mock };
    let controller: WorkProjectsController;

    beforeEach(() => {
        authService = { getUser: jest.fn().mockResolvedValue(user) };
        lifecycle = {
            createProjectWork: jest.fn().mockImplementation(async (_u, params) => ({
                id: 'w1',
                kind: 'project',
                ...params,
            })),
        };
        query = {
            checkSlugAvailability: jest
                .fn()
                .mockResolvedValue({ available: true, slug: 'website-relaunch' }),
        };
        controller = new WorkProjectsController(
            authService as never,
            lifecycle as never,
            query as never,
        );
    });

    it('creates a Project Work for the acting user with a slug derived from the name', async () => {
        const result = await controller.createProjectWork(auth, {
            name: 'Website relaunch',
            description: 'Q4',
        });
        expect(authService.getUser).toHaveBeenCalledWith('u1');
        expect(query.checkSlugAvailability).toHaveBeenCalledWith('Website relaunch', user);
        expect(lifecycle.createProjectWork).toHaveBeenCalledWith(user, {
            name: 'Website relaunch',
            slug: 'website-relaunch',
            description: 'Q4',
        });
        expect(result).toMatchObject({ kind: 'project', slug: 'website-relaunch' });
    });

    it('takes the first free <slug>-N when the derived slug is taken', async () => {
        query.checkSlugAvailability.mockResolvedValue({
            available: false,
            slug: 'website-relaunch',
            suggestion: 'website-relaunch-2',
        });
        await controller.createProjectWork(auth, { name: 'Website relaunch' });
        expect(lifecycle.createProjectWork).toHaveBeenCalledWith(
            user,
            expect.objectContaining({ slug: 'website-relaunch-2' }),
        );
    });

    it('refuses an explicit slug that is taken instead of silently renaming it', async () => {
        query.checkSlugAvailability.mockResolvedValue({
            available: false,
            slug: 'mine',
            suggestion: 'mine-2',
        });
        await expect(
            controller.createProjectWork(auth, { name: 'X', slug: 'mine' }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(lifecycle.createProjectWork).not.toHaveBeenCalled();
    });

    it('passes the switch refusal through unchanged', async () => {
        lifecycle.createProjectWork.mockRejectedValue(
            new BadRequestException({ code: 'project_works_disabled' }),
        );
        await expect(controller.createProjectWork(auth, { name: 'X' })).rejects.toMatchObject({
            status: 400,
            response: { code: 'project_works_disabled' },
        });
    });
});
