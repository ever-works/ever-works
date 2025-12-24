import { BadRequestException, HttpException, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Octokit } from 'octokit';
import { DirectoryRepository } from '@src/database/repositories/directory.repository';
import { DirectoryGenerationHistoryRepository } from '@src/database/repositories/directory-generation-history.repository';
import { DataGeneratorService } from '@src/data-generator/data-generator.service';
import { DataRepository } from '@src/data-generator/data-repository';
import { MarkdownGeneratorService } from '@src/markdown-generator/markdown-generator.service';
import { WebsiteGeneratorService } from '@src/website-generator/website-generator.service';
import { GithubService } from '@src/git/github.service';
import { SourceRepoAnalyzerService } from '@src/import/source-repo-analyzer.service';
import { AwesomeReadmeParserService } from '@src/import/awesome-readme-parser.service';
import {
    AnalyzeRepositoryDto,
    AnalyzeRepositoryResponseDto,
    ImportDirectoryDto,
    ImportDirectoryResponseDto,
    ImportSourceTypeEnum,
    GetUserRepositoriesDto,
    GetUserRepositoriesResponseDto,
    GitHubRepoDto,
} from '@src/dto/import-directory.dto';
import { Directory, ImportSourceType, SourceRepository } from '@src/entities/directory.entity';
import { User } from '@src/entities/user.entity';
import { DirectoryGenerationCompletedEvent } from '@src/events';
import { DirectoryImportResult, DirectoryImportErrorCode } from '@src/tasks/directory-import.types';
import { GenerateStatusType } from '@src/entities/types';
import { normalizeGeneratorError } from './utils/error.utils';
import { slugifyText } from '@src/items-generator/utils/text.utils';

@Injectable()
export class DirectoryImportService {
    private readonly logger = new Logger(DirectoryImportService.name);

    constructor(
        private readonly directoryRepository: DirectoryRepository,
        private readonly generationHistoryRepository: DirectoryGenerationHistoryRepository,
        private readonly dataGenerator: DataGeneratorService,
        private readonly markdownGenerator: MarkdownGeneratorService,
        private readonly websiteGenerator: WebsiteGeneratorService,
        private readonly githubService: GithubService,
        private readonly sourceRepoAnalyzer: SourceRepoAnalyzerService,
        private readonly awesomeReadmeParser: AwesomeReadmeParserService,
        private readonly eventEmitter: EventEmitter2,
    ) {}

    /**
     * Analyze a GitHub repository to detect its type and structure
     */
    async analyzeRepository(
        dto: AnalyzeRepositoryDto,
        user: User,
    ): Promise<AnalyzeRepositoryResponseDto> {
        const token = this.getGitHubToken(user);
        return this.sourceRepoAnalyzer.analyzeRepository(dto.sourceUrl, token);
    }

