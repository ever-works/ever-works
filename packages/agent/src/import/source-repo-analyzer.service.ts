import { Injectable, Logger } from '@nestjs/common';
import { Octokit, RequestError } from 'octokit';
import { ImportSourceType } from '@src/entities/directory.entity';
import {
    AnalyzeRepositoryResponseDto,
    AnalyzeForLinkingResponseDto,
    RelatedRepoStatus,
} from '@src/dto/import-directory.dto';

interface ParsedGitHubUrl {
    owner: string;
    repo: string;
}

interface RepoContent {
    name: string;
    type: 'file' | 'dir' | 'submodule' | 'symlink';
    path: string;
}

@Injectable()
export class SourceRepoAnalyzerService {
    private readonly logger = new Logger(SourceRepoAnalyzerService.name);

    parseGitHubUrl(url: string): ParsedGitHubUrl | null {
        try {
            const cleanUrl = url.replace(/\.git$/, '').replace(/\/$/, '');

            const patterns = [
                /^https?:\/\/github\.com\/([^/]+)\/([^/]+)$/,
                /^github\.com\/([^/]+)\/([^/]+)$/,
                /^https?:\/\/www\.github\.com\/([^/]+)\/([^/]+)$/,
            ];

            for (const pattern of patterns) {
                const match = cleanUrl.match(pattern);
                if (match) {
                    return {
                        owner: match[1],
                        repo: match[2],
                    };
                }
            }

            return null;
        } catch (error) {
            this.logger.error(`Failed to parse GitHub URL: ${url}`, error);
            return null;
        }
    }

    async analyzeRepository(
        sourceUrl: string,
        token?: string,
    ): Promise<AnalyzeRepositoryResponseDto> {
        const parsed = this.parseGitHubUrl(sourceUrl);

        if (!parsed) {
            return {
                sourceUrl,
                owner: '',
                repo: '',
                detectedType: null,
                isPublic: false,
                requiresAuth: false,
                error: 'Invalid GitHub URL format. Expected: https://github.com/owner/repo',
            };
        }

        const { owner, repo } = parsed;

        try {
            const octokit = new Octokit({ auth: token });

            let repoInfo: { private: boolean };
            try {
                const response = await octokit.rest.repos.get({ owner, repo });
                repoInfo = response.data;
            } catch (err) {
                if (err instanceof RequestError) {
                    if (err.status === 404) {
                        if (!token) {
                            return {
                                sourceUrl,
                                owner,
                                repo,
                                detectedType: null,
                                isPublic: false,
                                requiresAuth: true,
                                error: 'Repository not found. It may be private - please connect your GitHub account.',
                            };
                        }
                        return {
                            sourceUrl,
                            owner,
                            repo,
                            detectedType: null,
                            isPublic: false,
                            requiresAuth: false,
                            error: 'Repository not found.',
                        };
                    }
                    if (err.status === 403) {
                        return {
                            sourceUrl,
                            owner,
                            repo,
                            detectedType: null,
                            isPublic: false,
                            requiresAuth: true,
                            error: 'Access denied. Please connect your GitHub account with appropriate permissions.',
                        };
                    }
                }
                throw err;
            }

            const isPublic = !repoInfo.private;

            let contents: RepoContent[];
            try {
                const response = await octokit.rest.repos.getContent({
                    owner,
                    repo,
                    path: '',
                });

                if (!Array.isArray(response.data)) {
                    return {
                        sourceUrl,
                        owner,
                        repo,
                        detectedType: null,
                        isPublic,
                        requiresAuth: false,
                        error: 'Unexpected repository structure.',
                    };
                }

                contents = response.data as RepoContent[];
            } catch (err) {
                this.logger.error(`Failed to get repo contents: ${owner}/${repo}`, err);
                return {
                    sourceUrl,
                    owner,
                    repo,
                    detectedType: null,
                    isPublic,
                    requiresAuth: false,
                    error: 'Failed to read repository contents.',
                };
            }

            const detectionResult = await this.detectRepositoryType(octokit, owner, repo, contents);

            return {
                sourceUrl,
                owner,
                repo,
                detectedType: detectionResult.type,
                isPublic,
                requiresAuth: false,
                structure: detectionResult.structure,
            };
        } catch (error) {
            this.logger.error(`Failed to analyze repository: ${sourceUrl}`, error);
            return {
                sourceUrl,
                owner,
                repo,
                detectedType: null,
                isPublic: false,
                requiresAuth: false,
                error: `Failed to analyze repository: ${error.message}`,
            };
        }
    }

