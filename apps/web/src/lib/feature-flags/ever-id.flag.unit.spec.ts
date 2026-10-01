import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * APW-12 T21 — the `ever-id` rollout flag (spec FR-1, ACC-12-01/02; plan §6.4).
 *
 * Three behaviours are pinned here:
 *
 *  1. **Fail closed.** With PostHog configured, only a strict `true` answered
 *     within the 1,500 ms budget turns Ever ID on; `false`, `undefined`, a
 *     truthy variant, a throw and a timeout are all off (ACC-12-02).
 *  2. **No flag service, configuration decides.** With no `POSTHOG_API_KEY` the
 *     helper answers `true` and never builds a client.
 *  3. **Zero outbound calls while Ever ID is off.** `isEverIdOffered` never asks
 *     PostHog unless the API reported `everId.enabled: true`.
 *
 * And one about the extraction: the Work-kind helper and this one share ONE
 * PostHog client (`./posthog-client`) yet keep opposite readings of a missing
 * key, so a later "unification" cannot silently change either.
 *
 * The client is a module-level singleton that caches "there is no key", so each
 * case re-imports the modules (`load`) after setting the environment.
 */

const isFeatureEnabled = vi.fn();
const constructed = vi.fn();

vi.mock('posthog-node', () => ({
    PostHog: class {
        constructor(...args: unknown[]) {
            constructed(...args);
        }
        isFeatureEnabled = isFeatureEnabled;
    },
}));

const ENV_KEYS = ['POSTHOG_API_KEY', 'POSTHOG_HOST', 'EVER_WORKS_APP_WORKS_ENABLED'] as const;
const SAVED: Record<string, string | undefined> = {};

async function load() {
    vi.resetModules();
    return await import('./ever-id');
}

describe('isEverIdFlagOn — the ever-id rollout flag (APW-12 T21)', () => {
    beforeEach(() => {
        for (const key of ENV_KEYS) SAVED[key] = process.env[key];
        delete process.env.POSTHOG_API_KEY;
        delete process.env.POSTHOG_HOST;
        delete process.env.EVER_WORKS_APP_WORKS_ENABLED;
        isFeatureEnabled.mockReset();
        constructed.mockReset();
    });

    afterEach(() => {
        for (const key of ENV_KEYS) {
            if (SAVED[key] === undefined) delete process.env[key];
            else process.env[key] = SAVED[key];
        }
        vi.useRealTimers();
    });

    it('lets the configuration alone decide when no PostHog key is set', async () => {
        const { isEverIdFlagOn } = await load();

        await expect(isEverIdFlagOn('anonymous')).resolves.toBe(true);
        expect(constructed).not.toHaveBeenCalled();
        expect(isFeatureEnabled).not.toHaveBeenCalled();
    });

    it('is on for a strict true, asked under the ever-id key for the given id', async () => {
        process.env.POSTHOG_API_KEY = 'ph-key';
        isFeatureEnabled.mockResolvedValue(true);
        const { isEverIdFlagOn, EVER_ID_FLAG_KEY } = await load();

        await expect(isEverIdFlagOn('user-1')).resolves.toBe(true);
        expect(EVER_ID_FLAG_KEY).toBe('ever-id');
        expect(isFeatureEnabled).toHaveBeenCalledWith(
            'ever-id',
            'user-1',
            expect.objectContaining({ sendFeatureFlagEvents: false }),
        );
    });

    it.each([
        ['false', false],
        ['undefined (missing flag)', undefined],
        ['a truthy variant that is not strictly true', 'variant-b'],
        ['null', null],
    ])('is off when the flag resolves to %s', async (_label, value) => {
        process.env.POSTHOG_API_KEY = 'ph-key';
        isFeatureEnabled.mockResolvedValue(value);
        const { isEverIdFlagOn } = await load();

        await expect(isEverIdFlagOn('anonymous')).resolves.toBe(false);
    });

    it('is off when PostHog throws', async () => {
        process.env.POSTHOG_API_KEY = 'ph-key';
        isFeatureEnabled.mockRejectedValue(new Error('posthog down'));
        const { isEverIdFlagOn } = await load();

        await expect(isEverIdFlagOn('anonymous')).resolves.toBe(false);
    });

    it('is off when PostHog does not answer within 1,500 ms', async () => {
        vi.useFakeTimers();
        process.env.POSTHOG_API_KEY = 'ph-key';
        isFeatureEnabled.mockReturnValue(new Promise(() => {}));
        const { isEverIdFlagOn, EVER_ID_FLAG_BUDGET_MS } = await load();

        const pending = isEverIdFlagOn('anonymous');
        await vi.advanceTimersByTimeAsync(EVER_ID_FLAG_BUDGET_MS);

        await expect(pending).resolves.toBe(false);
        expect(EVER_ID_FLAG_BUDGET_MS).toBe(1500);
    });

    it('a late true after the budget does not turn it on', async () => {
        vi.useFakeTimers();
        process.env.POSTHOG_API_KEY = 'ph-key';
        isFeatureEnabled.mockReturnValue(
            new Promise((resolve) => setTimeout(() => resolve(true), 5_000)),
        );
        const { isEverIdFlagOn } = await load();

        const pending = isEverIdFlagOn('anonymous');
        await vi.advanceTimersByTimeAsync(1_500);
        await expect(pending).resolves.toBe(false);
    });
});

