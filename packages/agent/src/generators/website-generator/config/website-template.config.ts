import { config } from '@src/config';

export type WebsiteTemplateId = 'classic' | 'minimal';

export interface WebsiteTemplateConfig {
    id: WebsiteTemplateId;
    name: string;
    description: string;
    owner: string;
    repo: string;
    branch: string;
    syncBranches: string[];
    betaBranch?: string | null;
}

const CLASSIC_WEBSITE_TEMPLATE: WebsiteTemplateConfig = {
    id: 'classic',
    name: 'Classic',
    description: 'The original Ever Works directory website template.',
    owner: 'ever-works',
    repo: 'directory-web-template',
    branch: 'main',
    syncBranches: ['main', 'stage', 'develop'],
    betaBranch: config.websiteTemplate.getBetaBranch(),
};

const createMinimalWebsiteTemplate = (): WebsiteTemplateConfig | null => {
    const repo = config.websiteTemplate.getMinimalRepo();
    if (!repo) {
        return null;
    }

    return {
        id: 'minimal',
        name: 'Minimal',
        description: 'A more minimalistic Ever Works directory website template.',
        owner: config.websiteTemplate.getMinimalOwner(),
        repo,
        branch: config.websiteTemplate.getMinimalBranch(),
        syncBranches: ['main', 'stage', 'develop'],
        betaBranch: config.websiteTemplate.getMinimalBetaBranch(),
    };
};

export const DEFAULT_WEBSITE_TEMPLATE_ID: WebsiteTemplateId = 'classic';

export const WEBSITE_TEMPLATES: WebsiteTemplateConfig[] = [
    CLASSIC_WEBSITE_TEMPLATE,
    ...(() => {
        const minimalTemplate = createMinimalWebsiteTemplate();
        return minimalTemplate ? [minimalTemplate] : [];
    })(),
];

export function listWebsiteTemplates(): WebsiteTemplateConfig[] {
    return [...WEBSITE_TEMPLATES];
}

export function getDefaultWebsiteTemplateId(): WebsiteTemplateId {
    const configuredDefaultId = config.websiteTemplate.getDefaultTemplateId();
    const configuredTemplate = WEBSITE_TEMPLATES.find(
        (template) => template.id === configuredDefaultId,
    );

    return configuredTemplate?.id || DEFAULT_WEBSITE_TEMPLATE_ID;
}

export function getWebsiteTemplateConfig(templateId?: string | null): WebsiteTemplateConfig {
    const resolvedTemplateId = templateId || getDefaultWebsiteTemplateId();

    return (
        WEBSITE_TEMPLATES.find((template) => template.id === resolvedTemplateId) ||
        CLASSIC_WEBSITE_TEMPLATE
    );
}

export function getWebsiteTemplateBranch(template: WebsiteTemplateConfig, useBeta = false): string {
    return useBeta && template.betaBranch ? template.betaBranch : template.branch;
}

export const WEBSITE_TEMPLATE_CONFIG = getWebsiteTemplateConfig();
