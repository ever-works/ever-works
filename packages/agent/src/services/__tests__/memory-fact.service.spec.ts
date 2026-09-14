import {
    BadRequestException,
    ConflictException,
    GoneException,
    NotFoundException,
} from '@nestjs/common';
import {
    MemoryFactService,
    decodeCursor,
    encodeCursor,
    validateBody,
} from '../memory-fact.service';
import type { MemoryFactRepository } from '../../database/repositories/memory-fact.repository';
import type { MemoryFactSearchService } from '../memory-fact-search.service';
import type { MemoryFactVectorIndexService } from '../memory-fact-vector-index.service';
import type { AgentRepository } from '../../database/repositories/agent.repository';
import type { ActivityLogService } from '../../activity-log/activity-log.service';
import type { MemoryFactEmbedDispatcher } from '../../tasks/memory-fact-embed-dispatcher';
import type { MemoryFact } from '../../entities/memory-fact.entity';
import { ActivityActionType } from '../../entities/activity-log.types';

const ORG = { tenantId: 't-1', organizationId: 'o-1' };
const ACTOR = { userId: 'u-1', ownership: ORG };
const DAY = 24 * 60 * 60 * 1000;

function fact(overrides: Partial<MemoryFact> = {}): MemoryFact {
    return {
        id: 'f-1',
        userId: 'u-1',
        tenantId: 't-1',
        organizationId: 'o-1',
        scope: 'workspace',
        agentId: null,
        body: 'We never quote a delivery date under ten days.',
        status: 'active',
        origin: 'user',
        sourceRunId: null,
        sourceConversationId: null,
        sourceAgentId: null,
        pinned: false,
        vectorStoreId: null,
        embeddingModel: null,
        embeddingDims: null,
        embeddedAt: null,
        recallCount: 0,
        lastRecalledAt: null,
        supersedesFactId: null,
        forgottenAt: null,
        createdAt: new Date('2026-09-14T10:00:00Z'),
        updatedAt: new Date('2026-09-14T10:00:00Z'),
        ...overrides,
    } as MemoryFact;
}

