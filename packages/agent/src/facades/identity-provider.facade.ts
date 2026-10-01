import { Injectable, Logger, Optional } from '@nestjs/common';
import {
    IDENTITY_TOKEN_REJECTION_CODES,
    IdentityTokenRejectedError,
    PLUGIN_CAPABILITIES,
    isIdentityProviderPlugin,
    type IIdentityProviderPlugin,
    type IdentityProviderCheck,
    type IdentityTokenRejectionCode,
    type VerifiedAccessTokenClaims,
    type VerifiedIdTokenClaims,
    type VerifiedLogoutTokenClaims,
} from '@ever-works/plugin';
import {
    PluginRegistryService,
    type RegisteredPlugin,
} from '../plugins/services/plugin-registry.service';
import { PluginRepository } from '../plugins/repositories/plugin.repository';
import { PluginSettingsService } from '../plugins/services/plugin-settings.service';
import { materializePlugin, pluginLoadFailure } from '../plugins/services/plugin-operation.util';
import { FacadeError } from './base.facade';

/**
 * Why the identity provider cannot serve a call (APW-12 plan §4.4).
 *
 * - `notRegistered` — no plugin with the `identity-provider` capability exists
 *   in this build.
 * - `disabled` — a platform administrator has not turned sign-in with it on
 *   (the API kill switch, spec FR-5).
 * - `notConfigured` — the issuer, client id or client secret is missing.
 * - `unavailable` — the last connection test failed (FR-14: sign-in stays off
 *   until an administrator re-tests).
 * - `loadFailed` — the plugin could not be loaded.
 *
 * The API answers `404 everIdDisabled` for the first three and `503
 * providerUnavailable` for the last two (plan §5.2).
 */
export type IdentityProviderUnavailableReason =
    | 'notRegistered'
    | 'disabled'
    | 'notConfigured'
    | 'unavailable'
    | 'loadFailed';

export class IdentityProviderUnavailableError extends FacadeError {
    constructor(readonly reason: IdentityProviderUnavailableReason) {
        super(`Identity provider unavailable: ${reason}`, 'getProvider');
        this.name = 'IdentityProviderUnavailableError';
    }
}

/**
 * The platform-written state the facade keeps in the plugin's own admin settings
 * row (`plugins.settings`), next to — never instead of — the plugin's
 * configuration. Shared through the database so every API replica agrees within
 * {@link IDENTITY_PROVIDER_STATE_CACHE_MS} (spec FR-5, NFR-4).
 */
export interface IdentityProviderAvailabilityRecord {
    unavailableSince?: string;
    discoveryRefreshedAt?: string;
    jwksRefreshedAt?: string;
    lastLogoutNoticeAt?: string;
}

/** What `getState()` answers — no network call is ever made to build it. */
export interface IdentityProviderState {
    /** A plugin with the capability exists in this build. */
    registered: boolean;
    /** A platform administrator turned sign-in with it on. */
    enabled: boolean;
    /** The persisted "last connection test failed" mark, or `null`. */
    unavailableSince: string | null;
}

/** One configuration field's provenance, for the administrator surface (never its value). */
export type IdentityProviderSettingSource = 'admin' | 'env' | 'default' | 'unset';

export interface IdentityProviderConfigurationStatus {
    configured: boolean;
    /** Required fields with no value from any source (names only, FR-4). */
    missing: string[];
    /** Where each field's value comes from; values themselves are never returned. */
    sources: Record<string, IdentityProviderSettingSource>;
    issuer: string | null;
    clientIdSet: boolean;
    clientSecretSet: boolean;
    displayName: string;
    signUpAllowed: boolean;
    localClients: number;
    /**
     * The public terminal clients (`cli` / `node`) the device exchange accepts, for
     * the administration page's form. A public client's id is not a secret.
     */
    localClientList: Array<{ kind: 'cli' | 'node'; clientId: string }>;
    accountManagementUrl: string | null;
    delegatedClientNames: Array<{ clientId: string; displayName: string }>;
}

export interface IdentityProviderHealth {
    discoveryRefreshedAt: string | null;
    jwksRefreshedAt: string | null;
    lastLogoutNoticeAt: string | null;
}

/** FR-5 / NFR-4: the enablement and availability state is re-read at least this often. */
export const IDENTITY_PROVIDER_STATE_CACHE_MS = 10_000;

