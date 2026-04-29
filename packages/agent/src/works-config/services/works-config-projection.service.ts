import { Injectable, Optional } from '@nestjs/common';
import type { ProvidersDto } from '@ever-works/contracts/api';
import { getUIKeyFromCapability } from '@ever-works/plugin';
import { DirectoryScheduleRepository } from '@src/database/repositories/directory-schedule.repository';
import { DirectoryPluginRepository } from '@src/plugins/repositories/directory-plugin.repository';
import { Directory } from '@src/entities/directory.entity';
import type { WorksConfigWriteRequest } from './works-config-writer.service';

@Injectable()
export class WorksConfigProjectionService {
    constructor(
        private readonly scheduleRepository: DirectoryScheduleRepository,
        @Optional()
        private readonly directoryPluginRepository?: DirectoryPluginRepository,
    ) {}

    async buildWriteRequest(directory: Directory): Promise<WorksConfigWriteRequest> {
        const [scheduleProviders, activeProviders, pipelineModel] = await Promise.all([
            this.getScheduleProviderOverrides(directory.id),
            this.getActiveCapabilityProviders(directory.id),
            this.getPipelineModel(directory.id),
        ]);

        return {
            name: directory.name,
            model: pipelineModel,
            providers: this.mergeProviders(activeProviders, scheduleProviders),
        };
    }

    private async getScheduleProviderOverrides(
        directoryId: string,
    ): Promise<ProvidersDto | undefined> {
        const schedule = await this.scheduleRepository.findByDirectoryId(directoryId);
        const providers = schedule?.providerOverrides ?? undefined;

        return this.hasProviders(providers) ? providers : undefined;
    }

    private async getActiveCapabilityProviders(
        directoryId: string,
    ): Promise<ProvidersDto | undefined> {
        if (!this.directoryPluginRepository) {
            return undefined;
        }

        const directoryPlugins =
            await this.directoryPluginRepository.findEnabledByDirectory(directoryId);
        const providers: ProvidersDto = {};

        for (const plugin of directoryPlugins) {
            const providerKey = this.getProviderKey(plugin.activeCapability);
            if (!providerKey || this.isSupplementaryPlugin(plugin.pluginEntity?.manifest)) {
                continue;
            }

            providers[providerKey] = plugin.pluginId;
        }

        return this.hasProviders(providers) ? providers : undefined;
    }

    private async getPipelineModel(directoryId: string): Promise<string | undefined> {
        const pipelinePlugin = await this.directoryPluginRepository?.findActiveByCapability(
            directoryId,
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

    private isSupplementaryPlugin(metadata: unknown): boolean {
        return (
            !!metadata &&
            typeof metadata === 'object' &&
            (metadata as Record<string, unknown>).supplementary === true
        );
    }
}
