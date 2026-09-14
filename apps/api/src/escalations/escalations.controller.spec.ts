import { NotFoundException } from '@nestjs/common';
import { EscalationsController } from './escalations.controller';
import type { AuthenticatedUser } from '../auth/types/auth.types';

/**
 * `/api/escalations` — the API edge.
 *
 * This controller had no spec. It matters more now that it is one of the
 * doors a decision can be taken through: a resolve here must go through
 * `AgentEscalationService.resolve` (which closes the Inbox mirror and
 * hands the note to the parked run), never around it. What is pinned:
 * the `api/` prefix, the owner-only call shapes (no caller-supplied user),
 * and 404-never-403 on get and resolve.
 */
const auth = { userId: 'u1' } as AuthenticatedUser;

function makeService() {
    return {
        listForUser: jest.fn(async () => [{ id: 'e1' }]),
        getForUser: jest.fn(async () => ({ id: 'e1' })),
        resolve: jest.fn(async () => true),
    };
}

describe('EscalationsController', () => {
    let service: ReturnType<typeof makeService>;
    let controller: EscalationsController;

    beforeEach(() => {
        service = makeService();
        controller = new EscalationsController(service as never);
    });

    it('is mounted under the api/ prefix', () => {
        expect(Reflect.getMetadata('path', EscalationsController)).toBe('api/escalations');
    });

    describe('GET /api/escalations', () => {
        it('lists the caller’s own queue with a bounded default page', async () => {
            await expect(controller.list(auth, {})).resolves.toEqual({ data: [{ id: 'e1' }] });

            expect(service.listForUser).toHaveBeenCalledWith('u1', {
                status: undefined,
                limit: 50,
                offset: 0,
            });
        });

        it('forwards status, limit and offset', async () => {
            await controller.list(auth, { status: 'resolved', limit: 10, offset: 20 });

            expect(service.listForUser).toHaveBeenCalledWith('u1', {
                status: 'resolved',
                limit: 10,
                offset: 20,
            });
        });
    });

    describe('GET /api/escalations/:id', () => {
        it('returns the caller’s escalation', async () => {
            await expect(controller.getOne(auth, 'e1')).resolves.toEqual({ id: 'e1' });
            expect(service.getForUser).toHaveBeenCalledWith('e1', 'u1');
        });

        it('404s when the service reports nothing, foreign and missing alike', async () => {
            service.getForUser.mockResolvedValue(null as never);
            await expect(controller.getOne(auth, 'e1')).rejects.toBeInstanceOf(NotFoundException);
        });
    });

    describe('POST /api/escalations/:id/resolve', () => {
        it('resolves through the service with the note, so the Inbox mirror closes too', async () => {
            await expect(
                controller.resolve(auth, 'e1', { note: 'Raised the budget' }),
            ).resolves.toEqual({ resolved: true, escalationId: 'e1' });

            expect(service.resolve).toHaveBeenCalledWith('e1', 'u1', 'Raised the budget');
        });

        it('normalises an absent note to null', async () => {
            await controller.resolve(auth, 'e1', {});

            expect(service.resolve).toHaveBeenCalledWith('e1', 'u1', null);
        });

        it('404s when nothing was resolved: foreign, missing, or already resolved', async () => {
            service.resolve.mockResolvedValue(false);

            await expect(controller.resolve(auth, 'e1', {})).rejects.toBeInstanceOf(
                NotFoundException,
            );
        });
    });
});
