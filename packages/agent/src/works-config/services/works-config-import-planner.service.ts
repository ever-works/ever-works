import { BadRequestException, Injectable } from '@nestjs/common';
import {
    WorksConfigService,
    type ParsedWorksConfig,
    type ResolvedWorksConfig,
} from './works-config.service';
import {
    ImportSourceType,
    SourceRepository,
    type RepositoryTarget,
    type WorksConfigSnapshot,
} from '@src/entities/directory.entity';
import { GeneratorFormSchemaService } from '@src/services/generator-form-schema.service';

type ConflictResult = {
    hasConflict: boolean;
    conflictingRepos: string[];
    suggestedSlug: string;
};

export type WorksConfigSourceRole = 'data' | 'directory';

export type WorksConfigSourceRepositoryOptions = {
    sourceUrl: string;
    sourceOwner: string;
    sourceRepo: string;
    sourceType: ImportSourceType;
    sourceRole?: WorksConfigSourceRole;
    importedAt?: Date;
    previous?: SourceRepository | null;
    worksConfig?: ParsedWorksConfig | ResolvedWorksConfig | null;
};

@Injectable()
export class WorksConfigImportPlannerService {
    constructor(
        private readonly worksConfigService: WorksConfigService,
        private readonly generatorFormSchemaService: GeneratorFormSchemaService,
    ) {}

    async loadFromRepository(options: {
        owner: string;
        repo: string;
        providerId?: string;
        token?: string;
    }): Promise<ParsedWorksConfig | null> {
        return this.worksConfigService.loadFromRepository(
            options.owner,
            options.repo,
            options.providerId,
            options.token,
        );
    }

    async validateForGeneratedImport(
        worksConfig: ParsedWorksConfig | null,
        userId: string,
    ): Promise<void> {
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

    buildSourceRepository(options: WorksConfigSourceRepositoryOptions): SourceRepository {
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
