import { Injectable } from '@nestjs/common';
import type { ParsedWorksConfig, ResolvedWorksConfig } from './works-config.service';
import { Directory } from '@src/entities/directory.entity';
import { User } from '@src/entities/user.entity';
import { PluginOperationsService } from '@src/plugins/services/plugin-operations.service';
import { DirectoryScheduleService } from '@src/services/directory-schedule.service';

@Injectable()
export class WorksConfigImportApplierService {
    constructor(
        private readonly pluginOperationsService: PluginOperationsService,
        private readonly directoryScheduleService: DirectoryScheduleService,
    ) {}

    async applyPipelineSettings(
        directoryId: string,
        userId: string,
        worksConfig?: ParsedWorksConfig | ResolvedWorksConfig | null,
    ): Promise<void> {
        const pipelineSettings = this.getPipelinePluginSettings(worksConfig);
        if (!pipelineSettings) {
            return;
        }

        await this.pluginOperationsService.enablePluginForDirectory(
            directoryId,
            pipelineSettings.pluginId,
            userId,
            {
                activeCapability: 'pipeline',
                settings: pipelineSettings.settings,
            },
        );
    }

    async applyInitialSchedule(
        directoryId: string,
        user: User,
        worksConfig?: ParsedWorksConfig | ResolvedWorksConfig | null,
    ): Promise<void> {
        if (!worksConfig?.scheduleCadence) {
            return;
        }

        await this.directoryScheduleService.updateSchedule(
            directoryId,
            {
                enable: true,
                cadence: worksConfig.scheduleCadence,
                alwaysCreatePullRequest: true,
                providerOverrides:
                    worksConfig.providers && Object.keys(worksConfig.providers).length > 0
                        ? worksConfig.providers
                        : null,
            },
            user,
        );
    }

    async applyScheduleOverrides(
        directory: Directory,
        user: User,
        worksConfig?: ParsedWorksConfig | ResolvedWorksConfig | null,
    ): Promise<void> {
        if (
            !directory.scheduledUpdatesEnabled ||
            (!worksConfig?.scheduleCadence && !worksConfig?.providers)
        ) {
            return;
        }

        await this.directoryScheduleService.updateSchedule(
            directory.id,
            {
                cadence: worksConfig?.scheduleCadence ?? undefined,
                providerOverrides:
                    worksConfig?.providers !== undefined ? worksConfig.providers : undefined,
            },
            user,
        );
    }

    private getPipelinePluginSettings(
        worksConfig?: ParsedWorksConfig | ResolvedWorksConfig | null,
    ): { pluginId: 'codex' | 'claude-code'; settings: Record<string, unknown> } | null {
        const pipelineId = worksConfig?.providers?.pipeline;
        const model = worksConfig?.model;

        if (!model) {
            return null;
        }

        if (pipelineId === 'codex' || pipelineId === 'claude-code') {
            return {
                pluginId: pipelineId,
                settings: { model },
            };
        }

        return null;
    }
}