describe('MemoryFactService', () => {
    let repo: Record<string, jest.Mock>;
    let search: { search: jest.Mock };
    let agents: { findByIdAndUser: jest.Mock };
    let vectors: { isAvailable: jest.Mock };
    let activity: { log: jest.Mock };
    let dispatcher: { dispatchMemoryFactEmbed: jest.Mock };
    let service: MemoryFactService;

    const counts = (overrides: Partial<Record<string, number>> = {}) => ({
        active: 0,
        proposed: 0,
        forgotten: 0,
        pinned: 0,
        ...overrides,
    });

    beforeEach(() => {
        repo = {
            countByStatus: jest.fn().mockResolvedValue(counts()),
            findLiveDuplicate: jest.fn().mockResolvedValue(null),
            create: jest.fn(async (input) => fact({ ...input, id: 'f-new' })),
            findOwned: jest.fn().mockResolvedValue(fact()),
            updateOwned: jest.fn(async (_id, _u, _o, patch) => fact({ ...patch })),
            forgetAll: jest.fn().mockResolvedValue(3),
            listForOwner: jest.fn().mockResolvedValue({ rows: [fact()], total: 1 }),
        };
        search = { search: jest.fn() };
        agents = { findByIdAndUser: jest.fn().mockResolvedValue({ id: 'a-1' }) };
        vectors = { isAvailable: jest.fn().mockResolvedValue(true) };
        activity = { log: jest.fn().mockResolvedValue({}) };
        dispatcher = { dispatchMemoryFactEmbed: jest.fn().mockResolvedValue('run-1') };
        service = new MemoryFactService(
            repo as unknown as MemoryFactRepository,
            search as unknown as MemoryFactSearchService,
            agents as unknown as AgentRepository,
            vectors as unknown as MemoryFactVectorIndexService,
            activity as unknown as ActivityLogService,
            dispatcher as unknown as MemoryFactEmbedDispatcher,
        );
    });

    describe('body bounds', () => {
        it('trims and accepts 1–500 characters', () => {
            expect(validateBody('  hello  ')).toBe('hello');
            expect(validateBody('x'.repeat(500))).toHaveLength(500);
        });

        it('refuses an empty or whitespace-only body', () => {
            expect(() => validateBody('   ')).toThrow(BadRequestException);
            expect(() => validateBody(undefined)).toThrow(BadRequestException);
        });

        it('refuses 501 characters and names the count', () => {
            try {
                validateBody('x'.repeat(501));
                fail('expected a refusal');
            } catch (error) {
                expect(error).toBeInstanceOf(BadRequestException);
                expect(JSON.stringify((error as BadRequestException).getResponse())).toContain(
                    '501',
                );
            }
        });
    });

    describe('create', () => {
        it('lands a human write active, records activity without the body, and enqueues an embed', async () => {
            const dto = await service.create(ACTOR, { body: ' Invoices go out on the 1st. ' });

            expect(repo.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: 'u-1',
                    ownership: ORG,
                    body: 'Invoices go out on the 1st.',
                    status: 'active',
                    origin: 'user',
                    scope: 'workspace',
                    agentId: null,
                }),
            );
            expect(dto.status).toBe('active');
            const logged = activity.log.mock.calls[0][0];
            expect(logged.actionType).toBe(ActivityActionType.MEMORY_FACT_CREATED);
            expect(JSON.stringify(logged)).not.toContain('Invoices go out');
            expect(dispatcher.dispatchMemoryFactEmbed).toHaveBeenCalledWith({
                factId: 'f-new',
                userId: 'u-1',
            });
        });

        it.each(['agent', 'consolidation', 'import'] as const)(
            'lands an %s write as proposed, never active',
            async (origin) => {
                await service.create(ACTOR, { body: 'Staging is rebuilt nightly.', origin });
                expect(repo.create.mock.calls[0][0].status).toBe('proposed');
            },
        );

        it('refuses the 2,001st active fact with the limit in the message', async () => {
            repo.countByStatus.mockResolvedValue(counts({ active: 2000 }));
            await expect(service.create(ACTOR, { body: 'one more' })).rejects.toThrow(
                /2,000 facts is the limit/,
            );
            expect(repo.create).not.toHaveBeenCalled();
        });

        it('drops a proposal when 200 are already waiting', async () => {
            repo.countByStatus.mockResolvedValue(counts({ proposed: 200 }));
            await expect(
                service.create(ACTOR, { body: 'agent idea', origin: 'agent' }),
            ).rejects.toBeInstanceOf(ConflictException);
            expect(repo.create).not.toHaveBeenCalled();
        });

        it('refuses the 21st pin', async () => {
            repo.countByStatus.mockResolvedValue(counts({ pinned: 20 }));
            await expect(service.create(ACTOR, { body: 'pin me', pinned: true })).rejects.toThrow(
                /At most 20/,
            );
        });

        it('refuses a pinned proposal', async () => {
            await expect(
                service.create(ACTOR, { body: 'pin me', pinned: true, origin: 'agent' }),
            ).rejects.toBeInstanceOf(ConflictException);
        });

        it('refuses an exact live duplicate and names the existing fact', async () => {
            repo.findLiveDuplicate.mockResolvedValue(fact({ id: 'f-existing' }));
            await expect(service.create(ACTOR, { body: 'dup' })).rejects.toMatchObject({
                response: expect.objectContaining({ existingId: 'f-existing' }),
            });
        });

        it('requires an agent for an agent-scoped fact and refuses one on a workspace fact', async () => {
            await expect(
                service.create(ACTOR, { body: 'x', scope: 'agent' }),
            ).rejects.toBeInstanceOf(BadRequestException);
            await expect(
                service.create(ACTOR, { body: 'x', scope: 'workspace', agentId: 'a-1' }),
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('404s an agent from another workspace', async () => {
            agents.findByIdAndUser.mockResolvedValue(null);
            await expect(
                service.create(ACTOR, { body: 'x', scope: 'agent', agentId: 'a-foreign' }),
            ).rejects.toBeInstanceOf(NotFoundException);
            expect(agents.findByIdAndUser).toHaveBeenCalledWith('a-foreign', 'u-1', ORG);
        });

        it('still saves when the dispatcher returns null or throws', async () => {
            dispatcher.dispatchMemoryFactEmbed.mockResolvedValueOnce(null);
            await expect(service.create(ACTOR, { body: 'a' })).resolves.toBeDefined();
            dispatcher.dispatchMemoryFactEmbed.mockRejectedValueOnce(new Error('runtime down'));
            await expect(service.create(ACTOR, { body: 'b' })).resolves.toBeDefined();
        });

        it('still saves when no dispatcher is bound at all', async () => {
            const bare = new MemoryFactService(
                repo as unknown as MemoryFactRepository,
                search as unknown as MemoryFactSearchService,
            );
            await expect(bare.create(ACTOR, { body: 'a' })).resolves.toBeDefined();
        });
    });

    describe('update', () => {
        it('clears the vector coordinates on a body edit and re-enqueues the embed', async () => {
            await service.update(ACTOR, 'f-1', { body: 'Escalate anything over 2,000.' });

            expect(repo.updateOwned).toHaveBeenCalledWith(
                'f-1',
                'u-1',
                ORG,
                expect.objectContaining({
                    body: 'Escalate anything over 2,000.',
                    embeddedAt: null,
                    embeddingModel: null,
                    vectorStoreId: null,
                }),
            );
            expect(dispatcher.dispatchMemoryFactEmbed).toHaveBeenCalled();
            expect(activity.log.mock.calls[0][0]).toMatchObject({
                actionType: ActivityActionType.MEMORY_FACT_UPDATED,
                details: { factId: 'f-1', changed: ['body'] },
            });
        });

        it('does not re-embed for a pin change', async () => {
            await service.update(ACTOR, 'f-1', { pinned: true });
            expect(dispatcher.dispatchMemoryFactEmbed).not.toHaveBeenCalled();
        });

        it('is a no-op (no write, no activity) when nothing changed', async () => {
            const dto = await service.update(ACTOR, 'f-1', { body: fact().body });
            expect(dto.id).toBe('f-1');
            expect(repo.updateOwned).not.toHaveBeenCalled();
            expect(activity.log).not.toHaveBeenCalled();
        });

        it('404s a cross-workspace id', async () => {
            repo.findOwned.mockResolvedValue(null);
            await expect(service.update(ACTOR, 'f-x', { pinned: true })).rejects.toBeInstanceOf(
                NotFoundException,
            );
        });

        it('refuses to edit a forgotten fact', async () => {
            repo.findOwned.mockResolvedValue(
                fact({ status: 'forgotten', forgottenAt: new Date() }),
            );
            await expect(service.update(ACTOR, 'f-1', { body: 'new' })).rejects.toBeInstanceOf(
                ConflictException,
            );
        });
    });

    describe('forget / restore', () => {
        it('forgets softly, unpins, and returns the 30-day restore deadline', async () => {
            const before = Date.now();
            const result = await service.forget(ACTOR, 'f-1');

            const patch = repo.updateOwned.mock.calls[0][3];
            expect(patch).toMatchObject({ status: 'forgotten', pinned: false });
            expect(patch.forgottenAt).toBeInstanceOf(Date);
            const deadline = new Date(result.restorableUntil).getTime();
            expect(deadline - before).toBeGreaterThanOrEqual(30 * DAY - 1000);
            expect(activity.log.mock.calls[0][0].actionType).toBe(
                ActivityActionType.MEMORY_FACT_FORGOTTEN,
            );
        });

        it('forgetting twice does not reset the retention clock', async () => {
            const forgottenAt = new Date('2026-09-01T00:00:00Z');
            repo.findOwned.mockResolvedValue(fact({ status: 'forgotten', forgottenAt }));
            const result = await service.forget(ACTOR, 'f-1');
            expect(repo.updateOwned).not.toHaveBeenCalled();
            expect(result.restorableUntil).toBe(
                new Date(forgottenAt.getTime() + 30 * DAY).toISOString(),
            );
        });

        it('restores inside 30 days', async () => {
            repo.findOwned.mockResolvedValue(
                fact({ status: 'forgotten', forgottenAt: new Date(Date.now() - 29 * DAY) }),
            );
            await service.restore(ACTOR, 'f-1');
            expect(repo.updateOwned.mock.calls[0][3]).toEqual({
                status: 'active',
                forgottenAt: null,
            });
        });

        it('answers 410 past 30 days', async () => {
            repo.findOwned.mockResolvedValue(
                fact({ status: 'forgotten', forgottenAt: new Date(Date.now() - 31 * DAY) }),
            );
            await expect(service.restore(ACTOR, 'f-1')).rejects.toBeInstanceOf(GoneException);
        });

        it('refuses a restore that would exceed the active cap', async () => {
            repo.findOwned.mockResolvedValue(
                fact({ status: 'forgotten', forgottenAt: new Date() }),
            );
            repo.countByStatus.mockResolvedValue(counts({ active: 2000 }));
            await expect(service.restore(ACTOR, 'f-1')).rejects.toBeInstanceOf(ConflictException);
        });

        it('refuses to restore a fact that is not forgotten', async () => {
            await expect(service.restore(ACTOR, 'f-1')).rejects.toBeInstanceOf(ConflictException);
        });
    });

    describe('accept / discard', () => {
        it('accepts a proposal into active', async () => {
            repo.findOwned.mockResolvedValue(fact({ status: 'proposed', origin: 'agent' }));
            await service.accept(ACTOR, 'f-1');
            expect(repo.updateOwned.mock.calls[0][3]).toEqual({ status: 'active' });
            expect(activity.log.mock.calls[0][0].actionType).toBe(
                ActivityActionType.MEMORY_FACT_ACCEPTED,
            );
        });

        it('discards a proposal into forgotten', async () => {
            repo.findOwned.mockResolvedValue(fact({ status: 'proposed', origin: 'agent' }));
            await service.discard(ACTOR, 'f-1');
            expect(repo.updateOwned.mock.calls[0][3]).toMatchObject({ status: 'forgotten' });
        });

        it('refuses to accept or discard a fact that is not proposed', async () => {
            await expect(service.accept(ACTOR, 'f-1')).rejects.toBeInstanceOf(ConflictException);
            await expect(service.discard(ACTOR, 'f-1')).rejects.toBeInstanceOf(ConflictException);
        });
    });

    describe('forgetAll', () => {
        it('writes memory_facts only and records one activity row with the count', async () => {
            const result = await service.forgetAll(ACTOR);

            expect(result).toEqual({ forgotten: 3 });
            expect(repo.forgetAll).toHaveBeenCalledWith('u-1', ORG, expect.any(Date));
            // No other write path is touched: context files, agent files,
            // uploads, meetings and KB documents are owned by other services
            // and repositories this service does not even hold.
            expect(repo.create).not.toHaveBeenCalled();
            expect(repo.updateOwned).not.toHaveBeenCalled();
            expect(activity.log).toHaveBeenCalledTimes(1);
            expect(activity.log.mock.calls[0][0]).toMatchObject({
                actionType: ActivityActionType.MEMORY_FACTS_CLEARED,
                details: { forgotten: 3 },
            });
        });
    });

    describe('list', () => {
        it('pages newest-first with an opaque cursor and reports semantic availability', async () => {
            repo.listForOwner.mockResolvedValue({ rows: [fact()], total: 3 });
            const page = await service.list(ACTOR, { limit: 1 });

            expect(repo.listForOwner).toHaveBeenCalledWith('u-1', ORG, {
                status: 'active',
                pinnedOnly: false,
                scope: undefined,
                agentId: undefined,
                limit: 1,
                offset: 0,
            });
            expect(page.total).toBe(3);
            expect(page.nextCursor).toBe(encodeCursor(1));
            expect(page.semantic).toBe(true);
        });

        it('caps the page size at 50', async () => {
            await service.list(ACTOR, { limit: 5000 });
            expect(repo.listForOwner.mock.calls[0][2].limit).toBe(50);
        });

        it('delegates a query to the search service and keeps its semantic flag', async () => {
            search.search.mockResolvedValue({
                results: [{ fact: fact(), score: 0.81, literalMatch: false }],
                semantic: false,
            });
            const result = await service.list(ACTOR, { q: 'delivery promises', status: 'active' });

            expect(search.search).toHaveBeenCalledWith(ACTOR, 'delivery promises', {
                status: 'active',
                pinnedOnly: false,
                scope: undefined,
                agentId: undefined,
            });
            expect(result.semantic).toBe(false);
            expect(result.facts[0]).toMatchObject({ score: 0.81, literalMatch: false });
        });

        it('treats a garbage cursor as the first page', () => {
            expect(decodeCursor('not-a-cursor')).toBe(0);
            expect(decodeCursor(encodeCursor(40))).toBe(40);
        });
    });

    describe('no job runtime — said once at startup, never per write', () => {
        function registry(active: { runtimeId: string; isEnabled: () => boolean } | null) {
            return { register: jest.fn(), getActive: jest.fn(() => active) };
        }

        function build(
            dispatcherValue: MemoryFactEmbedDispatcher | null | undefined,
            registryValue?: ReturnType<typeof registry>,
        ): MemoryFactService {
            return new MemoryFactService(
                repo as unknown as MemoryFactRepository,
                search as unknown as MemoryFactSearchService,
                agents as unknown as AgentRepository,
                vectors as unknown as MemoryFactVectorIndexService,
                activity as unknown as ActivityLogService,
                dispatcherValue,
                registryValue as never,
            );
        }

        it('logs one line at bootstrap when the dispatcher resolved to null, and nothing on writes', async () => {
            const svc = build(null, registry(null));
            const log = jest.spyOn((svc as any).logger, 'log').mockImplementation(() => undefined);
            const warn = jest
                .spyOn((svc as any).logger, 'warn')
                .mockImplementation(() => undefined);

            svc.onApplicationBootstrap();
            await svc.create(ACTOR, { body: 'a' });
            await svc.create(ACTOR, { body: 'b' });

            expect(log).toHaveBeenCalledTimes(1);
            expect(log.mock.calls[0][0]).toContain('no job runtime is configured');
            expect(warn).not.toHaveBeenCalled();
        });

        it('names a registered runtime that is not enabled', () => {
            const svc = build(
                dispatcher as unknown as MemoryFactEmbedDispatcher,
                registry({ runtimeId: 'pgboss', isEnabled: () => false }),
            );
            expect(svc.embedRuntimeGap()).toBe("the 'pgboss' job runtime is not enabled");
        });

        it('stays silent when an enabled runtime can run the embed', () => {
            const svc = build(
                dispatcher as unknown as MemoryFactEmbedDispatcher,
                registry({ runtimeId: 'bullmq', isEnabled: () => true }),
            );
            const log = jest.spyOn((svc as any).logger, 'log').mockImplementation(() => undefined);
            svc.onApplicationBootstrap();
            expect(svc.embedRuntimeGap()).toBeNull();
            expect(log).not.toHaveBeenCalled();
        });
    });
});
