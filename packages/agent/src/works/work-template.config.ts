/**
 * Curated Work Templates catalog.
 *
 * Work Templates are the pre-baked starters behind the "Work
 * Templates" tab on the Templates page: an id + display name +
 * description pointing at a real GitHub boilerplate repo the user can
 * fork into their own Work. The list here is the built-in catalog the
 * `TemplateCatalogService` seeds on boot; users can add custom Work
 * Template repos via the same Add Custom Template flow as website and
 * mission templates.
 *
 * Shape mirrors `WebsiteTemplateConfig` / `MissionTemplateConfig`
 * (owner / repo / branch + id / name / description) so the catalog
 * seed path can treat every kind uniformly. Unlike those two, a Work
 * Template carries an explicit `framework` so the catalog card can
 * label it deterministically (the website seed infers framework from
 * the repo name; Work Templates state it outright).
 */
export type WorkTemplateId = string;

export interface WorkTemplateConfig {
    id: WorkTemplateId;
    name: string;
    description: string;
    owner: string;
    repo: string;
    branch: string;
    syncBranches: string[];
    betaBranch?: string | null;
    // Human-facing framework label surfaced on the catalog card. Stated
    // explicitly (rather than inferred) so e.g. the Astro starter is not
    // mislabelled by repo-name heuristics.
    framework?: string | null;
}

const STARTER_DIRECTORY_WORK_TEMPLATE: WorkTemplateConfig = {
    id: 'starter-directory',
    name: 'Starter Directory',
    description:
        'A Next.js directory boilerplate — a batteries-included starting point for spinning up a new directory Work.',
    owner: 'ever-works',
    repo: 'directory-web-template',
    branch: 'main',
    syncBranches: ['main'],
    betaBranch: null,
    framework: 'Next.js',
};

const STARTER_DIRECTORY_MINIMAL_WORK_TEMPLATE: WorkTemplateConfig = {
    id: 'starter-directory-minimal',
    name: 'Starter Directory (Minimal)',
    description:
        'A minimal Astro directory boilerplate — a lightweight starting point for a fast, content-first directory Work.',
    owner: 'ever-works',
    repo: 'directory-web-minimal-template',
    branch: 'main',
    syncBranches: ['main'],
    betaBranch: null,
    framework: 'Astro',
};

export const WORK_TEMPLATES: WorkTemplateConfig[] = [
    STARTER_DIRECTORY_WORK_TEMPLATE,
    STARTER_DIRECTORY_MINIMAL_WORK_TEMPLATE,
];

export function listWorkTemplates(): WorkTemplateConfig[] {
    return [...WORK_TEMPLATES];
}

export function findWorkTemplateConfig(templateId?: string | null): WorkTemplateConfig | null {
    if (!templateId) return null;
    return WORK_TEMPLATES.find((template) => template.id === templateId) ?? null;
}
