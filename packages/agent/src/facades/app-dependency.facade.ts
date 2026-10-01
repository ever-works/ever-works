/**
 * APW-07 T16 — `AppDependencyFacadeService`, the ONE place an App dependency
 * provider is chosen and called (plan §4.8:541-546, §4.7:536-539).
 *
 * Spec: `docs/specs/features/app-works/APW-07-app-env-and-dependencies/spec.md`
 * FR-35 (one card, one provider chosen for the App Work's deploy target),
 * FR-36 (the default provider per kind), FR-39/FR-61 (the relay is offered only
 * when the operator configured one) and FR-62 (a provider that needs the
 * owner's settings). Plan: §4.7 is the provider contract, §4.8 is this
 * selection rule, §4.9a is `awaitingConfig`.
 *
 * ## Selection, in the order the plan fixes
 *
 * 1. Collect the **enabled** plugins declaring the `app-dependency` capability
 *    (`registry.getEnabledPluginsScoped` — the same enable check every facade
 *    uses, so a plugin the owner turned off is never offered).
 * 2. Keep those declaring a descriptor for the asked `kind` whose `targets`
 *    include the App Work's target.
 * 3. The owner's **explicit choice wins** when that provider supports the pair
 *    (plan §4.8:543-544) — and only then; a `providerId` nobody offers is
 *    `providerNotSupported`, never a silent fallback to a different provider
 *    that would provision something the owner did not ask for.
 * 4. Otherwise ask `supports(kind, target, ctx)` in **ascending `preference`**
 *    and take the first that answers yes.
 *
 * ## No provider id is written in this file
 *
 * Every provider id here comes from a plugin's own `dependencyProviders`
 * descriptors, so the facade cannot prefer, special-case or even name one
 * vendor's implementation (`app-dependencies.service.spec.ts` greps this file
 * for `APP_DEPENDENCY_PROVIDER_IDS`). The relative order the plan fixes lives
 * in each plugin's `preference`, which is where a plugin author can see it.
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import type {
    AppDependencyAvailableProvider,
    AppDependencyBackupPolicy,
    AppDependencyBackupStatus,
    AppDependencyDeprovisionOptions,
    AppDependencyDeprovisionOutcome,
    AppDependencyKind,
    AppDependencyPromptField,
    AppDependencyProvisionOutcome,
    AppDependencyProviderRef,
    AppDependencyTarget,
} from '@ever-works/contracts';
import {
    isAppDependencyProvider,
    PLUGIN_CAPABILITIES,
    type AppDependencyContext,
    type AppDependencyProviderDescriptor,
    type IAppDependencyProvider,
} from '@ever-works/plugin';
import {
    PluginRegistryService,
    loadRegisteredPlugins,
} from '../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../plugins/services/plugin-settings.service';
import { WorkPluginRepository } from '../plugins/repositories/work-plugin.repository';
import { FacadeError, BaseFacadeService } from './base.facade';

/** The `app-dependency` capability's own error family — mapped by name at the API boundary. */
export class AppDependencyFacadeError extends FacadeError {
    constructor(message: string, operation: string, provider?: string, cause?: Error) {
        super(message, operation, provider, cause);
        this.name = 'AppDependencyFacadeError';
    }
}

/** No enabled plugin declares the capability at all. */
export class NoAppDependencyProviderError extends AppDependencyFacadeError {
    constructor() {
        super('No App dependency provider is installed and enabled', 'getPlugin');
        this.name = 'NoAppDependencyProviderError';
    }
}

/** A named provider (plugin or provider id) that this installation does not offer for this kind. */
export class AppDependencyProviderNotFoundError extends AppDependencyFacadeError {
    constructor(providerId: string) {
        super(`App dependency provider not found: ${providerId}`, 'getPlugin', providerId);
        this.name = 'AppDependencyProviderNotFoundError';
    }
}

/**
 * Who serves one dependency, as everything downstream needs it.
 *
 * The pair `(providerPluginId, providerId)` is exactly what
 * `work_app_dependencies` stores (`providerPluginId`, `providerId`, plan
 * §3.2:209) — one plugin may serve several provider ids, so both halves are
 * required to resolve the implementation again on a later call.
 */
