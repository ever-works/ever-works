import { Injectable, Logger } from '@nestjs/common';
import { GitFacadeService } from '@src/facades/git.facade';
import { DataGeneratorService } from '@src/generators/data-generator/data-generator.service';
import { DataRepository } from '@src/generators/data-generator/data-repository';
import { MarkdownGeneratorService } from '@src/generators/markdown-generator/markdown-generator.service';
import { WebsiteGeneratorService } from '@src/generators/website-generator/website-generator.service';
import { SourceRepoAnalyzerService } from './source-repo-analyzer.service';
import { AwesomeReadmeParserService } from './awesome-readme-parser.service';
import { buildEnrichmentGenerationDto } from './enrichment-prompt.utils';
import { Directory, ImportSourceType } from '@src/entities/directory.entity';
import { User } from '@src/entities/user.entity';
import { DirectoryImportResult, DirectoryImportErrorCode } from '@src/tasks/directory-import.types';
import { GIT_TOKEN_NOT_AVAILABLE } from '@src/constants/messages';
import type { ImportEnrichmentConfigDto } from '@src/dto/import-directory.dto';
import type { ProvidersDto } from '@ever-works/contracts/api';

export interface ExecuteBySourceTypeOptions {
    directory: Directory;
    user: User;
    sourceType: ImportSourceType;
    sourceOwner: string;
    sourceRepo: string;
    sourceUrl: string;
    token?: string;
    createMissingRepos?: boolean;
    enrichmentConfig?: ImportEnrichmentConfigDto;
    providers?: ProvidersDto;
}

export interface ImportFromDataRepoOptions {
    directory: Directory;
    user: User;
    source: { owner: string; repo: string };
    token: string;
}

export interface ImportFromAwesomeReadmeOptions {
    directory: Directory;
    user: User;
    sourceUrl: string;
    token?: string;
    enrichmentConfig?: ImportEnrichmentConfigDto;
    providers?: ProvidersDto;
}

export interface LinkExistingDataRepoOptions {
    directory: Directory;
    user: User;
    source: { owner: string; repo: string };
    token: string;
    createMissingRepos?: boolean;
}

@Injectable()
export class ImportExecutorService {
    private readonly logger = new Logger(ImportExecutorService.name);

    constructor(
        private readonly gitFacade: GitFacadeService,
        private readonly dataGenerator: DataGeneratorService,
        private readonly markdownGenerator: MarkdownGeneratorService,
        private readonly websiteGenerator: WebsiteGeneratorService,
        private readonly sourceRepoAnalyzer: SourceRepoAnalyzerService,
        private readonly awesomeReadmeParser: AwesomeReadmeParserService,
    ) {}

