import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BROWSER_WORKSPACE_SCOPE_HEADER } from '../workspace-scope';
import { __resetOrganizationsStoreForTests, useOrganizations } from './use-organizations';

describe('useOrganizations workspace selector', () => {
    beforeEach(() => {
        __resetOrganizationsStoreForTests();
        window.history.replaceState({}, '', '/org/ever/settings');
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        window.history.replaceState({}, '', '/');
    });

    it('derives the selector from the current tab when it loads memberships', async () => {
        const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
            Promise.resolve(
                new Response(JSON.stringify([]), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                }),
            ),
        );
        vi.stubGlobal('fetch', fetchMock);

        renderHook(() => useOrganizations());

        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        const init = fetchMock.mock.calls[0][1] as RequestInit;
        expect(new Headers(init.headers).get(BROWSER_WORKSPACE_SCOPE_HEADER)).toBe('org:ever');
    });
});