describe('isEverIdOffered — the switch first, the flag only when it is on', () => {
    beforeEach(() => {
        for (const key of ENV_KEYS) SAVED[key] = process.env[key];
        delete process.env.POSTHOG_API_KEY;
        isFeatureEnabled.mockReset();
        constructed.mockReset();
    });

    afterEach(() => {
        for (const key of ENV_KEYS) {
            if (SAVED[key] === undefined) delete process.env[key];
            else process.env[key] = SAVED[key];
        }
    });

    it('asks nothing of PostHog while Ever ID is off (ACC-12-01: zero outbound calls)', async () => {
        process.env.POSTHOG_API_KEY = 'ph-key';
        isFeatureEnabled.mockResolvedValue(true);
        const { isEverIdOffered } = await load();

        await expect(isEverIdOffered({ enabled: false }, 'anonymous')).resolves.toBe(false);
        expect(isFeatureEnabled).not.toHaveBeenCalled();
        expect(constructed).not.toHaveBeenCalled();
    });

    it('treats anything but a strict enabled: true as off', async () => {
        process.env.POSTHOG_API_KEY = 'ph-key';
        isFeatureEnabled.mockResolvedValue(true);
        const { isEverIdOffered } = await load();

        await expect(
            isEverIdOffered({ enabled: 'true' as unknown as boolean }, 'anonymous'),
        ).resolves.toBe(false);
        expect(isFeatureEnabled).not.toHaveBeenCalled();
    });

    it('offers Ever ID when enabled and the flag is on', async () => {
        process.env.POSTHOG_API_KEY = 'ph-key';
        isFeatureEnabled.mockResolvedValue(true);
        const { isEverIdOffered } = await load();

        await expect(isEverIdOffered({ enabled: true }, 'user-7')).resolves.toBe(true);
        expect(isFeatureEnabled).toHaveBeenCalledWith('ever-id', 'user-7', expect.anything());
    });

    it('hides Ever ID when enabled but the flag is off for this viewer', async () => {
        process.env.POSTHOG_API_KEY = 'ph-key';
        isFeatureEnabled.mockResolvedValue(false);
        const { isEverIdOffered } = await load();

        await expect(isEverIdOffered({ enabled: true }, 'anonymous')).resolves.toBe(false);
    });

    it('offers Ever ID when enabled on an installation with no flag service', async () => {
        const { isEverIdOffered } = await load();

        await expect(isEverIdOffered({ enabled: true }, 'anonymous')).resolves.toBe(true);
        expect(constructed).not.toHaveBeenCalled();
    });
});

describe('the extracted PostHog client — shared, with both policies intact', () => {
    beforeEach(() => {
        for (const key of ENV_KEYS) SAVED[key] = process.env[key];
        delete process.env.POSTHOG_API_KEY;
        delete process.env.EVER_WORKS_APP_WORKS_ENABLED;
        isFeatureEnabled.mockReset();
        constructed.mockReset();
    });

    afterEach(() => {
        for (const key of ENV_KEYS) {
            if (SAVED[key] === undefined) delete process.env[key];
            else process.env[key] = SAVED[key];
        }
    });

    it('builds ONE client for both helpers, from the same key and host', async () => {
        process.env.POSTHOG_API_KEY = 'ph-key';
        process.env.POSTHOG_HOST = 'https://eu.i.posthog.com';
        isFeatureEnabled.mockResolvedValue(true);
        vi.resetModules();
        const everId = await import('./ever-id');
        const workKinds = await import('./work-kinds');

        await everId.isEverIdFlagOn('anonymous');
        await workKinds.getDisabledWorkKinds(['blog']);

        expect(constructed).toHaveBeenCalledTimes(1);
        expect(constructed).toHaveBeenCalledWith('ph-key', { host: 'https://eu.i.posthog.com' });
    });

    it('keeps the opposite readings of a missing key: Work kinds hide `app`, Ever ID is on', async () => {
        vi.resetModules();
        const everId = await import('./ever-id');
        const workKinds = await import('./work-kinds');

        // Work kinds: `app` is fail-CLOSED with no key (APW-01 T7b) …
        const disabled = await workKinds.getDisabledWorkKinds(['app', 'blog']);
        expect(disabled.has('app')).toBe(true);
        expect(disabled.has('blog')).toBe(false);
        // … while an authentication method is not switched off by a missing key.
        await expect(everId.isEverIdFlagOn('anonymous')).resolves.toBe(true);
        expect(constructed).not.toHaveBeenCalled();
    });
});
