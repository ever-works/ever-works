import { DomainType } from '../steps/domain-detection.service';

export const DOMAIN_EXTRACTION_PROMPTS: Record<DomainType, string> = {
    [DomainType.SOFTWARE]: `Extract software tools, libraries, frameworks, and services. Look for official websites, docs, or repositories. Prefer license/platform/pricing attributes.`,
    [DomainType.ECOMMERCE]: `Extract products or brands with official brand or product pages. Avoid marketplaces/aggregators unless official. Capture price ranges and materials when available.`,
    [DomainType.SERVICES]: `Extract businesses or service providers (restaurants, hotels, agencies). Prefer official sites/booking pages. Capture location, contact, hours.`,
    [DomainType.EDUCATION]: `Extract courses, tutorials, schools, or programs. Prefer official institution pages. Capture level, format, and prerequisites.`,
    [DomainType.HEALTHCARE]: `Extract medical/wellness products or providers. Prefer official clinic/manufacturer pages. Capture indications, certifications, and locations.`,
    [DomainType.ENTERTAINMENT]: `Extract movies, games, music, venues. Prefer official sites or publisher pages. Capture release info and platform.`,
    [DomainType.GENERAL]: `Extract items directly relevant to the topic. Prefer official sources over aggregators.`,
};
