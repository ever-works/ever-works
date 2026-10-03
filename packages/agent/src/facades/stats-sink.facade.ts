import { Injectable, Logger } from '@nestjs/common';
import {
    isStatsSinkPlugin,
    STATS_SINK_CAPABILITY,
    type IStatsSinkPlugin,
    type StatsSinkSendOptions,
} from '@ever-works/plugin';
import type { SignedStatsReport, StatsSendResult } from '@ever-works/contracts';
import { PluginRegistryService } from '../plugins/services/plugin-registry.service';
import { materializePlugin, pluginLoadFailure } from '../plugins/services/plugin-operation.util';
import { FacadeError } from './base.facade';

/** Why no `stats-sink` provider can take a report. */
export type StatsSinkUnavailableReason =
    | 'not_registered'
    | 'missing_capability'
    | 'load_failed'
    | 'not_a_stats_sink';

export class StatsSinkUnavailableError extends FacadeError {
    constructor(readonly reason: StatsSinkUnavailableReason) {
        super(`Statistics sink unavailable: ${reason}`, 'getProvider');
        this.name = 'StatsSinkUnavailableError';
    }
}

/**
 * The one way the anonymous usage statistics module reaches its delivery
 * plugin (capability `stats-sink`).
 *
 * The provider is the single plugin named by `EVER_WORKS_STATS_SINK` (default
 * `ever-stats-sink`), passed in by the caller from the configuration it read
 * at boot — the same "one selector picks one provider" shape as the job
 * runtime. Resolution is instance-level: there is no per-user or per-Work
 * provider for statistics.
 *
 * Constructing this facade does nothing; resolving a provider only touches the
 * in-process plugin registry. The plugin itself is materialised on the first
 * `send`, and with statistics switched off nothing ever calls `send`, so the
 * plugin stays installed but never active.
 */
@Injectable()
export class StatsSinkFacadeService {
    private readonly logger = new Logger(StatsSinkFacadeService.name);

    constructor(private readonly registry: PluginRegistryService) {}

    /**
     * Whether `pluginId` is registered and declares the capability — a cheap
     * read of the registry that loads nothing (for the status view).
     */
    isAvailable(pluginId: string): boolean {
        const entry = this.registry.get(pluginId);
        if (!entry || entry.state === 'error') return false;
        return (entry.manifest.capabilities ?? []).includes(STATS_SINK_CAPABILITY);
    }

    /** Resolve and (on first use) load the provider; throws {@link StatsSinkUnavailableError}. */
    async resolve(pluginId: string): Promise<IStatsSinkPlugin> {
        const entry = this.registry.get(pluginId);
        if (!entry) throw new StatsSinkUnavailableError('not_registered');
        if (!(entry.manifest.capabilities ?? []).includes(STATS_SINK_CAPABILITY)) {
            throw new StatsSinkUnavailableError('missing_capability');
        }
        if (entry.state === 'error') throw new StatsSinkUnavailableError('load_failed');
        let instance: unknown;
        try {
            instance = await materializePlugin(entry.plugin);
        } catch {
            throw new StatsSinkUnavailableError('load_failed');
        }
        if (pluginLoadFailure(this.registry.get(pluginId), pluginId)) {
            throw new StatsSinkUnavailableError('load_failed');
        }
        const plugin = instance ?? entry.plugin;
        if (!isStatsSinkPlugin(plugin)) throw new StatsSinkUnavailableError('not_a_stats_sink');
        return plugin;
    }

    /**
     * Hand one signed report to the provider. Never logs the body; a provider
     * that throws is reported as a `failed` send with no detail carried over.
     */
    async send(
        pluginId: string,
        report: SignedStatsReport,
        options: StatsSinkSendOptions,
    ): Promise<StatsSendResult> {
        const plugin = await this.resolve(pluginId);
        try {
            return await plugin.send(report, options);
        } catch (error) {
            this.logger.warn(
                `Statistics sink "${pluginId}" threw while sending a report (${
                    error instanceof Error ? error.name : 'error'
                })`,
            );
            return { status: 'failed', httpStatus: null, errorCode: 'network' };
        }
    }
}
