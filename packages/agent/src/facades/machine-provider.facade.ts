import { Injectable, Logger, Optional } from '@nestjs/common';
import type {
    IMachineProviderPlugin,
    MachineProviderCreateInput,
    MachineProviderCreateResult,
    MachineProviderMachine,
    MachineProviderOptions,
    MachineProviderUsage,
} from '@ever-works/plugin';
import {
    isMachineProviderError,
    PLUGIN_CAPABILITIES,
    type PluginSettings,
} from '@ever-works/plugin';
import { AuthAccountRepository } from '../database/repositories/auth-account.repository';
import { materializePlugin } from '../plugins/services/plugin-operation.util';
import { PluginRegistryService } from '../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../plugins/services/plugin-settings.service';
import { BaseFacadeService, FacadeError } from './base.facade';

export class MachineProviderFacadeError extends FacadeError {
    constructor(message: string, operation: string, provider?: string, cause?: Error) {
        super(message, operation, provider, cause);
        this.name = 'MachineProviderFacadeError';
    }
}

/** One provider the owner may create cloud computers with (the dialog's picker). */
export interface MachineProviderSummary {
    pluginId: string;
    name: string;
    providerName: string;
    /** The provider's own check that a token (or a sign-in) is saved. */
    configured: boolean;
    /** True when the plugin advertises `oauth` (P3 — the operator registered an application). */
    oauthAvailable: boolean;
}

/**
 * Cloud computers (FL-17, CONTRACTS R-15, plan §7) — the ONE way core code
 * reaches a machine provider. Resolves `machine-provider` plugins by
 * capability and by the owner's scope (the plugin must be enabled for them),
 * reads their settings through the 4-level hierarchy — the provider token is
 * an `x-secret` user-scope setting and goes to the plugin only — and never
 * names a provider (Constitution I/II; the guard spec greps for it).
 *
 * Every call is on behalf of ONE owner (`userId`): the owner of the cloud
 * computer for a sweep, the caller for a create. Multiple providers may be
 * enabled at once, so every method takes the explicit `pluginId` the Node
 * carries (or the dialog chose).
 *
 * A provider's typed refusal (`MachineProviderError`) passes through
 * untouched so the service can quote its first line (spec U2); anything else
 * is wrapped in {@link MachineProviderFacadeError}. Cloud spend is NOT
 * recorded as plugin usage: it is the provider's bill on the owner's account,
 * not platform spend, and must never reach model-spend Budgets (spec FR-24).
 */
@Injectable()
export class MachineProviderFacadeService extends BaseFacadeService {
    protected readonly logger = new Logger(MachineProviderFacadeService.name);
    protected readonly CAPABILITY = PLUGIN_CAPABILITIES.MACHINE_PROVIDER;

    constructor(
        registry: PluginRegistryService,
        settingsService: PluginSettingsService,
        // P3 (spec FR-31): the owner's completed "Sign in with <provider>" (the
        // `plugin:<id>` account row). Appended LAST + @Optional(): absent, only a
        // saved API token configures a provider — today's behaviour.
        @Optional() private readonly authAccounts?: AuthAccountRepository,
    ) {
        super(registry, settingsService);
    }

