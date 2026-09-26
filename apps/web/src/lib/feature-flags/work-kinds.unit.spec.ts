import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * APW-01 T7b — the fail-CLOSED exception for the `app` chip (Resolution R-6).
 *
 * `getDisabledWorkKinds` is fail-open by design: an OSS fork with no PostHog
 * must get every existing kind, so "we could not tell" means ENABLED. `app` is
 * the one kind that must not work that way — its surface is unfinished, and a
 * chip that appeared because a flag service was slow would leak it into the
 * picker. These cases pin both halves: `app` closes on every uncertain answer,
 * and every other `works-<kind>` flag keeps failing open, unchanged.
 *
 * The helper keeps a module-level PostHog singleton and — deliberately —
 * caches "there is no key" once it has decided, so a suite that flips
 * `POSTHOG_API_KEY` between cases must re-import the module. `load()` does
 * that, and the mock factory below is re-run on each import, closing over the
 * same `isFeatureEnabled` spy.
 */

const isFeatureEnabled = vi.fn();

vi.mock('posthog-node', () => ({
    PostHog: class {
        isFeatureEnabled = isFeatureEnabled;
    },
}));

const ENV_KEYS = ['POSTHOG_API_KEY', 'POSTHOG_HOST', 'EVER_WORKS_APP_WORKS_ENABLED'] as const;
const SAVED: Record<string, string | undefined> = {};

/** Every kind that exists today other than `app` — none of them may close. */
const OTHER_KINDS = [
    'website',
    'landing-page',
    'blog',
    'directory',
    'awesome-repo',
    'repo',
    'company',
    'campaign',
    'default',
] as const;

const CHIPS = [...OTHER_KINDS, 'app'] as const;

/** A fresh copy of the module, so the singleton starts undecided. */
async function load() {
    vi.resetModules();
    return await import('./work-kinds');
}