/** The required checks of FR-3 — the ones `enable` and `unavailableSince` depend on. */
export const IDENTITY_PROVIDER_REQUIRED_CHECKS: ReadonlyArray<IdentityProviderCheck['id']> = [
    'discovery',
    'issuerMatch',
    'endpoints',
    'pkceS256',
    'signingAlg',
];

const ENABLED_KEY = 'enabled';
const AVAILABILITY_KEY = 'availability';
const DEFAULT_DISPLAY_NAME = 'Ever ID';

/**
 * APW-12 (Ever ID) — the one way the platform reaches an identity provider
 * (plan §4.4).
 *
 * The plugin is resolved through `PluginRegistryService` by the
 * `identity-provider` capability, exactly like the other facades: no plugin id
 * appears outside the plugin. Resolution reads **platform-level** enablement and
 * settings only — the work → user → admin cascade collapses to the admin tier,
 * because sign-in runs before any user or Work exists (constitution gate II,
 * declared deviation).
 *
 * ## The kill switch, and why it never dials out
 *
 * "Enabled" is an explicit administrator decision stored in the plugin's own
 * settings row (`enabled: true`). It is read straight from the `plugins` table —
 * the plugin is not even loaded to answer it — so an installation where nobody
 * turned Ever ID on makes **no** request to any identity provider, whatever
 * environment variables are set (program rule: switched off ⇒ zero outbound
 * calls). Configuration (issuer, client) alone never turns anything on.
 *
 * Every method that reaches the provider requires the plugin to be enabled and
 * configured, except the three that must keep working while it is off: the
 * administrator's connection test (so a configuration can be checked BEFORE it
 * is switched on, FR-3), back-channel logout verification (sign-out notices are
 * honoured while turned off, FR-5) and the read-only status / health views.
 */
@Injectable()
export class IdentityProviderFacadeService {
    private readonly logger = new Logger(IdentityProviderFacadeService.name);
    private readonly CAPABILITY = PLUGIN_CAPABILITIES.IDENTITY_PROVIDER;
    private stateCache: { at: number; value: IdentityProviderState } | null = null;

    /**
     * `PluginRepository` and `PluginSettingsService` are optional so the facade
     * resolves in every process that imports `FacadesModule` (as the other
     * facades do with only the global registry). Without the repository nothing
     * can be read, so Ever ID is "not enabled" — the fail-closed answer.
     */
    constructor(
        private readonly registry: PluginRegistryService,
        @Optional() private readonly pluginRepository?: PluginRepository,
        @Optional() private readonly settingsService?: PluginSettingsService,
    ) {}

    // ------------------------------------------------------------------
    // State — database only, no plugin load, no network
    // ------------------------------------------------------------------

    /**
     * Whether a plugin is registered, whether an administrator enabled it, and
     * whether the last connection test marked it unavailable. Cached for at most
     * {@link IDENTITY_PROVIDER_STATE_CACHE_MS}; `invalidate()` drops the cache on
     * the replica that changed it.
     */
    async getState(): Promise<IdentityProviderState> {
        const now = Date.now();
        if (this.stateCache && now - this.stateCache.at < IDENTITY_PROVIDER_STATE_CACHE_MS) {
            return this.stateCache.value;
        }
        const value = await this.readState();
        this.stateCache = { at: now, value };
        return value;
    }

    invalidate(): void {
        this.stateCache = null;
    }

    /** The API kill switch: a registered plugin an administrator turned on (FR-5). */
    async isEnabled(): Promise<boolean> {
        const state = await this.getState();
        return state.registered && state.enabled;
    }

    /**
     * Enabled, configured and not marked unavailable — what `everId.enabled` on
     * `GET /api/auth/providers` reports (FR-1, FR-6). Loads the plugin only when
     * it is enabled; never calls the provider.
     */
    async isAvailable(): Promise<boolean> {
        const state = await this.getState();
        if (!state.registered || !state.enabled || state.unavailableSince) return false;
        try {
            const plugin = await this.loadPlugin();
            await plugin.getPublicConfig();
            return true;
        } catch {
            return false;
        }
    }

    /**
     * The non-secret configuration (FR-2) — the display name, the issuer, the
     * local clients, the API audience and whether sign-up is offered. Requires the
     * plugin to be enabled; no network call.
     */
    async getPublicConfig(): ReturnType<IIdentityProviderPlugin['getPublicConfig']> {
        const plugin = await this.requireUsable();
        return this.call(() => plugin.getPublicConfig(), 'notConfigured');
    }

