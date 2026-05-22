import { tool } from 'ai';
import { z } from 'zod';
import { Logger } from '@nestjs/common';
import type { ContentExtractorFacadeService } from '../../facades/content-extractor.facade';
import type { UserResearchLimitsService } from '../limits';

interface CreateFetchPageToolOptions {
    contentExtractor: ContentExtractorFacadeService;
    limits: UserResearchLimitsService;
    userId: string;
    logger?: Logger;
    maxContentChars?: number;
}

const inputSchema = z.object({
    url: z.string().url().describe('Absolute URL of the page to fetch.'),
});

export function createFetchPageTool(opts: CreateFetchPageToolOptions) {
    const log = opts.logger ?? new Logger('UserResearch:fetchPage');
    const maxChars = opts.maxContentChars ?? 2000;

    return tool({
        description:
            'Fetch and extract readable content from a single web page. Use sparingly (at most 3 times per run) on the most promising results — e.g. personal site, GitHub profile, company about page.',
        inputSchema,
        execute: async (input) => {
            try {
                const result = await opts.contentExtractor.extractContentWithDiagnostics(
                    input.url,
                    { includeImages: false, includeLinks: false },
                    { userId: opts.userId },
                );

                if (!result.content) {
                    return { content: null, error: result.error ?? 'no content extracted' };
                }

                const raw = result.content.rawContent ?? '';
                const truncated =
                    raw.length > maxChars ? raw.slice(0, maxChars) + '\n...[truncated]' : raw;
                const title =
                    typeof result.content.metadata?.['title'] === 'string'
                        ? (result.content.metadata['title'] as string)
                        : undefined;

                return {
                    content: truncated,
                    title,
                    url: input.url,
                };
            } catch (err) {
                log.warn(`fetchPage failed for ${input.url}: ${(err as Error).message}`);
                return { content: null, error: (err as Error).message };
            }
        },
    });
}
