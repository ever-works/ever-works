import { Injectable, Logger } from '@nestjs/common';
import type { ParsedWorksConfig, ResolvedWorksConfig } from './works-config.service';
import { Directory } from '@src/entities/directory.entity';
import { User } from '@src/entities/user.entity';
import { PluginOperationsService } from '@src/plugins/services/plugin-operations.service';
import { DirectoryScheduleService } from '@src/services/directory-schedule.service';

@Injectable()
export class WorksConfigImportApplierService {
    private readonly logger = new Logger(WorksConfigImportApplierService.name);

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

        try {
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
        } catch (error) {
            this.logger.warn(
                `Failed to restore schedule from works.yaml for directory ${directoryId}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
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

        try {
            await this.directoryScheduleService.updateSchedule(
                directory.id,
                {
                    cadence: worksConfig?.scheduleCadence ?? undefined,
                    providerOverrides:
                        worksConfig?.providers !== undefined ? worksConfig.providers : undefined,
                },
                user,
            );
        } catch (error) {
            this.logger.warn(
                `Failed to restore schedule overrides from works.yaml for directory ${directory.id}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
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
