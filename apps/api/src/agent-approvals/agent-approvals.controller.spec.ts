import { ConflictException, NotFoundException } from '@nestjs/common';
import { AgentApprovalsController } from './agent-approvals.controller';
import type { AuthenticatedUser } from '../auth/types/auth.types';

/**
 * `/api/agent-approvals` — the API edge.
 *
 * This controller had no spec. It is one of the doors a decision can be
 * taken through (the Home approvals block uses it), so every decision must
 * go through `AgentApprovalsService.decide` / `approveAll` — which close
 * the Inbox mirror — and never around them. What is pinned: the `api/`
 * prefix, owner-only call shapes, the approve / reject mapping, and that
 * the service's 404 and 409 reach the caller untouched.
 */
const auth = { userId: 'u1' } as AuthenticatedUser;

function makeService() {
    return {
        list: jest.fn(async () => ({ rows: [{ id: 'p1' }], total: 1 })),
        getOne: jest.fn(async () => ({ id: 'p1' })),
        decide: jest.fn(async (_userId: string, id: string, decision: string) => ({
            id,
            status: decision,
        })),
        approveAll: jest.fn(async () => ({ approved: 2, skipped: 1, excluded: 1 })),
    };
}

describe('AgentApprovalsController', () => {
    let service: ReturnType<typeof makeService>;
    let controller: AgentApprovalsController;

    beforeEach(() => {
        service = makeService();
        controller = new AgentApprovalsController(service as never);
    });

    it('is mounted under the api/ prefix', () => {
        expect(Reflect.getMetadata('path', AgentApprovalsController)).toBe('api/agent-approvals');
    });

    it('declares approve-all before the :id routes so it is not parsed as an id', () => {
        const names = Object.getOwnPropertyNames(AgentApprovalsController.prototype);
        expect(names.indexOf('approveAll')).toBeLessThan(names.indexOf('approve'));
    });

    describe('GET /api/agent-approvals', () => {
        it('lists the caller’s proposals with a bounded default page', async () => {
            const result = await controller.list(auth, {});

            expect(service.list).toHaveBeenCalledWith('u1', {
                status: undefined,
                organizationId: null,
                limit: 50,
                offset: 0,
            });
            expect(result).toEqual({
                data: [{ id: 'p1' }],
                meta: { total: 1, limit: 50, offset: 0 },
            });
        });

        it('forwards the status and organization filters', async () => {
            await controller.list(auth, {
                status: 'approved',
                organizationId: 'o1',
                limit: 5,
                offset: 10,
            } as never);

            expect(service.list).toHaveBeenCalledWith('u1', {
                status: 'approved',
                organizationId: 'o1',
                limit: 5,
                offset: 10,
            });
        });
    });

    describe('GET /api/agent-approvals/:id', () => {
        it('reads owner-scoped and lets the service 404 a foreign id', async () => {
            await expect(controller.getOne(auth, 'p1')).resolves.toEqual({ id: 'p1' });
            expect(service.getOne).toHaveBeenCalledWith('u1', 'p1');

            service.getOne.mockRejectedValue(new NotFoundException('Proposal p1 not found.'));
            await expect(controller.getOne(auth, 'p1')).rejects.toBeInstanceOf(NotFoundException);
        });
    });

    describe('decisions', () => {
        it('approve and reject go through the one decide path', async () => {
            await expect(controller.approve(auth, 'p1')).resolves.toMatchObject({
                status: 'approved',
            });
            await expect(controller.reject(auth, 'p1')).resolves.toMatchObject({
                status: 'rejected',
            });

            expect(service.decide.mock.calls).toEqual([
                ['u1', 'p1', 'approved'],
                ['u1', 'p1', 'rejected'],
            ]);
        });

        it('surfaces the 409 for a proposal that was already decided', async () => {
            service.decide.mockRejectedValue(new ConflictException('already approved'));

            await expect(controller.approve(auth, 'p1')).rejects.toBeInstanceOf(ConflictException);
        });

        it('approve-all forwards the optional subset and keeps skipped and excluded apart', async () => {
            await expect(controller.approveAll(auth, { ids: ['p1', 'p2'] })).resolves.toEqual({
                approved: 2,
                skipped: 1,
                excluded: 1,
            });
            expect(service.approveAll).toHaveBeenCalledWith('u1', ['p1', 'p2']);

            await controller.approveAll(auth, {});
            expect(service.approveAll).toHaveBeenLastCalledWith('u1', undefined);
        });
    });
});
