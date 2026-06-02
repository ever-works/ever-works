import { Injectable, Logger } from '@nestjs/common';
import type { ParsedWorksConfig, ResolvedWorksConfig } from './works-config.service';
import { Work } from '@src/entities/work.entity';
import { User } from '@src/entities/user.entity';
import { PluginOperationsService } from '@src/plugins/services/plugin-operations.service';
import { WorkScheduleService } from '@src/services/work-schedule.service';
import { WorkRepository } from '@src/database/repositories/work.repository';

// Security: a pipeline `model` read from `.works/works.yml` is attacker-controlled
// external content. It is persisted as a plugin setting and later passed verbatim
// to a coding-agent CLI subprocess via `spawn(cmd, argv)`. spawn with an argv array
// prevents shell injection, but a value beginning with `-`/`--` (or containing
// whitespace) could be parsed by the downstream CLI as an extra flag (argument
// injection — e.g. `--dangerously-bypass-approvals-and-sandbox`, `--max-budget-usd`),
// overriding platform safety limits. Constrain to the same strict charset the
// claude-code/codex process-runners accept: must start alphanumeric, then a short
// run of `A-Za-z0-9._-`. Every legitimate model id (`sonnet`, `opus`, `haiku`,
// `gpt-4o`, `o3`, `claude-sonnet-4-5-20250929`, `codex-mini-latest`) matches, so no
// real import is affected; malicious values are dropped (model omitted from the
// persisted settings, falling back to the plugin/CLI default).
const SAFE_PIPELINE_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

@Injectable()
export class WorksConfigImportApplierService {
    private readonly logger = new Logger(WorksConfigImportApplierService.name);

    constructor(
        private readonly pluginOperationsService: PluginOperationsService,
        private readonly workScheduleService: WorkScheduleService,
        private readonly workRepository: WorkRepository,
    ) {}

    /**
     * Project the `activity_sync.mode` field from a parsed `works.yml`
     * onto the Work entity. EW-120 dual-mode transport: this is the read
     * path used everywhere downstream (poller, ingest guard, feed router).
     */
    async applyActivitySyncMode(
        workId: string,
        worksConfig?: ParsedWorksConfig | ResolvedWorksConfig | null,
    ): Promise<void> {
        const mode = worksConfig?.activitySyncMode;
        if (!mode) {
            return;
        }
        try {
            await this.workRepository.update(workId, { activitySyncMode: mode });
        } catch (error) {
            this.logger.warn(
                `Failed to apply activitySyncMode=${mode} for work ${workId}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    async applyPipelineSettings(
        workId: string,
        userId: string,
        worksConfig?: ParsedWorksConfig | ResolvedWorksConfig | null,
    ): Promise<void> {
        const pipelineSettings = this.getPipelinePluginSettings(worksConfig);
        if (!pipelineSettings) {
            return;
        }

        await this.pluginOperationsService.enablePluginForWork(
            workId,
            pipelineSettings.pluginId,
            userId,
            {
                activeCapability: 'pipeline',
                settings: pipelineSettings.settings,
            },
        );
    }

    async applyInitialSchedule(
        workId: string,
        user: User,
        worksConfig?: ParsedWorksConfig | ResolvedWorksConfig | null,
    ): Promise<void> {
        if (!worksConfig?.scheduleCadence) {
            return;
        }

        try {
            await this.workScheduleService.updateSchedule(
                workId,
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
                `Failed to restore schedule from .works/works.yml for work ${workId}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    async applyScheduleOverrides(
        work: Work,
        user: User,
        worksConfig?: ParsedWorksConfig | ResolvedWorksConfig | null,
    ): Promise<void> {
        if (
            !work.scheduledUpdatesEnabled ||
            (!worksConfig?.scheduleCadence && !worksConfig?.providers)
        ) {
            return;
        }

        try {
            await this.workScheduleService.updateSchedule(
                work.id,
                {
                    cadence: worksConfig?.scheduleCadence ?? undefined,
                    providerOverrides:
                        worksConfig?.providers !== undefined ? worksConfig.providers : undefined,
                },
                user,
            );
        } catch (error) {
            this.logger.warn(
                `Failed to restore schedule overrides from .works/works.yml for work ${work.id}: ${
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

        // Security: reject a model id that could smuggle CLI flags into the
        // downstream coding-agent subprocess (argument injection). Drop the
        // invalid value rather than persisting it; a malformed optional field
        // must not abort the import, so treat it as "no model configured".
        if (!SAFE_PIPELINE_MODEL_PATTERN.test(model)) {
            this.logger.warn(
                `Ignoring invalid pipeline model from .works/works.yml (does not match allowed format): ${JSON.stringify(
                    model.slice(0, 120),
                )}`,
            );
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
