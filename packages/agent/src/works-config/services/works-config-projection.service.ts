import { Injectable, Optional } from '@nestjs/common';
import type { ProvidersDto } from '@ever-works/contracts/api';
import { getUIKeyFromCapability } from '@ever-works/plugin';
import { WorkScheduleRepository } from '@src/database/repositories/work-schedule.repository';
import { WorkPluginRepository } from '@src/plugins/repositories/work-plugin.repository';
import type { WorkPluginEntity } from '@src/plugins/entities/work-plugin.entity';
import {
    PluginRegistryService,
    loadRegisteredPlugins,
} from '@src/plugins/services/plugin-registry.service';
import { getActiveCapabilities } from '@src/plugins/utils/active-capabilities.util';
import { Work } from '@src/entities/work.entity';
import type { WorksConfigWriteRequest } from './works-config-writer.service';

@Injectable()
export class WorksConfigProjectionService {
    constructor(
        private readonly scheduleRepository: WorkScheduleRepository,
        @Optional()
        private readonly workPluginRepository?: WorkPluginRepository,
        @Optional()
        private readonly pluginRegistry?: PluginRegistryService,
    ) {}

    async buildWriteRequest(work: Work): Promise<WorksConfigWriteRequest> {
        const [scheduleProviders, activeProviders, pipelineModel] = await Promise.all([
            this.getScheduleProviderOverrides(work.id),
            this.getActiveCapabilityProviders(work.id),
            this.getPipelineModel(work.id),
        ]);

        return {
            name: work.name,
            model: pipelineModel ?? null,
            providers: this.mergeProviders(activeProviders, scheduleProviders) ?? null,
            activitySyncMode: work.activitySyncMode ?? null,
        };
    }

    private async getScheduleProviderOverrides(workId: string): Promise<ProvidersDto | undefined> {
        const schedule = await this.scheduleRepository.findByWorkId(workId);
        const providers = schedule?.providerOverrides ?? undefined;

        return this.hasProviders(providers) ? providers : undefined;
    }

    private async getActiveCapabilityProviders(workId: string): Promise<ProvidersDto | undefined> {
        if (!this.workPluginRepository) {
            return undefined;
        }

        const workPlugins = await this.workPluginRepository.findEnabledByWork(workId);
        const providers: ProvidersDto = {};

        for (const plugin of workPlugins) {
            const providerKeys = getActiveCapabilities(plugin)
                .map((capability) => this.getProviderKey(capability))
                .filter((providerKey): providerKey is keyof ProvidersDto => !!providerKey);
            if (providerKeys.length === 0) continue;

            if (await this.isSupplementaryPlugin(plugin)) {
                continue;
            }

            for (const providerKey of providerKeys) {
                providers[providerKey] = plugin.pluginId;
            }
        }

        return this.hasProviders(providers) ? providers : undefined;
    }

    private async getPipelineModel(workId: string): Promise<string | undefined> {
        const pipelinePlugin = await this.workPluginRepository?.findActiveByCapability(
            workId,
            'pipeline',
        );

        return this.readString(pipelinePlugin?.settings?.model);
    }

    private getProviderKey(capability?: string | null): keyof ProvidersDto | null {
        if (!capability) {
            return null;
        }

        try {
            return getUIKeyFromCapability(capability) as keyof ProvidersDto;
        } catch {
            return null;
        }
    }

    private hasProviders(providers?: ProvidersDto | null): providers is ProvidersDto {
        return !!providers && Object.keys(providers).length > 0;
    }

    private mergeProviders(
        activeProviders?: ProvidersDto,
        scheduleProviders?: ProvidersDto,
    ): ProvidersDto | undefined {
        const providers = {
            ...(activeProviders ?? {}),
            ...(scheduleProviders ?? {}),
        };

        return this.hasProviders(providers) ? providers : undefined;
    }

    private readString(value: unknown): string | undefined {
        return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
    }

    /**
     * Whether the plugin is supplementary (a URL-pattern specialist, never a
     * Work's provider). The plugin's DB row is not enough: each lazy
     * registration writes package.json's manifest into it, keeping only the
     * keys a first load of the SAME version wrote (a version change resets the
     * row to package.json's manifest, so a flag an older version declared does
     * not outlive the upgrade), and a plugin may declare `supplementary` only
     * in its class's getManifest() (pdf-extractor, officecli-extractor,
     * notion-extractor). The registry entry carries it once the plugin has
     * loaded, so load it (only a plugin with an active capability to project
     * reaches here). One that cannot load is still projected: the projection
     * mirrors the Work's configuration.
     */
    private async isSupplementaryPlugin(workPlugin: WorkPluginEntity): Promise<boolean> {
        if (this.isSupplementaryManifest(workPlugin.pluginEntity?.manifest)) {
            return true;
        }
        const registered = this.pluginRegistry?.get(workPlugin.pluginId);
        if (!registered) {
            return false;
        }
        await loadRegisteredPlugins([registered]);
        return this.isSupplementaryManifest(registered.manifest);
    }

    private isSupplementaryManifest(metadata: unknown): boolean {
        return (
            !!metadata &&
            typeof metadata === 'object' &&
            (metadata as Record<string, unknown>).supplementary === true
        );
    }
}
