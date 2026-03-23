import { Injectable, Logger } from '@nestjs/common';
import { GitFacadeService } from '@src/facades/git.facade';
import type { GitPullRequest } from '@ever-works/plugin';
import type { ItemData } from '@ever-works/contracts';

export interface GitFacadeOptionsForParsing {
    userId: string;
    providerId: string;
    token?: string;
}

export interface ParseIssuesAndPrsOptions {
    owner: string;
    repo: string;
    facadeOptions: GitFacadeOptionsForParsing;
    seedItems: ItemData[];
    maxPrPages?: number;
}

export interface ParseIssuesAndPrsResult {
    candidates: ItemData[];
    sourceCounts: {
        fromPrs: number;
        fromIssues: number;
    };
}

interface ExtractedCandidate {
    name: string;
    url: string;
    description: string;
    source: 'pr' | 'issue';
}

/**
 * Parses GitHub/GitLab PRs and issues to extract additional item candidates
 * for the import enrichment pipeline.
 *
 * Strategy:
 * - Closed/merged PRs: parse title and body for added items ("Add X" pattern), extract URLs
 * - Open issues: parse body for item suggestions ("Please add X", "Missing: X")
 * - Deduplicates against seed items by URL and name
 */
@Injectable()
export class GitIssuePrParserService {
    private readonly logger = new Logger(GitIssuePrParserService.name);

    /** Patterns for PR titles that indicate adding a new item */
    private readonly ADD_PATTERNS = [
        /^add\s+(.+)/i,
        /^feat:\s*add\s+(.+)/i,
        /^new:\s*(.+)/i,
        /^\[add\]\s*(.+)/i,
    ];

    /** Regex to extract markdown links [text](url) */
    private readonly MARKDOWN_LINK_REGEX = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;

    /** Regex to extract bare URLs */
    private readonly BARE_URL_REGEX =
        /(?<!\()(?<!\[)(https?:\/\/(?:github\.com|gitlab\.com|[^\s)]+\.[a-z]{2,})\/[^\s)]+)/gi;

    constructor(private readonly gitFacade: GitFacadeService) {}

    async parseIssuesAndPrs(options: ParseIssuesAndPrsOptions): Promise<ParseIssuesAndPrsResult> {
        const { owner, repo, facadeOptions, seedItems, maxPrPages = 3 } = options;
        const gitOptions = {
            userId: facadeOptions.userId,
            providerId: facadeOptions.providerId,
            token: facadeOptions.token,
        };

        const seedIndex = this.buildSeedIndex(seedItems);
        const allCandidates: ExtractedCandidate[] = [];

        // Parse closed/merged PRs
        try {
            for (let page = 1; page <= maxPrPages; page++) {
                const prs = await this.gitFacade.listPullRequests(
                    owner,
                    repo,
                    { state: 'closed', perPage: 100, page },
                    gitOptions,
                );

                if (prs.length === 0) break;

                const prCandidates = this.extractCandidatesFromPrs(prs);
                allCandidates.push(...prCandidates);

                this.logger.debug(
                    `Page ${page}: found ${prCandidates.length} candidates from ${prs.length} PRs`,
                );
            }
        } catch (error) {
            this.logger.warn(
                `Failed to list PRs for ${owner}/${repo}: ${(error as Error).message}`,
            );
        }

        // Deduplicate against seed items
        const deduplicated = this.deduplicateAgainstSeed(allCandidates, seedIndex);

        // Convert to ItemData
        const candidates = deduplicated.map((c) => this.toItemData(c));

        const fromPrs = deduplicated.filter((c) => c.source === 'pr').length;
        const fromIssues = deduplicated.filter((c) => c.source === 'issue').length;

        this.logger.log(
            `Parsed ${allCandidates.length} raw candidates, ${candidates.length} unique after dedup ` +
                `(${fromPrs} from PRs, ${fromIssues} from issues)`,
        );

        return {
            candidates,
            sourceCounts: { fromPrs, fromIssues },
        };
    }

    private extractCandidatesFromPrs(prs: GitPullRequest[]): ExtractedCandidate[] {
        const candidates: ExtractedCandidate[] = [];

        for (const pr of prs) {
            // Only process merged/closed PRs
            if (pr.state !== 'merged' && pr.state !== 'closed') continue;

            // Check if PR title matches an "add" pattern
            let itemName: string | null = null;
            for (const pattern of this.ADD_PATTERNS) {
                const match = pr.title.match(pattern);
                if (match) {
                    itemName = match[1].trim();
                    break;
                }
            }

            if (!itemName) continue;

            // Extract URLs from the PR body
            const urls = this.extractUrls(pr.body || '');

            if (urls.length > 0) {
                // Use the first URL as the source URL
                candidates.push({
                    name: itemName,
                    url: urls[0].url,
                    description: urls[0].text || pr.title,
                    source: 'pr',
                });
            } else {
                // Even without a URL, the PR title gives us a name to research
                candidates.push({
                    name: itemName,
                    url: '',
                    description: pr.title,
                    source: 'pr',
                });
            }
        }

        return candidates;
    }

    private extractUrls(body: string): Array<{ url: string; text: string }> {
        const urls: Array<{ url: string; text: string }> = [];
        const seen = new Set<string>();

        // Extract markdown links
        let match: RegExpExecArray | null;
        const mdRegex = new RegExp(this.MARKDOWN_LINK_REGEX.source, this.MARKDOWN_LINK_REGEX.flags);
        while ((match = mdRegex.exec(body)) !== null) {
            const url = match[2];
            if (!seen.has(url.toLowerCase())) {
                seen.add(url.toLowerCase());
                urls.push({ url, text: match[1] });
            }
        }

        // Extract bare URLs not already captured
        const bareRegex = new RegExp(this.BARE_URL_REGEX.source, this.BARE_URL_REGEX.flags);
        while ((match = bareRegex.exec(body)) !== null) {
            const url = match[0];
            if (!seen.has(url.toLowerCase())) {
                seen.add(url.toLowerCase());
                urls.push({ url, text: '' });
            }
        }

        return urls;
    }

    private buildSeedIndex(seedItems: ItemData[]): Set<string> {
        const index = new Set<string>();
        for (const item of seedItems) {
            if (item.source_url) {
                index.add(item.source_url.toLowerCase().replace(/\/$/, ''));
            }
            index.add(item.name.toLowerCase());
        }
        return index;
    }

    private deduplicateAgainstSeed(
        candidates: ExtractedCandidate[],
        seedIndex: Set<string>,
    ): ExtractedCandidate[] {
        const seen = new Set<string>();
        const result: ExtractedCandidate[] = [];

        for (const candidate of candidates) {
            const normalizedName = candidate.name.toLowerCase();
            const normalizedUrl = candidate.url?.toLowerCase().replace(/\/$/, '') || '';

            // Skip if already in seed
            if (seedIndex.has(normalizedName)) continue;
            if (normalizedUrl && seedIndex.has(normalizedUrl)) continue;

            // Skip internal duplicates
            const key = normalizedUrl || normalizedName;
            if (seen.has(key)) continue;
            seen.add(key);

            result.push(candidate);
        }

        return result;
    }

    private toItemData(candidate: ExtractedCandidate): ItemData {
        return {
            name: candidate.name,
            description: candidate.description,
            source_url: candidate.url || '',
            category: '',
            tags: [candidate.source === 'pr' ? 'from-pr' : 'from-issue'],
        };
    }
}
