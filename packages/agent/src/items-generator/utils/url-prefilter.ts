import { Injectable } from '@nestjs/common';

export type UrlClassification = 'accept' | 'reject' | 'needs_llm';

@Injectable()
export class UrlPrefilter {
    // High-confidence official patterns (skip LLM validation)
    private readonly OFFICIAL_PATTERNS = [
        /^https?:\/\/github\.com\/[\w-]+\/[\w-]+\/?$/,
        /^https?:\/\/gitlab\.com\/[\w-]+\/[\w-]+\/?$/,
        /^https?:\/\/www\.npmjs\.com\/package\/[\w-]+\/?$/,
        /^https?:\/\/pypi\.org\/project\/[\w-]+\/?$/,
        /^https?:\/\/crates\.io\/crates\/[\w-]+\/?$/,
        /^https?:\/\/packagist\.org\/packages\/[\w-]+\/[\w-]+\/?$/,
    ];

    // Low-quality or irrelevant patterns (reject immediately)
    private readonly REJECT_PATTERNS = [
        /^https?:\/\/(www\.)?google\./,
        /^https?:\/\/(www\.)?facebook\./,
        /^https?:\/\/(www\.)?twitter\./,
        /^https?:\/\/(www\.)?linkedin\./,
        /^https?:\/\/(www\.)?instagram\./,
        /^https?:\/\/(www\.)?tiktok\./,
        /^https?:\/\/(www\.)?pinterest\./,
        /\/search\?/,
        /\/tag\//,
        /\/category\//,
        /\/page\/\d+/,
        /\?utm_/,
    ];

    /**
     * Classifies a URL based on regex patterns.
     * - 'accept': High confidence official URL (save LLM cost)
     * - 'reject': Known irrelevant pattern (save LLM cost)
     * - 'needs_llm': Ambiguous, let the LLM decide
     */
    classify(url: string): UrlClassification {
        if (!url || typeof url !== 'string') {
            return 'reject';
        }

        if (this.REJECT_PATTERNS.some((p) => p.test(url))) {
            return 'reject';
        }

        if (this.OFFICIAL_PATTERNS.some((p) => p.test(url))) {
            return 'accept';
        }

        return 'needs_llm';
    }
}