    /**
     * The display name to show next to the button, or the default — safe to call
     * whatever the state: answers the default without loading anything when the
     * plugin is not enabled.
     */
    async getDisplayName(): Promise<string> {
        if (!(await this.isEnabled())) return DEFAULT_DISPLAY_NAME;
        try {
            const plugin = await this.loadPlugin();
            const config = await plugin.getPublicConfig();
            return config.displayName || DEFAULT_DISPLAY_NAME;
        } catch {
            return DEFAULT_DISPLAY_NAME;
        }
    }

    // ------------------------------------------------------------------
    // Pass-throughs (plan §4.1) — enabled + configured required
    // ------------------------------------------------------------------

    async buildAuthorizationRequest(
        input: Parameters<IIdentityProviderPlugin['buildAuthorizationRequest']>[0],
    ): ReturnType<IIdentityProviderPlugin['buildAuthorizationRequest']> {
        const plugin = await this.requireUsable();
        return this.run(() => plugin.buildAuthorizationRequest(input));
    }

    async exchangeAuthorizationCode(
        input: Parameters<IIdentityProviderPlugin['exchangeAuthorizationCode']>[0],
    ): Promise<VerifiedIdTokenClaims> {
        const plugin = await this.requireUsable();
        return this.run(() => plugin.exchangeAuthorizationCode(input));
    }

    async verifyAccessToken(
        token: string,
        input: Parameters<IIdentityProviderPlugin['verifyAccessToken']>[1],
    ): Promise<VerifiedAccessTokenClaims> {
        const plugin = await this.requireUsable();
        return this.run(() => plugin.verifyAccessToken(token, input));
    }

    async buildEndSessionUrl(
        input: Parameters<IIdentityProviderPlugin['buildEndSessionUrl']>[0],
    ): Promise<string | null> {
        const plugin = await this.requireUsable();
        return this.run(() => plugin.buildEndSessionUrl(input));
    }

    /**
     * Verify a back-channel logout token (FR-33). Allowed while the plugin is
     * turned off (FR-5: sign-out notices keep working), but never while it is
     * unregistered or unconfigured.
     */
    async verifyLogoutToken(token: string): Promise<VerifiedLogoutTokenClaims> {
        const plugin = await this.requireLoaded();
        return this.run(() => plugin.verifyLogoutToken(token));
    }

    /**
     * FR-3's connection test. Allowed while turned off — an administrator tests a
     * configuration before switching it on. Persists the outcome: every required
     * check passing clears `unavailableSince`, any failing sets it (FR-14).
     */
    async testConnection(): Promise<IdentityProviderCheck[]> {
        const plugin = await this.requireLoaded();
        const checks = await this.run(() => plugin.testConnection());
        const passed = IDENTITY_PROVIDER_REQUIRED_CHECKS.every(
            (id) => checks.find((check) => check.id === id)?.ok === true,
        );
        const now = new Date().toISOString();
        await this.patchAvailability((current) => {
            const next: IdentityProviderAvailabilityRecord = { ...current };
            if (passed) {
                delete next.unavailableSince;
                next.discoveryRefreshedAt = now;
            } else if (!next.unavailableSince) {
                next.unavailableSince = now;
            }
            return next;
        });
        return checks;
    }

    // ------------------------------------------------------------------
    // Administration
    // ------------------------------------------------------------------

    /**
     * Turn sign-in with the provider on or off (the API kill switch, FR-5).
     * Writes the platform-owned `enabled` field of the plugin's settings row;
     * takes effect on this replica at once and on every other one within
     * {@link IDENTITY_PROVIDER_STATE_CACHE_MS}.
     */
    async setEnabled(enabled: boolean): Promise<void> {
        const entry = this.entry();
        if (!entry) throw new IdentityProviderUnavailableError('notRegistered');
        await this.patchSettings(entry.manifest.id, (settings) => ({
            ...settings,
            [ENABLED_KEY]: enabled,
        }));
        this.invalidate();
    }

