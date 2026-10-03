import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `instanceStatsAPI.isAvailable` decides whether Settings shows the Ever
 * Platform tab: `false` ONLY for a 404 (the API has the statistics module
 * switched off by `EVER_STATS_ENABLED`). Any other failure keeps the tab, so
 * the page can say the status could not be read instead of vanishing.
 */
const serverFetch = vi.fn();

vi.mock('./server-api', () => {
    class ApiResponseError extends Error {
        constructor(
            message: string,
            public readonly statusCode: number,
        ) {
            super(message);
        }
    }
    return {
        ApiResponseError,
        serverFetch: (...args: unknown[]) => serverFetch(...args),
        serverMutation: vi.fn(),
    };
});

import { ApiResponseError } from './server-api';
import { instanceStatsAPI } from './instance-stats';

describe('instanceStatsAPI.isAvailable', () => {
    beforeEach(() => {
        serverFetch.mockReset();
    });

    it('is true when the status answers', async () => {
        serverFetch.mockResolvedValue({ enabled: true, managedBy: 'operator' });
        expect(await instanceStatsAPI.isAvailable()).toBe(true);
        expect(serverFetch).toHaveBeenCalledWith('/instance-stats/status', { cache: 'no-store' });
    });

    it('is false when the API answers 404 (module switched off)', async () => {
        serverFetch.mockRejectedValue(new ApiResponseError('Not Found', 404));
        expect(await instanceStatsAPI.isAvailable()).toBe(false);
    });

    it.each([401, 403, 500, 503])('stays true for a %s', async (status) => {
        serverFetch.mockRejectedValue(new ApiResponseError('error', status));
        expect(await instanceStatsAPI.isAvailable()).toBe(true);
    });

    it('stays true when the API cannot be reached at all', async () => {
        serverFetch.mockRejectedValue(new TypeError('fetch failed'));
        expect(await instanceStatsAPI.isAvailable()).toBe(true);
    });
});