describe('getDisabledWorkKinds — the fail-CLOSED app chip (APW-01 T7b)', () => {
    beforeEach(() => {
        for (const key of ENV_KEYS) SAVED[key] = process.env[key];
        delete process.env.POSTHOG_API_KEY;
        delete process.env.POSTHOG_HOST;
        delete process.env.EVER_WORKS_APP_WORKS_ENABLED;
        isFeatureEnabled.mockReset();
    });

    afterEach(() => {
        for (const key of ENV_KEYS) {
            if (SAVED[key] === undefined) delete process.env[key];
            else process.env[key] = SAVED[key];
        }
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('names `app` — and only `app` — in the fail-closed set', async () => {
        const { FAIL_CLOSED_WORK_KINDS, workKindFlagKey } = await load();

        expect([...FAIL_CLOSED_WORK_KINDS]).toEqual(['app']);
        expect(workKindFlagKey('app')).toBe('works-app');
    });

    it('hides `app` when no PostHog key is configured, and leaves every other kind enabled', async () => {
        const { getDisabledWorkKinds } = await load();

        const disabled = await getDisabledWorkKinds(CHIPS);

        expect(disabled.has('app')).toBe(true);
        for (const kind of OTHER_KINDS) {
            expect(disabled.has(kind), `kind "${kind}" must stay fail-open`).toBe(false);
        }
        // No client ⇒ no flag was ever asked for, and no other kind closed.
        expect(isFeatureEnabled).not.toHaveBeenCalled();
    });

    it('hides `app` when the flag does not exist (undefined) — the opposite of every other kind', async () => {
        process.env.POSTHOG_API_KEY = 'ph-key';
        isFeatureEnabled.mockResolvedValue(undefined);
        const { getDisabledWorkKinds } = await load();

        const disabled = await getDisabledWorkKinds(CHIPS);

        expect(disabled.has('app')).toBe(true);
        expect(disabled.has('blog')).toBe(false);
        expect(disabled.has('repo')).toBe(false);
    });

    it('hides `app` when the flag resolves to false, like every other kind', async () => {
        process.env.POSTHOG_API_KEY = 'ph-key';
        isFeatureEnabled.mockResolvedValue(false);
        const { getDisabledWorkKinds } = await load();

        const disabled = await getDisabledWorkKinds(CHIPS);

        expect(disabled.has('app')).toBe(true);
        expect(disabled.has('blog')).toBe(true);
    });

    it('hides `app` when the flag resolves to a truthy value that is not strictly true', async () => {
        process.env.POSTHOG_API_KEY = 'ph-key';
        isFeatureEnabled.mockResolvedValue('variant-2' as unknown as boolean);
        const { getDisabledWorkKinds } = await load();

        const disabled = await getDisabledWorkKinds(['app']);

        expect(disabled.has('app')).toBe(true);
    });

    it('shows `app` only on a strict true, asked under its own flag key', async () => {
        process.env.POSTHOG_API_KEY = 'ph-key';
        isFeatureEnabled.mockImplementation(async (key: string) => key === 'works-app');
        const { getDisabledWorkKinds } = await load();

        const disabled = await getDisabledWorkKinds(CHIPS, 'user-1');

        expect(disabled.has('app')).toBe(false);
        expect(isFeatureEnabled).toHaveBeenCalledWith(
            'works-app',
            'user-1',
            expect.objectContaining({ sendFeatureFlagEvents: false }),
        );
    });

    it('hides `app` even on a true flag when the API-side gate says App Works are off', async () => {
        process.env.POSTHOG_API_KEY = 'ph-key';
        isFeatureEnabled.mockResolvedValue(true);
        const { getDisabledWorkKinds } = await load();

        const open = await getDisabledWorkKinds(['app'], 'user-1', { appWorksEnabled: true });
        const closed = await getDisabledWorkKinds(['app'], 'user-1', { appWorksEnabled: false });

        expect(open.has('app')).toBe(false);
        expect(closed.has('app')).toBe(true);
    });

    it('hides `app` and only `app` when PostHog throws', async () => {
        process.env.POSTHOG_API_KEY = 'ph-key';
        isFeatureEnabled.mockRejectedValue(new Error('posthog down'));
        const { getDisabledWorkKinds } = await load();

        const disabled = await getDisabledWorkKinds(CHIPS);

        expect(disabled.has('app')).toBe(true);
        for (const kind of OTHER_KINDS) {
            expect(disabled.has(kind), `kind "${kind}" must stay fail-open`).toBe(false);
        }
    });

    it('hides `app` when PostHog never answers and the timeout returns a partial set', async () => {
        vi.useFakeTimers();
        try {
            process.env.POSTHOG_API_KEY = 'ph-key';
            // `blog` answers in time; `app` never does. The partial set the
            // timeout hands back must not contain an enabled `app`.
            isFeatureEnabled.mockImplementation((key: string) =>
                key === 'works-blog' ? Promise.resolve(true) : new Promise(() => undefined),
            );
            const { getDisabledWorkKinds } = await load();

            const pending = getDisabledWorkKinds(['blog', 'app']);
            await vi.advanceTimersByTimeAsync(1600);
            const disabled = await pending;

            expect(disabled.has('app')).toBe(true);
            expect(disabled.has('blog')).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });

    it.each(OTHER_KINDS)(
        'leaves the "%s" chip fail-open: a missing flag enables it',
        async (kind) => {
            process.env.POSTHOG_API_KEY = 'ph-key';
            isFeatureEnabled.mockResolvedValue(undefined);
            const { getDisabledWorkKinds } = await load();

            const disabled = await getDisabledWorkKinds([kind]);

            expect(disabled.has(kind)).toBe(false);
        },
    );

    it('never throws, whatever the flag service does', async () => {
        process.env.POSTHOG_API_KEY = 'ph-key';
        isFeatureEnabled.mockRejectedValue(new Error('boom'));
        const { getDisabledWorkKinds } = await load();

        await expect(getDisabledWorkKinds(CHIPS)).resolves.toBeInstanceOf(Set);
    });

    // -----------------------------------------------------------------------
    // The `/new` + `/works/new` server-render crash: `values` is NOT always an
    // array, and the fail-CLOSED set must not be seeded FROM it.
    // -----------------------------------------------------------------------

    describe('a `values` that is not an array cannot 500 the page', () => {
        /**
         * The shape a server component ACTUALLY receives when it imports a plain
         * value from a `'use client'` module: an opaque client reference with no
         * array methods, so `.filter` is `undefined`. That call sat before any
         * `try`/`catch`, which is what turned it into a 500 rather than a
         * degraded chip row.
         */
        const CLIENT_REFERENCE = {
            $$typeof: Symbol.for('react.client.reference'),
            name: 'ALL_NEW_CHIP_VALUES',
        };
        /** The other half of the same failure mode: an opaque reference that THROWS on access. */
        const OPAQUE_REFERENCE = new Proxy(function clientRef() {} as unknown as object, {
            get() {
                throw new Error('Attempted to access a client reference from the server');
            },
        });

        /** Values a caller can reach this with, once TypeScript's array type is a lie. */
        const NOT_ARRAYS: ReadonlyArray<readonly [string, unknown]> = [
            ['a client reference object', CLIENT_REFERENCE],
            ['an opaque reference that throws on access', OPAQUE_REFERENCE],
            ['undefined', undefined],
            ['null', null],
            ['a bare string', 'website'],
            ['a number', 42],
        ];

        const asValues = (value: unknown) => value as unknown as readonly string[];

        it.each(NOT_ARRAYS)('returns a Set instead of throwing for %s', async (_label, value) => {
            const { getDisabledWorkKinds } = await load();

            const result = getDisabledWorkKinds(asValues(value));

            await expect(result).resolves.toBeInstanceOf(Set);
        });

        it.each(NOT_ARRAYS)(
            'keeps EVERY fail-CLOSED kind disabled for %s',
            async (_label, value) => {
                const { FAIL_CLOSED_WORK_KINDS, getDisabledWorkKinds } = await load();

                const disabled = await getDisabledWorkKinds(asValues(value));

                for (const kind of FAIL_CLOSED_WORK_KINDS) {
                    expect(disabled.has(kind), `"${kind}" must stay disabled`).toBe(true);
                }
            },
        );

        it('keeps ordinary kinds enabled — nothing is falsely closed — and asks no flag', async () => {
            const { FAIL_CLOSED_WORK_KINDS, getDisabledWorkKinds } = await load();

            const disabled = await getDisabledWorkKinds(asValues(CLIENT_REFERENCE));

            // Exactly the fail-closed set and nothing else: a non-array input
            // yields no candidates, so no ordinary kind can be closed and the
            // flag service is never consulted.
            expect([...disabled]).toEqual([...FAIL_CLOSED_WORK_KINDS]);
            for (const kind of OTHER_KINDS) {
                expect(disabled.has(kind), `kind "${kind}" must stay enabled`).toBe(false);
            }
            expect(isFeatureEnabled).not.toHaveBeenCalled();
        });

        it('does not re-enable the fail-CLOSED kinds even when PostHog is live and would say yes', async () => {
            // Seeding the disabled set FROM `values` made the guarantee depend on
            // the input, so a caller that passed something broken got a set in
            // which `app` was ENABLED — the opposite of fail-closed. With a
            // client configured the flag is never even asked about a fail-closed
            // kind that was not offered.
            process.env.POSTHOG_API_KEY = 'ph-key';
            isFeatureEnabled.mockResolvedValue(true);
            const { getDisabledWorkKinds } = await load();

            const disabled = await getDisabledWorkKinds(asValues(CLIENT_REFERENCE));

            expect(disabled.has('app')).toBe(true);
            expect(isFeatureEnabled).not.toHaveBeenCalled();
        });

        it('keeps the fail-CLOSED kinds disabled for an EMPTY array — the same bug without a bad type', async () => {
            const { getDisabledWorkKinds } = await load();

            const disabled = await getDisabledWorkKinds([]);

            expect(disabled.has('app')).toBe(true);
            expect([...disabled]).toEqual(['app']);
        });

        it('keeps the fail-CLOSED kinds disabled for an array that omits them', async () => {
            const { getDisabledWorkKinds } = await load();

            const disabled = await getDisabledWorkKinds(['website', 'blog']);

            expect(disabled.has('app')).toBe(true);
            // …while the ordinary kinds it DID name stay fail-open.
            expect(disabled.has('website')).toBe(false);
            expect(disabled.has('blog')).toBe(false);
        });

        it('still lets an explicit `true` + instance setting clear the fail-CLOSED kinds, non-array or not', async () => {
            // The seeding change must not make the fail-closed kinds
            // UNREACHABLE: the documented re-enable path is untouched.
            process.env.EVER_WORKS_APP_WORKS_ENABLED = 'true';
            const { getDisabledWorkKinds } = await load();

            const viaArray = await getDisabledWorkKinds(['app', 'blog']);
            const viaNonArray = await getDisabledWorkKinds(asValues(CLIENT_REFERENCE));

            expect(viaArray.has('app')).toBe(false);
            // A non-array carries no `app` to enable, so it stays disabled —
            // that is the correct direction for a fail-CLOSED kind.
            expect(viaNonArray.has('app')).toBe(true);
        });
    });

    // -----------------------------------------------------------------------
    // APW-01 T20 — the runtime instance setting decides the no-PostHog case
    // -----------------------------------------------------------------------

    describe('with NO PostHog configured, the runtime instance setting decides (T20)', () => {
        it('hides `app` when the setting is unset — "we could not tell" is still OFF', async () => {
            const { getDisabledWorkKinds } = await load();

            const disabled = await getDisabledWorkKinds(['app', 'blog']);

            expect(disabled.has('app')).toBe(true);
            expect(disabled.has('blog')).toBe(false);
        });

        it('shows `app` when the instance has switched App Works on', async () => {
            process.env.EVER_WORKS_APP_WORKS_ENABLED = 'true';
            const { getDisabledWorkKinds } = await load();

            const disabled = await getDisabledWorkKinds(['app', 'blog']);

            expect(disabled.has('app')).toBe(false);
            // Every other kind is untouched by the switch.
            expect(disabled.has('blog')).toBe(false);
        });

        it.each(['1', 'yes', 'TRUE', 'true ', ''])(
            'still hides `app` for %p — only the exact string "true" is on',
            async (value) => {
                process.env.EVER_WORKS_APP_WORKS_ENABLED = value;
                const { getDisabledWorkKinds } = await load();

                const disabled = await getDisabledWorkKinds(['app']);

                expect(disabled.has('app')).toBe(true);
            },
        );

        it('reads the setting at CALL time, not at import time', async () => {
            // A container restarted with a different value must behave
            // correctly without a rebuild, which is the whole reason this is an
            // environment read inside the function rather than a module-level
            // constant or a build-time NEXT_PUBLIC_* value.
            const { getDisabledWorkKinds } = await load();

            const before = await getDisabledWorkKinds(['app']);
            process.env.EVER_WORKS_APP_WORKS_ENABLED = 'true';
            const after = await getDisabledWorkKinds(['app']);

            expect(before.has('app')).toBe(true);
            expect(after.has('app')).toBe(false);
        });

        it('lets the caller’s gate win over the environment, both ways', async () => {
            // When the API publishes its own answer, that answer is the truth:
            // a chip for a surface the API refuses would be a dead end, and a
            // hidden chip for a surface it serves is a missing feature.
            process.env.EVER_WORKS_APP_WORKS_ENABLED = 'true';
            const { getDisabledWorkKinds } = await load();

            const refused = await getDisabledWorkKinds(['app'], 'user-1', {
                appWorksEnabled: false,
            });
            delete process.env.EVER_WORKS_APP_WORKS_ENABLED;
            const allowed = await getDisabledWorkKinds(['app'], 'user-1', {
                appWorksEnabled: true,
            });

            expect(refused.has('app')).toBe(true);
            expect(allowed.has('app')).toBe(false);
        });

        it('leaves every other kind fail-open in exactly the same conditions', async () => {
            process.env.EVER_WORKS_APP_WORKS_ENABLED = 'true';
            const { getDisabledWorkKinds } = await load();

            const disabled = await getDisabledWorkKinds(CHIPS);

            expect(disabled.has('app')).toBe(false);
            for (const kind of OTHER_KINDS) {
                expect(disabled.has(kind), `kind "${kind}" must stay fail-open`).toBe(false);
            }
        });
    });
});