    /**
     * Write administrator-managed, non-secret settings through the platform's
     * settings service (validated against the plugin's schema). Fields bound to
     * an environment variable — the issuer, the client, the audience — are
     * operator configuration and are refused by that service, so only fields such
     * as the local clients, the delegated client names, the account management
     * address and the display name can be changed here. Returns the field names
     * written (FR-4: an Activity row records names, never values).
     */
    async updateSettings(patch: Record<string, unknown>): Promise<string[]> {
        const entry = this.entry();
        if (!entry) throw new IdentityProviderUnavailableError('notRegistered');
        const fields = Object.keys(patch).filter(
            (key) => key !== ENABLED_KEY && key !== AVAILABILITY_KEY,
        );
        if (fields.length === 0) return [];
        if (!this.settingsService) throw new IdentityProviderUnavailableError('notRegistered');
        // `null` clears a stored value. It travels as `undefined`: the schema check
        // skips an undefined property, and the stored JSON drops the key, so the
        // setting falls back to its environment variable or default again.
        const allowed = Object.fromEntries(
            fields.map((key) => [key, patch[key] === null ? undefined : patch[key]]),
        );
        await this.settingsService.updateAdminSettings(entry.manifest.id, allowed);
        return fields;
    }

    /** Field provenance and the non-secret facts the administrator surface shows. */
    async getConfigurationStatus(): Promise<IdentityProviderConfigurationStatus> {
        const entry = this.entry();
        if (!entry || !this.settingsService)
            throw new IdentityProviderUnavailableError('notRegistered');
        const resolved = await this.settingsService.getResolvedSettings(entry.manifest.id);
        const schema = (entry.plugin.settingsSchema ?? {}) as {
            required?: string[];
            properties?: Record<string, { 'x-hidden'?: boolean }>;
        };
        const required = Array.isArray(schema.required) ? schema.required : [];
        const sources: Record<string, IdentityProviderSettingSource> = {};
        for (const key of Object.keys(schema.properties ?? {})) {
            if (key === ENABLED_KEY || key === AVAILABILITY_KEY) continue;
            const setting = resolved[key];
            const hasValue = isPresent(setting?.value);
            sources[key] = !hasValue
                ? 'unset'
                : setting?.source === 'admin'
                  ? 'admin'
                  : setting?.source === 'env'
                    ? 'env'
                    : 'default';
        }
        const missing = required.filter((key) => !isPresent(resolved[key]?.value));
        const value = (key: string): unknown => resolved[key]?.value;
        const names = Array.isArray(value('delegatedClientNames'))
            ? (value('delegatedClientNames') as Array<{
                  clientId?: unknown;
                  displayName?: unknown;
              }>)
            : [];
        // The resolution above is what the plugin's own context sees: for an
        // admin-only plugin the settings service never hands a stored secret back,
        // so `clientSecret` resolves from its environment variable or not at all.
        return {
            configured: missing.length === 0,
            missing,
            sources,
            issuer: typeof value('issuerUrl') === 'string' ? (value('issuerUrl') as string) : null,
            clientIdSet: isPresent(value('clientId')),
            clientSecretSet: isPresent(value('clientSecret')),
            displayName:
                typeof value('displayName') === 'string' && (value('displayName') as string).trim()
                    ? (value('displayName') as string)
                    : DEFAULT_DISPLAY_NAME,
            signUpAllowed: value('signUpAllowed') !== false,
            localClients: Array.isArray(value('localClients'))
                ? (value('localClients') as unknown[]).length
                : 0,
            localClientList: (Array.isArray(value('localClients'))
                ? (value('localClients') as Array<{ kind?: unknown; clientId?: unknown }>)
                : []
            )
                .filter(
                    (entry) =>
                        (entry?.kind === 'cli' || entry?.kind === 'node') &&
                        typeof entry.clientId === 'string' &&
                        entry.clientId.length > 0,
                )
                .map((entry) => ({
                    kind: entry.kind as 'cli' | 'node',
                    clientId: entry.clientId as string,
                })),
            accountManagementUrl:
                typeof value('accountManagementUrl') === 'string' &&
                /^https:\/\//.test(value('accountManagementUrl') as string)
                    ? (value('accountManagementUrl') as string)
                    : null,
            delegatedClientNames: names
                .filter((entry) => typeof entry?.clientId === 'string' && entry.clientId)
                .map((entry) => ({
                    clientId: entry.clientId as string,
                    displayName:
                        typeof entry.displayName === 'string' && entry.displayName.trim()
                            ? entry.displayName
                            : (entry.clientId as string),
                })),
        };
    }

