import { BadRequestException, Injectable } from '@nestjs/common';
import {
    WorksConfigService,
    type ParsedWorksConfig,
    type ResolvedWorksConfig,
} from '@src/import/works-config.service';
import {
    Directory,
    ImportSourceType,
    SourceRepository,
    type RepositoryTarget,
    type WorksConfigSnapshot,
} from '@src/entities/directory.entity';
import { User } from '@src/entities/user.entity';
import { GeneratorFormSchemaService } from './generator-form-schema.service';
import { PluginOperationsService } from '@src/plugins/services/plugin-operations.service';
import { DirectoryScheduleService } from './directory-schedule.service';

type ConflictResult = {
    hasConflict: boolean;
    conflictingRepos: string[];
    suggestedSlug: string;
};

@Injectable()
export class WorksConfigRestoreService {
    constructor(
        private readonly worksConfigService: WorksConfigService,
        private readonly generatorFormSchemaService: GeneratorFormSchemaService,
        private readonly pluginOperationsService: PluginOperationsService,
        private readonly directoryScheduleService: DirectoryScheduleService,
    ) {}

    toSnapshot(
        worksConfig?: ParsedWorksConfig | ResolvedWorksConfig | null,
    ): WorksConfigSnapshot | undefined {
        if (!worksConfig) {
            return undefined;
        }

        return {
            name: worksConfig.name,
            initialPrompt: worksConfig.initialPrompt,
            model: worksConfig.model,
            websiteRepo: worksConfig.websiteRepo,
            scheduleCadence: worksConfig.scheduleCadence ?? null,
            providers:
                worksConfig.providers && Object.keys(worksConfig.providers).length > 0
                    ? worksConfig.providers
                    : undefined,
            additionalAgentsCount: worksConfig.additionalAgentsCount,
        };
    }

    toResolved(worksConfig?: ParsedWorksConfig | null): ResolvedWorksConfig | null {
        if (!worksConfig) {
            return null;
        }

        const { raw: _raw, ...resolvedWorksConfig } = worksConfig;
        return resolvedWorksConfig;
    }

    getConflictRepoNames(
        slug: string,
        sourceRepoName?: string | null,
        worksConfig?: { websiteRepo?: string } | null,
    ): string[] {
        const normalizedSourceRepoName = sourceRepoName?.toLowerCase();
        const repoNames = [`${slug}-data`];

        const websiteRepo =
            this.worksConfigService.parseRepositoryReference(worksConfig?.websiteRepo)?.repo ||
            `${slug}-website`;
        repoNames.push(websiteRepo);

        return Array.from(
            new Set(
                repoNames.filter(
                    (repoName) =>
                        typeof repoName === 'string' &&
                        repoName.length > 0 &&
                        repoName.toLowerCase() !== normalizedSourceRepoName,
                ),
            ),
        );
    }

    sanitizeConflict(
        conflict: ConflictResult,
        sourceRepoName?: string | null,
        worksConfig?: { websiteRepo?: string } | null,
    ): ConflictResult {
        const benignRepos = new Set<string>();
        const normalizedSourceRepoName = sourceRepoName?.toLowerCase();

        if (sourceRepoName) {
            benignRepos.add(sourceRepoName.toLowerCase());
        }

        const websiteRepo = this.worksConfigService.parseRepositoryReference(
            worksConfig?.websiteRepo,
        )?.repo;
        if (
            websiteRepo &&
            normalizedSourceRepoName &&
            websiteRepo.toLowerCase() === normalizedSourceRepoName
        ) {
            benignRepos.add(websiteRepo.toLowerCase());
        }

        const conflictingRepos = conflict.conflictingRepos.filter(
            (repoName) => !benignRepos.has(repoName.toLowerCase()),
        );

        return {
            hasConflict: conflictingRepos.length > 0,
            conflictingRepos,
            suggestedSlug: conflict.suggestedSlug,
        };
    }

    async validateForImport(worksConfig: ParsedWorksConfig | null, userId: string): Promise<void> {
        if (!worksConfig?.initialPrompt) {
            throw new BadRequestException('works.yml is missing initial_prompt');
        }

        await this.generatorFormSchemaService.validateSelectedProviders(worksConfig.providers, {
            userId,
        });
        await this.generatorFormSchemaService.validateRequiredProvidersForPipeline(
            worksConfig.providers?.pipeline,
            worksConfig.providers,
            { userId },
        );
    }

    validateRepositoryTargets(
        source: RepositoryTarget,
        worksConfig?: ParsedWorksConfig | ResolvedWorksConfig | null,
    ): void {
        this.assertSafeRepositoryTargets(source, worksConfig?.websiteRepositoryTarget);
    }

    buildSourceRepository(options: {
        sourceUrl: string;
        sourceOwner: string;
        sourceRepo: string;
        sourceType: ImportSourceType;
        sourceRole?: 'data' | 'directory';
        importedAt?: Date;
        previous?: SourceRepository | null;
        worksConfig?: ParsedWorksConfig | ResolvedWorksConfig | null;
    }): SourceRepository {
        const sourceTarget = { owner: options.sourceOwner, repo: options.sourceRepo };
        this.assertSafeRepositoryTargets(
            sourceTarget,
            options.worksConfig?.websiteRepositoryTarget,
        );
        const sourceRole = options.sourceRole ?? 'directory';

        return {
            ...(options.previous || {
                url: options.sourceUrl,
                importedAt: options.importedAt ?? new Date(),
            }),
            url: options.sourceUrl,
            owner: options.sourceOwner,
            repo: options.sourceRepo,
            type: options.sourceType,
            worksConfig: this.toSnapshot(options.worksConfig),
            relatedRepositories: {
                ...(options.previous?.relatedRepositories || {}),
                [sourceRole]: sourceTarget,
                ...(options.worksConfig?.websiteRepositoryTarget
                    ? {
                          website: options.worksConfig.websiteRepositoryTarget,
                      }
                    : {}),
            },
        };
    }

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

    private assertSafeRepositoryTargets(
        source: RepositoryTarget,
        website?: RepositoryTarget,
    ): void {
        if (!website) {
            return;
        }

        const sourceOwner = source.owner?.toLowerCase();
        const websiteOwner = website.owner?.toLowerCase();
        const sameOwner = !websiteOwner || !sourceOwner || websiteOwner === sourceOwner;
        const sameRepo = website.repo.toLowerCase() === source.repo.toLowerCase();

        if (sameOwner && sameRepo) {
            throw new BadRequestException(
                'works.yml website_repo must not point to the source directory repository',
            );
        }
    }
}