    async importFromDataRepo(options: ImportFromDataRepoOptions): Promise<DirectoryImportResult> {
        const { directory, user, source, token } = options;

        try {
            this.logger.log(`Cloning source repo: ${source.owner}/${source.repo}`);

            const sourceDir = await this.gitFacade.cloneOrPull(
                {
                    owner: source.owner,
                    repo: source.repo,
                    committer: directory.resolveCommitter(user),
                },
                { userId: user.id, providerId: directory.gitProvider, token },
            );

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
                        sourceUrl: this.gitFacade.getWebUrl(
                            directory.gitProvider,
                            source.owner,
                            source.repo,
                        ),
                        sourceType: 'data_repo' as ImportSourceType,
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
                error: (error as Error).message,
                errorCode: DirectoryImportErrorCode.CLONE_FAILED,
            };
        }
    }

    /**
     * Import from an awesome README repository.
     *
     * Flow:
     * 1. Parse the README to extract seed items, categories, tags
     * 2. Write seeds to the directory's data repository
     * 3. Run the standard generation pipeline (same as GeneratorForm) with an
     *    enrichment-focused prompt that instructs the pipeline to expand, rewrite,
     *    and enrich the seed data
     * 4. Generate markdown and website
     */
    async importFromAwesomeReadme(
        options: ImportFromAwesomeReadmeOptions,
    ): Promise<DirectoryImportResult> {
        const { directory, user, sourceUrl, token, enrichmentConfig, providers } = options;

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
            const parsedData = await this.awesomeReadmeParser.parseReadme(
                readme.content,
                {
                    userId: user.id,
                    directoryId: directory.id,
                },
                providers?.ai,
            );

            this.logger.log(
                `Parsed ${parsedData.items.length} seed items, ${parsedData.categories.length} categories`,
            );

            if (parsedData.items.length === 0) {
                return {
                    success: false,
                    directoryId: directory.id,
                    error: 'No items found in README',
                    errorCode: DirectoryImportErrorCode.PARSE_FAILED,
                };
            }

            // Step 1: Write seed data to the directory's data repository
            const parsedUrl = this.sourceRepoAnalyzer.parseGitUrl(sourceUrl);
            const initResult = await this.dataGenerator.initializeWithImportedData(
                directory,
                user,
                {
                    items: parsedData.items,
                    categories: parsedData.categories,
                    tags: parsedData.tags,
                    config: {
                        metadata: {
                            imported_from: parsedUrl
                                ? `${parsedUrl.owner}/${parsedUrl.repo}`
                                : sourceUrl,
                            imported_at: new Date().toISOString(),
                            import_type: 'awesome_readme',
                        },
                    },
                    importRequest: {
                        sourceUrl,
                        sourceType: 'awesome_readme' as ImportSourceType,
                        sourceOwner: parsedUrl?.owner ?? '',
                        sourceRepo: parsedUrl?.repo ?? '',
                    },
                },
            );

            if (initResult.success === false) {
                return {
                    success: false,
                    directoryId: directory.id,
                    error: initResult.error.message || 'Failed to write seed data',
                    errorCode: DirectoryImportErrorCode.CREATE_REPO_FAILED,
                };
            }

            // Step 2: Build enrichment DTO and run the standard generation pipeline
            const generationDto = buildEnrichmentGenerationDto({
                directory,
                parsedData,
                sourceUrl,
                enrichmentConfig,
                providers,
            });

            this.logger.log(
                `Running enrichment pipeline: ${parsedData.items.length} seeds, ` +
                    `target_items=${generationDto.pluginConfig?.target_items}, ` +
                    `pipeline=${generationDto.providers?.pipeline}`,
            );

            const genResult = await this.dataGenerator.initialize(directory, user, generationDto);

            // Step 3: Generate markdown + website
            if (genResult.success !== false) {
                await this.markdownGenerator.initialize(directory, user);
                await this.websiteGenerator.initialize(directory, user);
            }

            const seedCount = parsedData.items.length;
            const finalCount = genResult.success ? genResult.stats.totalItemsCount : seedCount;

            return {
                success: genResult.success !== false,
                directoryId: directory.id,
                itemsImported: finalCount,
                categoriesImported: parsedData.categories.length,
                tagsImported: parsedData.tags.length,
                enrichmentMetrics: {
                    seedItemCount: seedCount,
                    finalItemCount: finalCount,
                    expansionRatio: seedCount > 0 ? finalCount / seedCount : 1,
                    seedCategoryCount: parsedData.categories.length,
                    finalCategoryCount: parsedData.categories.length,
                    seedTagCount: parsedData.tags.length,
                    finalTagCount: parsedData.tags.length,
                    complianceReport: {
                        importProportion: finalCount > 0 ? seedCount / finalCount : 1,
                        withinTarget: finalCount > 0 ? seedCount / finalCount <= 0.4 : false,
                        enrichedDescriptions: 0,
                        newCategoriesAdded: 0,
                        newTagsAdded: 0,
                    },
                },
                error: genResult.success === false ? genResult.error.message : undefined,
            };
        } catch (error) {
            this.logger.error('Failed to import from awesome readme', error);
            return {
                success: false,
                directoryId: directory.id,
                error: (error as Error).message,
                errorCode: DirectoryImportErrorCode.ENRICHMENT_FAILED,
            };
        }
    }

    async linkExistingDataRepo(
        options: LinkExistingDataRepoOptions,
    ): Promise<DirectoryImportResult> {
        const { directory, user, source, token, createMissingRepos = false } = options;

        try {
            const linkAnalysis = await this.sourceRepoAnalyzer.analyzeForLinking(
                this.gitFacade.getWebUrl(directory.gitProvider, source.owner, source.repo),
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

            const dataRepoDir = await this.gitFacade.cloneOrPull(
                {
                    owner: source.owner,
                    repo: source.repo,
                    committer: directory.resolveCommitter(user),
                },
                { userId: user.id, providerId: directory.gitProvider, token },
            );

            const sourceData = await DataRepository.create(dataRepoDir);
            const items = await sourceData.getItems();
            const categories = await sourceData.getCategories().catch(() => []);
            const tags = await sourceData.getTags().catch(() => []);

            this.logger.log(
                `Linked repo has ${items.length} items, ${categories.length} categories, ${tags.length} tags`,
            );

            if (!linkAnalysis.relatedRepos.markdown.exists && createMissingRepos) {
                await this.markdownGenerator.initialize(directory, user);
            }

            if (!linkAnalysis.relatedRepos.website.exists && createMissingRepos) {
                await this.websiteGenerator.initialize(directory, user);
            }

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
                error: (error as Error).message,
                errorCode: DirectoryImportErrorCode.CLONE_FAILED,
            };
        }
    }

    async executeBySourceType(opts: ExecuteBySourceTypeOptions): Promise<DirectoryImportResult> {
        const { directory, user, sourceType, token } = opts;

        switch (sourceType) {
            case 'data_repo': {
                if (!token) {
                    throw new Error(GIT_TOKEN_NOT_AVAILABLE);
                }
                return this.importFromDataRepo({
                    directory,
                    user,
                    source: { owner: opts.sourceOwner, repo: opts.sourceRepo },
                    token,
                });
            }
            case 'awesome_readme':
                return this.importFromAwesomeReadme({
                    directory,
                    user,
                    sourceUrl: opts.sourceUrl,
                    token,
                    enrichmentConfig: opts.enrichmentConfig,
                    providers: opts.providers,
                });
            case 'link_existing': {
                if (!token) {
                    throw new Error(GIT_TOKEN_NOT_AVAILABLE);
                }
                return this.linkExistingDataRepo({
                    directory,
                    user,
                    source: { owner: opts.sourceOwner, repo: opts.sourceRepo },
                    token,
                    createMissingRepos: opts.createMissingRepos ?? false,
                });
            }
            default:
                throw new Error(`Unsupported source type: ${sourceType}`);
        }
    }
}
