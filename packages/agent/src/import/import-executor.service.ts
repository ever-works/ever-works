import { Injectable, Logger } from '@nestjs/common';
import { GitFacadeService } from '@src/facades/git.facade';
import { DataGeneratorService } from '@src/generators/data-generator/data-generator.service';
import { DataRepository } from '@src/generators/data-generator/data-repository';
import { MarkdownGeneratorService } from '@src/generators/markdown-generator/markdown-generator.service';
import { WebsiteGeneratorService } from '@src/generators/website-generator/website-generator.service';
import { SourceRepoAnalyzerService } from './source-repo-analyzer.service';
import { AwesomeReadmeParserService } from './awesome-readme-parser.service';
import { Directory, ImportSourceType } from '@src/entities/directory.entity';
import { User } from '@src/entities/user.entity';
import { DirectoryImportResult, DirectoryImportErrorCode } from '@src/tasks/directory-import.types';

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
                    committer: user.asCommitter(),
                },
                { userId: user.id, providerId: directory.repoProvider, token },
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
                            directory.repoProvider,
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

    async importFromAwesomeReadme(
        options: ImportFromAwesomeReadmeOptions,
    ): Promise<DirectoryImportResult> {
        const { directory, user, sourceUrl, token } = options;

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
            const parsedData = await this.awesomeReadmeParser.parseReadme(readme.content, {
                userId: user.id,
                directoryId: directory.id,
            });

            this.logger.log(
                `Parsed ${parsedData.items.length} items, ${parsedData.categories.length} categories`,
            );

            const parsed = this.sourceRepoAnalyzer.parseGitUrl(sourceUrl);
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
                        sourceType: 'awesome_readme' as ImportSourceType,
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
                metrics: parsedData.metrics,
            };
        } catch (error) {
            this.logger.error('Failed to import from awesome readme', error);
            return {
                success: false,
                directoryId: directory.id,
                error: (error as Error).message,
                errorCode: DirectoryImportErrorCode.AI_EXTRACTION_FAILED,
            };
        }
    }

    async linkExistingDataRepo(
        options: LinkExistingDataRepoOptions,
    ): Promise<DirectoryImportResult> {
        const { directory, user, source, token, createMissingRepos = false } = options;

        try {
            const linkAnalysis = await this.sourceRepoAnalyzer.analyzeForLinking(
                this.gitFacade.getWebUrl(directory.repoProvider, source.owner, source.repo),
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
                    committer: user.asCommitter(),
                },
                { userId: user.id, providerId: directory.repoProvider, token },
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
}
