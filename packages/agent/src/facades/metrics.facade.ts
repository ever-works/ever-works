import { Injectable, Logger, Optional } from '@nestjs/common';
import type {
    FacadeOptions,
    IMetricsProviderPlugin,
    MetricDescriptor,
    MetricQuery,
    MetricSample,
} from '@ever-works/plugin';
import { PLUGIN_CAPABILITIES } from '@ever-works/plugin';
import { PluginRegistryService } from '../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../plugins/services/plugin-settings.service';
import { WorkPluginRepository } from '../plugins/repositories/work-plugin.repository';
import { PluginUsageService } from '../usage/plugin-usage.service';
import { BudgetGuardService } from '../budgets/budget-guard.service';
import { PluginUsageCapability } from '@src/entities/plugin-usage-event.entity';
import { BaseFacadeService, FacadeError } from './base.facade';

export class MetricsFacadeError extends FacadeError {
    constructor(message: string, operation: string, provider?: string, cause?: Error) {
        super(message, operation, provider, cause);
        this.name = 'MetricsFacadeError';
    }
}

/**
 * Goals feature — PR-7 (metrics-provider capability).
 *
 * Routes read-only metric reads through enabled `metrics-provider`
 * plugins (custom-http, Stripe; PostHog + Google Analytics in PR-9).
 * From PR-8 on, Goal evaluation consumes this facade to check targets
 * like "$100/day balance" or "$1000/month income".
 *
 * Unlike TasksFacadeService (single active provider per scope),
 * MULTIPLE metrics providers can be enabled at once — a Goal may read
 * Stripe income while another reads a custom HTTP counter. Every
 * method therefore takes an explicit `pluginId`; when it is undefined
 * the normal resolution chain applies (providerOverride > work active >
 * defaultForCapabilities > first enabled).
 *
 * EW-602 integration:
 *   - `getMetricValue` is budget-guarded via BudgetGuardService BEFORE
 *     the provider call (capability `metrics`).
 *   - Every provider call records a `plugin_usage_events` row with
 *     capability `metrics`, best-effort (a failed write never breaks
 *     the read).
 */
@Injectable()
export class MetricsFacadeService extends BaseFacadeService {
    protected readonly logger = new Logger(MetricsFacadeService.name);
    protected readonly CAPABILITY = PLUGIN_CAPABILITIES.METRICS_PROVIDER;

    constructor(
        registry: PluginRegistryService,
        settingsService: PluginSettingsService,
        @Optional() workPluginRepository?: WorkPluginRepository,
        @Optional() private readonly pluginUsageService?: PluginUsageService,
        @Optional() private readonly budgetGuard?: BudgetGuardService,
    ) {
        super(registry, settingsService, workPluginRepository);
    }

    /**
     * Enumerate the metrics a provider can serve.
     *
     * @param pluginId - Metrics provider plugin id (e.g. `'stripe'`,
     *   `'custom-http'`). When undefined, resolves the default enabled
     *   provider for the (work, user) scope.
     */
    async listMetrics(
        pluginId: string | undefined,
        facadeOptions: FacadeOptions,
    ): Promise<MetricDescriptor[]> {
        const plugin = await this.resolveProvider(pluginId, facadeOptions);
        const settings = await this.getResolvedSettings(plugin.id, facadeOptions);

        let descriptors: MetricDescriptor[];
        try {
            descriptors = await plugin.listMetrics(settings);
        } catch (error) {
            throw this.toFacadeError(error, 'listMetrics', plugin.id);
        }

        // Discovery calls are free — record units only, no cost.
        await this.recordUsage(plugin.id, facadeOptions, 0, undefined, {
            operation: 'listMetrics',
            metricCount: descriptors.length,
        });

        return descriptors;
    }

    /**
     * Read one metric value from a provider. Budget-guarded (EW-602)
     * before the provider is invoked.
     *
     * @param pluginId - Metrics provider plugin id; undefined resolves
     *   the default enabled provider for the (work, user) scope.
     */
    async getMetricValue(
        pluginId: string | undefined,
        query: MetricQuery,
        facadeOptions: FacadeOptions,
    ): Promise<MetricSample> {
        const plugin = await this.resolveProvider(pluginId, facadeOptions);

        if (this.budgetGuard && facadeOptions.workId && facadeOptions.userId) {
            await this.budgetGuard.checkBudget(
                facadeOptions.workId,
                facadeOptions.userId,
                PluginUsageCapability.METRICS,
                plugin.id,
            );
        }

        const settings = await this.getResolvedSettings(plugin.id, facadeOptions);

        let sample: MetricSample;
        try {
            sample = await plugin.getMetricValue(query, settings);
        } catch (error) {
            throw this.toFacadeError(error, 'getMetricValue', plugin.id);
        }

        const pricing = (await plugin.getPricing?.()) ?? null;
        await this.recordUsage(
            plugin.id,
            facadeOptions,
            pricing?.costPerCallCents ?? 0,
            pricing?.currency,
            {
                operation: 'getMetricValue',
                metricId: query.metricId,
                window: query.window,
            },
        );

        return sample;
    }

    private async resolveProvider(
        pluginId: string | undefined,
        facadeOptions: FacadeOptions,
    ): Promise<IMetricsProviderPlugin> {
        // An explicit pluginId behaves exactly like a provider override:
        // it must be a loaded `metrics-provider` plugin enabled for the
        // scope, otherwise ProviderNotFoundError.
        return this.resolvePlugin<IMetricsProviderPlugin>(
            pluginId ?? facadeOptions.providerOverride,
            facadeOptions.userId,
            facadeOptions.workId,
        );
    }

    /**
     * Map arbitrary plugin failures into the facade error family.
     * FacadeError subclasses (NoProviderError, ProviderNotFoundError,
     * nested facade errors) pass through untouched; budget exceptions
     * are thrown before the try block and never reach here.
     */
    private toFacadeError(error: unknown, operation: string, pluginId: string): FacadeError {
        if (error instanceof FacadeError) {
            return error;
        }
        const cause = error instanceof Error ? error : new Error(String(error));
        return new MetricsFacadeError(
            `Metrics provider '${pluginId}' failed during ${operation}: ${cause.message}`,
            operation,
            pluginId,
            cause,
        );
    }

    // Best-effort usage recording — PluginUsageService.record never
    // throws, but guard the optional injection too.
    private async recordUsage(
        pluginId: string,
        facadeOptions: FacadeOptions,
        costCents: number,
        currency: string | undefined,
        metadata: Record<string, unknown>,
    ): Promise<void> {
        // Build the record explicitly rather than passing `currency: undefined`
        // through — omit the key when unknown (free/discovery calls, or
        // providers with no pricing). Explicit assignment, NOT a conditional
        // spread (`...cond && {}`), per the DTS conditional-spread gotcha.
        const record: Parameters<NonNullable<typeof this.pluginUsageService>['record']>[0] = {
            workId: facadeOptions.workId,
            userId: facadeOptions.userId,
            // Phase 15.6 — Agent/Task attribution propagation.
            agentId: facadeOptions.agentId,
            taskId: facadeOptions.taskId,
            pluginId,
            capability: PluginUsageCapability.METRICS,
            units: 1,
            costCents,
            metadata,
        };
        if (currency !== undefined) {
            record.currency = currency;
        }
        await this.pluginUsageService?.record(record);
    }
}
