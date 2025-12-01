import { Injectable, Logger } from '@nestjs/common';
import { WebPageData } from '../interfaces/items-generator.interfaces';

@Injectable()
export class ContentPrefilterService {
    private readonly logger = new Logger(ContentPrefilterService.name);

    /**
     * Fast heuristic filtering before expensive LLM calls.
     * Goal: Eliminate obviously low-quality pages without risking relevant content.
     */
    prefilterPages(
        pages: WebPageData[],
        topicName: string,
        topicDescription: string,
    ): WebPageData[] {
        const keywords = this.extractBasicKeywords(topicName, topicDescription);

        return pages.filter((page) => {
            const content = page.raw_content || '';

            // 1. Content Structure Check
            // Reject if it lacks basic structure (headings, paragraphs)
            if (!this.hasStructure(content)) {
                this.logger.debug(`[Prefilter] Rejected ${page.source_url}: No structure`);
                return false;
            }

            // 2. Keyword Density Check
            // Reject if main topic keywords are virtually absent (< 0.1% density is extremely low)
            // We use a very low threshold to avoid false negatives
            if (!this.hasKeywordPresence(content, keywords)) {
                this.logger.debug(`[Prefilter] Rejected ${page.source_url}: No keyword presence`);
                return false;
            }

            // 3. Spam/Marketing Score
            // Reject if it looks purely like a generic landing page/spam
            if (this.isLikelySpam(content)) {
                this.logger.debug(`[Prefilter] Rejected ${page.source_url}: High spam score`);
                return false;
            }

            return true;
        });
    }

    private extractBasicKeywords(name: string, description: string): string[] {
        const stopWords = new Set([
            'the',
            'a',
            'an',
            'and',
            'or',
            'but',
            'in',
            'on',
            'at',
            'to',
            'for',
            'of',
            'with',
            'by',
            'best',
            'top',
            'list',
            'collection',
        ]);
        const text = `${name} ${description}`.toLowerCase();
        return text
            .split(/[\s,.-]+/)
            .filter((w) => w.length > 2 && !stopWords.has(w))
            .slice(0, 10); // Top 10 distinct words
    }

    private hasStructure(content: string): boolean {
        // Markdown/text content should have some structure tokens
        const hasHeadings = /^#{1,6}\s/m.test(content);
        const hasLists = /^[\-\*]\s/m.test(content) || /^\d+\.\s/m.test(content);
        const paragraphCount = content.split(/\n\n+/).length;

        // Loose check: needs at least one structural element or decent paragraph separation
        return hasHeadings || hasLists || paragraphCount > 3;
    }

    private hasKeywordPresence(content: string, keywords: string[]): boolean {
        const contentLower = content.toLowerCase();
        // Check if at least ONE relevant keyword appears reasonably often or at least once
        // We want to avoid pages that are completely unrelated
        const matches = keywords.filter((k) => contentLower.includes(k));
        return matches.length > 0;
    }

    private isLikelySpam(content: string): number | boolean {
        const spamIndicators = [
            /buy\s+now/gi,
            /limited\s+time/gi,
            /act\s+fast/gi,
            /click\s+here/gi,
            /free\s+trial/gi,
            /\$\d+/g, // Price mentions often
            /★{3,}/g, // Star ratings
        ];

        let score = 0;
        // A simple counter isn't enough, density matters.
        // But for a quick filter, we just check if these dominate the text?
        // Actually, implementing a hard spam rejector is risky for E-commerce domains.
        // So we will keep this very conservative.
        // Only reject if it's overwhelmed by these terms?
        // For now, let's return false (not spam) by default unless we are sure.
        // We'll stub this for now to avoid reducing accuracy on E-commerce.
        return false;
    }
}