    /**
     * Get user's GitHub repositories for selection
     */
    async getUserRepositories(
        dto: GetUserRepositoriesDto,
        user: User,
    ): Promise<GetUserRepositoriesResponseDto> {
        const token = this.getGitHubToken(user);

        if (!token) {
            throw new BadRequestException('GitHub account not connected');
        }

        const octokit = new Octokit({ auth: token });
        const page = dto.page || 1;
        const perPage = dto.perPage || 30;

        try {
            const { data: repos } = await octokit.rest.repos.listForAuthenticatedUser({
                sort: 'updated',
                direction: 'desc',
                per_page: perPage,
                page,
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

            const repositories: GitHubRepoDto[] = filteredRepos.map((repo) => ({
                id: repo.id,
                name: repo.name,
                full_name: repo.full_name,
                owner: repo.owner.login,
                description: repo.description,
                html_url: repo.html_url,
                private: repo.private,
                updated_at: repo.updated_at || new Date().toISOString(),
                default_branch: repo.default_branch,
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
            throw new BadRequestException('Failed to fetch GitHub repositories');
        }
    }

    /**
     * Initiate a directory import
     */
    async initiateImport(dto: ImportDirectoryDto, user: User): Promise<ImportDirectoryResponseDto> {
        // Parse the source URL
        const parsed = this.sourceRepoAnalyzer.parseGitHubUrl(dto.sourceUrl);
        if (!parsed) {
            return {
                status: 'error',
                message: 'Invalid GitHub URL format',
            };
        }

        // Create the slug from directory name
        const slug = slugifyText(dto.name);

        // Check if directory with this slug already exists
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
            // Create the directory record
            const directory = await this.directoryRepository.create(
                {
                    slug,
                    name: dto.name,
                    description: `Imported from ${dto.sourceUrl}`,
                    userId: user.id,
                    owner: dto.owner,
                    organization: dto.organization || false,
                    repoProvider: 'github',
                },
                user,
            );

            // Set the source repository info
            const sourceRepository: SourceRepository = {
                url: dto.sourceUrl,
                owner: parsed.owner,
                repo: parsed.repo,
                type: dto.sourceType as ImportSourceType,
                importedAt: new Date(),
            };

            await this.directoryRepository.update(directory.id, {
                sourceRepository,
                generateStatus: {
                    status: GenerateStatusType.GENERATING,
                    step: 'import_started',
                },
            });

            // Create generation history record
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
                triggeredBy: 'user',
                startedAt: new Date(),
            });

            // Run import in-process for now (can be moved to Trigger.dev later)
            this.runImportInBackground(directory.id, user, dto, parsed, history.id).catch(
                (error) => {
                    this.logger.error(`Import failed for directory ${directory.id}`, error);
                },
            );

            return {
                status: 'pending',
                directoryId: directory.id,
                historyId: history.id,
                message: 'Import started. You will be redirected to the directory page.',
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

    /**
     * Run import in background (can be converted to Trigger.dev task)
     */
    private async runImportInBackground(
        directoryId: string,
        user: User,
        dto: ImportDirectoryDto,
        parsed: { owner: string; repo: string },
        historyId: string,
    ): Promise<void> {
        const startTime = Date.now();
        let result: DirectoryImportResult;

        try {
            const directory = await this.directoryRepository.findById(directoryId);
            if (!directory) {
                throw new Error('Directory not found');
            }

            if (dto.sourceType === ImportSourceTypeEnum.DATA_REPO) {
                result = await this.importFromDataRepo(directory, user, parsed);
            } else if (dto.sourceType === ImportSourceTypeEnum.AWESOME_README) {
                result = await this.importFromAwesomeReadme(directory, user, dto.sourceUrl);
            } else {
                throw new Error(`Unsupported source type: ${dto.sourceType}`);
            }

            // Update directory status
            if (result.success) {
                await this.directoryRepository.update(directoryId, {
                    generateStatus: {
                        status: GenerateStatusType.GENERATED,
                    },
                    generationFinishedAt: new Date(),
                    itemsCount: result.itemsImported,
                });

                // Update history
                await this.generationHistoryRepository.updateEntry(historyId, {
                    status: GenerateStatusType.GENERATED,
                    finishedAt: new Date(),
                    durationInSeconds: Math.round((Date.now() - startTime) / 1000),
                    newItemsCount: result.itemsImported,
                    totalItemsCount: result.itemsImported,
                });

                // Emit completion event
                this.eventEmitter.emit(
                    'directory.generation.completed',
                    new DirectoryGenerationCompletedEvent(directory),
                );
            } else {
                await this.handleImportFailure(
                    directoryId,
                    historyId,
                    result.error || 'Unknown error',
                    startTime,
                );
            }
        } catch (error) {
            this.logger.error(`Import failed for directory ${directoryId}`, error);
            await this.handleImportFailure(directoryId, historyId, error.message, startTime);
        }
    }

    /**
     * Import from a Data Repository (Type A)
     */
    private async importFromDataRepo(
        directory: Directory,
        user: User,
        source: { owner: string; repo: string },
    ): Promise<DirectoryImportResult> {
        const token = this.getGitHubToken(user);

        if (!token) {
            return {
                success: false,
                directoryId: directory.id,
                error: 'GitHub token not available',
                errorCode: DirectoryImportErrorCode.REPO_ACCESS_DENIED,
            };
        }

        try {
            // Clone the source repository
            this.logger.log(`Cloning source repo: ${source.owner}/${source.repo}`);

            const sourceDir = await this.githubService.cloneOrPull({
                owner: source.owner,
                repo: source.repo,
                token,
                committer: user.asCommitter(),
            });

            // Create DataRepository instance to read source data
            const sourceData = await DataRepository.create(sourceDir);

            // Read items, categories, and tags
            const items = await sourceData.getItems();
            const categories = await sourceData.getCategories().catch(() => []);
            const tags = await sourceData.getTags().catch(() => []);
            const config = await sourceData.getConfig().catch(() => ({}));

            this.logger.log(
                `Found ${items.length} items, ${categories.length} categories, ${tags.length} tags`,
            );

            if (items.length === 0) {
                return {
                    success: false,
                    directoryId: directory.id,
                    error: 'No items found in source repository',
                    errorCode: DirectoryImportErrorCode.PARSE_FAILED,
                };
            }

            // Initialize user's data repository with imported content
            const configWithMeta = config as Record<string, any>;
            const initResult = await this.dataGenerator.initializeWithImportedData(
                directory,
                user,
                {
                    items,
                    categories,
                    tags,
                    config: {
                        ...configWithMeta,
                        metadata: {
                            ...(configWithMeta.metadata || {}),
                            imported_from: `${source.owner}/${source.repo}`,
                            imported_at: new Date().toISOString(),
                        },
                    },
                },
            );

            if (initResult.success === false) {
                return {
                    success: false,
                    directoryId: directory.id,
                    error: initResult.error.message || 'Failed to initialize data repository',
                    errorCode: DirectoryImportErrorCode.CREATE_REPO_FAILED,
                };
            }

            // Generate markdown and website
            await this.markdownGenerator.initialize(directory, user);

            await this.websiteGenerator.initialize(directory, user);

            return {
                success: true,
                directoryId: directory.id,
                itemsImported: items.length,
                categoriesImported: categories.length,
                tagsImported: tags.length,
            };
        } catch (error) {
            this.logger.error('Failed to import from data repo', error);
            return {
                success: false,
                directoryId: directory.id,
                error: error.message,
                errorCode: DirectoryImportErrorCode.CLONE_FAILED,
            };
        }
    }

    /**
     * Import from an Awesome README (Type B)
     */
    private async importFromAwesomeReadme(
        directory: Directory,
        user: User,
        sourceUrl: string,
    ): Promise<DirectoryImportResult> {
        const token = this.getGitHubToken(user);

        try {
            // Fetch README content
            const readme = await this.sourceRepoAnalyzer.getReadmeContent(sourceUrl, token);

            if (!readme) {
                return {
                    success: false,
                    directoryId: directory.id,
                    error: 'README.md not found in repository',
                    errorCode: DirectoryImportErrorCode.PARSE_FAILED,
                };
            }

            this.logger.log(`Parsing README from ${sourceUrl}`);

            // Parse README using AI
            const parsedData = await this.awesomeReadmeParser.parseReadme(readme.content);

            this.logger.log(
                `Parsed ${parsedData.items.length} items, ${parsedData.categories.length} categories`,
            );

            if (parsedData.items.length === 0) {
                return {
                    success: false,
                    directoryId: directory.id,
                    error: 'No items could be extracted from README',
                    errorCode: DirectoryImportErrorCode.AI_EXTRACTION_FAILED,
                };
            }

            const parsed = this.sourceRepoAnalyzer.parseGitHubUrl(sourceUrl);

            // Initialize user's data repository with parsed content
            const initResult = await this.dataGenerator.initializeWithImportedData(
                directory,
                user,
                {
                    items: parsedData.items,
                    categories: parsedData.categories,
                    tags: parsedData.tags,
                    config: {
                        metadata: {
                            imported_from: parsed ? `${parsed.owner}/${parsed.repo}` : sourceUrl,
                            imported_at: new Date().toISOString(),
                            import_type: 'awesome_readme',
                        },
                    },
                },
            );

            if (initResult.success === false) {
                return {
                    success: false,
                    directoryId: directory.id,
                    error: initResult.error.message || 'Failed to initialize data repository',
                    errorCode: DirectoryImportErrorCode.CREATE_REPO_FAILED,
                };
            }

            // Generate markdown and website
            await this.markdownGenerator.initialize(directory, user);

            await this.websiteGenerator.initialize(directory, user);

            return {
                success: true,
                directoryId: directory.id,
                itemsImported: parsedData.items.length,
                categoriesImported: parsedData.categories.length,
                tagsImported: parsedData.tags.length,
            };
        } catch (error) {
            this.logger.error('Failed to import from awesome readme', error);
            return {
                success: false,
                directoryId: directory.id,
                error: error.message,
                errorCode: DirectoryImportErrorCode.AI_EXTRACTION_FAILED,
            };
        }
    }

    /**
     * Handle import failure
     */
    private async handleImportFailure(
        directoryId: string,
        historyId: string,
        errorMessage: string,
        startTime: number,
    ): Promise<void> {
        await this.directoryRepository.update(directoryId, {
            generateStatus: {
                status: GenerateStatusType.ERROR,
                error: errorMessage,
            },
            generationFinishedAt: new Date(),
        });

        await this.generationHistoryRepository.updateEntry(historyId, {
            status: GenerateStatusType.ERROR,
            finishedAt: new Date(),
            durationInSeconds: Math.round((Date.now() - startTime) / 1000),
            errorMessage,
        });
    }

    /**
     * Get GitHub token from user
     */
    private getGitHubToken(user: User): string | undefined {
        const oauthToken = user.oauthTokens?.find((t) => t.provider === 'github');
        return oauthToken?.accessToken;
    }
}
