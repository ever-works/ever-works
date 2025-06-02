/**
 * Configuration for the website template repository
 * This is the source template used for creating and updating website repositories
 */
export const WEBSITE_TEMPLATE_CONFIG = {
    owner: 'ever-co',
    repo: 'ever-works-website-template',
} as const;

export type WebsiteTemplateConfig = typeof WEBSITE_TEMPLATE_CONFIG;
