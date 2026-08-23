import { afterEach, describe, expect, it, vi } from 'vitest';
import { BROWSER_WORKSPACE_SCOPE_HEADER } from '../workspace-scope';
import { browserApiFetch } from './browser-api';

describe('browserApiFetch workspace selector', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        window.history.replaceState({}, '', '/');
    });

    it('derives the Organization selector at call time so two tabs do not share preference state', async () => {
        const observed: string[] = [];
        vi.stubGlobal(
            'fetch',
            vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
                observed.push(new Headers(init?.headers).get(BROWSER_WORKSPACE_SCOPE_HEADER) ?? '');
                return new Response(null, { status: 204 });
            }),
        );

        window.history.replaceState({}, '', '/org/ever/missions/new');
        await browserApiFetch('/api/missions', { method: 'POST' });
        window.history.replaceState({}, '', '/org/yo/missions/new');
        await browserApiFetch('/api/missions', { method: 'POST' });

        expect(observed).toEqual(['org:ever', 'org:yo']);
    });

    it('emits explicit personal scope only from a genuinely unprefixed route', async () => {
        const fetchMock = vi.fn(
            async (_input: RequestInfo | URL, _init?: RequestInit) =>
                new Response(null, { status: 204 }),
        );
        vi.stubGlobal('fetch', fetchMock);
        window.history.replaceState({}, '', '/missions/new');

        await browserApiFetch('/api/missions', { method: 'POST' });

        const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);
        expect(headers.get(BROWSER_WORKSPACE_SCOPE_HEADER)).toBe('personal');
    });

    it('overwrites a caller-supplied selector and re-derives after navigation', async () => {
        const fetchMock = vi.fn(
            async (_input: RequestInfo | URL, _init?: RequestInit) =>
                new Response(null, { status: 204 }),
        );
        vi.stubGlobal('fetch', fetchMock);
        window.history.replaceState({}, '', '/org/ever/dashboard');

        await browserApiFetch('/api/missions', {
            method: 'POST',
            headers: { [BROWSER_WORKSPACE_SCOPE_HEADER]: 'org:yo' },
        });
        window.history.replaceState({}, '', '/dashboard');
        await browserApiFetch('/api/missions', { method: 'POST' });

        expect(
            fetchMock.mock.calls.map((call) =>
                new Headers(call[1]?.headers).get(BROWSER_WORKSPACE_SCOPE_HEADER),
            ),
        ).toEqual(['org:ever', 'personal']);
    });
});
