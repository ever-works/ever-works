import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Cloud computers (FL-17 P3, T-28, spec FR-31) — the OAuth plugins callback
 * accepts a machine provider beside the fixed sign-in enum only when the
 * API's own provider list says the signed-in owner may use it AND it offers
 * "Sign in"; a crafted id, a provider without sign-in, cloud computers being
 * switched off (the list answers 404) or any failure are refused.
 */

const api = vi.hoisted(() => ({ providers: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/api/fleet-cloud', () => ({ fleetCloudAPI: api }));

import { isSignInMachineProvider } from './machine-provider-sign-in';

const listed = (oauthAvailable: boolean) => ({
    providers: [
        {
            pluginId: 'machines-plugin',
            name: 'Machines',
            providerName: 'Provider',
            configured: false,
            account: null,
            oauthAvailable,
        },
    ],
});

describe('isSignInMachineProvider (FL-17 P3)', () => {
    beforeEach(() => vi.clearAllMocks());

    it('accepts a listed provider that offers sign-in', async () => {
        api.providers.mockResolvedValue(listed(true));
        await expect(isSignInMachineProvider('machines-plugin')).resolves.toBe(true);
    });

    it('refuses a provider without sign-in, an unlisted id and a crafted id', async () => {
        api.providers.mockResolvedValue(listed(false));
        await expect(isSignInMachineProvider('machines-plugin')).resolves.toBe(false);
        api.providers.mockResolvedValue(listed(true));
        await expect(isSignInMachineProvider('other-plugin')).resolves.toBe(false);
        await expect(isSignInMachineProvider('../admin')).resolves.toBe(false);
        await expect(isSignInMachineProvider('Machines-Plugin')).resolves.toBe(false);
        // The two crafted ids never reach the API.
        expect(api.providers).toHaveBeenCalledTimes(2);
    });

    it('refuses when the provider list cannot be read (cloud computers off)', async () => {
        api.providers.mockRejectedValue(Object.assign(new Error('Not Found'), { statusCode: 404 }));
        await expect(isSignInMachineProvider('machines-plugin')).resolves.toBe(false);
    });
});
