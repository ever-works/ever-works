// The real `@ever-works/agent/goals` barrel is loaded (the DTOs read its
// constants); the services arrive as doubles through the constructor.

import { ConflictException, NotFoundException } from '@nestjs/common';
import { GoalsController } from './goals.controller';

/**
 * APW-08 T31 (FR-45) — `POST` / `PATCH /api/me/goals` carry the Goal's `workId` to the service,
 * which owns the rule (reachable in the Goal's scope; unchangeable while the loop runs). The
 * controller adds nothing and hides nothing: the service's `404 workNotFound` and
 * `409 loopRunning` reach the client as they are.
 */
const GOAL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WORK = '11111111-1111-4111-8111-111111111111';
const session = { userId: 'u1', authMethod: 'session' } as never;

function build() {
    const service = {
        create: jest.fn(async (_userId: string, input: { workId?: string | null }) => ({
            id: GOAL,
            workId: input.workId ?? null,
        })),
        update: jest.fn(
            async (_userId: string, _id: string, input: { workId?: string | null }) => ({
                id: GOAL,
                workId: input.workId ?? null,
            }),
        ),
    };
    const controller = new GoalsController(service as never, {} as never);
    return { controller, service };
}

const DELIVERY = {
    title: 'Ship the booking flow',
    goalKind: 'delivery',
    dodCriteria: [{ id: 'flow', text: 'The booking flow is live', status: 'open' }],
};

describe('GoalsController — the Goal’s Work (APW-08 T31)', () => {
    it('create: the workId round-trips through the service', async () => {
        const { controller, service } = build();
        const created = await controller.create(session, { ...DELIVERY, workId: WORK } as never);
        expect(service.create).toHaveBeenCalledWith(
            'u1',
            expect.objectContaining({ workId: WORK }),
            undefined,
        );
        expect(created).toMatchObject({ workId: WORK });
    });

    it('update: a workId (or null to clear) round-trips; an omitted one stays omitted', async () => {
        const { controller, service } = build();
        await controller.update(session, GOAL, { workId: WORK } as never);
        await controller.update(session, GOAL, { workId: null } as never);
        await controller.update(session, GOAL, { title: 'Renamed' } as never);
        expect(service.update.mock.calls.map(([, , input]) => input.workId)).toEqual([
            WORK,
            null,
            undefined,
        ]);
    });

    it('another account’s Work answers the service’s not-found, and a running loop its 409', async () => {
        const { controller, service } = build();
        service.create.mockRejectedValueOnce(
            new NotFoundException({ code: 'workNotFound', message: `Work ${WORK} not found.` }),
        );
        await expect(
            controller.create(session, { ...DELIVERY, workId: WORK } as never),
        ).rejects.toBeInstanceOf(NotFoundException);

        service.update.mockRejectedValueOnce(new ConflictException({ code: 'loopRunning' }));
        await expect(
            controller.update(session, GOAL, { workId: WORK } as never),
        ).rejects.toMatchObject({ response: { code: 'loopRunning' } });
    });
});