    /**
     * The three timestamps of spec §6.7's Health block: the latest of what this
     * process saw and what any replica persisted. No network call.
     */
    async getHealth(): Promise<IdentityProviderHealth> {
        const persisted = await this.readAvailability();
        let local: { discoveryRefreshedAt?: string | null; jwksRefreshedAt?: string | null } = {};
        const entry = this.entry();
        if (entry && this.isLoadedAlready(entry)) {
            const plugin = entry.plugin as unknown as {
                getAvailability?: () => {
                    discoveryRefreshedAt?: string | null;
                    jwksRefreshedAt?: string | null;
                };
            };
            try {
                local =
                    typeof plugin.getAvailability === 'function'
                        ? (plugin.getAvailability() ?? {})
                        : {};
            } catch {
                local = {};
            }
        }
        return {
            discoveryRefreshedAt: latest(
                persisted.discoveryRefreshedAt,
                local.discoveryRefreshedAt,
            ),
            jwksRefreshedAt: latest(persisted.jwksRefreshedAt, local.jwksRefreshedAt),
            lastLogoutNoticeAt: persisted.lastLogoutNoticeAt ?? null,
        };
    }

    /** Persist "a valid sign-out notice was just accepted" (Health, FR-33). Best-effort. */
    async recordLogoutNotice(at: Date = new Date()): Promise<void> {
        try {
            await this.patchAvailability((current) => ({
                ...current,
                lastLogoutNoticeAt: at.toISOString(),
            }));
        } catch (error) {
            this.logger.warn(
                `Could not persist the sign-out notice timestamp: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    /** The identity-provider registry entry, or `undefined` when none is registered. */
    private entry(): RegisteredPlugin | undefined {
        return this.registry
            .getByCapability(this.CAPABILITY)
            .filter((entry) => entry.state !== 'error')
            .sort((a, b) => a.manifest.id.localeCompare(b.manifest.id))[0];
    }

    private async readState(): Promise<IdentityProviderState> {
        const entry = this.entry();
        if (!entry) return { registered: false, enabled: false, unavailableSince: null };
        if (!this.pluginRepository)
            return { registered: true, enabled: false, unavailableSince: null };
        let settings: Record<string, unknown> = {};
        try {
            const row = await this.pluginRepository.findByPluginId(entry.manifest.id);
            settings = (row?.settings as Record<string, unknown> | undefined) ?? {};
        } catch (error) {
            // Fail closed: a database that cannot answer means "not enabled".
            this.logger.warn(
                `Could not read the identity provider's state: ${error instanceof Error ? error.message : String(error)}`,
            );
            return { registered: true, enabled: false, unavailableSince: null };
        }
        const availability = (settings[AVAILABILITY_KEY] ??
            {}) as IdentityProviderAvailabilityRecord;
        return {
            registered: true,
            // Only a strict `true` counts — a string, a number or a missing key is off.
            enabled: settings[ENABLED_KEY] === true,
            unavailableSince:
                typeof availability.unavailableSince === 'string'
                    ? availability.unavailableSince
                    : null,
        };
    }

    /** The loaded plugin when enabled, configured and available; throws otherwise. */
    private async requireUsable(): Promise<IIdentityProviderPlugin> {
        const state = await this.getState();
        if (!state.registered) throw new IdentityProviderUnavailableError('notRegistered');
        if (!state.enabled) throw new IdentityProviderUnavailableError('disabled');
        if (state.unavailableSince) throw new IdentityProviderUnavailableError('unavailable');
        return this.requireLoaded();
    }

    /** The loaded plugin whatever its enablement (connection test, sign-out notices). */
    private async requireLoaded(): Promise<IIdentityProviderPlugin> {
        if (!this.entry()) throw new IdentityProviderUnavailableError('notRegistered');
        return this.loadPlugin();
    }

    private async loadPlugin(): Promise<IIdentityProviderPlugin> {
        const entry = this.entry();
        if (!entry) throw new IdentityProviderUnavailableError('notRegistered');
        let instance: unknown;
        try {
            instance = await materializePlugin(entry.plugin);
        } catch {
            throw new IdentityProviderUnavailableError('loadFailed');
        }
        if (pluginLoadFailure(entry, entry.manifest.id)) {
            throw new IdentityProviderUnavailableError('loadFailed');
        }
        const plugin = (instance ?? entry.plugin) as IIdentityProviderPlugin;
        if (!isIdentityProviderPlugin(plugin)) {
            throw new IdentityProviderUnavailableError('loadFailed');
        }
        return plugin;
    }

    /** Whether the plugin is imported already — reading it then loads nothing. */
    private isLoadedAlready(entry: RegisteredPlugin): boolean {
        const lazy = entry.plugin as unknown as { __isMaterialized?: boolean };
        return lazy.__isMaterialized !== false;
    }

    private async call<T>(
        fn: () => Promise<T>,
        reason: IdentityProviderUnavailableReason,
    ): Promise<T> {
        try {
            return await fn();
        } catch {
            throw new IdentityProviderUnavailableError(reason);
        }
    }

