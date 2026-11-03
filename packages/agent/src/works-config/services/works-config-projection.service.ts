import { Injectable, Optional } from '@nestjs/common';
import type { ProvidersDto } from '@ever-works/contracts/api';
import { getUIKeyFromCapability } from '@ever-works/plugin';
import { WorkScheduleRepository } from '@src/database/repositories/work-schedule.repository';
import { WorkPluginRepository } from '@src/plugins/repositories/work-plugin.repository';
import { getActiveCapabilities } from '@src/plugins/utils/active-capabilities.util';
import { Work } from '@src/entities/work.entity';
import type { WorksConfigWriteRequest } from './works-config-writer.service';

@Injectable()
export class WorksConfigProjectionService {
    constructor(
        private readonly scheduleRepository: WorkScheduleRepository,
        @Optional()
        private readonly workPluginRepository?: WorkPluginRepository,
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
            // EW-612: project the dashboard's deploy provider into the file.
            //
            // Without this the write request was silent on the field, so
            // `WorksConfigWriterService.resolveDeployProvider` resolved it from
            // the EXISTING `.works/works.yml` and re-wrote the value already
            // there. The sync then produced no diff, no commit, and the
            // dashboard change never reached the data repo — the user re-picked
            // the provider forever while the file kept overriding them.
            //
            // `undefined` (NOT `?? null`) when the column is empty: `null` is
            // the writer's explicit CLEAR signal and would delete a provider the
            // user declared by hand in the file. An unset column simply has
            // nothing to say, so the data repo keeps whatever it holds.
            deployProvider: this.readString(work.deployProvider),
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
            if (this.isSupplementaryPlugin(plugin.pluginEntity?.manifest)) {
                continue;
            }

            for (const capability of getActiveCapabilities(plugin)) {
                const providerKey = this.getProviderKey(capability);
                if (!providerKey) continue;
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

    private isSupplementaryPlugin(metadata: unknown): boolean {
        return (
            !!metadata &&
            typeof metadata === 'object' &&
            (metadata as Record<string, unknown>).supplementary === true
        );
    }
}
