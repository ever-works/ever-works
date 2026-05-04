import {
    BadRequestException,
    HttpException,
    Inject,
    Injectable,
    Logger,
    Optional,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { WorkRepository } from '@src/database/repositories/work.repository';
import { WorkGenerationHistoryRepository } from '@src/database/repositories/work-generation-history.repository';
import { DataGeneratorService } from '@src/generators/data-generator/data-generator.service';
import { DataRepository } from '@src/generators/data-generator/data-repository';
import { MarkdownGeneratorService } from '@src/generators/markdown-generator/markdown-generator.service';
import { WebsiteGeneratorService } from '@src/generators/website-generator/website-generator.service';
import { GitFacadeService } from '@src/facades/git.facade';
import { SourceRepoAnalyzerService } from '@src/import/source-repo-analyzer.service';
import { ImportExecutorService } from '@src/import/import-executor.service';
import {
    LINKED_WORK_SYNC_UNSUPPORTED_MESSAGE,
    supportsWorkSourceSync,
} from '@src/import/source-sync-support';
import {
    WorksConfigService,
    type ParsedWorksConfig,
    type ResolvedWorksConfig,
} from '@src/works-config/services/works-config.service';
import { WorksConfigRestoreService } from '@src/works-config/services/works-config-restore.service';
import {
    AnalyzeRepositoryDto,
    AnalyzeRepositoryResponseDto,
    AnalyzeForLinkingResponseDto,
    ImportWorkDto,
    ImportWorkResponseDto,
    ImportSourceTypeEnum,
    GetUserRepositoriesDto,
    GetUserRepositoriesResponseDto,
    GitRepoDto,
} from '@src/dto/import-work.dto';
import { Work, ImportSourceType, SourceRepository } from '@src/entities/work.entity';
import { User } from '@src/entities/user.entity';
import { WorkGenerationCompletedEvent } from '@src/events';
import { buildImportStatsUpdate } from '@src/work-operations';
import {
    WorkImportPayload,
    WorkImportResult,
    WorkImportErrorCode,
    WorkImportDispatcher,
    WORK_IMPORT_DISPATCHER,
} from '@src/tasks';
import { WorkScheduleService } from './work-schedule.service';
import { WorkScheduleCadence, GenerateStatusType } from '@src/entities/types';
import { normalizeGeneratorError } from './utils/error.utils';
import { calculateDurationSeconds } from '../utils/time.utils';
import { slugifyText } from '@src/utils/text.utils';
import { GenerationMethod } from '@src/items-generator/dto';
import { WorkGenerationHistory } from '@src/entities/work-generation-history.entity';
import { GeneratorFormSchemaService } from './generator-form-schema.service';

import { OperationTriggerContext, DEFAULT_TRIGGER_CONTEXT } from './types/trigger-context.types';

@Injectable()
export class WorkImportService {
    private readonly logger = new Logger(WorkImportService.name);

    constructor(
        private readonly workRepository: WorkRepository,
        private readonly generationHistoryRepository: WorkGenerationHistoryRepository,
        private readonly dataGenerator: DataGeneratorService,
        private readonly markdownGenerator: MarkdownGeneratorService,
        private readonly websiteGenerator: WebsiteGeneratorService,
        private readonly gitFacade: GitFacadeService,
        private readonly sourceRepoAnalyzer: SourceRepoAnalyzerService,
        private readonly importExecutor: ImportExecutorService,
        private readonly worksConfigService: WorksConfigService,
        private readonly worksConfigRestoreService: WorksConfigRestoreService,
        private readonly workScheduleService: WorkScheduleService,
        private readonly generatorFormSchemaService: GeneratorFormSchemaService,
        private readonly eventEmitter: EventEmitter2,
        @Optional()
        @Inject(WORK_IMPORT_DISPATCHER)
        private readonly importDispatcher?: WorkImportDispatcher,
    ) {}

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
                this.normalizeWorkName(baseSlug, ImportSourceTypeEnum.LINK_EXISTING),
            );

            try {
                const rawConflict = await this.sourceRepoAnalyzer.checkSlugConflicts(
                    repoOwner,
                    slug,
                    token,
                    providerId,
                    result.worksConfig
                        ? {
                              includeRepoNames: this.worksConfigRestoreService.getConflictRepoNames(
                                  slug,
                                  result.repo,
                                  result.worksConfig,
                              ),
                          }
                        : undefined,
                );
                const conflict = result.worksConfig
                    ? this.worksConfigRestoreService.sanitizeConflict(
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
     * Initiate a work import
     */
    async initiateImport(
        dto: ImportWorkDto,
        user: User,
        context: OperationTriggerContext = DEFAULT_TRIGGER_CONTEXT,
    ): Promise<ImportWorkResponseDto> {
        const parsed = this.sourceRepoAnalyzer.parseGitUrl(dto.sourceUrl);
        if (!parsed) {
            return {
                status: 'error',
                message: 'Invalid repository URL format',
            };
        }

        const normalizedName = this.normalizeWorkName(dto.name, dto.sourceType);
        let slug = slugifyText(normalizedName);

        const existingDir = await this.workRepository.findByOwnerAndSlug({
            userId: user.id,
            owner: dto.owner || user.username,
            slug,
        });

        if (existingDir) {
            return {
                status: 'error',
                message: `A work with slug "${slug}" already exists`,
            };
        }

        try {
            if (!dto.gitProvider) {
                return {
                    status: 'error',
                    message: 'Git provider is required',
                };
            }

            // Validate selected providers are configured before creating work
            if (dto.sourceType === ImportSourceTypeEnum.AWESOME_README) {
                await this.generatorFormSchemaService.validateSelectedProviders(dto.providers, {
                    userId: user.id,
                });
            }

            const shouldRestoreWorksConfig =
                dto.sourceType === ImportSourceTypeEnum.WORKS_CONFIG ||
                dto.restoreWorksConfig !== false;

            let worksConfig: ParsedWorksConfig | null = null;
            if (
                shouldRestoreWorksConfig &&
                (dto.sourceType === ImportSourceTypeEnum.WORKS_CONFIG ||
                    dto.sourceType === ImportSourceTypeEnum.DATA_REPO ||
                    dto.sourceType === ImportSourceTypeEnum.AWESOME_README)
            ) {
                const token = await this.getProviderToken(user, dto.gitProvider);
                worksConfig = await this.worksConfigService.loadFromRepository(
                    parsed.owner,
                    parsed.repo,
                    dto.gitProvider,
                    token,
                );

                if (dto.sourceType === ImportSourceTypeEnum.WORKS_CONFIG) {
                    await this.worksConfigRestoreService.validateForImport(worksConfig, user.id);
                } else {
                    await this.worksConfigRestoreService.validateProviderSettings(
                        worksConfig,
                        user.id,
                    );
                }

                this.worksConfigRestoreService.validateRepositoryTargets(
                    { owner: parsed.owner, repo: parsed.repo },
                    worksConfig,
                );
            }

            if (dto.sourceType !== ImportSourceTypeEnum.LINK_EXISTING) {
                slug = await this.resolveSlugConflicts(
                    slug,
                    dto.owner || user.username,
                    user,
                    dto.gitProvider,
                    worksConfig
                        ? this.worksConfigRestoreService.getConflictRepoNames(
                              slug,
                              parsed.repo,
                              worksConfig,
                          )
                        : undefined,
                );
            }

            // For link_existing, the owner must be the source repo's owner
            // since the repos already exist under that account
            const workOwner =
                dto.sourceType === ImportSourceTypeEnum.LINK_EXISTING ? parsed.owner : dto.owner;

            const work = await this.workRepository.create(
                {
                    slug,
                    name: normalizedName,
                    description: `Imported from ${dto.sourceUrl}`,
                    userId: user.id,
                    owner: workOwner,
                    organization: dto.organization || false,
                    gitProvider: dto.gitProvider,
                    deployProvider: dto.deployProvider,
                },
                user,
            );

            if (dto.sourceType === ImportSourceTypeEnum.LINK_EXISTING) {
                return this.handleLinkExisting(work, dto, parsed, user);
            }

            if (worksConfig) {
                await this.worksConfigRestoreService.applyPipelineSettings(
                    work.id,
                    user.id,
                    worksConfig,
                );
            }

            const updateData: Partial<Work> = {
                generateStatus: {
                    status: GenerateStatusType.GENERATING,
                    step: 'import_started',
                },
            };

            if (dto.sourceType === ImportSourceTypeEnum.AWESOME_README) {
                updateData.sourceRepository = this.worksConfigRestoreService.buildSourceRepository({
                    sourceUrl: dto.sourceUrl,
                    sourceOwner: parsed.owner,
                    sourceRepo: parsed.repo,
                    sourceType: dto.sourceType as ImportSourceType,
                    sourceRole: null,
                    worksConfig,
                });
            } else if (dto.sourceType === ImportSourceTypeEnum.DATA_REPO) {
                updateData.sourceRepository = this.worksConfigRestoreService.buildSourceRepository({
                    sourceUrl: dto.sourceUrl,
                    sourceOwner: parsed.owner,
                    sourceRepo: parsed.repo,
                    sourceType: dto.sourceType as ImportSourceType,
                    sourceRole: 'data',
                    worksConfig,
                });
            } else if (dto.sourceType === ImportSourceTypeEnum.WORKS_CONFIG) {
                updateData.sourceRepository = this.worksConfigRestoreService.buildSourceRepository({
                    sourceUrl: dto.sourceUrl,
                    sourceOwner: parsed.owner,
                    sourceRepo: parsed.repo,
                    sourceType: dto.sourceType as ImportSourceType,
                    worksConfig,
                });
            }

            await this.workRepository.update(work.id, updateData);
            Object.assign(work, updateData);

            const history = await this.generationHistoryRepository.createEntry({
                workId: work.id,
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
                work,
                user,
                dto,
                parsed,
                history,
                context,
                this.worksConfigRestoreService.toResolved(worksConfig),
            );

            // Enable sync schedule only for awesome_readme imports
            if (dto.sync !== false && dto.sourceType === ImportSourceTypeEnum.AWESOME_README) {
                try {
                    await this.workScheduleService.updateSchedule(
                        work.id,
                        {
                            enable: true,
                            cadence: WorkScheduleCadence.WEEKLY,
                            alwaysCreatePullRequest: true,
                        },
                        user,
                    );
                    this.logger.log(`Created sync schedule for work ${work.id}`);
                } catch (err) {
                    this.logger.warn(
                        `Failed to create sync schedule for work ${work.id}: ${err.message}`,
                    );
                }
            }

            return {
                status: 'success',
                workId: work.id,
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

    async onboardLinkedRepository(
        input: {
            sourceUrl: string;
            sourceOwner: string;
            sourceRepo: string;
            name: string;
            gitProvider: string;
            organization?: boolean;
            auth?: SourceRepository['auth'];
        },
        user: User,
    ): Promise<ImportWorkResponseDto> {
        const normalizedName = this.normalizeWorkName(
            input.name,
            ImportSourceTypeEnum.LINK_EXISTING,
        );
        const slug = slugifyText(normalizedName);

        const existingDir = await this.workRepository.findByOwnerAndSlug({
            userId: user.id,
            owner: input.sourceOwner,
            slug,
        });

        if (existingDir) {
            return {
                status: 'error',
                workId: existingDir.id,
                message: `A work with slug "${slug}" already exists`,
            };
        }

        const work = await this.workRepository.create(
            {
                slug,
                name: normalizedName,
                description: `Imported from ${input.sourceUrl}`,
                userId: user.id,
                owner: input.sourceOwner,
                organization: input.organization || false,
                gitProvider: input.gitProvider,
                deployProvider: undefined,
            },
            user,
        );

        return this.handleLinkExisting(
            work,
            {
                sourceUrl: input.sourceUrl,
                sourceType: ImportSourceTypeEnum.LINK_EXISTING,
                name: normalizedName,
                owner: input.sourceOwner,
                organization: input.organization || false,
                createMissingRepos: false,
                sync: false,
                restoreWorksConfig: false,
                gitProvider: input.gitProvider,
            } as ImportWorkDto,
            {
                owner: input.sourceOwner,
                repo: input.sourceRepo,
            },
            user,
            input.auth,
        );
    }

    private async dispatchImportTask(
        work: Work,
        user: User,
        dto: ImportWorkDto,
        parsed: { owner: string; repo: string },
        history: WorkGenerationHistory,
        context: OperationTriggerContext,
        worksConfig?: ResolvedWorksConfig | null,
    ): Promise<void> {
        await Promise.all([
            this.workRepository.recordGenerationStartTime(work.id, new Date()),
            this.workRepository.updateGenerateStatus(work.id, {
                status: GenerateStatusType.GENERATING,
            }),
        ]);

        const payload: WorkImportPayload = {
            workId: work.id,
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
            ? await this.importDispatcher.dispatchWorkImport(payload)
            : null;

        if (dispatchedId) {
            await this.generationHistoryRepository.updateEntry(history.id, {
                triggerRunId: dispatchedId,
            });
            return;
        }

        this.logger.warn(
            `Trigger dispatch failed, falling back to in-process import for work ${work.id}`,
        );

        // If triggered by schedule, await to prevent concurrency explosion
        // For user/api triggers, fire-and-forget
        if (context.triggeredBy === 'schedule') {
            await this.processImport(work, user, dto, parsed, history, worksConfig);
        } else {
            void this.processImport(work, user, dto, parsed, history, worksConfig);
        }
    }

    /**
     * Process the import in-process (fallback when Trigger.dev is unavailable)
     */
    private async processImport(
        work: Work,
        user: User,
        dto: ImportWorkDto,
        parsed: { owner: string; repo: string },
        history: WorkGenerationHistory,
        worksConfig?: ResolvedWorksConfig | null,
    ): Promise<void> {
        const startTime = new Date();

        await Promise.all([
            this.workRepository.recordGenerationStartTime(work.id, startTime),
            this.workRepository.updateGenerateStatus(work.id, {
                status: GenerateStatusType.GENERATING,
            }),
        ]);

        await this.generationHistoryRepository.updateEntry(history.id, {
            startedAt: startTime,
            status: GenerateStatusType.GENERATING,
        });

        let result: WorkImportResult | null = null;

        try {
            const token = await this.getProviderToken(user, work.gitProvider);

            result = await this.importExecutor.executeBySourceType({
                work,
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
                this.workRepository.recordGenerationFinishTime(work.id, endTime),
                this.workRepository.updateGenerateStatus(work.id, {
                    status: GenerateStatusType.GENERATED,
                }),
                this.workRepository.update(work.id, {
                    itemsCount: result.itemsImported,
                }),
            ]);

            await this.generationHistoryRepository.updateEntry(history.id, {
                status: GenerateStatusType.GENERATED,
                finishedAt: endTime,
                durationInSeconds: calculateDurationSeconds(startTime, endTime),
                ...buildImportStatsUpdate(result),
            });

            if (worksConfig) {
                await this.worksConfigRestoreService.applyInitialSchedule(
                    work.id,
                    user,
                    worksConfig,
                );
            }

            this.eventEmitter.emit(
                WorkGenerationCompletedEvent.EVENT_NAME,
                new WorkGenerationCompletedEvent(work),
            );
        } catch (error) {
            const endTime = new Date();
            const errorMessage = normalizeGeneratorError(error);

            await Promise.all([
                this.workRepository.recordGenerationFinishTime(work.id, endTime),
                this.workRepository.updateGenerateStatus(work.id, {
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

            this.logger.error(`Import failed for work ${work.id}`, error);

            this.eventEmitter.emit(
                WorkGenerationCompletedEvent.EVENT_NAME,
                new WorkGenerationCompletedEvent(work),
            );
        }
    }

    /**
     * Sync work from original source
     */
    async syncWork(work: Work, user: User, historyId?: string): Promise<WorkImportResult> {
        const startTime = new Date();
        const sourceRepo = work.sourceRepository;

        if (!sourceRepo) {
            return {
                success: false,
                workId: work.id,
                error: 'No source repository configured',
                errorCode: WorkImportErrorCode.PARSE_FAILED,
            };
        }

        try {
            let result: WorkImportResult;

            if (sourceRepo.type === ImportSourceTypeEnum.DATA_REPO) {
                result = await this.syncFromDataRepo(work, user, {
                    owner: sourceRepo.owner,
                    repo: sourceRepo.repo,
                });
            } else if (sourceRepo.type === ImportSourceTypeEnum.AWESOME_README) {
                result = await this.syncFromAwesomeReadme(work, user, sourceRepo.url);
            } else if (sourceRepo.type === ImportSourceTypeEnum.WORKS_CONFIG) {
                result = await this.syncFromWorksConfig(work, user, {
                    owner: sourceRepo.owner,
                    repo: sourceRepo.repo,
                });
            } else if (!supportsWorkSourceSync(sourceRepo.type)) {
                return {
                    success: false,
                    workId: work.id,
                    error: LINKED_WORK_SYNC_UNSUPPORTED_MESSAGE,
                    errorCode: WorkImportErrorCode.UNSUPPORTED_FORMAT,
                };
            } else {
                return {
                    success: false,
                    workId: work.id,
                    error: `Unsupported source repository type: ${sourceRepo.type}`,
                    errorCode: WorkImportErrorCode.UNSUPPORTED_FORMAT,
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
                    WorkGenerationCompletedEvent.EVENT_NAME,
                    new WorkGenerationCompletedEvent(work),
                );
            }

            return result;
        } catch (error) {
            this.logger.error(`Sync failed for work ${work.id}`, error);
            return {
                success: false,
                workId: work.id,
                error: error.message,
                errorCode: WorkImportErrorCode.CLONE_FAILED,
            };
        }
    }

    private async syncFromDataRepo(
        work: Work,
        user: User,
        source: { owner: string; repo: string },
    ): Promise<WorkImportResult> {
        const options = {
            userId: user.id,
            providerId: work.gitProvider,
            workId: work.id,
        };
        const hasCredentials = await this.gitFacade.hasValidCredentials(options);

        if (!hasCredentials) {
            return {
                success: false,
                workId: work.id,
                error: 'Git provider token not available',
                errorCode: WorkImportErrorCode.REPO_ACCESS_DENIED,
            };
        }

        try {
            const worksConfig = await this.loadAndApplySourceWorksConfig(work, user, {
                owner: source.owner,
                repo: source.repo,
                url: this.gitFacade.getWebUrl(work.gitProvider, source.owner, source.repo),
                type: ImportSourceTypeEnum.DATA_REPO as ImportSourceType,
                role: 'data',
            });
            const sourceDir = await this.gitFacade.cloneOrPull(
                {
                    owner: source.owner,
                    repo: source.repo,
                    committer: work.resolveCommitter(user),
                },
                { userId: user.id, providerId: work.gitProvider, workId: work.id },
            );

            const sourceData = await DataRepository.create(sourceDir);
            const items = await sourceData.getItems();
            const categories = await sourceData.getCategories().catch(() => []);
            const tags = await sourceData.getTags().catch(() => []);
            const config = await sourceData.getConfig().catch(() => ({}));

            const syncResult = await this.dataGenerator.updateWithImportedData(
                work,
                user,
                { items, categories, tags, config: config as Record<string, any>, worksConfig },
                { updateWithPullRequest: true },
            );

            if (syncResult.success === false) {
                return {
                    success: false,
                    workId: work.id,
                    error: syncResult.error.message,
                    errorCode: WorkImportErrorCode.GENERATION_FAILED,
                };
            }

            // Regenerate markdown and website if there were changes
            if (syncResult.stats.newItemsCount > 0 || syncResult.stats.updatedItemsCount > 0) {
                await this.markdownGenerator.initialize(work, user, {
                    generation_method: GenerationMethod.CREATE_UPDATE,
                    pr_update: syncResult.prUpdate
                        ? {
                              branch: syncResult.prUpdate.branch,
                              title: syncResult.prUpdate.title,
                              body: syncResult.prUpdate.body,
                          }
                        : undefined,
                });
                await this.websiteGenerator.initialize(work, user);
            }

            return {
                success: true,
                workId: work.id,
                itemsImported: syncResult.stats.newItemsCount,
                stats: syncResult.stats,
            };
        } catch (error) {
            return {
                success: false,
                workId: work.id,
                error: error.message,
                errorCode: WorkImportErrorCode.CLONE_FAILED,
            };
        }
    }

    private async syncFromAwesomeReadme(
        work: Work,
        user: User,
        sourceUrl: string,
    ): Promise<WorkImportResult> {
        const source = this.sourceRepoAnalyzer.parseGitUrl(sourceUrl);
        const worksConfig = source
            ? await this.loadAndApplySourceWorksConfig(work, user, {
                  owner: source.owner,
                  repo: source.repo,
                  url: sourceUrl,
                  type: ImportSourceTypeEnum.AWESOME_README as ImportSourceType,
                  role: null,
              })
            : null;

        return this.importExecutor.importFromAwesomeReadme({
            work,
            user,
            sourceUrl,
            updateWithPullRequest: true,
            worksConfig,
        });
    }

    private async syncFromWorksConfig(
        work: Work,
        user: User,
        source: { owner: string; repo: string },
    ): Promise<WorkImportResult> {
        const token = await this.getProviderToken(user, work.gitProvider);
        const worksConfig = await this.worksConfigService.loadFromRepository(
            source.owner,
            source.repo,
            work.gitProvider,
            token,
        );
        const previousSourceRepository =
            work.sourceRepository ||
            ({
                url: this.gitFacade.getWebUrl(work.gitProvider, source.owner, source.repo),
                owner: source.owner,
                repo: source.repo,
                type: ImportSourceTypeEnum.WORKS_CONFIG as ImportSourceType,
                importedAt: new Date(),
            } as SourceRepository);
        const updatedSourceRepository = this.worksConfigRestoreService.buildSourceRepository({
            sourceUrl: previousSourceRepository.url,
            sourceOwner: source.owner,
            sourceRepo: source.repo,
            sourceType: ImportSourceTypeEnum.WORKS_CONFIG as ImportSourceType,
            previous: previousSourceRepository,
            worksConfig,
        });

        await this.workRepository.update(work.id, {
            sourceRepository: updatedSourceRepository,
        });
        work.sourceRepository = updatedSourceRepository;

        await this.worksConfigRestoreService.applyScheduleOverrides(work, user, worksConfig);
        await this.worksConfigRestoreService.applyPipelineSettings(work.id, user.id, worksConfig);

        return this.importExecutor.importFromWorksConfig({
            work,
            user,
            source,
            token,
            worksConfig: this.worksConfigRestoreService.toResolved(worksConfig),
        });
    }

    private async cleanupFailedImport(workId: string, historyId: string): Promise<void> {
        try {
            await this.generationHistoryRepository.deleteEntry(historyId);
            await this.workRepository.delete(workId);
            this.logger.log(`Cleaned up failed import: work ${workId}`);
        } catch (error) {
            this.logger.error(`Failed to cleanup after import failure: ${error.message}`);
        }
    }

    private async loadAndApplySourceWorksConfig(
        work: Work,
        user: User,
        source: {
            owner: string;
            repo: string;
            url: string;
            type: ImportSourceType;
            role: 'data' | 'work' | null;
        },
    ): Promise<ResolvedWorksConfig | null> {
        const token = await this.getProviderToken(user, work.gitProvider);
        const parsedWorksConfig = await this.worksConfigService.loadFromRepository(
            source.owner,
            source.repo,
            work.gitProvider,
            token,
        );

        if (!parsedWorksConfig) {
            return null;
        }

        const updatedSourceRepository = this.worksConfigRestoreService.buildSourceRepository({
            sourceUrl: source.url,
            sourceOwner: source.owner,
            sourceRepo: source.repo,
            sourceType: source.type,
            sourceRole: source.role,
            previous: work.sourceRepository,
            worksConfig: parsedWorksConfig,
        });

        await this.workRepository.update(work.id, {
            sourceRepository: updatedSourceRepository,
        });
        work.sourceRepository = updatedSourceRepository;

        await this.worksConfigRestoreService.applyScheduleOverrides(work, user, parsedWorksConfig);
        await this.worksConfigRestoreService.applyPipelineSettings(
            work.id,
            user.id,
            parsedWorksConfig,
        );

        return this.worksConfigRestoreService.toResolved(parsedWorksConfig);
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
            const dbExists = await this.workRepository.findByOwnerAndSlug({
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
        work: Work,
        dto: ImportWorkDto,
        parsed: { owner: string; repo: string },
        user: User,
        auth?: SourceRepository['auth'],
    ): Promise<ImportWorkResponseDto> {
        const now = new Date();

        await this.workRepository.update(work.id, {
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
                auth,
            },
        });

        const history = await this.generationHistoryRepository.createEntry({
            workId: work.id,
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

        this.logger.log(`Linked work ${work.id} to existing repos at ${dto.sourceUrl}`);

        this.eventEmitter.emit(
            WorkGenerationCompletedEvent.EVENT_NAME,
            new WorkGenerationCompletedEvent(work),
        );

        return {
            status: 'success',
            workId: work.id,
            message: 'Work linked to existing repositories',
        };
    }

    /**
     * Normalize work name by stripping -data suffix for data repo imports.
     * This prevents naming conflicts where a repo like "my-dir-data" would
     * result in "my-dir-data-data" for the data repository.
     */
    private normalizeWorkName(name: string, sourceType: ImportSourceTypeEnum): string {
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
