import {
    BadRequestException,
    HttpException,
    Inject,
    Injectable,
    Logger,
    Optional,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DirectoryRepository } from '@src/database/repositories/directory.repository';
import { DirectoryGenerationHistoryRepository } from '@src/database/repositories/directory-generation-history.repository';
import { DataGeneratorService } from '@src/generators/data-generator/data-generator.service';
import { DataRepository } from '@src/generators/data-generator/data-repository';
import { MarkdownGeneratorService } from '@src/generators/markdown-generator/markdown-generator.service';
import { WebsiteGeneratorService } from '@src/generators/website-generator/website-generator.service';
import { GitFacadeService } from '@src/facades/git.facade';
import { SourceRepoAnalyzerService } from '@src/import/source-repo-analyzer.service';
import { ImportExecutorService } from '@src/import/import-executor.service';
import { WorksConfigService, type ParsedWorksConfig } from '@src/import/works-config.service';
import {
    AnalyzeRepositoryDto,
    AnalyzeRepositoryResponseDto,
    AnalyzeForLinkingResponseDto,
    ImportDirectoryDto,
    ImportDirectoryResponseDto,
    ImportSourceTypeEnum,
    GetUserRepositoriesDto,
    GetUserRepositoriesResponseDto,
    GitRepoDto,
} from '@src/dto/import-directory.dto';
import {
    Directory,
    ImportSourceType,
    SourceRepository,
    type WorksConfigSnapshot,
} from '@src/entities/directory.entity';
import { User } from '@src/entities/user.entity';
import { DirectoryGenerationCompletedEvent } from '@src/events';
import { buildImportStatsUpdate } from '@src/directory-operations';
import {
    DirectoryImportPayload,
    DirectoryImportResult,
    DirectoryImportErrorCode,
    DirectoryImportDispatcher,
    DIRECTORY_IMPORT_DISPATCHER,
} from '@src/tasks';
import { DirectoryScheduleService } from './directory-schedule.service';
import { DirectoryScheduleCadence, GenerateStatusType } from '@src/entities/types';
import { normalizeGeneratorError } from './utils/error.utils';
import { calculateDurationSeconds } from '../utils/time.utils';
import { slugifyText } from '@src/utils/text.utils';
import { GenerationMethod } from '@src/items-generator/dto';
import { DirectoryGenerationHistory } from '@src/entities/directory-generation-history.entity';
import { GeneratorFormSchemaService } from './generator-form-schema.service';
import { PluginOperationsService } from '@src/plugins/services/plugin-operations.service';

import { OperationTriggerContext, DEFAULT_TRIGGER_CONTEXT } from './types/trigger-context.types';

@Injectable()
export class DirectoryImportService {
    private readonly logger = new Logger(DirectoryImportService.name);

    constructor(
        private readonly directoryRepository: DirectoryRepository,
        private readonly generationHistoryRepository: DirectoryGenerationHistoryRepository,
        private readonly dataGenerator: DataGeneratorService,
        private readonly markdownGenerator: MarkdownGeneratorService,
        private readonly websiteGenerator: WebsiteGeneratorService,
        private readonly gitFacade: GitFacadeService,
        private readonly sourceRepoAnalyzer: SourceRepoAnalyzerService,
        private readonly importExecutor: ImportExecutorService,
        private readonly worksConfigService: WorksConfigService,
        private readonly directoryScheduleService: DirectoryScheduleService,
        private readonly generatorFormSchemaService: GeneratorFormSchemaService,
        private readonly pluginOperationsService: PluginOperationsService,
        private readonly eventEmitter: EventEmitter2,
        @Optional()
        @Inject(DIRECTORY_IMPORT_DISPATCHER)
        private readonly importDispatcher?: DirectoryImportDispatcher,
    ) {}

