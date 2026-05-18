import { config } from '@src/config';

export type WebsiteTemplateId = string;

export interface WebsiteTemplateConfig {
    id: WebsiteTemplateId;
    name: string;
    description: string;
    owner: string;
    repo: string;
    branch: string;
    syncBranches: string[];
    betaBranch?: string | null;
    // Whether a fork of this template can be agent-customized (UI-only edits
    // applied to a user's fork). Templates without a matching customization
    // prompt cannot be customized regardless of this flag. See
    // packages/agent/src/template-catalog/customization-prompts/.
    customizable?: boolean;
}

const CLASSIC_WEBSITE_TEMPLATE: WebsiteTemplateConfig = {
    id: 'classic',
    name: 'Classic',
    description: 'The original Ever Works website template.',
    owner: 'ever-works',
    // Concrete GitHub repository name. See
    // docs/features/website-templates.md for the full template catalogue.
    repo: 'directory-web-template',
    branch: 'main',
    syncBranches: ['main', 'stage', 'develop'],
    betaBranch: config.websiteTemplate.getBetaBranch(),
    // Too large/complex to safely agent-customize end-to-end today.
    customizable: false,
};

const MINIMAL_WEBSITE_TEMPLATE: WebsiteTemplateConfig = {
    id: 'minimal',
    name: 'Minimal',
    description: 'A more minimalistic Ever Works work website template.',
    owner: config.websiteTemplate.getMinimalOwner(),
    repo: config.websiteTemplate.getMinimalRepo(),
    branch: config.websiteTemplate.getMinimalBranch(),
    syncBranches: ['main', 'stage', 'develop'],
    betaBranch: config.websiteTemplate.getMinimalBetaBranch(),
    customizable: true,
};

export const DEFAULT_WEBSITE_TEMPLATE_ID: WebsiteTemplateId = 'classic';

export const WEBSITE_TEMPLATES: WebsiteTemplateConfig[] = [
    CLASSIC_WEBSITE_TEMPLATE,
    MINIMAL_WEBSITE_TEMPLATE,
];

export function listWebsiteTemplates(): WebsiteTemplateConfig[] {
    return [...WEBSITE_TEMPLATES];
}

export function findWebsiteTemplateConfig(
    templateId?: string | null,
): WebsiteTemplateConfig | null {
    if (!templateId) {
        return null;
    }

    return WEBSITE_TEMPLATES.find((template) => template.id === templateId) || null;
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

    return findWebsiteTemplateConfig(resolvedTemplateId) || CLASSIC_WEBSITE_TEMPLATE;
}

export function getWebsiteTemplateBranch(template: WebsiteTemplateConfig, useBeta = false): string {
    return useBeta && template.betaBranch ? template.betaBranch : template.branch;
}

export const WEBSITE_TEMPLATE_CONFIG = getWebsiteTemplateConfig();
