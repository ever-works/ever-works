import type { FeedEntryDto } from '@ever-works/contracts';
import { HomeActivityBuilder } from '../builders/activity.builder';
import { HomeSummaryCache } from '../home-summary.cache';
import { HomeSummaryService, selectBlocks } from '../home-summary.service';
import { InvalidHomeTimezoneError } from '../home-window';

const NOW = new Date('2026-09-14T07:04:00.000Z');
const SCOPE = { tenantId: 'tenant-1', organizationId: 'org-1' };

function entry(id: string): FeedEntryDto {
    return {
        id,
        createdAt: NOW.toISOString(),
        kind: 'work',
        status: 'completed',
        actionType: 'task_status_changed',
        actor: { kind: 'agent', agentId: 'agent-1', label: 'Research' },
        narration: { key: 'fallback', params: {} },
        target: { type: 'task', id: 'task-1' },
    };
}

function builders() {
    const decisions = {
        build: jest
            .fn()
            .mockResolvedValue({ rows: [], total: 3, overdueCount: 0, blockingCount: 0 }),
        openCount: jest.fn().mockResolvedValue(3),
    };
    const runs = {
        workingNow: jest.fn().mockResolvedValue({ rows: [], total: 2 }),
        counters: jest.fn().mockResolvedValue({ workingNow: 2, doneToday: 7, failedToday: 1 }),
    };
    const today = { build: jest.fn().mockResolvedValue({ ran: [], due: [], dueTotal: 0 }) };
    const spend = { build: jest.fn().mockResolvedValue({ totalCents: 1842 }) };
    const activity = { build: jest.fn().mockResolvedValue({ entries: [entry('a-1')] }) };
    const preferences = { findByUser: jest.fn().mockResolvedValue({ timezone: 'Europe/Kyiv' }) };
    const service = new HomeSummaryService(
        decisions as never,
        runs as never,
        today as never,
        spend as never,
        activity as never,
        preferences as never,
    );
    return { decisions, runs, today, spend, activity, preferences, service };
}