    private async detectRepositoryType(
        octokit: Octokit,
        owner: string,
        repo: string,
        contents: RepoContent[],
    ): Promise<{
        type: ImportSourceType | null;
        structure: {
            hasConfig: boolean;
            hasDataFolder: boolean;
            hasReadme: boolean;
            itemCount?: number;
            categoryCount?: number;
        };
    }> {
        const hasConfig =
            contents.some((c) => c.name === 'config.yml' && c.type === 'file') ||
            contents.some((c) => c.name === 'config.yaml' && c.type === 'file');

        const hasDataFolder = contents.some((c) => c.name === 'data' && c.type === 'dir');

        const hasReadme = contents.some(
            (c) => c.name.toLowerCase() === 'readme.md' && c.type === 'file',
        );

        const structure = {
            hasConfig,
            hasDataFolder,
            hasReadme,
            itemCount: undefined as number | undefined,
            categoryCount: undefined as number | undefined,
        };

        if (hasConfig && hasDataFolder) {
            try {
                const dataContents = await octokit.rest.repos.getContent({
                    owner,
                    repo,
                    path: 'data',
                });

                if (Array.isArray(dataContents.data)) {
                    const itemDirs = dataContents.data.filter((c) => c.type === 'dir');
                    structure.itemCount = itemDirs.length;
                }

                const hasCategoriesFile = contents.some(
                    (c) =>
                        (c.name === 'categories.yml' || c.name === 'categories.yaml') &&
                        c.type === 'file',
                );

                if (hasCategoriesFile) {
                    try {
                        const categoriesContent = await this.getFileContent(
                            octokit,
                            owner,
                            repo,
                            'categories.yml',
                        );
                        if (categoriesContent) {
                            const categoryMatches = categoriesContent.match(/^-\s+(id|name):/gm);
                            structure.categoryCount = categoryMatches
                                ? categoryMatches.length
                                : undefined;
                        }
                    } catch {
                        try {
                            const categoriesContent = await this.getFileContent(
                                octokit,
                                owner,
                                repo,
                                'categories.yaml',
                            );
                            if (categoriesContent) {
                                const categoryMatches =
                                    categoriesContent.match(/^-\s+(id|name):/gm);
                                structure.categoryCount = categoryMatches
                                    ? categoryMatches.length
                                    : undefined;
                            }
                        } catch {}
                    }
                }
            } catch (err) {
                this.logger.warn(`Failed to count items in data folder: ${owner}/${repo}`, err);
            }

            return { type: 'data_repo', structure };
        }

        if (hasReadme) {
            try {
                const readmeContent = await this.getFileContent(octokit, owner, repo, 'README.md');

                if (readmeContent && this.isAwesomeListReadme(readmeContent)) {
                    const listItems = readmeContent.match(/^[-*]\s+\[.+?\]\(.+?\)/gm);
                    structure.itemCount = listItems ? listItems.length : undefined;

                    const headers = readmeContent.match(/^#{2,3}\s+.+$/gm);
                    const nonCategoryHeaders = [
                        'contents',
                        'table of contents',
                        'contributing',
                        'license',
                        'authors',
                        'acknowledgments',
                        'resources',
                        'related',
                        'see also',
                    ];
                    const categoryHeaders = headers?.filter((h) => {
                        const headerText = h.replace(/^#+\s+/, '').toLowerCase();
                        return !nonCategoryHeaders.some((nc) => headerText.includes(nc));
                    });
                    structure.categoryCount = categoryHeaders ? categoryHeaders.length : undefined;

                    return { type: 'awesome_readme', structure };
                }
            } catch (err) {
                this.logger.warn(`Failed to analyze README: ${owner}/${repo}`, err);
            }
        }

        return { type: null, structure };
    }

    private isAwesomeListReadme(content: string): boolean {
        const hasListLinks = /^[-*]\s+\[.+?\]\(.+?\)/m.test(content);
        const hasSectionHeaders = /^#{2,3}\s+.+$/m.test(content);
        const listItemCount = (content.match(/^[-*]\s+\[.+?\]\(.+?\)/gm) || []).length;

        return hasListLinks && hasSectionHeaders && listItemCount >= 5;
    }

    async getFileContent(
        octokit: Octokit,
        owner: string,
        repo: string,
        path: string,
    ): Promise<string | null> {
        try {
            const response = await octokit.rest.repos.getContent({
                owner,
                repo,
                path,
            });

            if ('content' in response.data && response.data.type === 'file') {
                return Buffer.from(response.data.content, 'base64').toString('utf-8');
            }

            return null;
        } catch (err) {
            if (err instanceof RequestError && err.status === 404) {
                return null;
            }
            throw err;
        }
    }

    async getReadmeContent(
        sourceUrl: string,
        token?: string,
    ): Promise<{ content: string; path: string } | null> {
        const parsed = this.parseGitHubUrl(sourceUrl);
        if (!parsed) {
            return null;
        }

        const octokit = new Octokit({ auth: token });

        const readmeFiles = ['README.md', 'readme.md', 'Readme.md'];

        for (const filename of readmeFiles) {
            const content = await this.getFileContent(octokit, parsed.owner, parsed.repo, filename);
            if (content) {
                return { content, path: filename };
            }
        }

        return null;
    }

    async analyzeForLinking(
        sourceUrl: string,
        token: string,
    ): Promise<AnalyzeForLinkingResponseDto> {
        const parsed = this.parseGitHubUrl(sourceUrl);

        if (!parsed) {
            return {
                canLink: false,
                hasWriteAccess: false,
                relatedRepos: {
                    data: { exists: true, name: '' },
                    markdown: { exists: false, name: null },
                    website: { exists: false, name: null },
                },
                error: 'Invalid GitHub URL format',
            };
        }

        const { owner, repo } = parsed;
        const octokit = new Octokit({ auth: token });

        try {
            const repoInfo = await octokit.rest.repos.get({ owner, repo });
            const hasWriteAccess = repoInfo.data.permissions?.push || false;

            if (!hasWriteAccess) {
                return {
                    canLink: false,
                    hasWriteAccess: false,
                    relatedRepos: {
                        data: { exists: true, name: repo },
                        markdown: { exists: false, name: null },
                        website: { exists: false, name: null },
                    },
                    error: 'You do not have write access to this repository',
                };
            }

            let itemCount: number | undefined;
            let categoryCount: number | undefined;
            try {
                const dataContents = await octokit.rest.repos.getContent({
                    owner,
                    repo,
                    path: 'data',
                });
                if (Array.isArray(dataContents.data)) {
                    itemCount = dataContents.data.filter((c) => c.type === 'dir').length;
                }
            } catch {}

            try {
                const categoriesContent = await this.getFileContent(
                    octokit,
                    owner,
                    repo,
                    'categories.yml',
                );
                if (categoriesContent) {
                    const categoryMatches = categoriesContent.match(/^-\s+(id|name):/gm);
                    categoryCount = categoryMatches ? categoryMatches.length : undefined;
                }
            } catch {}

            const relatedRepos = await this.detectRelatedRepos(octokit, owner, repo);

            return {
                canLink: true,
                hasWriteAccess: true,
                relatedRepos: {
                    data: { exists: true, name: repo, hasWriteAccess: true },
                    ...relatedRepos,
                },
                itemCount,
                categoryCount,
            };
        } catch (error) {
            this.logger.error(`Failed to analyze for linking: ${sourceUrl}`, error);
            return {
                canLink: false,
                hasWriteAccess: false,
                relatedRepos: {
                    data: { exists: true, name: repo },
                    markdown: { exists: false, name: null },
                    website: { exists: false, name: null },
                },
                error: error instanceof Error ? error.message : 'Failed to analyze repository',
            };
        }
    }

    private async detectRelatedRepos(
        octokit: Octokit,
        owner: string,
        dataRepoName: string,
    ): Promise<{
        markdown: RelatedRepoStatus;
        website: RelatedRepoStatus;
    }> {
        const baseSlug = dataRepoName.endsWith('-data') ? dataRepoName.slice(0, -5) : dataRepoName;

        const potentialMarkdownRepos = [baseSlug];
        const potentialWebsiteRepos = [`${baseSlug}-website`];

        if (!dataRepoName.endsWith('-data')) {
            potentialMarkdownRepos.push(dataRepoName);
        }

        const markdown = await this.findExistingRepo(octokit, owner, potentialMarkdownRepos);
        const website = await this.findExistingRepo(octokit, owner, potentialWebsiteRepos);

        return { markdown, website };
    }

    private async findExistingRepo(
        octokit: Octokit,
        owner: string,
        potentialNames: string[],
    ): Promise<RelatedRepoStatus> {
        for (const name of potentialNames) {
            try {
                const response = await octokit.rest.repos.get({ owner, repo: name });
                const hasWriteAccess = response.data.permissions?.push || false;
                return { exists: true, name, hasWriteAccess };
            } catch (err) {
                if (err instanceof RequestError && err.status === 404) {
                    continue;
                }
                continue;
            }
        }
        return { exists: false, name: null };
    }
}