export interface AppDependencySelection {
    readonly providerPluginId: string;
    readonly providerId: string;
    readonly label: string;
    readonly backupPolicy: AppDependencyBackupPolicy;
    /**
     * True when this provider needs something only the owner can supply
     * (plan §4.9a:641): `reconcile` writes `awaiting_config`, dispatches
     * nothing and starts no deadline.
     */
    readonly awaitingConfig: boolean;
    readonly descriptor: AppDependencyProviderDescriptor;
}

/** `select`'s answer: the selection, or the reason nothing supported the pair. */
export type AppDependencySelectionResult =
    | ({ readonly supported: true } & AppDependencySelection)
    | { readonly supported: false; readonly reason: string };

/** Options every selection and settings read carries. */
export interface AppDependencyFacadeOptions {
    readonly workId?: string;
    readonly userId?: string;
}

/** A provider resolved back to its implementation — what a worker call needs. */
export interface ResolvedAppDependencyProvider {
    readonly plugin: IAppDependencyProvider;
    readonly descriptor: AppDependencyProviderDescriptor;
    readonly selection: AppDependencySelection;
}

@Injectable()
export class AppDependencyFacadeService extends BaseFacadeService {
    protected readonly CAPABILITY = PLUGIN_CAPABILITIES.APP_DEPENDENCY;
    protected readonly logger = new Logger(AppDependencyFacadeService.name);

    constructor(
        registry: PluginRegistryService,
        @Optional() settingsService?: PluginSettingsService,
        @Optional() workPluginRepository?: WorkPluginRepository,
    ) {
        super(registry, settingsService, workPluginRepository);
    }

    /* ---------------------------------------------------------------------- *
     * Discovery
     * ---------------------------------------------------------------------- */

    /**
     * Every enabled plugin that serves at least one provider for this
     * (kind, target), with the descriptors it declares for it.
     *
     * Ordered by `preference` ascending, then by provider id so two identical
     * calls answer identically — a selection that depends on registry
     * insertion order would be a selection that changes when a plugin is
     * installed.
     */
    async providersFor(
        kind: AppDependencyKind,
        target: AppDependencyTarget,
        opts: AppDependencyFacadeOptions = {},
    ): Promise<
        Array<{ plugin: IAppDependencyProvider; descriptor: AppDependencyProviderDescriptor }>
    > {
        const plugins = await this.enabledProviders(opts);
        const found: Array<{
            plugin: IAppDependencyProvider;
            descriptor: AppDependencyProviderDescriptor;
        }> = [];

        for (const plugin of plugins) {
            for (const descriptor of plugin.dependencyProviders ?? []) {
                if (descriptor?.kind !== kind) continue;
                if (!(descriptor.targets ?? []).includes(target)) continue;
                found.push({ plugin, descriptor });
            }
        }

        found.sort((a, b) => {
            const byPreference =
                descriptorPreference(a.descriptor) - descriptorPreference(b.descriptor);
            if (byPreference !== 0) return byPreference;
            return a.descriptor.id.localeCompare(b.descriptor.id);
        });

        return found;
    }

    /**
     * The enabled `app-dependency` plugins, materialised through the registry's
     * own scope check — `autoEnable`/`builtIn` decide for an installation
     * nobody has explicitly toggled (that is why an unset plugin choice is not
     * the same thing as a disabled plugin).
     */
    async enabledProviders(
        opts: AppDependencyFacadeOptions = {},
    ): Promise<IAppDependencyProvider[]> {
        const registered = await this.registry.getEnabledPluginsScoped(
            this.CAPABILITY,
            opts.workId,
            opts.userId,
        );

        return registered
            .filter((entry) => entry.state === 'loaded')
            .map((entry) => entry.plugin)
            .filter(isAppDependencyProvider);
    }

