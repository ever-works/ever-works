import { Injectable, Logger } from '@nestjs/common';
import { GitFacadeService } from '@src/facades/git.facade';
import { ImportSourceType } from '@src/entities/directory.entity';
import {
    AnalyzeRepositoryResponseDto,
    AnalyzeForLinkingResponseDto,
    RelatedRepoStatus,
} from '@src/dto/import-directory.dto';

interface ParsedRepoUrl {
    owner: string;
    repo: string;
    provider?: string;
}

interface RepoContent {
    name: string;
    type: 'file' | 'dir' | 'submodule' | 'symlink';
    path: string;
}

// Supported git provider URL patterns
const GIT_PROVIDER_PATTERNS: Array<{
    pattern: RegExp;
    provider: string;
}> = [
    // GitHub
    { pattern: /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)$/, provider: 'github' },
    { pattern: /^github\.com\/([^/]+)\/([^/]+)$/, provider: 'github' },
    // GitLab (can add more patterns as needed)
    { pattern: /^https?:\/\/(?:www\.)?gitlab\.com\/([^/]+)\/([^/]+)$/, provider: 'gitlab' },
    // Bitbucket (can add more patterns as needed)
    { pattern: /^https?:\/\/(?:www\.)?bitbucket\.org\/([^/]+)\/([^/]+)$/, provider: 'bitbucket' },
];

@Injectable()
export class SourceRepoAnalyzerService {
    private readonly logger = new Logger(SourceRepoAnalyzerService.name);

    constructor(private readonly gitFacade: GitFacadeService) {}

    /**
     * Parse a git repository URL into owner and repo components.
     * Supports multiple git providers (GitHub, GitLab, Bitbucket).
     */
    parseGitUrl(url: string): ParsedRepoUrl | null {
        try {
            const cleanUrl = url.replace(/\.git$/, '').replace(/\/$/, '');

            for (const { pattern, provider } of GIT_PROVIDER_PATTERNS) {
                const match = cleanUrl.match(pattern);
                if (match) {
                    return {
                        owner: match[1],
                        repo: match[2],
                        provider,
                    };
                }
            }

            return null;
        } catch (error) {
            this.logger.error(`Failed to parse repository URL: ${url}`, error);
            return null;
        }
    }