    /** Run a plugin call and hand its error back in the platform's own types. */
    private async run<T>(fn: () => Promise<T>): Promise<T> {
        try {
            return await fn();
        } catch (error) {
            throw normalizeIdentityProviderError(error);
        }
    }

    private async readAvailability(): Promise<IdentityProviderAvailabilityRecord> {
        const entry = this.entry();
        if (!entry || !this.pluginRepository) return {};
        try {
            const row = await this.pluginRepository.findByPluginId(entry.manifest.id);
            const settings = (row?.settings as Record<string, unknown> | undefined) ?? {};
            const record = settings[AVAILABILITY_KEY];
            return record && typeof record === 'object'
                ? (record as IdentityProviderAvailabilityRecord)
                : {};
        } catch {
            return {};
        }
    }

    private async patchAvailability(
        update: (current: IdentityProviderAvailabilityRecord) => IdentityProviderAvailabilityRecord,
    ): Promise<void> {
        const entry = this.entry();
        if (!entry) return;
        await this.patchSettings(entry.manifest.id, (settings) => {
            const current = (settings[AVAILABILITY_KEY] ??
                {}) as IdentityProviderAvailabilityRecord;
            return { ...settings, [AVAILABILITY_KEY]: update({ ...current }) };
        });
        this.invalidate();
    }

    /**
     * Read-modify-write of the plugin's admin settings JSON for the two
     * platform-owned keys (`enabled`, `availability`). Written straight to the
     * row: these are platform state about the plugin, not an operator's settings
     * change, so they bypass the settings validator and its change events. The
     * encrypted secret column is left exactly as it is.
     */
    private async patchSettings(
        pluginId: string,
        update: (settings: Record<string, unknown>) => Record<string, unknown>,
    ): Promise<void> {
        if (!this.pluginRepository) throw new IdentityProviderUnavailableError('notRegistered');
        const row = await this.pluginRepository.findByPluginId(pluginId);
        if (!row) {
            throw new IdentityProviderUnavailableError('notRegistered');
        }
        const settings = (row.settings as Record<string, unknown> | undefined) ?? {};
        await this.pluginRepository.updateSettings(pluginId, update({ ...settings }));
    }
}

/**
 * Hand a plugin's error back in the platform's own types.
 *
 * A plugin package may bundle its own copy of `@ever-works/plugin` (the
 * `oidc-identity` plugin does), so its `IdentityTokenRejectedError` is not the
 * class the platform imports and `instanceof` cannot be trusted across that
 * boundary. A token refusal is therefore recognised by its name and its closed
 * code, and re-thrown as the platform's own class; the plugin's "cannot start"
 * errors carry a closed `reason` and become {@link IdentityProviderUnavailableError}
 * (`notConfigured`, or `unavailable` for anything else). No message text from the
 * plugin or the provider is carried over (FR-16).
 */
export function normalizeIdentityProviderError(error: unknown): Error {
    if (error instanceof IdentityTokenRejectedError) return error;
    if (error instanceof IdentityProviderUnavailableError) return error;
    if (isTokenRejection(error)) return new IdentityTokenRejectedError(error.code);
    const reason = (error as { reason?: unknown } | null)?.reason;
    return new IdentityProviderUnavailableError(
        reason === 'notConfigured' ? 'notConfigured' : 'unavailable',
    );
}

function isTokenRejection(
    error: unknown,
): error is { name: string; code: IdentityTokenRejectionCode } {
    if (!error || typeof error !== 'object') return false;
    const candidate = error as { name?: unknown; code?: unknown };
    return (
        candidate.name === 'IdentityTokenRejectedError' &&
        typeof candidate.code === 'string' &&
        (IDENTITY_TOKEN_REJECTION_CODES as readonly string[]).includes(candidate.code)
    );
}

function isPresent(value: unknown): boolean {
    if (value === undefined || value === null) return false;
    if (typeof value === 'string') return value.trim().length > 0;
    return true;
}

function latest(a?: string | null, b?: string | null): string | null {
    const ta = a ? Date.parse(a) : Number.NaN;
    const tb = b ? Date.parse(b) : Number.NaN;
    if (!Number.isFinite(ta) && !Number.isFinite(tb)) return null;
    if (!Number.isFinite(ta)) return b ?? null;
    if (!Number.isFinite(tb)) return a ?? null;
    return ta >= tb ? (a ?? null) : (b ?? null);
}
