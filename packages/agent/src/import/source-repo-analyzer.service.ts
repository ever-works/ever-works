import { Injectable, Logger } from '@nestjs/common';
import { Octokit, RequestError } from 'octokit';
import { ImportSourceType } from '@src/entities/directory.entity';
import { AnalyzeRepositoryResponseDto } from '@src/dto/import-directory.dto';

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

    /**
     * Parse a GitHub URL to extract owner and repo
     */
    parseGitHubUrl(url: string): ParsedGitHubUrl | null {
        try {
            // Handle various GitHub URL formats:
            // https://github.com/owner/repo
            // https://github.com/owner/repo.git
            // https://github.com/owner/repo/
            // github.com/owner/repo
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

    /**
     * Analyze a GitHub repository to detect its type and structure
     */
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
            // Try without auth first for public repos
            const octokit = new Octokit({ auth: token });

            // Get repo info to check if it's public/private
            let repoInfo;
            try {
                const response = await octokit.rest.repos.get({ owner, repo });
                repoInfo = response.data;
            } catch (err) {
                if (err instanceof RequestError) {
                    if (err.status === 404) {
                        // Could be private repo without auth
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

            // Get root contents to detect structure
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

            // Detect repository type
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

    /**
     * Detect if the repository is a Data Repo or Awesome README
     */
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

        // Type A: Data Repo (has config.yml + data folder)
        if (hasConfig && hasDataFolder) {
            // Try to count items in data folder
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

                // Try to count categories
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
                            // Simple count: count lines starting with "- id:" or "- name:"
                            const categoryMatches = categoriesContent.match(/^-\s+(id|name):/gm);
                            structure.categoryCount = categoryMatches
                                ? categoryMatches.length
                                : undefined;
                        }
                    } catch {
                        // Try categories.yaml
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
                        } catch {
                            // Ignore
                        }
                    }
                }
            } catch (err) {
                this.logger.warn(`Failed to count items in data folder: ${owner}/${repo}`, err);
            }

            return { type: 'data_repo', structure };
        }

        // Type B: Awesome README (has README.md with list structure)
        if (hasReadme) {
            try {
                const readmeContent = await this.getFileContent(octokit, owner, repo, 'README.md');

                if (readmeContent && this.isAwesomeListReadme(readmeContent)) {
                    // Estimate item count from markdown list items
                    const listItems = readmeContent.match(/^[-*]\s+\[.+?\]\(.+?\)/gm);
                    structure.itemCount = listItems ? listItems.length : undefined;

                    // Estimate category count from headers
                    const headers = readmeContent.match(/^#{2,3}\s+.+$/gm);
                    // Filter out common non-category headers
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

    /**
     * Check if a README looks like an Awesome List
     */
    private isAwesomeListReadme(content: string): boolean {
        // Check for common Awesome List patterns:
        // 1. Has markdown list items with links
        const hasListLinks = /^[-*]\s+\[.+?\]\(.+?\)/m.test(content);

        // 2. Has section headers
        const hasSectionHeaders = /^#{2,3}\s+.+$/m.test(content);

        // 3. Has multiple list items
        const listItemCount = (content.match(/^[-*]\s+\[.+?\]\(.+?\)/gm) || []).length;

        // Consider it an Awesome List if it has:
        // - At least 5 list items with links
        // - Section headers
        return hasListLinks && hasSectionHeaders && listItemCount >= 5;
    }

    /**
     * Get file content from a repository
     */
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

    /**
     * Get README content from a repository
     */
    async getReadmeContent(
        sourceUrl: string,
        token?: string,
    ): Promise<{ content: string; path: string } | null> {
        const parsed = this.parseGitHubUrl(sourceUrl);
        if (!parsed) {
            return null;
        }

        const octokit = new Octokit({ auth: token });

        // Try common README filenames
        const readmeFiles = ['README.md', 'readme.md', 'Readme.md'];

        for (const filename of readmeFiles) {
            const content = await this.getFileContent(octokit, parsed.owner, parsed.repo, filename);
            if (content) {
                return { content, path: filename };
            }
        }

        return null;
    }
}
