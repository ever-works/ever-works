import 'server-only';
import { fleetCloudAPI } from '@/lib/api/fleet-cloud';

/** A plugin id shape: lower-case letters, digits and hyphens (nothing that could re-shape an API path). */
const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

/**
 * Cloud computers (FL-17 P3, spec FR-31) — whether `providerId` is a
 * machine-provider plugin the signed-in owner may use AND that offers
 * "Sign in with <provider>" (the operator registered an application), as the
 * API's own `GET /api/fleet/providers` says. The OAuth plugins callback
 * accepts such a provider beside the fixed sign-in enum; anything else —
 * including any id while cloud computers are switched off — is refused as
 * before. Never throws.
 */
export async function isSignInMachineProvider(providerId: string): Promise<boolean> {
    if (!PLUGIN_ID_PATTERN.test(providerId)) return false;
    try {
        const { providers } = await fleetCloudAPI.providers();
        return providers.some(
            (provider) => provider.pluginId === providerId && provider.oauthAvailable,
        );
    } catch {
        return false;
    }
}
