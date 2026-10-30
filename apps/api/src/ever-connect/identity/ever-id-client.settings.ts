import { Inject, Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { PluginPlatformSettingsService } from '@ever-works/agent/plugins';
import {
    EVER_ID_LOGIN_INTEGRATION,
    type EverIdLoginIntegration,
} from './ever-connect-identity.ports';

/** The plugin that signs people in with Ever ID (`packages/plugins/oidc-identity`). */
export const EVER_ID_SIGN_IN_PLUGIN_ID = 'oidc-identity';

/**
 * The sign-in plugin's own variables. When an operator set any of them, the
 * installation is configured by hand and the client Ever Platform made is not
 * offered at all, so the two are never mixed.
 */
export const EVER_ID_OPERATOR_VARIABLES = [
    'EVER_ID_ISSUER_URL',
    'EVER_ID_CLIENT_ID',
    'EVER_ID_CLIENT_SECRET',
] as const;

/** How long a read of the stored client is reused (settings are resolved per sign-in call). */
const CACHE_MS = 30_000;

/**
 * Offers the sign-in client Ever Platform made for this installation to the
 * Ever ID sign-in plugin, as its issuer, client id and client secret, through
 * the settings level below every value an operator sets.
 *
 * Turning Ever ID on stays the administrator's step (Settings → Ever ID); this
 * only provides the configuration it needs.
 */
@Injectable()
export class EverIdClientSettings implements OnModuleInit, OnModuleDestroy {
    private cache: { at: number; value: Readonly<Record<string, unknown>> | null } | null = null;
    private unregister: (() => void) | undefined;

    constructor(
        @Inject(EVER_ID_LOGIN_INTEGRATION) private readonly integration: EverIdLoginIntegration,
        @Optional() private readonly platformSettings?: PluginPlatformSettingsService,
    ) {}

    onModuleInit(): void {
        this.unregister = this.platformSettings?.register(EVER_ID_SIGN_IN_PLUGIN_ID, () =>
            this.read(),
        );
    }

    onModuleDestroy(): void {
        this.unregister?.();
        this.unregister = undefined;
    }

    /** Drop the cached read after the stored client changed. */
    invalidate(): void {
        this.cache = null;
    }

    /** The plugin settings to offer, or `null` (configured by hand, or no client). */
    async read(now = Date.now()): Promise<Readonly<Record<string, unknown>> | null> {
        if (EVER_ID_OPERATOR_VARIABLES.some((name) => isSet(process.env[name]))) return null;
        if (this.cache && now - this.cache.at < CACHE_MS) return this.cache.value;
        const client = await this.integration.readClient();
        const value = client
            ? {
                  issuerUrl: client.issuer,
                  clientId: client.clientId,
                  clientSecret: client.clientSecret,
              }
            : null;
        this.cache = { at: now, value };
        return value;
    }
}

function isSet(value: string | undefined): boolean {
    return typeof value === 'string' && value.trim() !== '';
}
