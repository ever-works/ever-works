/**
 * Phase 8 PR X — curated Mission Templates catalog.
 *
 * Mission Templates are pre-baked Goal/Project starters: a
 * description, a recommended cadence, and a seed of guardrails
 * override + KB pointers the user can fork into their own
 * `<slug>-mission` repo (per Decision A8). The list here is the
 * built-in catalog the TemplateCatalogService seeds on boot;
 * users can add custom Mission Template repos via the same Add
 * Custom Template flow as website templates.
 *
 * Shape mirrors `WebsiteTemplateConfig` (owner / repo / branch
 * + name / description / id) so the catalog seed path can treat
 * both kinds uniformly. The Mission-specific extras (cadence
 * suggestion, KB seed paths) live in `.works/mission.yml` inside
 * each template repo — read at fork time by Phase 8 PR JJ's
 * `MissionTemplateManifestService`.
 *
 * v1 seeds two starter templates so PR W's Mission tab on the
 * Templates page renders real content; PR JJ wires the manifest
 * reader; the per-Mission `<slug>-mission` repo scaffolder
 * (Decision A8 — Phase 8 PR X.2) is a follow-up that wires
 * `gitFacade.createRepository()` to a chosen template.
 */
export type MissionTemplateId = string;

export interface MissionTemplateConfig {
    id: MissionTemplateId;
    name: string;
    description: string;
    owner: string;
    repo: string;
    branch: string;
    syncBranches: string[];
    betaBranch?: string | null;
}

const STARTER_BUSINESS_MISSION_TEMPLATE: MissionTemplateConfig = {
    id: 'starter-business',
    name: 'Starter Business',
    description:
        'A blank-slate Mission for spinning up Ideas around a new business — research-heavy cadence, balanced guardrails.',
    owner: 'ever-works',
    repo: 'starter-business-mission-template',
    branch: 'main',
    syncBranches: ['main'],
    betaBranch: null,
};

const STARTER_CONTENT_MISSION_TEMPLATE: MissionTemplateConfig = {
    id: 'starter-content',
    name: 'Starter Content Site',
    description:
        'A Mission for running a recurring content site — weekly cadence, lower guardrails, auto-build on by default.',
    owner: 'ever-works',
    repo: 'starter-content-mission-template',
    branch: 'main',
    syncBranches: ['main'],
    betaBranch: null,
};

export const MISSION_TEMPLATES: MissionTemplateConfig[] = [
    STARTER_BUSINESS_MISSION_TEMPLATE,
    STARTER_CONTENT_MISSION_TEMPLATE,
];

export function listMissionTemplates(): MissionTemplateConfig[] {
    return [...MISSION_TEMPLATES];
}

export function findMissionTemplateConfig(
    templateId?: string | null,
): MissionTemplateConfig | null {
    if (!templateId) return null;
    return MISSION_TEMPLATES.find((template) => template.id === templateId) ?? null;
}
