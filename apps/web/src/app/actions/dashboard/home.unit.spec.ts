import { beforeEach, describe, expect, it, vi } from 'vitest';

const summary = vi.fn();
const createTask = vi.fn();
const getAuth = vi.fn();
const redirectMock = vi.fn((path: string) => {
    throw new Error(`NEXT_REDIRECT:${path}`);
});

const { FakeApiResponseError } = vi.hoisted(() => {
    class FakeApiResponseError extends Error {
        constructor(
            message: string,
            public readonly statusCode: number,
        ) {
            super(message);
        }
    }
    return { FakeApiResponseError };
});

vi.mock('next/navigation', () => ({ redirect: (path: string) => redirectMock(path) }));
vi.mock('@/lib/auth', () => ({ getAuthFromCookie: () => getAuth() }));
vi.mock('@/lib/api/server-api', () => ({ ApiResponseError: FakeApiResponseError }));
vi.mock('@/lib/api/home', () => ({
    homeAPI: { summary: (...args: unknown[]) => summary(...args) },
}));
vi.mock('@/app/actions/tasks', () => ({
    createTaskAction: (...args: unknown[]) => createTask(...args),
}));

import { createHomeTaskAction, getHomeSummaryAction, refreshHomeBlockAction } from './home';

/**
 * Home (AW-19) — the server actions behind the morning read and the composer.
 */
describe('home server actions', () => {
    beforeEach(() => {
        summary.mockReset();
        createTask.mockReset();
        getAuth.mockReset();
        redirectMock.mockClear();
        getAuth.mockResolvedValue({ id: 'user-1', username: 'dana' });
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    it('redirects an unauthenticated caller before any request is issued', async () => {
        getAuth.mockResolvedValue(null);

        await expect(getHomeSummaryAction()).rejects.toThrow('NEXT_REDIRECT');
        await expect(refreshHomeBlockAction('today')).rejects.toThrow('NEXT_REDIRECT');
        await expect(createHomeTaskAction('summarise the week')).rejects.toThrow('NEXT_REDIRECT');

        expect(summary).not.toHaveBeenCalled();
        expect(createTask).not.toHaveBeenCalled();
    });

    it('reads the summary with the browser timezone', async () => {
        summary.mockResolvedValue({ timezone: 'Europe/Kyiv' });

        await expect(getHomeSummaryAction('Europe/Kyiv')).resolves.toEqual({
            timezone: 'Europe/Kyiv',
        });
        expect(summary).toHaveBeenCalledWith({ tz: 'Europe/Kyiv' });
    });

    it('retries once without a timezone the API refused', async () => {
        summary
            .mockRejectedValueOnce(new FakeApiResponseError('tz', 400))
            .mockResolvedValueOnce({ timezone: 'UTC', timezoneFallback: true });

        await expect(getHomeSummaryAction('Mars/Base')).resolves.toMatchObject({ timezone: 'UTC' });
        expect(summary).toHaveBeenNthCalledWith(2);
    });

    it('lets any other failure reject', async () => {
        summary.mockRejectedValue(new FakeApiResponseError('down', 500));
        await expect(getHomeSummaryAction('UTC')).rejects.toThrow('down');
        expect(summary).toHaveBeenCalledTimes(1);
    });

    it('re-reads a single block', async () => {
        summary.mockResolvedValue({});
        await refreshHomeBlockAction('today', 'UTC');
        expect(summary).toHaveBeenCalledWith({ tz: 'UTC', blocks: ['today'] });
    });

    describe('createHomeTaskAction', () => {
        it('creates an unscoped Task with a derived title and the sentence as description (S2)', async () => {
            createTask.mockResolvedValue({ id: 'task-1', title: 'summarise the week' });

            const result = await createHomeTaskAction('  summarise the week  ');

            expect(result).toEqual({
                ok: true,
                task: { id: 'task-1', title: 'summarise the week' },
            });
            expect(createTask).toHaveBeenCalledWith({
                title: 'summarise the week',
                description: 'summarise the week',
            });
        });

        it('refuses text under 3 or over 2000 characters without a request (S14)', async () => {
            await expect(createHomeTaskAction(' ab ')).resolves.toEqual({
                ok: false,
                reason: 'invalid',
            });
            await expect(createHomeTaskAction('a'.repeat(2001))).resolves.toEqual({
                ok: false,
                reason: 'invalid',
            });
            expect(createTask).not.toHaveBeenCalled();
        });

        it('tells a throttle apart from any other failure (S13)', async () => {
            createTask.mockRejectedValueOnce(new FakeApiResponseError('slow down', 429));
            await expect(createHomeTaskAction('summarise the week')).resolves.toEqual({
                ok: false,
                reason: 'throttled',
            });

            createTask.mockRejectedValueOnce(new Error('offline'));
            await expect(createHomeTaskAction('summarise the week')).resolves.toEqual({
                ok: false,
                reason: 'failed',
            });
        });
    });
});
