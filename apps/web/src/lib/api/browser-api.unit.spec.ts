import { afterEach, describe, expect, it, vi } from 'vitest';
import { BROWSER_WORKSPACE_SCOPE_HEADER } from '../workspace-scope';
import { applyBrowserWorkspaceScope, browserApiFetch } from './browser-api';

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

/**
 * `applyBrowserWorkspaceScope` exists for callers that own their own transport
 * and so cannot go through `browserApiFetch` — today that is the AI SDK's
 * `DefaultChatTransport` in `components/ai/ChatProvider.tsx`.
 *
 * That transport shipped WITHOUT a selector, and because the tool loop inside
 * `/api/chat` reaches the platform through `serverFetch` — which throws
 * `Invalid workspace scope` on a missing header rather than degrading — every
 * data action the in-app assistant attempted failed before a request left the
 * web tier, in personal scope as well as org scope. These pin the contract that
 * fix depends on.
 */
describe('applyBrowserWorkspaceScope', () => {
    afterEach(() => {
        window.history.replaceState({}, '', '/');
    });

    it('stamps the selector derived from the visible tab URL', () => {
        window.history.replaceState({}, '', '/org/ever/dashboard');

        expect(applyBrowserWorkspaceScope().get(BROWSER_WORKSPACE_SCOPE_HEADER)).toBe('org:ever');
    });

    it('never emits a missing selector — an unprefixed route is explicitly personal', () => {
        window.history.replaceState({}, '', '/dashboard');

        const headers = applyBrowserWorkspaceScope();
        expect(headers.get(BROWSER_WORKSPACE_SCOPE_HEADER)).toBe('personal');
        expect(headers.has(BROWSER_WORKSPACE_SCOPE_HEADER)).toBe(true);
    });

    it('preserves caller headers and overwrites only the selector', () => {
        window.history.replaceState({}, '', '/org/yo/chat');

        const headers = applyBrowserWorkspaceScope({
            'content-type': 'application/json',
            [BROWSER_WORKSPACE_SCOPE_HEADER]: 'org:stale-tab',
        });

        expect(headers.get('content-type')).toBe('application/json');
        expect(headers.get(BROWSER_WORKSPACE_SCOPE_HEADER)).toBe('org:yo');
    });

    it('re-derives per call, so a navigation between sends cannot reuse a stale scope', () => {
        window.history.replaceState({}, '', '/org/ever/chat');
        const first = applyBrowserWorkspaceScope().get(BROWSER_WORKSPACE_SCOPE_HEADER);
        window.history.replaceState({}, '', '/org/yo/chat');
        const second = applyBrowserWorkspaceScope().get(BROWSER_WORKSPACE_SCOPE_HEADER);

        expect([first, second]).toEqual(['org:ever', 'org:yo']);
    });
});
