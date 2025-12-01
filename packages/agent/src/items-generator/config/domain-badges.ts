import { DomainType } from '../steps/domain-detection.service';

export type DomainBadgeType =
    | 'security'
    | 'license'
    | 'quality'
    | 'verified'
    | 'price_range'
    | 'availability'
    | 'booking';

export const DOMAIN_BADGE_TYPES: Record<DomainType, DomainBadgeType[]> = {
    [DomainType.SOFTWARE]: ['security', 'license', 'quality'],
    [DomainType.ECOMMERCE]: ['verified', 'price_range'],
    [DomainType.SERVICES]: ['availability', 'booking'],
    [DomainType.EDUCATION]: ['verified'],
    [DomainType.HEALTHCARE]: ['verified'],
    [DomainType.ENTERTAINMENT]: ['quality'],
    [DomainType.GENERAL]: ['quality'],
};
