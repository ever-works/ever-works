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
    AnalyzeForLinkingResponseDto,
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

    async analyzeForLinking(
        dto: AnalyzeRepositoryDto,
        user: User,
    ): Promise<AnalyzeForLinkingResponseDto> {
        const token = this.getGitHubToken(user);
        if (!token) {
            return {
                canLink: false,
                hasWriteAccess: false,
                relatedRepos: {
                    data: { exists: true, name: '' },
                    markdown: { exists: false, name: null },
                    website: { exists: false, name: null },
                },
                error: 'GitHub token not available',
            };
        }
        return this.sourceRepoAnalyzer.analyzeForLinking(dto.sourceUrl, token);
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
        const parsed = this.sourceRepoAnalyzer.parseGitHubUrl(dto.sourceUrl);
        if (!parsed) {
            return {
                status: 'error',
                message: 'Invalid GitHub URL format',
            };
        }

        // Strip -data suffix from name for data_repo/link_existing imports
        // to avoid naming conflicts (e.g., my-dir-data would create my-dir-data-data)
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
            const directory = await this.directoryRepository.create(
                {
                    slug,
                    name: normalizedName,
                    description: `Imported from ${dto.sourceUrl}`,
                    userId: user.id,
                    owner: dto.owner,
                    organization: dto.organization || false,
                    repoProvider: 'github',
                },
                user,
            );

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

            const result = await this.runImport(directory.id, user, dto, parsed, history.id);

            if (result.success) {
                return {
                    status: 'success',
                    directoryId: directory.id,
                    historyId: history.id,
                    message: `Successfully imported ${result.itemsImported} items.`,
                };
            } else {
                await this.cleanupFailedImport(directory.id, history.id);

                return {
                    status: 'error',
                    message: result.error || 'Import failed',
                };
            }
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
     * Run the import process
     */
    private async runImport(
        directoryId: string,
        user: User,
        dto: ImportDirectoryDto,
        parsed: { owner: string; repo: string },
        historyId: string,
    ): Promise<DirectoryImportResult> {
        const startTime = Date.now();
        let result: DirectoryImportResult;

        try {
            const directory = await this.directoryRepository.findById(directoryId);
            if (!directory) {
                return {
                    success: false,
                    directoryId,
                    error: 'Directory not found',
                    errorCode: DirectoryImportErrorCode.CLONE_FAILED,
                };
            }

            if (dto.sourceType === ImportSourceTypeEnum.DATA_REPO) {
                result = await this.importFromDataRepo(directory, user, parsed);
            } else if (dto.sourceType === ImportSourceTypeEnum.AWESOME_README) {
                result = await this.importFromAwesomeReadme(directory, user, dto.sourceUrl);
            } else if (dto.sourceType === ImportSourceTypeEnum.LINK_EXISTING) {
                result = await this.linkExistingDataRepo(directory, user, parsed, {
                    createMissingRepos: dto.createMissingRepos ?? false,
                });
            } else {
                return {
                    success: false,
                    directoryId,
                    error: `Unsupported source type: ${dto.sourceType}`,
                    errorCode: DirectoryImportErrorCode.PARSE_FAILED,
                };
            }

            if (result.success) {
                await this.directoryRepository.update(directoryId, {
                    generateStatus: {
                        status: GenerateStatusType.GENERATED,
                    },
                    generationFinishedAt: new Date(),
                    itemsCount: result.itemsImported,
                });

                await this.generationHistoryRepository.updateEntry(historyId, {
                    status: GenerateStatusType.GENERATED,
                    finishedAt: new Date(),
                    durationInSeconds: Math.round((Date.now() - startTime) / 1000),
                    newItemsCount: result.itemsImported,
                    totalItemsCount: result.itemsImported,
                });

                this.eventEmitter.emit(
                    'directory.generation.completed',
                    new DirectoryGenerationCompletedEvent(directory),
                );
            }

            return result;
        } catch (error) {
            this.logger.error(`Import failed for directory ${directoryId}`, error);

            return {
                success: false,
                directoryId,
                error: error.message,
                errorCode: DirectoryImportErrorCode.CLONE_FAILED,
            };
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
            this.logger.log(`Cloning source repo: ${source.owner}/${source.repo}`);

            const sourceDir = await this.githubService.cloneOrPull({
                owner: source.owner,
                repo: source.repo,
                token,
                committer: user.asCommitter(),
            });

            const sourceData = await DataRepository.create(sourceDir);
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
                            import_type: 'data_repo',
                        },
                    },
                    importRequest: {
                        sourceUrl: `https://github.com/${source.owner}/${source.repo}`,
                        sourceType: ImportSourceTypeEnum.DATA_REPO,
                        sourceOwner: source.owner,
                        sourceRepo: source.repo,
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
                    importRequest: {
                        sourceUrl,
                        sourceType: ImportSourceTypeEnum.AWESOME_README,
                        sourceOwner: parsed?.owner || '',
                        sourceRepo: parsed?.repo || '',
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

    private async linkExistingDataRepo(
        directory: Directory,
        user: User,
        source: { owner: string; repo: string },
        options: { createMissingRepos: boolean },
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
            const linkAnalysis = await this.sourceRepoAnalyzer.analyzeForLinking(
                `https://github.com/${source.owner}/${source.repo}`,
                token,
            );

            if (!linkAnalysis.canLink) {
                return {
                    success: false,
                    directoryId: directory.id,
                    error: linkAnalysis.error || 'Cannot link to this repository',
                    errorCode: DirectoryImportErrorCode.REPO_ACCESS_DENIED,
                };
            }

            this.logger.log(`Linking to existing data repo: ${source.owner}/${source.repo}`);

            const dataRepoDir = await this.githubService.cloneOrPull({
                owner: source.owner,
                repo: source.repo,
                token,
                committer: user.asCommitter(),
            });

            const sourceData = await DataRepository.create(dataRepoDir);
            const items = await sourceData.getItems();
            const categories = await sourceData.getCategories().catch(() => []);
            const tags = await sourceData.getTags().catch(() => []);

            this.logger.log(
                `Linked repo has ${items.length} items, ${categories.length} categories, ${tags.length} tags`,
            );

            if (!linkAnalysis.relatedRepos.markdown.exists && options.createMissingRepos) {
                await this.markdownGenerator.initialize(directory, user);
            }

            if (!linkAnalysis.relatedRepos.website.exists && options.createMissingRepos) {
                await this.websiteGenerator.initialize(directory, user);
            }

            await this.directoryRepository.update(directory.id, {
                owner: source.owner,
                itemsCount: items.length,
            });

            return {
                success: true,
                directoryId: directory.id,
                itemsImported: items.length,
                categoriesImported: categories.length,
                tagsImported: tags.length,
            };
        } catch (error) {
            this.logger.error('Failed to link existing data repo', error);
            return {
                success: false,
                directoryId: directory.id,
                error: error.message,
                errorCode: DirectoryImportErrorCode.CLONE_FAILED,
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

    private getGitHubToken(user: User): string | undefined {
        const oauthToken = user.oauthTokens?.find((t) => t.provider === 'github');
        return oauthToken?.accessToken;
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