    async analyzeRepository(
        sourceUrl: string,
        token?: string,
    ): Promise<AnalyzeRepositoryResponseDto> {
        const parsed = this.parseGitUrl(sourceUrl);

        if (!parsed) {
            return {
                sourceUrl,
                owner: '',
                repo: '',
                detectedType: null,
                isPublic: false,
                requiresAuth: false,
                error: 'Invalid repository URL format. Expected format: https://<provider>.com/owner/repo',
            };
        }

        const { owner, repo, provider } = parsed;

        try {
            // Check if git provider is configured
            if (!this.gitFacade.isConfigured()) {
                return {
                    sourceUrl,
                    owner,
                    repo,
                    detectedType: null,
                    isPublic: false,
                    requiresAuth: true,
                    error: 'No git provider configured. Please connect your git provider account.',
                };
            }

            // Get repository info via facade
            let repoInfo;
            try {
                repoInfo = await this.gitFacade.getRepository(owner, repo, {
                    token,
                    providerId: provider,
                });
            } catch (err: any) {
                if (err.status === 404 || err.message?.includes('not found')) {
                    if (!token) {
                        return {
                            sourceUrl,
                            owner,
                            repo,
                            detectedType: null,
                            isPublic: false,
                            requiresAuth: true,
                            error: 'Repository not found. It may be private - please connect your git provider account.',
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
                        error: 'Access denied. Please connect your git provider account with appropriate permissions.',
                    };
                }
                throw err;
            }

            if (!repoInfo) {
                return {
                    sourceUrl,
                    owner,
                    repo,
                    detectedType: null,
                    isPublic: false,
                    requiresAuth: !token,
                    error: 'Repository not found.',
                };
            }

            const isPublic = !repoInfo.isPrivate;

            // Get root directory contents
            let contents: RepoContent[] | null;
            try {
                contents = await this.gitFacade.getDirectoryContents(owner, repo, '', {
                    token,
                    providerId: provider,
                });
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

            if (!contents) {
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

            const detectionResult = await this.detectRepositoryType(
                owner,
                repo,
                contents,
                token,
                provider,
            );

            const response: AnalyzeRepositoryResponseDto = {
                sourceUrl,
                owner,
                repo,
                detectedType: detectionResult.type,
                isPublic,
                requiresAuth: false,
                structure: detectionResult.structure,
            };

            if (detectionResult.type !== 'data_repo') {
                const ecosystem = await this.detectDirectoryEcosystem(owner, repo, token, provider);
                if (ecosystem) {
                    response.relatedDataRepo = ecosystem.dataRepo;
                    response.baseSlug = ecosystem.baseSlug;
                }
            }

            return response;
        } catch (error: any) {
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
        owner: string,
        repo: string,
        contents: RepoContent[],
        token?: string,
        provider?: string,
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
            isMultiFile: false,
            itemCount: undefined as number | undefined,
            categoryCount: undefined as number | undefined,
        };

        if (hasConfig && hasDataFolder) {
            try {
                const dataContents = await this.gitFacade.getDirectoryContents(
                    owner,
                    repo,
                    'data',
                    { token, providerId: provider },
                );

                if (dataContents) {
                    const itemDirs = dataContents.filter((c) => c.type === 'dir');
                    structure.itemCount = itemDirs.length;
                }

                const hasCategoriesFile = contents.some(
                    (c) =>
                        (c.name === 'categories.yml' || c.name === 'categories.yaml') &&
                        c.type === 'file',
                );

                if (hasCategoriesFile) {
                    try {
                        const categoriesContent = await this.getFileContentInternal(
                            owner,
                            repo,
                            'categories.yml',
                            token,
                            provider,
                        );
                        if (categoriesContent) {
                            const categoryMatches = categoriesContent.match(/^-\s+(id|name):/gm);
                            structure.categoryCount = categoryMatches
                                ? categoryMatches.length
                                : undefined;
                        }
                    } catch {
                        try {
                            const categoriesContent = await this.getFileContentInternal(
                                owner,
                                repo,
                                'categories.yaml',
                                token,
                                provider,
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
                const readmeContent = await this.getFileContentInternal(
                    owner,
                    repo,
                    'README.md',
                    token,
                    provider,
                );

                if (readmeContent && this.isAwesomeListReadme(readmeContent)) {
                    // Check if this is a multi-file structure (links to subdirectories)
                    const directoryLinks = (
                        readmeContent.match(/\[.+?\]\(\.\/[a-zA-Z0-9-_]+\/?/gm) || []
                    ).length;
                    const isMultiFile = directoryLinks >= 3;
                    structure.isMultiFile = isMultiFile;

                    if (isMultiFile) {
                        const subDirs = contents.filter((c) => c.type === 'dir');
                        structure.categoryCount = subDirs.length;

                        // Extract item counts from directory names if available (e.g., "category-123")
                        let estimatedItems = 0;
                        for (const dir of subDirs) {
                            const countMatch = dir.name.match(/-(\d+)$/);
                            if (countMatch) {
                                estimatedItems += parseInt(countMatch[1], 10);
                            }
                        }
                        structure.itemCount = estimatedItems > 0 ? estimatedItems : undefined;
                    } else {
                        const listItems = this.countListItems(readmeContent);
                        structure.itemCount = listItems > 0 ? listItems : undefined;

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
                        structure.categoryCount = categoryHeaders
                            ? categoryHeaders.length
                            : undefined;
                    }

                    return { type: 'awesome_readme', structure };
                }
            } catch (err) {
                this.logger.warn(`Failed to analyze README: ${owner}/${repo}`, err);
            }
        }

        return { type: null, structure };
    }

    private countListItems(content: string): number {
        // Count bullet list links (- [Name](url) or * [Name](url), with optional bold)
        const bulletListLinks = (content.match(/^[-*]\s+\*{0,2}\[.+?\]\(.+?\)/gm) || []).length;

        // Count numbered list links (1. [Name](url))
        const numberedListLinks = (content.match(/^\d+\.\s+\*{0,2}\[.+?\]\(.+?\)/gm) || []).length;

        // Count table format links (| [Name](url) |)
        const tableLinks = (content.match(/\|\s*\[.+?\]\(https?:\/\/.+?\)/gm) || []).length;

        return bulletListLinks + numberedListLinks + tableLinks;
    }

    private isAwesomeListReadme(content: string): boolean {
        // Check for any markdown headers (H1, H2, or H3)
        const hasSectionHeaders = /^#{1,3}\s+.+$/m.test(content);

        // Pattern 1: Standard bullet list links (- [Name](url) or * [Name](url))
        const bulletListLinks = (content.match(/^[-*]\s+\*{0,2}\[.+?\]\(.+?\)/gm) || []).length;

        // Pattern 2: Numbered list links (1. [Name](url))
        const numberedListLinks = (content.match(/^\d+\.\s+\*{0,2}\[.+?\]\(.+?\)/gm) || []).length;

        // Pattern 3: Table format links (| [Name](url) |) with http/https URLs
        const tableLinks = (content.match(/\|\s*\[.+?\]\(https?:\/\/.+?\)/gm) || []).length;

        // Pattern 4: Links to internal directories (./folder/ or ./folder-name/)
        const directoryLinks = (content.match(/\[.+?\]\(\.\/[a-zA-Z0-9-_]+\/?/gm) || []).length;

        const totalLinkCount = bulletListLinks + numberedListLinks + tableLinks;
        const hasListLinks = totalLinkCount > 0;

        // Multi-file structure: has directory links AND section headers
        const isMultiFileStructure = directoryLinks >= 3 && hasSectionHeaders;

        // Standard awesome list: has list links AND section headers AND enough items
        const isStandardAwesomeList = hasListLinks && hasSectionHeaders && totalLinkCount >= 5;

        return isStandardAwesomeList || isMultiFileStructure;
    }

    private async getFileContentInternal(
        owner: string,
        repo: string,
        path: string,
        token?: string,
        provider?: string,
    ): Promise<string | null> {
        const result = await this.gitFacade.getFileContent(owner, repo, path, {
            token,
            providerId: provider,
        });
        return result?.content ?? null;
    }

    async getReadmeContent(
        sourceUrl: string,
        token?: string,
    ): Promise<{ content: string; path: string } | null> {
        const parsed = this.parseGitUrl(sourceUrl);
        if (!parsed) {
            return null;
        }

        const { owner, repo, provider } = parsed;

        // Try using the facade's getReadme method first
        const result = await this.gitFacade.getReadme(owner, repo, {
            token,
            providerId: provider,
        });
        if (result) {
            return result;
        }

        // Fallback: fetch from raw URL directly
        const branches = ['main', 'master'];
        const readmeFiles = ['README.md', 'readme.md', 'Readme.md', 'README.MD'];

        for (const branch of branches) {
            for (const filename of readmeFiles) {
                try {
                    const rawUrl = this.gitFacade.getRawFileUrl(
                        provider || 'github', // getRawFileUrl requires providerId
                        owner,
                        repo,
                        branch,
                        filename,
                    );
                    const response = await fetch(rawUrl);
                    if (response.ok) {
                        const content = await response.text();
                        return { content, path: filename };
                    }
                } catch {
                    // Continue to next attempt
                }
            }
        }

        return null;
    }

    async analyzeForLinking(
        sourceUrl: string,
        token: string,
    ): Promise<AnalyzeForLinkingResponseDto> {
        const parsed = this.parseGitUrl(sourceUrl);

        if (!parsed) {
            return {
                canLink: false,
                hasWriteAccess: false,
                relatedRepos: {
                    data: { exists: true, name: '' },
                    markdown: { exists: false, name: null },
                    website: { exists: false, name: null },
                },
                error: 'Invalid repository URL format',
            };
        }

        const { owner, repo, provider } = parsed;

        try {
            const repoInfo = await this.gitFacade.getRepository(owner, repo, {
                token,
                providerId: provider,
            });

            if (!repoInfo) {
                return {
                    canLink: false,
                    hasWriteAccess: false,
                    relatedRepos: {
                        data: { exists: true, name: repo },
                        markdown: { exists: false, name: null },
                        website: { exists: false, name: null },
                    },
                    error: 'Repository not found',
                };
            }

            // Check write access by trying to get repository with user context
            const hasWriteAccess = await this.gitFacade.hasRepositoryAccess(owner, repo, {
                token,
                providerId: provider,
            });

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
                const dataContents = await this.gitFacade.getDirectoryContents(
                    owner,
                    repo,
                    'data',
                    { token, providerId: provider },
                );
                if (dataContents) {
                    itemCount = dataContents.filter((c) => c.type === 'dir').length;
                }
            } catch {}

            try {
                const categoriesContent = await this.getFileContentInternal(
                    owner,
                    repo,
                    'categories.yml',
                    token,
                    provider,
                );
                if (categoriesContent) {
                    const categoryMatches = categoriesContent.match(/^-\s+(id|name):/gm);
                    categoryCount = categoryMatches ? categoryMatches.length : undefined;
                }
            } catch {}

            const relatedRepos = await this.detectRelatedRepos(owner, repo, token, provider);

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
        } catch (error: any) {
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

    async checkSlugConflicts(
        owner: string,
        slug: string,
        token: string,
        provider?: string,
    ): Promise<{
        hasConflict: boolean;
        conflictingRepos: string[];
        suggestedSlug: string;
    }> {
        const repoNames = [slug, `${slug}-data`, `${slug}-website`];
        const conflictingRepos: string[] = [];

        await Promise.all(
            repoNames.map(async (repoName) => {
                try {
                    const exists = await this.gitFacade.repositoryExists(owner, repoName, {
                        token,
                        providerId: provider,
                    });
                    if (exists) {
                        conflictingRepos.push(repoName);
                    }
                } catch {
                    // ignore
                }
            }),
        );

        if (conflictingRepos.length === 0) {
            return { hasConflict: false, conflictingRepos: [], suggestedSlug: slug };
        }

        // Try slug-2 through slug-10
        let suggestedSlug = slug;
        for (let i = 2; i <= 10; i++) {
            const candidate = `${slug}-${i}`;
            const candidateRepos = [candidate, `${candidate}-data`, `${candidate}-website`];
            let candidateConflicts = false;

            for (const repo of candidateRepos) {
                try {
                    const exists = await this.gitFacade.repositoryExists(owner, repo, {
                        token,
                        providerId: provider,
                    });
                    if (exists) {
                        candidateConflicts = true;
                        break;
                    }
                } catch {
                    // ignore
                }
            }

            if (!candidateConflicts) {
                suggestedSlug = candidate;
                break;
            }
        }

        if (suggestedSlug === slug) {
            suggestedSlug = `${slug}-${Date.now()}`;
        }

        return { hasConflict: true, conflictingRepos, suggestedSlug };
    }

    private async detectDirectoryEcosystem(
        owner: string,
        repo: string,
        token?: string,
        provider?: string,
    ): Promise<{ baseSlug: string; dataRepo: { name: string; owner: string } } | null> {
        if (repo.endsWith('-data')) {
            return null;
        }

        let candidateDataRepo: string;
        let baseSlug: string;

        if (repo.endsWith('-website')) {
            baseSlug = repo.slice(0, -8);
            candidateDataRepo = `${baseSlug}-data`;
        } else {
            baseSlug = repo;
            candidateDataRepo = `${repo}-data`;
        }

        try {
            const dataRepoInfo = await this.gitFacade.getRepository(owner, candidateDataRepo, {
                token,
                providerId: provider,
            });

            if (!dataRepoInfo) {
                return null;
            }

            const contents = await this.gitFacade.getDirectoryContents(
                owner,
                candidateDataRepo,
                '',
                { token, providerId: provider },
            );

            if (!contents) {
                return null;
            }

            const hasConfig =
                contents.some((c) => c.name === 'config.yml' && c.type === 'file') ||
                contents.some((c) => c.name === 'config.yaml' && c.type === 'file');
            const hasDataFolder = contents.some((c) => c.name === 'data' && c.type === 'dir');

            if (!hasConfig || !hasDataFolder) {
                return null;
            }

            return {
                baseSlug,
                dataRepo: { name: candidateDataRepo, owner },
            };
        } catch (err) {
            this.logger.debug(`No ecosystem data repo found for ${owner}/${repo}: ${err.message}`);
            return null;
        }
    }

    private async detectRelatedRepos(
        owner: string,
        dataRepoName: string,
        token: string,
        provider?: string,
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

        const markdown = await this.findExistingRepo(
            owner,
            potentialMarkdownRepos,
            token,
            provider,
        );
        const website = await this.findExistingRepo(owner, potentialWebsiteRepos, token, provider);

        return { markdown, website };
    }

    private async findExistingRepo(
        owner: string,
        potentialNames: string[],
        token: string,
        provider?: string,
    ): Promise<RelatedRepoStatus> {
        for (const name of potentialNames) {
            try {
                const repo = await this.gitFacade.getRepository(owner, name, {
                    token,
                    providerId: provider,
                });
                if (repo) {
                    const hasWriteAccess = await this.gitFacade.hasRepositoryAccess(owner, name, {
                        token,
                        providerId: provider,
                    });
                    return { exists: true, name, hasWriteAccess };
                }
            } catch {
                continue;
            }
        }
        return { exists: false, name: null };
    }
}
