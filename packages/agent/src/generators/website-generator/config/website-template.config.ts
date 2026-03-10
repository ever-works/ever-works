export const WEBSITE_TEMPLATE_CONFIG = {
    owner: 'ever-works',
    repo: 'directory-web-template',
    branch: 'main',
    syncBranches: ['main', 'stage', 'develop'],
} as const;

export type WebsiteTemplateConfig = typeof WEBSITE_TEMPLATE_CONFIG;
