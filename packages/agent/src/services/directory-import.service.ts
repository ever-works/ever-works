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
import { AwesomeReadmeParserService } from '@src/import/awesome-readme-parser.service';
import { ImportExecutorService } from '@src/import/import-executor.service';
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
import { Directory, ImportSourceType, SourceRepository } from '@src/entities/directory.entity';
import { User } from '@src/entities/user.entity';
import { DirectoryGenerationCompletedEvent } from '@src/events';
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
import { slugifyText } from '@src/utils/text.utils';
import { GenerationMethod } from '@src/items-generator/dto';
import { DirectoryGenerationHistory } from '@src/entities/directory-generation-history.entity';

type ImportTriggerContext = {
    triggeredBy: 'user' | 'schedule' | 'api';
    scheduleId?: string;
};

const DEFAULT_IMPORT_CONTEXT: ImportTriggerContext = { triggeredBy: 'user' };

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
        private readonly awesomeReadmeParser: AwesomeReadmeParserService,
        private readonly importExecutor: ImportExecutorService,
        private readonly directoryScheduleService: DirectoryScheduleService,
        private readonly eventEmitter: EventEmitter2,
        @Optional()
        @Inject(DIRECTORY_IMPORT_DISPATCHER)
        private readonly importDispatcher?: DirectoryImportDispatcher,
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
        return this.sourceRepoAnalyzer.analyzeRepository(dto.sourceUrl, token);
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
        context: ImportTriggerContext = DEFAULT_IMPORT_CONTEXT,
    ): Promise<ImportDirectoryResponseDto> {
        const parsed = this.sourceRepoAnalyzer.parseGitUrl(dto.sourceUrl);
        if (!parsed) {
            return {
                status: 'error',
                message: 'Invalid repository URL format',
            };
        }

        const normalizedName = this.normalizeDirectoryName(dto.name, dto.sourceType);
        const slug = slugifyText(normalizedName);

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

            const directory = await this.directoryRepository.create(
                {
                    slug,
                    name: normalizedName,
                    description: `Imported from ${dto.sourceUrl}`,
                    userId: user.id,
                    owner: dto.owner,
                    organization: dto.organization || false,
                    gitProvider: dto.gitProvider,
                },
                user,
            );

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
            }

            await this.directoryRepository.update(directory.id, updateData);

            const history = await this.generationHistoryRepository.createEntry({
                directoryId: directory.id,
                userId: user.id,
                status: GenerateStatusType.GENERATING,
                generationMethod: 'import' as any,
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
            await this.dispatchImportTask(directory, user, dto, parsed, history, context);

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
        context: ImportTriggerContext,
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
            await this.processImport(directory, user, dto, parsed, history);
        } else {
            void this.processImport(directory, user, dto, parsed, history);
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

            if (dto.sourceType === ImportSourceTypeEnum.DATA_REPO) {
                if (!token) {
                    throw new Error('Git provider token not available');
                }
                result = await this.importExecutor.importFromDataRepo({
                    directory,
                    user,
                    source: parsed,
                    token,
                });
            } else if (dto.sourceType === ImportSourceTypeEnum.AWESOME_README) {
                result = await this.importExecutor.importFromAwesomeReadme({
                    directory,
                    user,
                    sourceUrl: dto.sourceUrl,
                    token,
                });
            } else if (dto.sourceType === ImportSourceTypeEnum.LINK_EXISTING) {
                if (!token) {
                    throw new Error('Git provider token not available');
                }
                result = await this.importExecutor.linkExistingDataRepo({
                    directory,
                    user,
                    source: parsed,
                    token,
                    createMissingRepos: dto.createMissingRepos ?? false,
                });
            } else {
                throw new Error(`Unsupported source type: ${dto.sourceType}`);
            }

            if (!result.success) {
                throw new Error(result.error || 'Import failed');
            }

            const endTime = new Date();
            const duration = Math.round((endTime.getTime() - startTime.getTime()) / 1000);

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
                durationInSeconds: duration,
                newItemsCount: result.itemsImported ?? 0,
                totalItemsCount: result.itemsImported ?? 0,
                metrics: result.metrics
                    ? {
                          total_tokens_used: result.metrics.total_tokens_used ?? 0,
                          total_cost: result.metrics.total_cost ?? 0,
                          new_items_added_to_store: result.itemsImported ?? 0,
                          total_items_in_store: result.itemsImported ?? 0,
                      }
                    : undefined,
            });

            this.eventEmitter.emit(
                'directory.generation.completed',
                new DirectoryGenerationCompletedEvent(directory),
            );
        } catch (error) {
            const endTime = new Date();
            const duration = Math.round((endTime.getTime() - startTime.getTime()) / 1000);
            const errorMessage = error instanceof Error ? error.message : String(error);

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
                durationInSeconds: duration,
                errorMessage,
                newItemsCount: result?.itemsImported ?? 0,
                totalItemsCount: result?.itemsImported ?? 0,
            });

            this.logger.error(`Import failed for directory ${directory.id}`, error);

            this.eventEmitter.emit(
                'directory.generation.completed',
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
        const startTime = Date.now();
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
            } else {
                // For LINK_EXISTING or others, we assume it's up to date via direct git operations
                return {
                    success: true,
                    directoryId: directory.id,
                    itemsImported: 0,
                };
            }

            if (result.success && historyId) {
                await this.generationHistoryRepository.updateEntry(historyId, {
                    status: GenerateStatusType.GENERATED,
                    finishedAt: new Date(),
                    durationInSeconds: Math.round((Date.now() - startTime) / 1000),
                    newItemsCount: result.stats?.newItemsCount ?? 0,
                    updatedItemsCount: result.stats?.updatedItemsCount ?? 0,
                    totalItemsCount: result.stats?.totalItemsCount ?? 0,
                    metrics: result.metrics
                        ? {
                              total_tokens_used: result.metrics.total_tokens_used,
                              total_cost: result.metrics.total_cost,
                              new_items_added_to_store: result.stats?.newItemsCount ?? 0,
                              total_items_in_store: result.stats?.totalItemsCount ?? 0,
                          }
                        : undefined,
                });

                this.eventEmitter.emit(
                    'directory.generation.completed',
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
                    committer: user.asCommitter(),
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
        const providerId = this.getProviderFromUrl(sourceUrl);
        const token = await this.getProviderToken(user, providerId);

        try {
            const readme = await this.sourceRepoAnalyzer.getReadmeContent(sourceUrl, token);
            if (!readme) {
                return {
                    success: false,
                    directoryId: directory.id,
                    error: 'README.md not found in repository',
                    errorCode: DirectoryImportErrorCode.PARSE_FAILED,
                };
            }

            const parsedData = await this.awesomeReadmeParser.parseReadme(readme.content, {
                userId: user.id,
                directoryId: directory.id,
            });

            const syncResult = await this.dataGenerator.updateWithImportedData(
                directory,
                user,
                {
                    items: parsedData.items,
                    categories: parsedData.categories,
                    tags: parsedData.tags,
                },
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
                metrics: parsedData.metrics,
            };
        } catch (error) {
            return {
                success: false,
                directoryId: directory.id,
                error: error.message,
                errorCode: DirectoryImportErrorCode.AI_EXTRACTION_FAILED,
            };
        }
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

        // Check both the original name and slugified version for -data suffix
        const slugified = slugifyText(name);

        if (slugified.endsWith('-data')) {
            // Handle different name formats:
            // "my-dir-data" -> "my-dir"
            // "My Dir Data" -> "My Dir"
            // "My-Dir-Data" -> "My-Dir"
            const trimmed = name.trim();

            // Check for " Data" suffix (case-insensitive)
            if (/\s+data$/i.test(trimmed)) {
                return trimmed.replace(/\s+data$/i, '');
            }

            // Check for "-Data" or "-data" suffix
            if (/-data$/i.test(trimmed)) {
                return trimmed.replace(/-data$/i, '');
            }

            // Fallback: strip from slugified and convert back to title case
            const baseSlug = slugified.slice(0, -5);
            return baseSlug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
        }

        return name;
    }
}
