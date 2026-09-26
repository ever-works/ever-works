import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * APW-11 T13 — the fail-closed matrix of `isAppLauncherEnabled`.
 *
 * Every row here is a way to be *unsure*, and every one of them must resolve to
 * `false`. The one exception is an unconfigured PostHog, which abstains: an OSS
 * deployment with no PostHog key still gets the launcher when its own
 * installation switch says so. That exception is why this is a matrix — the two
 * halves are combined, not merely both checked.
 *
 * The helper keeps a module-level PostHog singleton and — deliberately — caches
 * "there is no key" once it has decided (`null`, exactly as
 * `./work-kinds.ts` does), so a suite that flips `POSTHOG_API_KEY` between cases
 * must re-import the module. `load()` does that, and the mock factory below is
 * re-run on each import, closing over the same `isFeatureEnabled` spy.
 */

const isFeatureEnabled = vi.fn();

vi.mock('posthog-node', () => ({
    PostHog: class {
        isFeatureEnabled = isFeatureEnabled;
    },
}));

import { API_URL } from '@/lib/constants';

const ENV_KEYS = ['POSTHOG_API_KEY', 'POSTHOG_HOST'] as const;
const SAVED: Record<string, string | undefined> = {};

/** A fresh copy of the module, so the singleton starts undecided. */
async function load() {
    vi.resetModules();
    return await import('./app-launcher');
}

function configResponse(value: unknown): Response {
    return {
        ok: true,
        status: 200,
        json: async () => ({ features: { appLauncherEnabled: value } }),
    } as unknown as Response;
}

describe('isAppLauncherEnabled (APW-11 T13)', () => {
    beforeEach(() => {
        for (const key of ENV_KEYS) SAVED[key] = process.env[key];
        delete process.env.POSTHOG_API_KEY;
        isFeatureEnabled.mockReset();
    });

    afterEach(() => {
        for (const key of ENV_KEYS) {
            if (SAVED[key] === undefined) delete process.env[key];
            else process.env[key] = SAVED[key];
        }
        vi.unstubAllGlobals();
    });

    it('is ON when the installation switch is on and PostHog is not configured', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => configResponse(true)),
        );
        const { isAppLauncherEnabled } = await load();

        await expect(isAppLauncherEnabled('user-1')).resolves.toBe(true);
    });

    it('is OFF when the installation switch is off, without asking PostHog at all', async () => {
        const fetchMock = vi.fn(async () => configResponse(false));
        vi.stubGlobal('fetch', fetchMock);
        process.env.POSTHOG_API_KEY = 'ph-key';
        const { isAppLauncherEnabled } = await load();

        await expect(isAppLauncherEnabled('user-1')).resolves.toBe(false);
        expect(isFeatureEnabled).not.toHaveBeenCalled();
    });

    it('is OFF when the config endpoint is unreachable', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => {
                throw new Error('ECONNREFUSED');
            }),
        );
        const { isAppLauncherEnabled } = await load();

        await expect(isAppLauncherEnabled('user-1')).resolves.toBe(false);
    });

    it('is OFF when the config endpoint answers a non-200', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }) as Response),
        );
        const { isAppLauncherEnabled } = await load();

        await expect(isAppLauncherEnabled('user-1')).resolves.toBe(false);
    });

    it('is OFF when the config body is not JSON', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(
                async () =>
                    ({
                        ok: true,
                        status: 200,
                        json: async () => {
                            throw new Error('Unexpected token < in JSON');
                        },
                    }) as unknown as Response,
            ),
        );
        const { isAppLauncherEnabled } = await load();

        await expect(isAppLauncherEnabled('user-1')).resolves.toBe(false);
    });

    it('is OFF when the config body carries a truthy value that is not true', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => configResponse('yes')),
        );
        const { isAppLauncherEnabled } = await load();

        await expect(isAppLauncherEnabled('user-1')).resolves.toBe(false);
    });

    it('is OFF when the config request times out', async () => {
        // `AbortSignal.timeout` rejects the fetch; the helper must not wait for
        // the real 1,500 ms budget in the suite.
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => {
                throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
            }),
        );
        const { isAppLauncherEnabled } = await load();

        await expect(isAppLauncherEnabled('user-1')).resolves.toBe(false);
    });

    it('is OFF when PostHog resolves the flag to false', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => configResponse(true)),
        );
        process.env.POSTHOG_API_KEY = 'ph-key';
        isFeatureEnabled.mockResolvedValue(false);
        const { isAppLauncherEnabled, APP_LAUNCHER_FLAG_KEY } = await load();

        await expect(isAppLauncherEnabled('user-1')).resolves.toBe(false);
        expect(isFeatureEnabled).toHaveBeenCalledWith(
            APP_LAUNCHER_FLAG_KEY,
            'user-1',
            expect.objectContaining({ sendFeatureFlagEvents: false }),
        );
    });

    it('is OFF when the flag does not exist (undefined) — the opposite of the work-kind chips', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => configResponse(true)),
        );
        process.env.POSTHOG_API_KEY = 'ph-key';
        isFeatureEnabled.mockResolvedValue(undefined);
        const { isAppLauncherEnabled } = await load();

        await expect(isAppLauncherEnabled('user-1')).resolves.toBe(false);
    });

    it('is OFF when PostHog throws', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => configResponse(true)),
        );
        process.env.POSTHOG_API_KEY = 'ph-key';
        isFeatureEnabled.mockRejectedValue(new Error('posthog down'));
        const { isAppLauncherEnabled } = await load();

        await expect(isAppLauncherEnabled('user-1')).resolves.toBe(false);
    });

    it('is OFF when PostHog never answers, rather than holding up the page', async () => {
        vi.useFakeTimers();
        try {
            vi.stubGlobal(
                'fetch',
                vi.fn(async () => configResponse(true)),
            );
            process.env.POSTHOG_API_KEY = 'ph-key';
            isFeatureEnabled.mockImplementation(() => new Promise(() => undefined));
            const { isAppLauncherEnabled } = await load();

            const pending = isAppLauncherEnabled('user-1');
            await vi.advanceTimersByTimeAsync(1600);

            await expect(pending).resolves.toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });

    it('is ON only when both halves agree', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => configResponse(true)),
        );
        process.env.POSTHOG_API_KEY = 'ph-key';
        isFeatureEnabled.mockResolvedValue(true);
        const { isAppLauncherEnabled } = await load();

        await expect(isAppLauncherEnabled('user-1')).resolves.toBe(true);
    });

    it('addresses the API at API_URL/config, without doubling the /api segment', async () => {
        const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
            configResponse(true),
        );
        vi.stubGlobal('fetch', fetchMock);
        const { isAppLauncherEnabled } = await load();

        await isAppLauncherEnabled('user-1');

        // `API_URL` already ends in `/api` (`lib/constants`), so the helper must
        // not append another one. Asserted against the constant rather than a
        // literal, because the constant is resolved once at import time.
        expect(fetchMock.mock.calls[0][0]).toBe(`${API_URL}/config`);
    });
});