    /**
     * The providers the Dependencies card may offer for a (kind, target), as
     * `AppDependencyView.availableProviders` (plan §5:793).
     *
     * `configSet` names the prompt-schema keys the row already has a stored
     * value for, because a secret is never read back: the card renders
     * `promptFields[].set` instead of a value (FR-5).
     */
    async availableProviders(
        kind: AppDependencyKind,
        target: AppDependencyTarget,
        opts: AppDependencyFacadeOptions & { readonly configSet?: readonly string[] } = {},
    ): Promise<AppDependencyAvailableProvider[]> {
        const providers = await this.providersFor(kind, target, opts);
        const set = new Set(opts.configSet ?? []);

        return providers.map(({ descriptor }) => ({
            providerId: descriptor.id,
            label: descriptor.label,
            promptFields: promptFieldsOf(descriptor, set),
        }));
    }

    /**
     * Choose the provider for one (kind, target, ctx).
     *
     * The explicit `providerId` is honoured only when the provider both offers
     * the pair AND answers `supports` — "the owner's explicit choice wins if
     * supported" (plan §4.8:543-544). When it does not, the answer is a refusal
     * naming `providerNotSupported`: falling back to another provider would
     * provision a dependency with an implementation the owner did not choose.
     */
    async select(
        kind: AppDependencyKind,
        target: AppDependencyTarget,
        ctx: AppDependencyContext,
        opts: AppDependencyFacadeOptions & { readonly providerId?: string } = {},
    ): Promise<AppDependencySelectionResult> {
        const providers = await this.providersFor(kind, target, opts);

        if (opts.providerId) {
            const chosen = providers.find((entry) => entry.descriptor.id === opts.providerId);
            if (!chosen) {
                return { supported: false, reason: 'providerNotSupported' };
            }
            return this.confirm(chosen, kind, target, ctx);
        }

        for (const candidate of providers) {
            const answer = await this.confirm(candidate, kind, target, ctx);
            if (answer.supported) return answer;
        }

        return { supported: false, reason: 'providerNotSupported' };
    }

    /**
     * Resolve a stored `(providerPluginId, providerId)` pair back to its
     * implementation, without any enable check: the row already records a
     * provider that was chosen while the plugin was enabled, and a refresh or a
     * deprovision must still be able to reach it. `null` means the plugin or
     * the descriptor is gone — the caller reports that, and never provisions a
     * replacement under the same row.
     *
     * A plugin still `loaded` is LOADED first (waiting for a first load in
     * flight): `isAppDependencyProvider` and the descriptor lookup read the
     * class's `dependencyProviders` and methods, which a cold lazy proxy
     * answers as forwarding wrappers — so a builtIn such as k8s, cold in a
     * fresh API or worker process, resolved to `null` though it was there.
     * The entry's own plugin (the proxy) is still what is returned, so a call
     * after a failed first load is refused by the proxy as before.
     */
    async resolve(
        providerPluginId: string,
        providerId: string,
        kind?: AppDependencyKind,
    ): Promise<ResolvedAppDependencyProvider | null> {
        const registered = this.registry.get(providerPluginId);
        if (registered?.state === 'loaded') {
            await loadRegisteredPlugins([registered]);
        }
        const plugin = registered?.plugin;
        if (!plugin || !isAppDependencyProvider(plugin)) return null;

        const descriptor = (plugin.dependencyProviders ?? []).find(
            (entry) => entry.id === providerId && (kind === undefined || entry.kind === kind),
        );
        if (!descriptor) return null;

        return {
            plugin,
            descriptor,
            selection: {
                providerPluginId: plugin.id,
                providerId: descriptor.id,
                label: descriptor.label,
                backupPolicy: descriptor.backupPolicy,
                awaitingConfig: descriptor.awaitingConfig === true,
                descriptor,
            },
        };
    }

    /* ---------------------------------------------------------------------- *
     * Delegation — the five provider operations the job calls
     * ---------------------------------------------------------------------- */

    async provision(
        selection: AppDependencySelection,
        ctx: AppDependencyContext,
    ): Promise<AppDependencyProvisionOutcome> {
        return (await this.require(selection)).provision(selection.providerId, ctx);
    }

    async getOutputs(
        selection: AppDependencySelection,
        ctx: AppDependencyContext,
    ): Promise<Record<string, string>> {
        return (await this.require(selection)).getOutputs(selection.providerId, ctx);
    }

    async deprovision(
        selection: AppDependencySelection,
        ctx: AppDependencyContext,
        opts: AppDependencyDeprovisionOptions,
    ): Promise<AppDependencyDeprovisionOutcome> {
        return (await this.require(selection)).deprovision(selection.providerId, ctx, opts);
    }

