// Mock the agent barrel + injected collaborators so this unit spec does not
// pull the TypeORM graph in. Every collaborator arrives through the
// constructor. Mirrors `memory-files/memory-files.controller.spec.ts`.
jest.mock('@ever-works/agent/services', () => ({ MemoryFactService: class {} }));
jest.mock('../scope', () => ({ ScopeContextService: class {} }));
jest.mock('../auth/decorators/user.decorator', () => ({ CurrentUser: () => () => undefined }));

import {
    ConflictException,
    GoneException,
    NotFoundException,
    UnprocessableEntityException,
} from '@nestjs/common';
import { THROTTLER_LIMIT, THROTTLER_TTL } from '@nestjs/throttler/dist/throttler.constants';
import { MemoryFactsController } from './memory-facts.controller';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import type { ScopeContextService } from '../scope';
import type { MemoryFactService } from '@ever-works/agent/services';

/**
 * `/api/memory/facts` — the contracts that live in the controller rather
 * than the service: the workspace comes ONLY from the scope context, the
 * Forget-all confirmation is checked before anything is written, errors from
 * the service reach the client with their status intact (404 for another
 * workspace, 409 at a cap, 410 past the restore window), and every route
 * carries its throttle.
 */
describe('MemoryFactsController', () => {
    const auth = { userId: 'u-1' } as AuthenticatedUser;
    const ORG_SCOPE = { tenantId: 't-1', organizationId: 'o-1' };
    const ACTOR = { userId: 'u-1', ownership: ORG_SCOPE };

    let facts: Record<string, jest.Mock>;
    let scopeContext: { getScope: jest.Mock };
    let controller: MemoryFactsController;

    beforeEach(() => {
        facts = {
            list: jest.fn().mockResolvedValue({ facts: [], total: 0, counts: {}, semantic: false }),
            stats: jest.fn().mockResolvedValue({ active: 0 }),
            get: jest.fn().mockResolvedValue({ id: 'f-1' }),
            create: jest.fn().mockResolvedValue({ id: 'f-1', status: 'active' }),
            update: jest.fn().mockResolvedValue({ id: 'f-1' }),
            forget: jest.fn().mockResolvedValue({ id: 'f-1', status: 'forgotten' }),
            restore: jest.fn().mockResolvedValue({ id: 'f-1', status: 'active' }),
            accept: jest.fn().mockResolvedValue({ id: 'f-1', status: 'active' }),
            discard: jest.fn().mockResolvedValue(undefined),
            forgetAll: jest.fn().mockResolvedValue({ forgotten: 7 }),
        };
        scopeContext = { getScope: jest.fn().mockReturnValue(ORG_SCOPE) };
        controller = new MemoryFactsController(
            facts as unknown as MemoryFactService,
            scopeContext as unknown as ScopeContextService,
        );
    });

    describe('workspace scoping', () => {
        it('passes the caller and the scope-context workspace to every call', async () => {
            await controller.list(auth, { q: 'delivery', status: 'active', limit: 10 });
            expect(facts.list).toHaveBeenCalledWith(ACTOR, {
                q: 'delivery',
                status: 'active',
                scope: undefined,
                agentId: undefined,
                pinnedOnly: undefined,
                limit: 10,
                cursor: undefined,
            });
        });

        it('treats an unscoped request as the personal workspace', async () => {
            scopeContext.getScope.mockReturnValue({ tenantId: 't-1', organizationId: null });
            await controller.stats(auth);
            expect(facts.stats).toHaveBeenCalledWith({
                userId: 'u-1',
                ownership: { tenantId: 't-1', organizationId: null },
            });
        });

        it('never lets the client choose the origin — a direct write is always the person’s own', async () => {
            await controller.create(auth, {
                body: 'Invoices go out on the 1st.',
                ...({ origin: 'agent' } as object),
            } as never);
            expect(facts.create).toHaveBeenCalledWith(
                ACTOR,
                expect.objectContaining({ origin: 'user', body: 'Invoices go out on the 1st.' }),
            );
        });

        it('surfaces a cross-workspace id as 404, not 403', async () => {
            facts.update.mockRejectedValue(new NotFoundException('Memory fact f-x not found'));
            await expect(controller.update(auth, 'f-x', { pinned: true })).rejects.toBeInstanceOf(
                NotFoundException,
            );
        });
    });

    describe('forget all', () => {
        it.each([undefined, '', 'forget all', 'FORGET  ALL', 'FORGET ALL ', 'yes'])(
            'refuses confirm=%j with 422 and changes nothing',
            async (confirm) => {
                await expect(
                    controller.forgetAll(auth, { confirm } as never),
                ).rejects.toBeInstanceOf(UnprocessableEntityException);
                expect(facts.forgetAll).not.toHaveBeenCalled();
            },
        );

        it('forgets with the exact confirmation', async () => {
            await expect(controller.forgetAll(auth, { confirm: 'FORGET ALL' })).resolves.toEqual({
                forgotten: 7,
            });
            expect(facts.forgetAll).toHaveBeenCalledWith(ACTOR);
        });
    });

    describe('status codes from the service reach the client intact', () => {
        it('409 at the 2,000-fact cap', async () => {
            facts.create.mockRejectedValue(new ConflictException('Memory is full'));
            await expect(controller.create(auth, { body: 'x' })).rejects.toBeInstanceOf(
                ConflictException,
            );
        });

        it('410 on a too-late restore', async () => {
            facts.restore.mockRejectedValue(new GoneException('too late'));
            await expect(controller.restore(auth, 'f-1')).rejects.toBeInstanceOf(GoneException);
        });
    });

    describe('routes delegate one-to-one', () => {
        it.each([
            ['get', 'get'],
            ['forget', 'forget'],
            ['restore', 'restore'],
            ['accept', 'accept'],
            ['discard', 'discard'],
        ] as const)('%s → service.%s(actor, id)', async (route, method) => {
            await (controller[route] as (a: AuthenticatedUser, id: string) => Promise<unknown>)(
                auth,
                'f-1',
            );
            expect(facts[method]).toHaveBeenCalledWith(ACTOR, 'f-1');
        });
    });

    describe('throttles', () => {
        const limitOf = (name: keyof MemoryFactsController) =>
            Reflect.getMetadata(THROTTLER_LIMIT + 'long', MemoryFactsController.prototype[name]);
        const ttlOf = (name: keyof MemoryFactsController) =>
            Reflect.getMetadata(THROTTLER_TTL + 'long', MemoryFactsController.prototype[name]);

        it.each(['create', 'update', 'forget', 'restore', 'accept', 'discard'] as const)(
            '%s is limited to 60 writes a minute',
            (name) => {
                expect(limitOf(name)).toBe(60);
                expect(ttlOf(name)).toBe(60_000);
            },
        );

        it('forget all is limited to 3 an hour', () => {
            expect(limitOf('forgetAll')).toBe(3);
            expect(ttlOf('forgetAll')).toBe(3_600_000);
        });

        it.each(['list', 'stats', 'get'] as const)(
            '%s is limited to 120 reads a minute',
            (name) => {
                expect(limitOf(name)).toBe(120);
            },
        );
    });
});