    /**
     * The settings one call runs with: the 4-level resolved plugin settings,
     * plus — when the owner signed in with the provider and that sign-in has not
     * expired — its access token as `oauthAccessToken` (P3, spec FR-31). The
     * plugin prefers a saved `apiToken`. Never logged.
     */
    private async callSettings(pluginId: string, userId: string): Promise<PluginSettings> {
        const settings = ((await this.getResolvedSettings(pluginId, { userId })) ??
            {}) as PluginSettings;
        if (!this.authAccounts || !userId) return settings;
        try {
            const account = await this.authAccounts.findConnectedProviderAccount(userId, pluginId, {
                usePluginProviderId: true,
            });
            const token = account?.accessToken;
            if (typeof token === 'string' && token.length > 0)
                return { ...settings, oauthAccessToken: token };
        } catch (error) {
            this.logger.debug(
                `machine provider ${pluginId}: the sign-in could not be read: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
        return settings;
    }

    /** Whether the LIVE plugin advertises `oauth` (its env-gated getter), not the cold manifest list. */
    private async liveOAuth(plugin: unknown): Promise<boolean> {
        try {
            const live = (await materializePlugin(plugin)) as { capabilities?: readonly string[] };
            return (live.capabilities ?? []).includes(PLUGIN_CAPABILITIES.OAUTH);
        } catch {
            return false;
        }
    }

    /** Every machine provider enabled for the owner, with whether it is configured (spec FR-2). */
    async listProviders(userId: string): Promise<MachineProviderSummary[]> {
        const enabled = await this.getEnabledPlugins(undefined as unknown as string, userId);
        const out: MachineProviderSummary[] = [];
        for (const registered of enabled) {
            const plugin = registered.plugin as IMachineProviderPlugin;
            let configured = false;
            try {
                const settings = await this.callSettings(plugin.id, userId);
                configured =
                    typeof plugin.isConfigured === 'function'
                        ? plugin.isConfigured(settings)
                        : false;
            } catch (error) {
                this.logger.debug(
                    `machine provider ${plugin.id}: settings could not be read: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
            out.push({
                pluginId: plugin.id,
                name: registered.manifest.name ?? plugin.id,
                providerName: this.providerNameOf(plugin),
                configured,
                // P3: the live instance's env-gated capability — the manifest lists `oauth`
                // for the registry's index even where the operator registered no application.
                oauthAvailable: await this.liveOAuth(registered.plugin),
            });
        }
        return out.sort((a, b) => a.name.localeCompare(b.name));
    }

    /** The provider's display name for a plugin id the owner can use, or null when it is not usable. */
    async providerName(pluginId: string, userId: string): Promise<string | null> {
        try {
            return this.providerNameOf(await this.resolveProvider(pluginId, userId));
        } catch {
            return null;
        }
    }

    async listOptions(pluginId: string, userId: string): Promise<MachineProviderOptions> {
        const plugin = await this.resolveProvider(pluginId, userId);
        const settings = await this.callSettings(plugin.id, userId);
        try {
            return await plugin.listOptions(settings);
        } catch (error) {
            throw this.toFacadeError(error, 'listOptions', plugin.id);
        }
    }

    async create(
        pluginId: string,
        userId: string,
        input: MachineProviderCreateInput,
    ): Promise<MachineProviderCreateResult> {
        const plugin = await this.resolveProvider(pluginId, userId);
        const settings = await this.callSettings(plugin.id, userId);
        try {
            return await plugin.create(input, settings);
        } catch (error) {
            throw this.toFacadeError(error, 'create', plugin.id);
        }
    }

    async power(
        pluginId: string,
        userId: string,
        machineRef: string,
        action: 'on' | 'off',
    ): Promise<void> {
        const plugin = await this.resolveProvider(pluginId, userId);
        const settings = await this.callSettings(plugin.id, userId);
        try {
            await plugin.power(machineRef, action, settings);
        } catch (error) {
            throw this.toFacadeError(error, 'power', plugin.id);
        }
    }

    async destroy(pluginId: string, userId: string, machineRef: string): Promise<void> {
        const plugin = await this.resolveProvider(pluginId, userId);
        const settings = await this.callSettings(plugin.id, userId);
        try {
            await plugin.destroy(machineRef, settings);
        } catch (error) {
            throw this.toFacadeError(error, 'destroy', plugin.id);
        }
    }

    async getMachine(
        pluginId: string,
        userId: string,
        machineRef: string,
    ): Promise<MachineProviderMachine> {
        const plugin = await this.resolveProvider(pluginId, userId);
        const settings = await this.callSettings(plugin.id, userId);
        try {
            return await plugin.getMachine(machineRef, settings);
        } catch (error) {
            throw this.toFacadeError(error, 'getMachine', plugin.id);
        }
    }

    async listTagged(
        pluginId: string,
        userId: string,
        tag: string,
    ): Promise<MachineProviderMachine[]> {
        const plugin = await this.resolveProvider(pluginId, userId);
        const settings = await this.callSettings(plugin.id, userId);
        try {
            return await plugin.listTagged(tag, settings);
        } catch (error) {
            throw this.toFacadeError(error, 'listTagged', plugin.id);
        }
    }

    /** The provider's own month-to-date figure, or null when the plugin cannot read one (P2). */
    async usage(
        pluginId: string,
        userId: string,
        machineRefs: readonly string[],
    ): Promise<MachineProviderUsage | null> {
        const plugin = await this.resolveProvider(pluginId, userId);
        if (typeof plugin.usage !== 'function') return null;
        const settings = await this.callSettings(plugin.id, userId);
        try {
            return await plugin.usage(machineRefs, settings);
        } catch (error) {
            throw this.toFacadeError(error, 'usage', plugin.id);
        }
    }

    private async resolveProvider(
        pluginId: string,
        userId: string,
    ): Promise<IMachineProviderPlugin> {
        // An explicit pluginId behaves like a provider override: it must be a
        // loaded `machine-provider` plugin enabled for the owner, else
        // ProviderNotFoundError (the service turns that into "the plugin is
        // disabled — enable it to power or destroy this computer", spec U5).
        return this.resolvePlugin<IMachineProviderPlugin>(pluginId, userId, undefined);
    }

    private providerNameOf(plugin: IMachineProviderPlugin): string {
        const name = (plugin as { providerName?: unknown }).providerName;
        return typeof name === 'string' && name.trim() ? name.trim() : this.getProviderName(plugin);
    }

    /** A provider's typed refusal passes through (its hint is quoted); anything else is wrapped. */
    private toFacadeError(error: unknown, operation: string, pluginId: string): Error {
        if (error instanceof FacadeError || isMachineProviderError(error)) return error as Error;
        const cause = error instanceof Error ? error : new Error(String(error));
        return new MachineProviderFacadeError(
            `Machine provider '${pluginId}' failed during ${operation}: ${cause.message}`,
            operation,
            pluginId,
            cause,
        );
    }
}
