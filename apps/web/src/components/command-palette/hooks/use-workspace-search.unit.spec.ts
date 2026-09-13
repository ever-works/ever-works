import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { WorkspaceSearchResponse } from '@ever-works/contracts/api';
import { useWorkspaceSearch, type UseWorkspaceSearchOptions } from './use-workspace-search';

function body(query: string): WorkspaceSearchResponse {
    return {
        query,
        groups: [{ kind: 'mission', total: 1, hits: [] }],
        degradedKinds: [],
        servedBy: 'fanout',
        tookMs: 3,
    };
}

function ok(query: string): Response {
    return new Response(JSON.stringify(body(query)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
    });
}

type Fetcher = NonNullable<UseWorkspaceSearchOptions['fetcher']>;

function setOnline(online: boolean) {
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => online });
}

describe('useWorkspaceSearch', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        setOnline(true);
    });

    afterEach(() => {
        vi.useRealTimers();
        setOnline(true);
    });

    function run(initial: Partial<UseWorkspaceSearchOptions>, fetcher: Fetcher) {
        return renderHook((props: Partial<UseWorkspaceSearchOptions>) =>
            useWorkspaceSearch({ query: '', enabled: true, fetcher, ...initial, ...props }),
        );
    }

    it('issues no request below two characters', async () => {
        const fetcher = vi.fn<Fetcher>(async () => ok('i'));
        const { result } = run({ query: 'i' }, fetcher);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(500);
        });
        expect(fetcher).not.toHaveBeenCalled();
        expect(result.current.status).toBe('idle');
    });

    it('issues exactly one request after the 150 ms debounce for fast typing', async () => {
        const fetcher = vi.fn<Fetcher>(async (url) =>
            ok(new URL(url, 'http://x').searchParams.get('q') ?? ''),
        );
        const { result, rerender } = run({ query: 'in' }, fetcher);
        for (const next of ['inv', 'invo', 'invoi', 'invoic', 'invoice']) {
            rerender({ query: next });
            await act(async () => {
                await vi.advanceTimersByTimeAsync(40);
            });
        }
        expect(fetcher).not.toHaveBeenCalled();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(150);
        });
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(fetcher.mock.calls[0][0]).toContain('q=invoice');
        expect(result.current.status).toBe('ready');
        expect(result.current.response?.query).toBe('invoice');
    });

    it('aborts the older request and never lets its late answer overwrite the newer one', async () => {
        const resolvers: Array<(response: Response) => void> = [];
        const signals: AbortSignal[] = [];
        const fetcher = vi.fn<Fetcher>(
            (_url, init) =>
                new Promise<Response>((resolve) => {
                    signals.push(init.signal as AbortSignal);
                    resolvers.push(resolve);
                }),
        );
        const { result, rerender } = run({ query: 'first' }, fetcher);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(150);
        });
        rerender({ query: 'second' });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(150);
        });
        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(signals[0].aborted).toBe(true);

        await act(async () => {
            resolvers[1](ok('second'));
            resolvers[0](ok('first'));
            await vi.advanceTimersByTimeAsync(0);
        });
        expect(result.current.response?.query).toBe('second');
    });

    it('times out after 3.5 s, keeps the previous results, and retries on demand', async () => {
        let call = 0;
        const fetcher = vi.fn<Fetcher>((url, init) => {
            call += 1;
            if (call === 1) return Promise.resolve(ok('ab'));
            return new Promise<Response>((_resolve, reject) => {
                init.signal?.addEventListener('abort', () =>
                    reject(new DOMException('aborted', 'AbortError')),
                );
            });
        });
        const { result, rerender } = run({ query: 'ab' }, fetcher);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(150);
        });
        expect(result.current.status).toBe('ready');

        rerender({ query: 'abc' });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(150 + 3500);
        });
        expect(result.current.status).toBe('timeout');
        expect(result.current.response?.query).toBe('ab');
        expect(result.current.stale).toBe(true);

        act(() => result.current.retry());
        await act(async () => {
            await vi.advanceTimersByTimeAsync(150);
        });
        expect(fetcher).toHaveBeenCalledTimes(3);
    });

    it('pauses for five seconds after a 429', async () => {
        const fetcher = vi.fn<Fetcher>(async () => new Response('', { status: 429 }));
        const { result, rerender } = run({ query: 'ab' }, fetcher);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(150);
        });
        expect(result.current.status).toBe('throttled');

        rerender({ query: 'abc' });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(1000);
        });
        expect(fetcher).toHaveBeenCalledTimes(1);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(4500);
        });
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('reports a server failure as an error without dropping earlier results', async () => {
        let call = 0;
        const fetcher = vi.fn<Fetcher>(async () => {
            call += 1;
            return call === 1 ? ok('ab') : new Response('', { status: 500 });
        });
        const { result, rerender } = run({ query: 'ab' }, fetcher);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(150);
        });
        rerender({ query: 'abc' });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(150);
        });
        expect(result.current.status).toBe('error');
        expect(result.current.response?.query).toBe('ab');
    });

    it('attempts no request while the browser is offline', async () => {
        setOnline(false);
        const fetcher = vi.fn<Fetcher>(async () => ok('ab'));
        const { result } = run({ query: 'ab' }, fetcher);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(500);
        });
        expect(fetcher).not.toHaveBeenCalled();
        expect(result.current.status).toBe('offline');
    });

    it('sends the group filter, the per-group cap and recent keys', async () => {
        const fetcher = vi.fn<Fetcher>(async () => ok('ab'));
        run({ query: 'ab', kinds: ['task'], perKindLimit: 25, recent: ['task:t1'] }, fetcher);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(150);
        });
        const url = fetcher.mock.calls[0][0];
        expect(url).toContain('kinds=task');
        expect(url).toContain('perKindLimit=25');
        expect(url).toContain('recent=task%3At1');
    });

    it('discards results when the workspace changes', async () => {
        const fetcher = vi.fn<Fetcher>(async () => ok('ab'));
        const { result, rerender } = run({ query: 'ab', scopeKey: 'org:acme' }, fetcher);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(150);
        });
        expect(result.current.response).not.toBeNull();
        rerender({ scopeKey: 'org:globex' });
        expect(result.current.response).toBeNull();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(150);
        });
        expect(fetcher).toHaveBeenCalledTimes(2);
    });
});
