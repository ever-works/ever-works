import { NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { InboxController } from '../inbox.controller';
import {
    ListInboxDecisionsQueryDto,
    ListInboxQueryDto,
    ReplyInboxItemDto,
    SetInboxReadStateDto,
} from '../dto/inbox.dto';
import type { AuthenticatedUser } from '../../auth/types/auth.types';

/**
 * `/api/inbox` — the API edge.
 *
 * Two things are worth pinning here and nowhere else:
 *
 *  1. **The body/query mapping.** Every field a DTO declares has to be
 *     COPIED into the service call. A validated field the controller
 *     never forwards is the wired-but-dead defect: the request passes
 *     validation, the endpoint 200s, and the value silently evaporates.
 *  2. **The route prefix.** `apps/api` sets no global prefix, so a
 *     controller declared as `@Controller('inbox')` would be unreachable
 *     in production behind an ingress that only routes `/api/*`.
 */
const auth = { userId: 'u1' } as AuthenticatedUser;

function makeService() {
    return {
        list: jest.fn(async () => ({ items: [], total: 0, unreadCount: 3 })),
        unreadCount: jest.fn(async () => 3),
        getForUser: jest.fn(async () => ({ id: 'i1' })),
        reply: jest.fn(async () => ({ item: { id: 'i1' }, routed: 'steered' })),
        setUnread: jest.fn(async () => ({ id: 'i1', unread: false })),
        setArchived: jest.fn(async () => ({ id: 'i1', status: 'archived' })),
        delete: jest.fn(async () => undefined),
        listDecisions: jest.fn(async () => ({
            items: [],
            total: 7,
            counts: { open: 4, blocking: 2, lastRaisedAt: '2026-08-01T00:00:00.000Z' },
        })),
        decisionCounts: jest.fn(async () => ({ open: 4, blocking: 2, lastRaisedAt: null })),
    };
}

describe('InboxController', () => {
    let service: ReturnType<typeof makeService>;
    let controller: InboxController;

    beforeEach(() => {
        service = makeService();
        controller = new InboxController(service as never);
    });

    it('is mounted under the api/ prefix', () => {
        // Reflect the decorator rather than trusting the source string: a
        // missing `api/` made an entire controller unreachable in prod once.
        expect(Reflect.getMetadata('path', InboxController)).toBe('api/inbox');
    });

    describe('GET /api/inbox', () => {
        it('forwards status, limit and offset, and reports the unread count', async () => {
            const result = await controller.list(auth, {
                status: 'archived',
                limit: 10,
                offset: 20,
            });

            expect(service.list).toHaveBeenCalledWith('u1', {
                status: 'archived',
                limit: 10,
                offset: 20,
            });
            expect(result.meta).toEqual({
                total: 0,
                limit: 10,
                offset: 20,
                unreadCount: 3,
            });
        });

        it('defaults to the active view with a bounded page', async () => {
            const result = await controller.list(auth, {});

            expect(service.list).toHaveBeenCalledWith('u1', {
                status: undefined,
                limit: 50,
                offset: 0,
            });
            expect(result.meta.limit).toBe(50);
        });

        it('forwards a taskId filter (the Task page open-question lookup, slice Q)', async () => {
            await controller.list(auth, { taskId: 't1', status: 'open', limit: 5 });

            expect(service.list).toHaveBeenCalledWith(
                'u1',
                expect.objectContaining({ taskId: 't1', status: 'open', limit: 5 }),
            );
        });
    });

    describe('GET /api/inbox/:id', () => {
        it('404s when the service reports nothing — foreign and missing alike', async () => {
            service.getForUser.mockResolvedValue(null as never);
            await expect(controller.getOne(auth, 'i1')).rejects.toBeInstanceOf(NotFoundException);
        });
    });

    describe('POST /api/inbox/:id/reply', () => {
        it('copies BOTH reply fields through to the service', async () => {
            await controller.reply(auth, 'i1', { text: 'Use Postgres', optionId: 'pg' });

            expect(service.reply).toHaveBeenCalledWith('u1', 'i1', {
                text: 'Use Postgres',
                optionId: 'pg',
            });
        });

        it('normalizes absent halves to null rather than dropping them', async () => {
            await controller.reply(auth, 'i1', {});

            expect(service.reply).toHaveBeenCalledWith('u1', 'i1', {
                text: null,
                optionId: null,
            });
        });
    });

    describe('GET /api/inbox/decisions (My Decisions)', () => {
        it('is declared before :id so the literal path is not swallowed by the UUID route', () => {
            const names = Object.getOwnPropertyNames(InboxController.prototype);
            const routeIndex = (method: string) => names.indexOf(method);
            expect(routeIndex('listDecisions')).toBeGreaterThan(-1);
            expect(routeIndex('listDecisions')).toBeLessThan(routeIndex('getOne'));
            expect(routeIndex('decisionCounts')).toBeLessThan(routeIndex('getOne'));
            expect(Reflect.getMetadata('path', InboxController.prototype.listDecisions)).toBe(
                'decisions',
            );
            expect(Reflect.getMetadata('path', InboxController.prototype.decisionCounts)).toBe(
                'decisions/counts',
            );
        });

        it('defaults to the open queue with a page of 25 and reports the header counts', async () => {
            const result = await controller.listDecisions(auth, {});

            expect(service.listDecisions).toHaveBeenCalledWith('u1', {
                status: 'open',
                limit: 25,
                offset: 0,
            });
            expect(result.meta).toEqual({
                total: 7,
                limit: 25,
                offset: 0,
                openCount: 4,
                blockingCount: 2,
                lastRaisedAt: '2026-08-01T00:00:00.000Z',
                nextCursor: null,
            });
        });

        it('forwards the cursor and hands back the next one', async () => {
            service.listDecisions.mockResolvedValueOnce({
                items: [],
                total: 7,
                counts: { open: 4, blocking: 2, lastRaisedAt: null },
                nextCursor: 'bmV4dA',
            } as never);

            const result = await controller.listDecisions(auth, { cursor: 'cHJldg' });

            expect(service.listDecisions).toHaveBeenCalledWith('u1', {
                status: 'open',
                limit: 25,
                offset: 0,
                cursor: 'cHJldg',
            });
            expect(result.meta.nextCursor).toBe('bmV4dA');
        });

        it('forwards every filter, trimming the search term', async () => {
            await controller.listDecisions(auth, {
                status: 'answered',
                kind: 'approval',
                agentId: 'a1',
                taskId: 't1',
                missionId: 'm1',
                q: '  budget  ',
                limit: 50,
                offset: 25,
            });

            expect(service.listDecisions).toHaveBeenCalledWith('u1', {
                status: 'answered',
                kind: 'approval',
                agentId: 'a1',
                taskId: 't1',
                missionId: 'm1',
                search: 'budget',
                limit: 50,
                offset: 25,
            });
        });

        it('drops a blank search rather than matching everything by accident', async () => {
            await controller.listDecisions(auth, { q: '   ' });

            expect(service.listDecisions).toHaveBeenCalledWith('u1', {
                status: 'open',
                limit: 25,
                offset: 0,
            });
        });

        it('returns the counts owner-scoped', async () => {
            await expect(controller.decisionCounts(auth)).resolves.toEqual({
                open: 4,
                blocking: 2,
                lastRaisedAt: null,
            });
            expect(service.decisionCounts).toHaveBeenCalledWith('u1');
        });
    });

    describe('POST /api/inbox/:id/reply — the reason opt-in', () => {
        it('forwards requireReason only when the caller opted in', async () => {
            await controller.reply(auth, 'i1', { optionId: 'reject', requireReason: true });
            expect(service.reply).toHaveBeenLastCalledWith('u1', 'i1', {
                text: null,
                optionId: 'reject',
                requireReason: true,
            });

            await controller.reply(auth, 'i1', { optionId: 'reject', requireReason: false });
            expect(service.reply).toHaveBeenLastCalledWith('u1', 'i1', {
                text: null,
                optionId: 'reject',
            });
        });
    });

    describe('read-state / archive / delete', () => {
        it('PATCH read defaults to marking READ and honours {unread:true}', async () => {
            await controller.setReadState(auth, 'i1', {});
            expect(service.setUnread).toHaveBeenLastCalledWith('i1', 'u1', false);

            await controller.setReadState(auth, 'i1', { unread: true });
            expect(service.setUnread).toHaveBeenLastCalledWith('i1', 'u1', true);
        });

        it('archive and unarchive hit the same service call with opposite flags', async () => {
            await controller.archive(auth, 'i1');
            expect(service.setArchived).toHaveBeenLastCalledWith('i1', 'u1', true);

            await controller.unarchive(auth, 'i1');
            expect(service.setArchived).toHaveBeenLastCalledWith('i1', 'u1', false);
        });

        it('delete is owner-scoped and echoes the id', async () => {
            await expect(controller.remove(auth, 'i1')).resolves.toEqual({
                deleted: true,
                itemId: 'i1',
            });
            expect(service.delete).toHaveBeenCalledWith('i1', 'u1');
        });
    });
});

describe('inbox DTO validation', () => {
    async function errorsFor<T extends object>(cls: new () => T, payload: unknown) {
        const dto = plainToInstance(cls, payload, { enableImplicitConversion: false });
        const errors = await validate(dto as object, {
            whitelist: true,
            forbidNonWhitelisted: true,
        });
        return errors.map((error) => error.property);
    }

    it('accepts a well-formed list query', async () => {
        expect(
            await errorsFor(ListInboxQueryDto, { status: 'open', limit: '25', offset: '0' }),
        ).toEqual([]);
    });

    it('rejects an unknown status and an out-of-range limit', async () => {
        expect(await errorsFor(ListInboxQueryDto, { status: 'deleted' })).toEqual(['status']);
        expect(await errorsFor(ListInboxQueryDto, { limit: '500' })).toEqual(['limit']);
        expect(await errorsFor(ListInboxQueryDto, { offset: '-1' })).toEqual(['offset']);
    });

    it('accepts a UUID Task id filter and rejects anything else — the column is uuid (review SR-4)', async () => {
        expect(
            await errorsFor(ListInboxQueryDto, { taskId: '3f2b6c1e-4d5a-4b7c-9e8f-0a1b2c3d4e5f' }),
        ).toEqual([]);
        // A slug, an empty string or an oversize string would reach the
        // query as `item.taskId = :taskId` and come back from Postgres as
        // 22P02 — a 500 for a client typo; the DTO turns it into a 400.
        expect(await errorsFor(ListInboxQueryDto, { taskId: 'task-1' })).toEqual(['taskId']);
        expect(await errorsFor(ListInboxQueryDto, { taskId: '' })).toEqual(['taskId']);
        expect(await errorsFor(ListInboxQueryDto, { taskId: 'x'.repeat(65) })).toEqual(['taskId']);
    });

    it('rejects unknown fields — forbidNonWhitelisted is on globally', async () => {
        expect(await errorsFor(ReplyInboxItemDto, { text: 'ok', userId: 'someone-else' })).toEqual([
            'userId',
        ]);
    });

    it('rejects a reply past the length cap', async () => {
        expect(await errorsFor(ReplyInboxItemDto, { text: 'x'.repeat(8001) })).toEqual(['text']);
        expect(await errorsFor(ReplyInboxItemDto, { text: 'x'.repeat(8000) })).toEqual([]);
    });

    it('rejects an option id past the column width', async () => {
        expect(await errorsFor(ReplyInboxItemDto, { optionId: 'x'.repeat(65) })).toEqual([
            'optionId',
        ]);
    });

    it('accepts an empty reply body — the service decides what a valid answer is', async () => {
        // Emptiness is a ROUTING rule (text or option or both), not a shape
        // rule; the service raises the 400 so every caller gets it.
        expect(await errorsFor(ReplyInboxItemDto, {})).toEqual([]);
    });

    it('accepts a well-formed decisions query and rejects every malformed filter', async () => {
        const uuid = '3f2b6c1e-4d5a-4b7c-9e8f-0a1b2c3d4e5f';
        expect(
            await errorsFor(ListInboxDecisionsQueryDto, {
                status: 'archived',
                kind: 'escalation',
                agentId: uuid,
                taskId: uuid,
                missionId: uuid,
                q: 'budget',
                limit: '100',
                offset: '25',
            }),
        ).toEqual([]);
        expect(await errorsFor(ListInboxDecisionsQueryDto, { kind: 'notice' })).toEqual(['kind']);
        expect(await errorsFor(ListInboxDecisionsQueryDto, { status: 'resolved' })).toEqual([
            'status',
        ]);
        expect(await errorsFor(ListInboxDecisionsQueryDto, { limit: '101' })).toEqual(['limit']);
        expect(await errorsFor(ListInboxDecisionsQueryDto, { limit: '0' })).toEqual(['limit']);
        expect(await errorsFor(ListInboxDecisionsQueryDto, { offset: '-1' })).toEqual(['offset']);
        expect(await errorsFor(ListInboxDecisionsQueryDto, { agentId: 'agent-1' })).toEqual([
            'agentId',
        ]);
        expect(await errorsFor(ListInboxDecisionsQueryDto, { missionId: 'm' })).toEqual([
            'missionId',
        ]);
        expect(await errorsFor(ListInboxDecisionsQueryDto, { q: 'x'.repeat(201) })).toEqual(['q']);
    });

    it('accepts a URL-safe cursor and rejects anything else at the edge', async () => {
        expect(
            await errorsFor(ListInboxDecisionsQueryDto, { cursor: 'eyJ2IjoxfQ', limit: '25' }),
        ).toEqual([]);
        expect(await errorsFor(ListInboxDecisionsQueryDto, { cursor: 'a b' })).toEqual(['cursor']);
        expect(await errorsFor(ListInboxDecisionsQueryDto, { cursor: 'abc=' })).toEqual(['cursor']);
        expect(await errorsFor(ListInboxDecisionsQueryDto, { cursor: 'x'.repeat(513) })).toEqual([
            'cursor',
        ]);
    });

    it('accepts a boolean reason opt-in and rejects anything else', async () => {
        expect(await errorsFor(ReplyInboxItemDto, { requireReason: true })).toEqual([]);
        expect(await errorsFor(ReplyInboxItemDto, { requireReason: 'yes' })).toEqual([
            'requireReason',
        ]);
    });

    it('rejects a non-boolean read state', async () => {
        expect(await errorsFor(SetInboxReadStateDto, { unread: 'yes' })).toEqual(['unread']);
        expect(await errorsFor(SetInboxReadStateDto, { unread: true })).toEqual([]);
    });
});