    async backupStatus(
        selection: AppDependencySelection,
        ctx: AppDependencyContext,
    ): Promise<AppDependencyBackupStatus> {
        return (await this.require(selection)).backupStatus(selection.providerId, ctx);
    }

    /* ---------------------------------------------------------------------- *
     * Settings
     * ---------------------------------------------------------------------- */

    /**
     * The plugin's resolved settings at the four-level hierarchy
     * (Work → User → Admin → defaults): `appDependencyStorageClass`,
     * `appDependencySizes` and the admin image overrides of plan §4.9:630-633.
     *
     * A facade with no settings service answers `{}` rather than throwing —
     * that is `BaseFacadeService.getResolvedSettings`'s own contract, and a
     * provider that needs a setting reports its absence itself.
     */
    async settingsFor(
        pluginId: string,
        opts: AppDependencyFacadeOptions = {},
    ): Promise<Record<string, unknown>> {
        return this.getResolvedSettings(pluginId, { userId: opts.userId, workId: opts.workId });
    }

    /* ---------------------------------------------------------------------- *
     * Internals
     * ---------------------------------------------------------------------- */

    /** Ask one candidate whether it serves this pair, and shape the answer as a selection. */
    private async confirm(
        candidate: { plugin: IAppDependencyProvider; descriptor: AppDependencyProviderDescriptor },
        kind: AppDependencyKind,
        target: AppDependencyTarget,
        ctx: AppDependencyContext,
    ): Promise<AppDependencySelectionResult> {
        const answer = (await candidate.plugin.supports(kind, target, ctx)) as
            | { supported: true; providerId?: string }
            | { supported: false; reason?: string }
            | undefined;
        if (answer?.supported !== true) {
            return {
                supported: false,
                reason:
                    (answer as { reason?: string } | undefined)?.reason ?? 'providerNotSupported',
            };
        }

        return {
            supported: true,
            providerPluginId: candidate.plugin.id,
            providerId: candidate.descriptor.id,
            label: candidate.descriptor.label,
            backupPolicy: candidate.descriptor.backupPolicy,
            awaitingConfig: candidate.descriptor.awaitingConfig === true,
            descriptor: candidate.descriptor,
        };
    }

    /** Materialise the implementation of a selection, or refuse loudly. */
    private async require(selection: AppDependencySelection): Promise<IAppDependencyProvider> {
        const resolved = await this.resolve(selection.providerPluginId, selection.providerId);
        if (!resolved) {
            throw new AppDependencyProviderNotFoundError(selection.providerId);
        }
        return resolved.plugin;
    }
}

/** `preference` is required by the contract; a descriptor missing it sorts last, never first. */
function descriptorPreference(descriptor: AppDependencyProviderDescriptor): number {
    const value = descriptor?.preference;
    return typeof value === 'number' && Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

/**
 * The card's prompt fields, from the provider's `promptSchema` (plan §5:793).
 *
 * A `x-secret` property is marked secret and its `set` flag is the only thing
 * the card learns about a stored value (FR-5). `required` comes from the
 * schema's own `required` list, so the dialog and the write path agree on what
 * a complete configuration is.
 */
/** The only part of a provider's prompt schema the card reads (plan §5:793). */
interface PromptSchemaShape {
    properties?: Record<
        string,
        { 'x-secret'?: boolean; title?: string; description?: string } | undefined
    >;
    required?: readonly string[];
}

function promptFieldsOf(
    descriptor: AppDependencyProviderDescriptor,
    set: ReadonlySet<string>,
): AppDependencyPromptField[] {
    const schema = (descriptor.promptSchema ?? undefined) as PromptSchemaShape | undefined;
    const properties = schema?.properties ?? {};
    const required = new Set(schema?.required ?? []);

    return Object.keys(properties).map((key) => {
        const property = properties[key] ?? {};
        return {
            key,
            label: property.title ?? property.description ?? key,
            secret: property['x-secret'] === true,
            required: required.has(key),
            set: set.has(key),
        };
    });
}

/** Re-exported so a consumer can talk about "who serves this" without a second shape. */
export type { AppDependencyProviderRef };
