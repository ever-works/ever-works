import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * APW-12 T22 — the additive `everId` field on `GET /auth/providers` (spec FR-6).
 *
 * An API that predates Ever ID sends no `everId`; that must read as "not
 * available", never as an error, and every existing field must keep the meaning
 * it had (ACC-12-05). Only a strict `enabled: true` turns Ever ID on.
 */

function respond(body: unknown, ok = true) {
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(JSON.stringify(body), { status: ok ? 200 : 503 })),
    );
}

async function load() {
    vi.resetModules();
    return import('./providers');
}

describe('getAuthProvidersConfig — Ever ID availability', () => {
    beforeEach(() => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        delete process.env.OAUTH_PROVIDERS;
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('defaults to { enabled: false, displayName: "Ever ID" } when the field is absent', async () => {
        respond({ emailPassword: true, magicLink: true, socialProviders: ['github', 'google'] });
        const { getAuthProvidersConfig } = await load();

        const config = await getAuthProvidersConfig();

        expect(config.everId).toEqual({ enabled: false, displayName: 'Ever ID' });
        // The existing fields keep their meaning.
        expect(config.socialProviders).toEqual(['github', 'google']);
        expect(config.magicLinkEnabled).toBe(true);
    });

    it('reads enabled: true and the display name the API sends', async () => {
        respond({
            emailPassword: true,
            socialProviders: [],
            everId: { enabled: true, displayName: 'Ever ID' },
        });
        const { getAuthProvidersConfig } = await load();

        expect((await getAuthProvidersConfig()).everId).toEqual({
            enabled: true,
            displayName: 'Ever ID',
        });
    });

    it.each([
        ['the string "true"', 'true'],
        ['1', 1],
        ['null', null],
        ['missing', undefined],
    ])('treats enabled = %s as off', async (_label, enabled) => {
        respond({ emailPassword: true, socialProviders: [], everId: { enabled } });
        const { getAuthProvidersConfig } = await load();

        expect((await getAuthProvidersConfig()).everId.enabled).toBe(false);
    });

    it('falls back to the default display name for an empty one', async () => {
        respond({
            emailPassword: true,
            socialProviders: [],
            everId: { enabled: true, displayName: ' ' },
        });
        const { getAuthProvidersConfig } = await load();

        expect((await getAuthProvidersConfig()).everId.displayName).toBe('Ever ID');
    });

    it('reads an unreachable API as "not available", keeping the social fallback', async () => {
        process.env.OAUTH_PROVIDERS = 'github';
        respond({}, false);
        const { getAuthProvidersConfig, getEverIdAvailability } = await load();

        const config = await getAuthProvidersConfig();
        expect(config.everId).toEqual({ enabled: false, displayName: 'Ever ID' });
        expect(config.socialProviders).toEqual(['github']);
        await expect(getEverIdAvailability()).resolves.toEqual({
            enabled: false,
            displayName: 'Ever ID',
        });
    });

    it('getEverIdAvailability reads the same field', async () => {
        respond({ emailPassword: true, socialProviders: [], everId: { enabled: true } });
        const { getEverIdAvailability } = await load();

        await expect(getEverIdAvailability()).resolves.toEqual({
            enabled: true,
            displayName: 'Ever ID',
        });
    });
});
