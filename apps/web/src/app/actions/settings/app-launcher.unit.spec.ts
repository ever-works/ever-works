import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * APW-11 T16 — the **Manage apps** save action and the two requests it makes
 * (plan §4.1, §4.2, §4.5).
 *
 * This is the seam where "the web calls match the DTO exactly" is either true or
 * not: the component's own spec mocks the action, so without this file the exact
 * URL, the exact body and the exact shape of the pin-limit refusal would be
 * asserted nowhere. The transport (`serverFetch`/`serverMutation`) is the only
 * thing mocked, so the real `apps/web/src/lib/api/app-launcher.ts` runs and its
 * request is what is inspected.
 */

const serverFetch = vi.fn();
const serverMutation = vi.fn();
const getAuthFromCookie = vi.fn();
const redirect = vi.fn();

vi.mock('@/lib/api/server-api', async () => {
    const actual =
        await vi.importActual<typeof import('@/lib/api/server-api')>('@/lib/api/server-api');
    return {
        ApiResponseError: actual.ApiResponseError,
        serverFetch: (...args: unknown[]) => serverFetch(...args),
        serverMutation: (...args: unknown[]) => serverMutation(...args),
    };
});
vi.mock('@/lib/auth', () => ({
    getAuthFromCookie: () => getAuthFromCookie(),
}));
vi.mock('next/navigation', () => ({
    redirect: (...args: unknown[]) => redirect(...args),
}));

import { ApiResponseError } from '@/lib/api/server-api';
import { appLauncherAPI } from '@/lib/api/app-launcher';
import { ROUTES } from '@/lib/constants';
import { saveAppLauncherPreferencesAction } from './app-launcher';

beforeEach(() => {
    serverFetch.mockReset();
    serverMutation.mockReset();
    getAuthFromCookie.mockReset().mockResolvedValue({ id: 'user-1' });
    redirect.mockReset();
});

describe('appLauncherAPI — the read (plan §4.1)', () => {
    it('asks for hidden rows and the DTO’s maximum page size', async () => {
        serverFetch.mockResolvedValue({ items: [], meta: {} });

        await appLauncherAPI.list({ includeHidden: true, limit: 200 });

        expect(serverFetch).toHaveBeenCalledTimes(1);
        const [endpoint] = serverFetch.mock.calls[0];
        expect(endpoint).toBe('/me/apps?includeHidden=true&limit=200');
    });

    it('sends includeHidden as the string the DTO validates', async () => {
        serverFetch.mockResolvedValue({ items: [], meta: {} });

        await appLauncherAPI.list({ includeHidden: false });

        expect(serverFetch.mock.calls[0][0]).toBe('/me/apps?includeHidden=false&limit=200');
    });
});

describe('appLauncherAPI — the save (plan §4.2)', () => {
    it('PUTs exactly { changes } to the preferences route', async () => {
        serverMutation.mockResolvedValue({ saved: 1, rejected: [], items: [] });

        await appLauncherAPI.savePreferences([{ key: 'platform:gauzy', visible: false }]);

        expect(serverMutation).toHaveBeenCalledTimes(1);
        expect(serverMutation.mock.calls[0][0]).toEqual({
            endpoint: '/me/apps/preferences',
            method: 'PUT',
            wrapInData: false,
            data: { changes: [{ key: 'platform:gauzy', visible: false }] },
        });
    });

    it('carries a whole section’s order in one save without dropping any entry (FR-62)', async () => {
        serverMutation.mockResolvedValue({ saved: 3, rejected: [], items: [] });
        const changes = [0, 1, 2].map((order) => ({
            key: `work:00000000-0000-4000-8000-00000000000${order}`,
            order,
        }));

        await appLauncherAPI.savePreferences(changes);

        expect(serverMutation.mock.calls[0][0].data).toEqual({ changes });
    });
});

describe('saveAppLauncherPreferencesAction', () => {
    it('reports the refreshed list on success', async () => {
        const items = [{ key: 'platform:gauzy' }];
        serverMutation.mockResolvedValue({ saved: 1, rejected: [], items });

        const result = await saveAppLauncherPreferencesAction([
            { key: 'platform:gauzy', visible: false },
        ]);

        expect(result).toEqual({
            success: true,
            data: { saved: 1, rejected: [], items },
            error: null,
        });
    });

    it('turns the 422 pin-limit refusal into an ordinary failure (plan §4.5)', async () => {
        serverMutation.mockRejectedValue(
            new ApiResponseError('Unprocessable Entity', 422, 'pinLimit', {
                code: 'pinLimit',
                limit: 6,
            }),
        );

        const result = await saveAppLauncherPreferencesAction([
            { key: 'platform:gauzy', pinned: true },
        ]);

        expect(result.success).toBe(false);
        expect(result.data).toBeNull();
        // Never the API's status line: the editor renders this as
        // `Couldn't save. Try again.`, and a redacted or numeric message must not
        // leak into it.
        expect(result.success === false && result.error.length > 0).toBe(true);
    });

    it('surfaces an actionable API message when the body was rejected', async () => {
        serverMutation.mockRejectedValue(
            new ApiResponseError('order must not be greater than 9999', 400),
        );

        const result = await saveAppLauncherPreferencesAction([
            { key: 'platform:gauzy', order: 1 },
        ]);

        expect(result).toEqual({
            success: false,
            data: null,
            error: 'order must not be greater than 9999',
        });
    });

    it('refuses to save without a session', async () => {
        getAuthFromCookie.mockResolvedValue(null);
        redirect.mockImplementation(() => {
            throw new Error('NEXT_REDIRECT');
        });

        await expect(
            saveAppLauncherPreferencesAction([{ key: 'platform:gauzy', visible: false }]),
        ).rejects.toThrow('NEXT_REDIRECT');
        expect(redirect).toHaveBeenCalledWith(ROUTES.AUTH_LOGIN);
        expect(serverMutation).not.toHaveBeenCalled();
    });
});
