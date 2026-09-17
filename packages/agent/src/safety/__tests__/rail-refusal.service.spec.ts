import { RAIL_REFUSAL_COLLAPSE_THRESHOLD, RAIL_REFUSAL_SUMMARY_MAX } from '@ever-works/contracts';
import type { RailRefusal } from '../../entities/rail-refusal.entity';
import type { RailRefusalRepository } from '../rail-refusal.repository';
import { RailRefusalService, collapseKeyFor } from '../rail-refusal.service';

function refusalRow(partial: Partial<RailRefusal> = {}): RailRefusal {
    return {
        id: 'r1',
        userId: 'user-1',
        railId: 'ladder',
        category: 'message.external',
        verdict: 'held',
        reasonCode: 'rung-held',
        subjectType: 'run',
        subjectId: 'run-1',
        agentId: 'agent-1',
        runId: 'run-1',
        summary: 'held',
        requested: null,
        ceiling: null,
        proposalId: null,
        collapseKey: 'key-a',
        tenantId: 'tenant-1',
        organizationId: 'org-1',
        createdAt: new Date('2026-09-16T10:00:00.000Z'),
        ...partial,
    } as RailRefusal;
}

function makeService(overrides: Partial<jest.Mocked<RailRefusalRepository>> = {}) {
    const repository = {
        record: jest.fn().mockResolvedValue(refusalRow()),
        list: jest.fn().mockResolvedValue({ rows: [], hasMore: false }),
        listByCollapseKey: jest.fn().mockResolvedValue([]),
        findInWindow: jest.fn().mockResolvedValue([]),
        pruneOlderThan: jest.fn().mockResolvedValue(0),
        ...overrides,
    } as unknown as RailRefusalRepository;
    return { service: new RailRefusalService(repository), repository };
}

describe('RailRefusalService.record', () => {
    it('writes the refusal with a computed collapse key', async () => {
        const { service, repository } = makeService();
        await service.record({
            userId: 'user-1',
            railId: 'ladder',
            category: 'message.external',
            verdict: 'held',
            reasonCode: 'rung-held',
            subjectType: 'run',
            summary: 'held for review',
        });
        const written = (repository.record as jest.Mock).mock.calls[0][0];
        expect(written.collapseKey).toMatch(/^[0-9a-f]{40}$/);
        expect(written.summary).toBe('held for review');
    });

    it('caps the summary where the column caps it', async () => {
        const { service, repository } = makeService();
        await service.record({
            userId: 'user-1',
            railId: 'caps',
            verdict: 'refused',
            reasonCode: 'cap-reached',
            subjectType: 'run',
            summary: 'x'.repeat(2_000),
        });
        const written = (repository.record as jest.Mock).mock.calls[0][0];
        expect(written.summary).toHaveLength(RAIL_REFUSAL_SUMMARY_MAX);
    });

    it('NEVER throws when the write fails, and counts it instead', async () => {
        // FR-69 — a refusal that cannot be recorded still refuses. Failing the
        // action path because bookkeeping failed would invert the whole point.
        const { service } = makeService({
            record: jest.fn().mockRejectedValue(new Error('database down')),
        } as never);
        await expect(
            service.record({
                userId: 'user-1',
                railId: 'ladder',
                verdict: 'refused',
                reasonCode: 'rung-off',
                subjectType: 'run',
                summary: 'refused',
            }),
        ).resolves.toBeUndefined();
        expect(service.unrecordedCount()).toBe(1);
    });

    it('keeps counting unrecorded refusals across calls', async () => {
        const { service } = makeService({
            record: jest.fn().mockRejectedValue(new Error('still down')),
        } as never);
        const input = {
            userId: 'user-1',
            railId: 'ladder' as const,
            verdict: 'refused' as const,
            reasonCode: 'rung-off' as const,
            subjectType: 'run' as const,
            summary: 'refused',
        };
        await service.record(input);
        await service.record(input);
        expect(service.unrecordedCount()).toBe(2);
    });
});

