import 'reflect-metadata';

jest.mock('@ever-works/agent/schedules', () => ({
    SchedulesService: class {},
    ScheduleControlService: class {},
}));
jest.mock('../scope', () => ({
    ScopeContextService: class {},
}));

import { SchedulesController } from './schedules.controller';

/**
 * `GET /api/schedules/page` — the workspace list. The handler is a thin
 * translation from the validated query to the service filters; the paging
 * itself is covered in the agent package. What this pins:
 *
 *  - scope comes from the session + active workspace ONLY (no query field
 *    can name another user or Organization — the DTO spec proves the 400);
 *  - the wire name `entityKind` becomes `ownerType`, as on the flat list;
 *  - an absent filter is absent, never an empty string.
 */
function build(organizationId: string | null = 'org-1') {
    const page = {
        items: [],
        nextCursor: null,
        total: 0,
        unfilteredTotal: 0,
        countsBySourceType: {},
        unfilteredCountsBySourceType: {},
        countsByStatus: {},
        healthCounts: { ok: 0, neverRuns: 0 },
        degradedSources: [],
        healthCheckedAt: null,
        generatedAt: '2026-09-14T10:00:00.000Z',
    };
    const getPage = jest.fn().mockResolvedValue(page);
    const controller = new SchedulesController(
        { getPage } as never,
        { getOrganizationId: () => organizationId } as never,
    );
    return { controller, getPage, page };
}

const auth = { userId: 'user-1' } as never;

describe('SchedulesController.page', () => {
    it('passes every filter, the cursor and the limit through under the caller scope', async () => {
        const { controller, getPage, page } = build();
        const result = await controller.page(auth, {
            sourceType: 'recurring_task',
            entityKind: 'task',
            enabledOnly: true,
            agentId: '3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6b',
            status: 'paused',
            health: 'never-runs',
            q: 'inbox',
            cursor: 'cursor-1',
            limit: 20,
        });
        expect(result).toBe(page);
        expect(getPage).toHaveBeenCalledWith(
            { userId: 'user-1', organizationId: 'org-1' },
            {
                sourceType: 'recurring_task',
                ownerType: 'task',
                enabledOnly: true,
                agentId: '3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6b',
                status: 'paused',
                health: 'never-runs',
                q: 'inbox',
            },
            'cursor-1',
            20,
        );
    });

    it('sends no filters for an empty query and uses the personal scope when no workspace is active', async () => {
        const { controller, getPage } = build(null);
        await controller.page(auth, {});
        expect(getPage).toHaveBeenCalledWith(
            { userId: 'user-1', organizationId: null },
            {},
            null,
            undefined,
        );
    });

    it('scopes by the authenticated user, whoever is asking', async () => {
        const { controller, getPage } = build();
        await controller.page({ userId: 'user-2' } as never, {});
        expect(getPage.mock.calls[0][0]).toEqual({ userId: 'user-2', organizationId: 'org-1' });
    });
});
