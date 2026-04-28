import { Injectable, Logger } from '@nestjs/common';
import { GitFacadeService } from '@src/facades/git.facade';
import { DataGeneratorService } from '@src/generators/data-generator/data-generator.service';
import { DataRepository } from '@src/generators/data-generator/data-repository';
import { MarkdownGeneratorService } from '@src/generators/markdown-generator/markdown-generator.service';
import { WebsiteGeneratorService } from '@src/generators/website-generator/website-generator.service';
import { SourceRepoAnalyzerService } from './source-repo-analyzer.service';
import { buildImportGenerationDto } from './enrichment-prompt.utils';
import { Directory, ImportSourceType } from '@src/entities/directory.entity';
import { User } from '@src/entities/user.entity';
import { DirectoryImportResult, DirectoryImportErrorCode } from '@src/tasks/directory-import.types';
import { GIT_TOKEN_NOT_AVAILABLE } from '@src/constants/messages';
import type { ProvidersDto } from '@ever-works/contracts/api';
import { CreateItemsGeneratorDto } from '@src/items-generator/dto';
import {
    WorksConfigService,
    type ParsedWorksConfig,
    type ResolvedWorksConfig,
} from '@src/works-config/services/works-config.service';
import { mergeWorksConfigIntoDataConfig } from '@src/works-config/works-config-data';

export interface ExecuteBySourceTypeOptions {
    directory: Directory;
    user: User;
    sourceType: ImportSourceType;
    sourceOwner: string;
    sourceRepo: string;
    sourceUrl: string;
    token?: string;
    createMissingRepos?: boolean;
    expansionFactor?: number;
    providers?: ProvidersDto;
    worksConfig?: ResolvedWorksConfig | null;
}

export interface ImportFromDataRepoOptions {
    directory: Directory;
    user: User;
    source: { owner: string; repo: string };
    token: string;
    worksConfig?: ResolvedWorksConfig | null;
}

export interface ImportFromAwesomeReadmeOptions {
    directory: Directory;
    user: User;
    sourceUrl: string;
    expansionFactor?: number;
    providers?: ProvidersDto;
    worksConfig?: ResolvedWorksConfig | null;
    updateWithPullRequest?: boolean;
}

export interface LinkExistingDataRepoOptions {
    directory: Directory;
    user: User;
    source: { owner: string; repo: string };
    token: string;
    createMissingRepos?: boolean;
}

export interface ImportFromWorksConfigOptions {
    directory: Directory;
    user: User;
    source: { owner: string; repo: string };
    token?: string;
    providers?: ProvidersDto;
    worksConfig?: ResolvedWorksConfig | null;
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
        private readonly worksConfigService: WorksConfigService,
    ) {}

    async importFromDataRepo(options: ImportFromDataRepoOptions): Promise<DirectoryImportResult> {
        const { directory, user, source, token, worksConfig } = options;

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
            const configWithWorksState = mergeWorksConfigIntoDataConfig(
                config as Record<string, any>,
                directory.name,
                worksConfig,
            );

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

            const configWithMeta = configWithWorksState as Record<string, any>;
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
     * Delegates entirely to the pipeline plugin — no pre-parsing or seeding.
     * The pipeline fetches the source URL, uses it as research input, and builds
     * a significantly larger and fully-enriched directory.
     */
    async importFromAwesomeReadme(
        options: ImportFromAwesomeReadmeOptions,
    ): Promise<DirectoryImportResult> {
        const {
            directory,
            user,
            sourceUrl,
            expansionFactor,
            providers,
            worksConfig,
            updateWithPullRequest = false,
        } = options;

        try {
            const generationDto = buildImportGenerationDto({
                directory,
                sourceUrl,
                expansionFactor,
                providers: {
                    ...(worksConfig?.providers ?? {}),
                    ...(providers ?? {}),
                },
                model: worksConfig?.model,
                updateWithPullRequest,
            });

            this.logger.log(
                `Starting import pipeline for ${sourceUrl} — ` +
                    `target=${generationDto.pluginConfig?.target_items}, ` +
                    `pipeline=${generationDto.providers?.pipeline}`,
            );

            const genResult = await this.dataGenerator.initialize(directory, user, generationDto);

            if (genResult.success !== false) {
                await this.markdownGenerator.initialize(directory, user);
                await this.websiteGenerator.initialize(directory, user);
            }

            return {
                success: genResult.success !== false,
                directoryId: directory.id,
                itemsImported: genResult.success ? genResult.stats.totalItemsCount : 0,
                error: genResult.success === false ? genResult.error.message : undefined,
                errorCode:
                    genResult.success === false
                        ? DirectoryImportErrorCode.ENRICHMENT_FAILED
                        : undefined,
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

    async importFromWorksConfig(
        options: ImportFromWorksConfigOptions,
    ): Promise<DirectoryImportResult> {
        const { directory, user, source, token, providers, worksConfig } = options;

        try {
            const resolvedWorksConfig =
                worksConfig ??
                (await this.worksConfigService.loadFromRepository(
                    source.owner,
                    source.repo,
                    directory.gitProvider,
                    token,
                ));

            if (!resolvedWorksConfig?.initialPrompt) {
                return {
                    success: false,
                    directoryId: directory.id,
                    error: 'works.yml is missing initial_prompt',
                    errorCode: DirectoryImportErrorCode.PARSE_FAILED,
                };
            }

            const generationDto: CreateItemsGeneratorDto = {
                name: directory.name,
                prompt: resolvedWorksConfig.initialPrompt,
                model: resolvedWorksConfig.model,
                providers: {
                    ...(resolvedWorksConfig.providers ?? {}),
                    ...(providers ?? {}),
                },
                pluginConfig: {},
            };

            if (!generationDto.providers || Object.keys(generationDto.providers).length === 0) {
                delete generationDto.providers;
            }

            const genResult = await this.dataGenerator.initialize(directory, user, generationDto);

            if (genResult.success !== false) {
                await this.markdownGenerator.initialize(directory, user);
                await this.websiteGenerator.initialize(directory, user);
            }

            return {
                success: genResult.success !== false,
                directoryId: directory.id,
                itemsImported: genResult.success ? genResult.stats.totalItemsCount : 0,
                stats: genResult.success ? genResult.stats : undefined,
                error: genResult.success === false ? genResult.error.message : undefined,
                errorCode:
                    genResult.success === false
                        ? DirectoryImportErrorCode.GENERATION_FAILED
                        : undefined,
            };
        } catch (error) {
            this.logger.error('Failed to import from works config', error);
            return {
                success: false,
                directoryId: directory.id,
                error: (error as Error).message,
                errorCode: DirectoryImportErrorCode.GENERATION_FAILED,
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
                    worksConfig: opts.worksConfig,
                });
            }
            case 'awesome_readme':
                return this.importFromAwesomeReadme({
                    directory,
                    user,
                    sourceUrl: opts.sourceUrl,
                    expansionFactor: opts.expansionFactor,
                    providers: opts.providers,
                    worksConfig: opts.worksConfig,
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
            case 'works_config':
                return this.importFromWorksConfig({
                    directory,
                    user,
                    source: { owner: opts.sourceOwner, repo: opts.sourceRepo },
                    token,
                    providers: opts.providers,
                    worksConfig: opts.worksConfig,
                });
            default:
                throw new Error(`Unsupported source type: ${sourceType}`);
        }
    }
}