describe('collapseKeyFor', () => {
    it('is the same for the same rail, agent, category and day', () => {
        const a = collapseKeyFor(
            'ladder',
            'agent-1',
            'message.external',
            new Date('2026-09-16T01:00:00Z'),
        );
        const b = collapseKeyFor(
            'ladder',
            'agent-1',
            'message.external',
            new Date('2026-09-16T23:00:00Z'),
        );
        expect(a).toBe(b);
    });

    it('differs across days, agents, rails and categories', () => {
        const base = collapseKeyFor(
            'ladder',
            'agent-1',
            'message.external',
            new Date('2026-09-16T01:00:00Z'),
        );
        expect(
            collapseKeyFor(
                'ladder',
                'agent-1',
                'message.external',
                new Date('2026-09-17T01:00:00Z'),
            ),
        ).not.toBe(base);
        expect(
            collapseKeyFor(
                'ladder',
                'agent-2',
                'message.external',
                new Date('2026-09-16T01:00:00Z'),
            ),
        ).not.toBe(base);
        expect(
            collapseKeyFor('caps', 'agent-1', 'message.external', new Date('2026-09-16T01:00:00Z')),
        ).not.toBe(base);
        expect(
            collapseKeyFor(
                'ladder',
                'agent-1',
                'publish.external',
                new Date('2026-09-16T01:00:00Z'),
            ),
        ).not.toBe(base);
    });

    it('handles a missing agent and a missing category', () => {
        expect(collapseKeyFor('taxonomy', null, null, new Date())).toMatch(/^[0-9a-f]{40}$/);
    });
});

describe('RailRefusalService.list', () => {
    it('collapses a day that trips the threshold, and keeps the rest as rows', async () => {
        // U13 — a misconfigured agent must not be able to bury the log that is
        // the evidence it is misconfigured.
        const storm = Array.from({ length: RAIL_REFUSAL_COLLAPSE_THRESHOLD + 1 }, (_, index) =>
            refusalRow({ id: `storm-${index}`, collapseKey: 'storm' }),
        );
        const quiet = refusalRow({ id: 'quiet', collapseKey: 'quiet', railId: 'caps' });
        const { service } = makeService({
            findInWindow: jest.fn().mockResolvedValue([...storm, quiet]),
            list: jest.fn().mockResolvedValue({ rows: [...storm, quiet], hasMore: false }),
        } as never);

        const page = await service.list({ userId: 'user-1', from: new Date('2026-09-01') });

        expect(page.groups).toHaveLength(1);
        expect(page.groups[0].collapseKey).toBe('storm');
        expect(page.groups[0].count).toBe(RAIL_REFUSAL_COLLAPSE_THRESHOLD + 1);
        expect(page.items.map((item) => item.id)).toEqual(['quiet']);
        expect(page.total).toBe(RAIL_REFUSAL_COLLAPSE_THRESHOLD + 2);
    });

    it('does not collapse a day that stays at the threshold', async () => {
        const rows = Array.from({ length: RAIL_REFUSAL_COLLAPSE_THRESHOLD }, (_, index) =>
            refusalRow({ id: `row-${index}`, collapseKey: 'busy' }),
        );
        const { service } = makeService({
            findInWindow: jest.fn().mockResolvedValue(rows),
            list: jest.fn().mockResolvedValue({ rows, hasMore: false }),
        } as never);

        const page = await service.list({ userId: 'user-1', from: new Date('2026-09-01') });
        expect(page.groups).toEqual([]);
        expect(page.items).toHaveLength(RAIL_REFUSAL_COLLAPSE_THRESHOLD);
    });

    it('reports a cursor only when there is another page', async () => {
        const { service } = makeService({
            findInWindow: jest.fn().mockResolvedValue([refusalRow()]),
            list: jest.fn().mockResolvedValue({ rows: [refusalRow()], hasMore: true }),
        } as never);
        const page = await service.list({ userId: 'user-1', from: new Date('2026-09-01') });
        expect(page.nextCursor).toBe('2026-09-16T10:00:00.000Z');
    });
});

describe('RailRefusalService.counts', () => {
    it('separates refusals, holds and widening attempts', async () => {
        const { service } = makeService({
            findInWindow: jest
                .fn()
                .mockResolvedValue([
                    refusalRow({ verdict: 'held' }),
                    refusalRow({ verdict: 'refused', reasonCode: 'cap-reached' }),
                    refusalRow({ verdict: 'held', reasonCode: 'instruction-widening-attempt' }),
                ]),
        } as never);
        const counts = await service.counts('user-1', 30);
        expect(counts).toMatchObject({
            windowDays: 30,
            total: 3,
            refused: 1,
            held: 2,
            widenAttempts: 1,
            unrecorded: 0,
        });
    });
});

describe('RailRefusalService.prune', () => {
    it('asks for rows older than the retention horizon', async () => {
        const { service, repository } = makeService({
            pruneOlderThan: jest.fn().mockResolvedValue(7),
        } as never);
        const removed = await service.prune(90);
        expect(removed).toBe(7);
        const cutoff = (repository.pruneOlderThan as jest.Mock).mock.calls[0][0] as Date;
        const days = (Date.now() - cutoff.getTime()) / (24 * 60 * 60 * 1000);
        expect(days).toBeGreaterThan(89.9);
        expect(days).toBeLessThan(90.1);
    });
});
