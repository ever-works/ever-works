import { DomainType } from '../steps/domain-detection.service';

export class DomainUrlValidator {
    private readonly OFFICIAL_PATTERNS: Record<DomainType, RegExp[]> = {
        [DomainType.SOFTWARE]: [
            /github\.com\/[\w-]+\/[\w-]+/,
            /gitlab\.com\/[\w-]+\/[\w-]+/,
            /npmjs\.com\/package\//,
        ],
        [DomainType.ECOMMERCE]: [/\/products?\//i, /^https?:\/\/(www\.)?[\w-]+\.com/i],
        [DomainType.SERVICES]: [/\/contact/i, /\/about/i],
        [DomainType.EDUCATION]: [/\/course/i, /\/learn/i],
        [DomainType.HEALTHCARE]: [/\/clinic/i, /health/i],
        [DomainType.ENTERTAINMENT]: [/\/game/i, /\/music/i, /\/movie/i],
        [DomainType.GENERAL]: [],
    };

    private readonly AGGREGATOR_PATTERNS: Record<DomainType, RegExp[]> = {
        [DomainType.SOFTWARE]: [/g2\.com/i, /capterra\.com/i, /alternativeto\.net/i],
        [DomainType.ECOMMERCE]: [/amazon\./i, /ebay\./i],
        [DomainType.SERVICES]: [/yelp\./i, /tripadvisor\./i, /google\.com\/maps/i],
        [DomainType.EDUCATION]: [/udemy\./i, /coursera\./i],
        [DomainType.HEALTHCARE]: [/healthgrades\./i],
        [DomainType.ENTERTAINMENT]: [/imdb\.com/i, /rottentomatoes\.com/i],
        [DomainType.GENERAL]: [],
    };

    isOfficial(url: string, domain: DomainType): boolean {
        return this.OFFICIAL_PATTERNS[domain].some((p) => p.test(url));
    }

    isAggregator(url: string, domain: DomainType): boolean {
        return this.AGGREGATOR_PATTERNS[domain].some((p) => p.test(url));
    }
}