    private toWorksConfigSnapshot(
        worksConfig?: ParsedWorksConfig | null,
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

    private getWorksConfigConflictRepoNames(
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

    private sanitizeWorksConfigConflict(
        conflict: {
            hasConflict: boolean;
            conflictingRepos: string[];
            suggestedSlug: string;
        },
        sourceRepoName?: string | null,
        worksConfig?: { websiteRepo?: string } | null,
    ): {
        hasConflict: boolean;
        conflictingRepos: string[];
        suggestedSlug: string;
    } {
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

    private getPipelinePluginSettingsFromWorksConfig(
        worksConfig?: ParsedWorksConfig | null,
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

    private async applyWorksConfigPipelineSettings(
        directoryId: string,
        userId: string,
        worksConfig?: ParsedWorksConfig | null,
    ): Promise<void> {
        const pipelineSettings = this.getPipelinePluginSettingsFromWorksConfig(worksConfig);
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

    /**
     * Analyze a repository to detect its type and structure
     */
    async analyzeRepository(
        dto: AnalyzeRepositoryDto,
        user: User,
    ): Promise<AnalyzeRepositoryResponseDto> {
        const providerId = dto.gitProvider || this.getProviderFromUrl(dto.sourceUrl);
        const token = await this.getProviderToken(user, providerId);
        const result = await this.sourceRepoAnalyzer.analyzeRepository(dto.sourceUrl, token);

        if (!result.error && result.repo && token && result.detectedType) {
            const repoOwner = result.owner || user.username;
            const baseSlug = result.baseSlug || result.repo;
            const slug = slugifyText(
                this.normalizeDirectoryName(baseSlug, ImportSourceTypeEnum.LINK_EXISTING),
            );

            try {
                const rawConflict = await this.sourceRepoAnalyzer.checkSlugConflicts(
                    repoOwner,
                    slug,
                    token,
                    providerId,
                    result.detectedType === ImportSourceTypeEnum.WORKS_CONFIG
                        ? {
                              includeRepoNames: this.getWorksConfigConflictRepoNames(
                                  slug,
                                  result.repo,
                                  result.worksConfig,
                              ),
                          }
                        : undefined,
                );
                const conflict =
                    result.detectedType === ImportSourceTypeEnum.WORKS_CONFIG
                        ? this.sanitizeWorksConfigConflict(
                              rawConflict,
                              result.repo,
                              result.worksConfig,
                          )
                        : rawConflict;
                if (conflict.hasConflict) {
                    result.slugConflict = conflict;
                }
            } catch (err) {
                this.logger.debug(`Slug conflict check failed: ${err.message}`);
            }
        }

        return result;
    }

    async analyzeForLinking(
        dto: AnalyzeRepositoryDto,
        user: User,
    ): Promise<AnalyzeForLinkingResponseDto> {
        const providerId = dto.gitProvider || this.getProviderFromUrl(dto.sourceUrl);
        const token = await this.getProviderToken(user, providerId);
        if (!token) {
            return {
                canLink: false,
                hasWriteAccess: false,
                relatedRepos: {
                    data: { exists: true, name: '' },
                    markdown: { exists: false, name: null },
                    website: { exists: false, name: null },
                },
                error: 'Git provider token not available',
            };
        }
        return this.sourceRepoAnalyzer.analyzeForLinking(dto.sourceUrl, token);
    }

    /**
     * Get user's repositories for selection (uses git provider facade)
     */
    async getUserRepositories(
        dto: GetUserRepositoriesDto,
        user: User,
    ): Promise<GetUserRepositoriesResponseDto> {
        const options = { userId: user.id, providerId: dto.gitProvider };
        const hasCredentials = await this.gitFacade.hasValidCredentials(options);

        if (!hasCredentials) {
            throw new BadRequestException('Git provider account not connected');
        }

        const page = dto.page || 1;
        const perPage = dto.perPage || 30;

        try {
            const repos = await this.gitFacade.listRepositories(options, page, perPage, {
                owner: dto.owner,
                type: dto.type,
            });

            let filteredRepos = repos;
            if (dto.search) {
                const searchLower = dto.search.toLowerCase();
                filteredRepos = repos.filter(
                    (repo) =>
                        repo.name.toLowerCase().includes(searchLower) ||
                        repo.description?.toLowerCase().includes(searchLower),
                );
            }

            const repositories: GitRepoDto[] = filteredRepos.map((repo, index) => ({
                id: index, // Use index as fallback since generic GitRepository doesn't have id
                name: repo.name,
                full_name: repo.fullName,
                owner: repo.owner,
                description: repo.description ?? null,
                html_url: repo.url,
                private: repo.isPrivate,
                updated_at: new Date().toISOString(),
                default_branch: repo.defaultBranch,
            }));

            return {
                repositories,
                total: repos.length,
                page,
                perPage,
                hasMore: repos.length === perPage,
            };
        } catch (error) {
            this.logger.error('Failed to fetch user repositories', error);
            throw new BadRequestException('Failed to fetch repositories');
        }
    }

    /**
     * Initiate a directory import
     */
    async initiateImport(
        dto: ImportDirectoryDto,
        user: User,
        context: OperationTriggerContext = DEFAULT_TRIGGER_CONTEXT,
    ): Promise<ImportDirectoryResponseDto> {
        const parsed = this.sourceRepoAnalyzer.parseGitUrl(dto.sourceUrl);
        if (!parsed) {
            return {
                status: 'error',
                message: 'Invalid repository URL format',
            };
        }

        const normalizedName = this.normalizeDirectoryName(dto.name, dto.sourceType);
        let slug = slugifyText(normalizedName);

        const existingDir = await this.directoryRepository.findByOwnerAndSlug({
            userId: user.id,
            owner: dto.owner || user.username,
            slug,
        });

        if (existingDir) {
            return {
                status: 'error',
                message: `A directory with slug "${slug}" already exists`,
            };
        }

        try {
            if (!dto.gitProvider) {
                return {
                    status: 'error',
                    message: 'Git provider is required',
                };
            }

            // Validate selected providers are configured before creating directory
            if (dto.sourceType === ImportSourceTypeEnum.AWESOME_README) {
                await this.generatorFormSchemaService.validateSelectedProviders(dto.providers, {
                    userId: user.id,
                });
            }

            let worksConfig: ParsedWorksConfig | null = null;
            if (dto.sourceType === ImportSourceTypeEnum.WORKS_CONFIG) {
                const token = await this.getProviderToken(user, dto.gitProvider);
                worksConfig = await this.worksConfigService.loadFromRepository(
                    parsed.owner,
                    parsed.repo,
                    dto.gitProvider,
                    token,
                );

                if (!worksConfig?.initialPrompt) {
                    return {
                        status: 'error',
                        message: 'works.yml is missing initial_prompt',
                    };
                }

                await this.generatorFormSchemaService.validateSelectedProviders(
                    worksConfig.providers,
                    { userId: user.id },
                );
            }

            if (dto.sourceType !== ImportSourceTypeEnum.LINK_EXISTING) {
                slug = await this.resolveSlugConflicts(
                    slug,
                    dto.owner || user.username,
                    user,
                    dto.gitProvider,
                    dto.sourceType === ImportSourceTypeEnum.WORKS_CONFIG
                        ? this.getWorksConfigConflictRepoNames(slug, parsed.repo, worksConfig)
                        : undefined,
                );
            }

            // For link_existing, the owner must be the source repo's owner
            // since the repos already exist under that account
            const directoryOwner =
                dto.sourceType === ImportSourceTypeEnum.LINK_EXISTING ? parsed.owner : dto.owner;

            const directory = await this.directoryRepository.create(
                {
                    slug,
                    name: normalizedName,
                    description: `Imported from ${dto.sourceUrl}`,
                    userId: user.id,
                    owner: directoryOwner,
                    organization: dto.organization || false,
                    gitProvider: dto.gitProvider,
                    deployProvider: dto.deployProvider,
                },
                user,
            );

            if (dto.sourceType === ImportSourceTypeEnum.LINK_EXISTING) {
                return this.handleLinkExisting(directory, dto, parsed, user);
            }

            if (dto.sourceType === ImportSourceTypeEnum.WORKS_CONFIG) {
                await this.applyWorksConfigPipelineSettings(directory.id, user.id, worksConfig);
            }

            const updateData: Partial<Directory> = {
                generateStatus: {
                    status: GenerateStatusType.GENERATING,
                    step: 'import_started',
                },
            };

            if (dto.sourceType === ImportSourceTypeEnum.AWESOME_README) {
                updateData.sourceRepository = {
                    url: dto.sourceUrl,
                    owner: parsed.owner,
                    repo: parsed.repo,
                    type: dto.sourceType as ImportSourceType,
                    importedAt: new Date(),
                };
            } else if (dto.sourceType === ImportSourceTypeEnum.WORKS_CONFIG) {
                updateData.sourceRepository = {
                    url: dto.sourceUrl,
                    owner: parsed.owner,
                    repo: parsed.repo,
                    type: dto.sourceType as ImportSourceType,
                    importedAt: new Date(),
                    worksConfig: this.toWorksConfigSnapshot(worksConfig),
                    relatedRepositories: {
                        directory: {
                            owner: parsed.owner,
                            repo: parsed.repo,
                        },
                        ...(worksConfig?.websiteRepositoryTarget
                            ? {
                                  website: worksConfig.websiteRepositoryTarget,
                              }
                            : {}),
                    },
                };
            }

            await this.directoryRepository.update(directory.id, updateData);
            Object.assign(directory, updateData);

            const history = await this.generationHistoryRepository.createEntry({
                directoryId: directory.id,
                userId: user.id,
                status: GenerateStatusType.GENERATING,
                generationMethod: GenerationMethod.IMPORT,
                parameters: {
                    sourceUrl: dto.sourceUrl,
                    sourceType: dto.sourceType,
                    sourceOwner: parsed.owner,
                    sourceRepo: parsed.repo,
                },
                triggeredBy: context.triggeredBy,
                scheduleId: context.scheduleId ?? null,
                startedAt: new Date(),
            });

            // Dispatch to Trigger.dev or run in-process with fallback
            await this.dispatchImportTask(
                directory,
                user,
                dto,
                parsed,
                history,
                context,
                worksConfig,
            );

            // Enable sync schedule only for awesome_readme imports
            if (dto.sync !== false && dto.sourceType === ImportSourceTypeEnum.AWESOME_README) {
                try {
                    await this.directoryScheduleService.updateSchedule(
                        directory.id,
                        {
                            enable: true,
                            cadence: DirectoryScheduleCadence.WEEKLY,
                            alwaysCreatePullRequest: true,
                        },
                        user,
                    );
                    this.logger.log(`Created sync schedule for directory ${directory.id}`);
                } catch (err) {
                    this.logger.warn(
                        `Failed to create sync schedule for directory ${directory.id}: ${err.message}`,
                    );
                }
            }

            return {
                status: 'success',
                directoryId: directory.id,
                historyId: history.id,
                message: 'Import started',
            };
        } catch (error) {
            this.logger.error('Failed to initiate import', error);

            if (error instanceof HttpException) {
                throw error;
            }

            return {
                status: 'error',
                message: normalizeGeneratorError(error),
            };
        }
    }

    private async dispatchImportTask(
        directory: Directory,
        user: User,
        dto: ImportDirectoryDto,
        parsed: { owner: string; repo: string },
        history: DirectoryGenerationHistory,
        context: OperationTriggerContext,
        worksConfig?: ParsedWorksConfig | null,
    ): Promise<void> {
        await Promise.all([
            this.directoryRepository.recordGenerationStartTime(directory.id, new Date()),
            this.directoryRepository.updateGenerateStatus(directory.id, {
                status: GenerateStatusType.GENERATING,
            }),
        ]);

        const payload: DirectoryImportPayload = {
            directoryId: directory.id,
            userId: user.id,
            sourceUrl: dto.sourceUrl,
            sourceOwner: parsed.owner,
            sourceRepo: parsed.repo,
            sourceType: dto.sourceType as ImportSourceType,
            historyId: history.id,
            historyStartedAt:
                history?.startedAt?.toISOString() ??
                history?.createdAt?.toISOString() ??
                new Date().toISOString(),
            triggerSource: context.triggeredBy,
            options: {
                createMissingRepos: dto.createMissingRepos ?? false,
                enableSync: dto.sync ?? true,
            },
            providers: dto.providers,
            enrichmentConfig: dto.enrichmentConfig,
            worksConfig: worksConfig ?? null,
        };

        const dispatchedId = this.importDispatcher
            ? await this.importDispatcher.dispatchDirectoryImport(payload)
            : null;

        if (dispatchedId) {
            await this.generationHistoryRepository.updateEntry(history.id, {
                triggerRunId: dispatchedId,
            });
            return;
        }

        this.logger.warn(
            `Trigger dispatch failed, falling back to in-process import for directory ${directory.id}`,
        );

        // If triggered by schedule, await to prevent concurrency explosion
        // For user/api triggers, fire-and-forget
        if (context.triggeredBy === 'schedule') {
            await this.processImport(directory, user, dto, parsed, history, worksConfig);
        } else {
            void this.processImport(directory, user, dto, parsed, history, worksConfig);
        }
    }

    /**
     * Process the import in-process (fallback when Trigger.dev is unavailable)
     */
    private async processImport(
        directory: Directory,
        user: User,
        dto: ImportDirectoryDto,
        parsed: { owner: string; repo: string },
        history: DirectoryGenerationHistory,
        worksConfig?: ParsedWorksConfig | null,
    ): Promise<void> {
        const startTime = new Date();

        await Promise.all([
            this.directoryRepository.recordGenerationStartTime(directory.id, startTime),
            this.directoryRepository.updateGenerateStatus(directory.id, {
                status: GenerateStatusType.GENERATING,
            }),
        ]);

        await this.generationHistoryRepository.updateEntry(history.id, {
            startedAt: startTime,
            status: GenerateStatusType.GENERATING,
        });

        let result: DirectoryImportResult | null = null;

        try {
            const token = await this.getProviderToken(user, directory.gitProvider);

            result = await this.importExecutor.executeBySourceType({
                directory,
                user,
                sourceType: dto.sourceType as ImportSourceType,
                sourceOwner: parsed.owner,
                sourceRepo: parsed.repo,
                sourceUrl: dto.sourceUrl,
                token,
                createMissingRepos: dto.createMissingRepos,
                expansionFactor: dto.enrichmentConfig?.expansionFactor,
                providers: dto.providers,
                worksConfig,
            });

            if (!result.success) {
                throw new Error(result.error || 'Import failed');
            }

            const endTime = new Date();

            await Promise.all([
                this.directoryRepository.recordGenerationFinishTime(directory.id, endTime),
                this.directoryRepository.updateGenerateStatus(directory.id, {
                    status: GenerateStatusType.GENERATED,
                }),
                this.directoryRepository.update(directory.id, {
                    itemsCount: result.itemsImported,
                }),
            ]);

            await this.generationHistoryRepository.updateEntry(history.id, {
                status: GenerateStatusType.GENERATED,
                finishedAt: endTime,
                durationInSeconds: calculateDurationSeconds(startTime, endTime),
                ...buildImportStatsUpdate(result),
            });

            if (
                dto.sourceType === ImportSourceTypeEnum.WORKS_CONFIG &&
                worksConfig?.scheduleCadence
            ) {
                await this.directoryScheduleService.updateSchedule(
                    directory.id,
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

            this.eventEmitter.emit(
                DirectoryGenerationCompletedEvent.EVENT_NAME,
                new DirectoryGenerationCompletedEvent(directory),
            );
        } catch (error) {
            const endTime = new Date();
            const errorMessage = normalizeGeneratorError(error);

            await Promise.all([
                this.directoryRepository.recordGenerationFinishTime(directory.id, endTime),
                this.directoryRepository.updateGenerateStatus(directory.id, {
                    status: GenerateStatusType.ERROR,
                    error: errorMessage,
                }),
            ]);

            await this.generationHistoryRepository.updateEntry(history.id, {
                status: GenerateStatusType.ERROR,
                finishedAt: endTime,
                durationInSeconds: calculateDurationSeconds(startTime, endTime),
                errorMessage,
                ...buildImportStatsUpdate(result),
            });

            this.logger.error(`Import failed for directory ${directory.id}`, error);

            this.eventEmitter.emit(
                DirectoryGenerationCompletedEvent.EVENT_NAME,
                new DirectoryGenerationCompletedEvent(directory),
            );
        }
    }

    /**
     * Sync directory from original source
     */
    async syncDirectory(
        directory: Directory,
        user: User,
        historyId?: string,
    ): Promise<DirectoryImportResult> {
        const startTime = new Date();
        const sourceRepo = directory.sourceRepository;

        if (!sourceRepo) {
            return {
                success: false,
                directoryId: directory.id,
                error: 'No source repository configured',
                errorCode: DirectoryImportErrorCode.PARSE_FAILED,
            };
        }

        try {
            let result: DirectoryImportResult;

            if (sourceRepo.type === ImportSourceTypeEnum.DATA_REPO) {
                result = await this.syncFromDataRepo(directory, user, {
                    owner: sourceRepo.owner,
                    repo: sourceRepo.repo,
                });
            } else if (sourceRepo.type === ImportSourceTypeEnum.AWESOME_README) {
                result = await this.syncFromAwesomeReadme(directory, user, sourceRepo.url);
            } else if (sourceRepo.type === ImportSourceTypeEnum.WORKS_CONFIG) {
                result = await this.syncFromWorksConfig(directory, user, {
                    owner: sourceRepo.owner,
                    repo: sourceRepo.repo,
                });
            } else {
                // For LINK_EXISTING or others, we assume it's up to date via direct git operations
                return {
                    success: true,
                    directoryId: directory.id,
                    itemsImported: 0,
                };
            }

            if (result.success && historyId) {
                const finishedAt = new Date();
                await this.generationHistoryRepository.updateEntry(historyId, {
                    status: GenerateStatusType.GENERATED,
                    finishedAt,
                    durationInSeconds: calculateDurationSeconds(startTime, finishedAt),
                    ...buildImportStatsUpdate(result),
                });

                this.eventEmitter.emit(
                    DirectoryGenerationCompletedEvent.EVENT_NAME,
                    new DirectoryGenerationCompletedEvent(directory),
                );
            }

            return result;
        } catch (error) {
            this.logger.error(`Sync failed for directory ${directory.id}`, error);
            return {
                success: false,
                directoryId: directory.id,
                error: error.message,
                errorCode: DirectoryImportErrorCode.CLONE_FAILED,
            };
        }
    }

    private async syncFromDataRepo(
        directory: Directory,
        user: User,
        source: { owner: string; repo: string },
    ): Promise<DirectoryImportResult> {
        const options = { userId: user.id, providerId: directory.gitProvider };
        const hasCredentials = await this.gitFacade.hasValidCredentials(options);

        if (!hasCredentials) {
            return {
                success: false,
                directoryId: directory.id,
                error: 'Git provider token not available',
                errorCode: DirectoryImportErrorCode.REPO_ACCESS_DENIED,
            };
        }

        try {
            const sourceDir = await this.gitFacade.cloneOrPull(
                {
                    owner: source.owner,
                    repo: source.repo,
                    committer: directory.resolveCommitter(user),
                },
                { userId: user.id, providerId: directory.gitProvider },
            );

            const sourceData = await DataRepository.create(sourceDir);
            const items = await sourceData.getItems();
            const categories = await sourceData.getCategories().catch(() => []);
            const tags = await sourceData.getTags().catch(() => []);

            const syncResult = await this.dataGenerator.updateWithImportedData(
                directory,
                user,
                { items, categories, tags },
                { updateWithPullRequest: true },
            );

            if (syncResult.success === false) {
                return {
                    success: false,
                    directoryId: directory.id,
                    error: syncResult.error.message,
                    errorCode: DirectoryImportErrorCode.GENERATION_FAILED,
                };
            }

            // Regenerate markdown and website if there were changes
            if (syncResult.stats.newItemsCount > 0 || syncResult.stats.updatedItemsCount > 0) {
                await this.markdownGenerator.initialize(directory, user, {
                    generation_method: GenerationMethod.CREATE_UPDATE,
                    pr_update: syncResult.prUpdate
                        ? {
                              branch: syncResult.prUpdate.branch,
                              title: syncResult.prUpdate.title,
                              body: syncResult.prUpdate.body,
                          }
                        : undefined,
                });
                await this.websiteGenerator.initialize(directory, user);
            }

            return {
                success: true,
                directoryId: directory.id,
                itemsImported: syncResult.stats.newItemsCount,
                stats: syncResult.stats,
            };
        } catch (error) {
            return {
                success: false,
                directoryId: directory.id,
                error: error.message,
                errorCode: DirectoryImportErrorCode.CLONE_FAILED,
            };
        }
    }

    private async syncFromAwesomeReadme(
        directory: Directory,
        user: User,
        sourceUrl: string,
    ): Promise<DirectoryImportResult> {
        return this.importExecutor.importFromAwesomeReadme({
            directory,
            user,
            sourceUrl,
            updateWithPullRequest: true,
        });
    }

    private async syncFromWorksConfig(
        directory: Directory,
        user: User,
        source: { owner: string; repo: string },
    ): Promise<DirectoryImportResult> {
        const token = await this.getProviderToken(user, directory.gitProvider);
        const worksConfig = await this.worksConfigService.loadFromRepository(
            source.owner,
            source.repo,
            directory.gitProvider,
            token,
        );

        await this.directoryRepository.update(directory.id, {
            sourceRepository: {
                ...(directory.sourceRepository || {
                    url: this.gitFacade.getWebUrl(directory.gitProvider, source.owner, source.repo),
                    owner: source.owner,
                    repo: source.repo,
                    type: ImportSourceTypeEnum.WORKS_CONFIG as ImportSourceType,
                    importedAt: new Date(),
                }),
                owner: source.owner,
                repo: source.repo,
                type: ImportSourceTypeEnum.WORKS_CONFIG as ImportSourceType,
                worksConfig: this.toWorksConfigSnapshot(worksConfig),
                relatedRepositories: {
                    ...(directory.sourceRepository?.relatedRepositories || {}),
                    directory: {
                        owner: source.owner,
                        repo: source.repo,
                    },
                    ...(worksConfig?.websiteRepositoryTarget
                        ? {
                              website: worksConfig.websiteRepositoryTarget,
                          }
                        : {}),
                },
            },
        });

        if (
            directory.scheduledUpdatesEnabled &&
            (worksConfig?.scheduleCadence || worksConfig?.providers)
        ) {
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

        await this.applyWorksConfigPipelineSettings(directory.id, user.id, worksConfig);

        return this.importExecutor.importFromWorksConfig({
            directory,
            user,
            source,
            token,
            worksConfig,
        });
    }

    private async cleanupFailedImport(directoryId: string, historyId: string): Promise<void> {
        try {
            await this.generationHistoryRepository.deleteEntry(historyId);
            await this.directoryRepository.delete(directoryId);
            this.logger.log(`Cleaned up failed import: directory ${directoryId}`);
        } catch (error) {
            this.logger.error(`Failed to cleanup after import failure: ${error.message}`);
        }
    }

    private async getProviderToken(user: User, providerId?: string): Promise<string | undefined> {
        const token = await this.gitFacade.getAccessToken({
            userId: user.id,
            providerId: providerId,
        });
        return token ?? undefined;
    }

    private getProviderFromUrl(url: string): string | undefined {
        const parsed = this.sourceRepoAnalyzer.parseGitUrl(url);
        return parsed?.provider;
    }

    private async resolveSlugConflicts(
        slug: string,
        repoOwner: string,
        user: User,
        gitProvider: string,
        includeRepoNames?: string[],
    ): Promise<string> {
        const token = await this.getProviderToken(user, gitProvider);
        if (!token) {
            return slug;
        }

        const conflict = await this.sourceRepoAnalyzer.checkSlugConflicts(
            repoOwner,
            slug,
            token,
            gitProvider,
            includeRepoNames ? { includeRepoNames } : undefined,
        );

        if (!conflict.hasConflict) {
            return slug;
        }

        // Verify the suggested slug isn't already in our DB before accepting it
        const suggested = conflict.suggestedSlug;
        if (suggested !== slug) {
            const dbExists = await this.directoryRepository.findByOwnerAndSlug({
                userId: user.id,
                owner: repoOwner,
                slug: suggested,
            });
            if (!dbExists) {
                this.logger.log(
                    `Slug conflict resolved: "${slug}" → "${suggested}" for ${repoOwner}`,
                );
                return suggested;
            }
        }

        const fallback = `${slug}-${Date.now()}`;
        this.logger.log(`Slug conflict fallback: "${slug}" → "${fallback}" for ${repoOwner}`);
        return fallback;
    }

    private async handleLinkExisting(
        directory: Directory,
        dto: ImportDirectoryDto,
        parsed: { owner: string; repo: string },
        user: User,
    ): Promise<ImportDirectoryResponseDto> {
        const now = new Date();

        await this.directoryRepository.update(directory.id, {
            generateStatus: {
                status: GenerateStatusType.GENERATED,
                step: 'linked',
            },
            sourceRepository: {
                url: dto.sourceUrl,
                owner: parsed.owner,
                repo: parsed.repo,
                type: ImportSourceTypeEnum.LINK_EXISTING as ImportSourceType,
                importedAt: now,
            },
        });

        const history = await this.generationHistoryRepository.createEntry({
            directoryId: directory.id,
            userId: user.id,
            status: GenerateStatusType.GENERATED,
            generationMethod: GenerationMethod.IMPORT,
            parameters: {
                sourceUrl: dto.sourceUrl,
                sourceType: dto.sourceType,
                sourceOwner: parsed.owner,
                sourceRepo: parsed.repo,
            },
            triggeredBy: 'user',
            scheduleId: null,
            startedAt: now,
        });

        await this.generationHistoryRepository.updateEntry(history.id, {
            finishedAt: now,
            durationInSeconds: 0,
        });

        this.logger.log(`Linked directory ${directory.id} to existing repos at ${dto.sourceUrl}`);

        this.eventEmitter.emit(
            DirectoryGenerationCompletedEvent.EVENT_NAME,
            new DirectoryGenerationCompletedEvent(directory),
        );

        return {
            status: 'success',
            directoryId: directory.id,
            message: 'Directory linked to existing repositories',
        };
    }

    /**
     * Normalize directory name by stripping -data suffix for data repo imports.
     * This prevents naming conflicts where a repo like "my-dir-data" would
     * result in "my-dir-data-data" for the data repository.
     */
    private normalizeDirectoryName(name: string, sourceType: ImportSourceTypeEnum): string {
        // Only normalize for data_repo and link_existing imports
        if (
            sourceType !== ImportSourceTypeEnum.DATA_REPO &&
            sourceType !== ImportSourceTypeEnum.LINK_EXISTING
        ) {
            return name;
        }

        // Check both the original name and slugified version for -data / -website suffix
        const slugified = slugifyText(name);

        if (slugified.endsWith('-data') || slugified.endsWith('-website')) {
            const suffix = slugified.endsWith('-data') ? 'data' : 'website';
            const suffixLen = suffix.length;
            const trimmed = name.trim();

            // Check for " Data" / " Website" suffix (case-insensitive)
            const spaceSuffixRegex = new RegExp(`\\s+${suffix}$`, 'i');
            if (spaceSuffixRegex.test(trimmed)) {
                return trimmed.replace(spaceSuffixRegex, '');
            }

            // Check for "-Data" / "-Website" suffix (case-insensitive)
            const dashSuffixRegex = new RegExp(`-${suffix}$`, 'i');
            if (dashSuffixRegex.test(trimmed)) {
                return trimmed.replace(dashSuffixRegex, '');
            }

            // Fallback: strip from slugified and convert back to title case
            const baseSlug = slugified.slice(0, -(suffixLen + 1)); // +1 for the dash
            return baseSlug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
        }

        return name;
    }
}