describe('HomeSummaryService', () => {
    afterEach(() => {
        jest.useRealTimers();
    });

    it('returns every block with its status, the day and the moment it was computed', async () => {
        const { service } = builders();

        const summary = await service.build('user-1', { scope: SCOPE, now: NOW });

        expect(summary.computedAt).toBe(NOW.toISOString());
        expect(summary.timezone).toBe('Europe/Kyiv');
        expect(summary.timezoneFallback).toBe(false);
        expect(summary.day).toEqual({
            date: '2026-09-14',
            from: '2026-09-13T21:00:00.000Z',
            to: '2026-09-14T21:00:00.000Z',
        });
        expect(summary.needsYou).toEqual({
            status: 'ok',
            data: { rows: [], total: 3, overdueCount: 0, blockingCount: 0 },
        });
        expect(summary.glance).toEqual({
            status: 'ok',
            data: { needsYou: 3, workingNow: 2, doneToday: 7, failedToday: 1 },
        });
        expect(summary.today?.status).toBe('ok');
        expect(summary.thisWeek?.status).toBe('ok');
        expect(summary.workingNow?.status).toBe('ok');
        expect(summary.recentActivity?.data).toEqual({ entries: [entry('a-1')] });
    });

    it('isolates a failing block: one failed, five ok, and no error text on the wire (S10)', async () => {
        const { service, today } = builders();
        today.build.mockRejectedValue(new Error('relation "missions" does not exist — secret'));

        const summary = await service.build('user-1', { scope: SCOPE, now: NOW });

        expect(summary.today).toEqual({ status: 'failed', errorKey: 'error', data: null });
        expect(JSON.stringify(summary)).not.toContain('secret');
        for (const id of [
            'needsYou',
            'glance',
            'thisWeek',
            'workingNow',
            'recentActivity',
        ] as const) {
            expect(summary[id]?.status).toBe('ok');
        }
    });

    it('fails a block that exceeds its 1500 ms budget while the others answer', async () => {
        jest.useFakeTimers({ now: NOW });
        const { service, spend } = builders();
        spend.build.mockImplementation(() => new Promise(() => undefined));

        const pending = service.build('user-1', { scope: SCOPE, now: NOW });
        await jest.advanceTimersByTimeAsync(1499);
        let settled = false;
        void pending.then(() => {
            settled = true;
        });
        await Promise.resolve();
        expect(settled).toBe(false);

        await jest.advanceTimersByTimeAsync(1);
        const summary = await pending;

        expect(summary.thisWeek).toEqual({ status: 'failed', errorKey: 'timeout', data: null });
        expect(summary.needsYou?.status).toBe('ok');
    });

    it('reports an unwired source as unavailable rather than as an empty block', async () => {
        const service = new HomeSummaryService();

        const summary = await service.build('user-1', { scope: SCOPE, now: NOW });

        expect(summary.recentActivity).toEqual({
            status: 'failed',
            errorKey: 'unavailable',
            data: null,
        });
        expect(summary.glance).toEqual({ status: 'failed', errorKey: 'unavailable', data: null });
        expect(summary.timezone).toBe('UTC');
        expect(summary.timezoneFallback).toBe(true);
    });

    it('returns only the asked-for blocks and reads nothing else', async () => {
        const { service, decisions, runs, spend, activity, today } = builders();

        const summary = await service.build('user-1', {
            scope: SCOPE,
            blocks: ['today'],
            now: NOW,
        });

        expect(
            Object.keys(summary)
                .filter((key) => key !== 'day')
                .sort(),
        ).toEqual(['computedAt', 'timezone', 'timezoneFallback', 'today']);
        expect(today.build).toHaveBeenCalledTimes(1);
        for (const mock of [
            decisions.build,
            decisions.openCount,
            runs.workingNow,
            runs.counters,
            spend.build,
            activity.build,
        ]) {
            expect(mock).not.toHaveBeenCalled();
        }
    });

    it('uses an explicit timezone without reading the profile, and refuses an unknown one', async () => {
        const { service, preferences } = builders();

        const summary = await service.build('user-1', { scope: SCOPE, timezone: 'UTC', now: NOW });
        expect(summary.timezone).toBe('UTC');
        expect(preferences.findByUser).not.toHaveBeenCalled();

        await expect(
            service.build('user-1', { scope: SCOPE, timezone: 'Nowhere/Land', now: NOW }),
        ).rejects.toBeInstanceOf(InvalidHomeTimezoneError);
    });

    it('falls back to UTC when the profile timezone cannot be read', async () => {
        const { service, preferences } = builders();
        preferences.findByUser.mockRejectedValue(new Error('db down'));

        const summary = await service.build('user-1', { scope: SCOPE, now: NOW });

        expect(summary.timezone).toBe('UTC');
        expect(summary.timezoneFallback).toBe(true);
    });

    it('serves the same summary within 10 seconds and misses across another scope or timezone', async () => {
        jest.useFakeTimers({ now: NOW });
        const { service, today } = builders();

        const first = await service.build('user-1', { scope: SCOPE });
        const second = await service.build('user-1', { scope: SCOPE });
        expect(second).toBe(first);
        expect(today.build).toHaveBeenCalledTimes(1);

        await service.build('user-1', { scope: { tenantId: 'tenant-1', organizationId: null } });
        await service.build('user-1', { scope: SCOPE, timezone: 'UTC' });
        await service.build('user-2', { scope: SCOPE });
        expect(today.build).toHaveBeenCalledTimes(4);

        jest.setSystemTime(new Date(NOW.getTime() + 10_001));
        const later = await service.build('user-1', { scope: SCOPE });
        expect(later).not.toBe(first);
    });

    it('never caches a build with a pinned clock', async () => {
        const { service, today } = builders();
        await service.build('user-1', { scope: SCOPE, now: NOW });
        await service.build('user-1', { scope: SCOPE, now: NOW });
        expect(today.build).toHaveBeenCalledTimes(2);
    });

    it('orders a block selection by display order and treats an empty one as all', () => {
        expect(selectBlocks(['recentActivity', 'needsYou'])).toEqual([
            'needsYou',
            'recentActivity',
        ]);
        expect(selectBlocks([])).toHaveLength(6);
        expect(selectBlocks(undefined)).toHaveLength(6);
    });

    describe('recent activity', () => {
        it('reads the newest 8 Live Feed entries for the caller and scope, newest first', async () => {
            const items = Array.from({ length: 10 }, (_, index) => entry(`e-${index}`));
            const feed = {
                getPage: jest.fn().mockResolvedValue({ items, nextCursor: null, hasMore: false }),
            };
            const builder = new HomeActivityBuilder(feed as never);

            const result = await builder.build({
                userId: 'user-1',
                scope: SCOPE,
                timezone: 'UTC',
                day: { date: '2026-09-14', from: new Date(0), to: new Date(1) },
                now: NOW,
                memo: new Map(),
            });

            expect(feed.getPage).toHaveBeenCalledWith('user-1', SCOPE, { limit: 8 }, NOW);
            expect(result.entries.map((item) => item.id)).toEqual(
                items.slice(0, 8).map((item) => item.id),
            );
        });
    });

    describe('HomeSummaryCache', () => {
        it('expires entries after the TTL and evicts the oldest past its bound', () => {
            let clock = 0;
            const cache = new HomeSummaryCache<number>(100, 2, () => clock);
            cache.set('a', 1);
            cache.set('b', 2);
            cache.set('c', 3);
            expect(cache.get('a')).toBeUndefined();
            expect(cache.get('c')).toBe(3);
            clock = 100;
            expect(cache.get('c')).toBeUndefined();
            expect(cache.size).toBe(1);
        });
    });
});
