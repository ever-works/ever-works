/**
 * Work-blueprint catalog — isomorphic client types + built-in fallback
 * (Works Templates spec, ADR-014).
 *
 * Safe to import from BOTH server and client components — no `server-only`
 * modules are pulled in. The server-only fetch-with-fallback lives in
 * `work-templates.server.ts`; client code (e.g. the Create-Work chips +
 * selector) imports the type + `listBuiltinWorkBlueprints` from here.
 *
 * `WorkBlueprintEntry` mirrors the API DTO returned by
 * `GET /api/work-templates` (apps/api `works-template-catalog.service.ts`).
 */

export type WorkBlueprintStatus = 'production' | 'beta' | 'placeholder';

export interface WorkBlueprintEntry {
    /** Stable id; becomes `CreateWorkDto.websiteTemplateId`. */
    slug: string;
    /** Short selector label. */
    name: string;
    /** Full card title. */
    title: string;
    /** From manifest `summary`. */
    description: string;
    /** website | landing | blog | directory | store | company | awesome. */
    chipType: string;
    /** Chip value / Work intent (landing-page, awesome-repo, …). */
    kind: string;
    /** Coarse search facet. */
    category?: string;
    /** PascalCase Lucide id, resolved at render time. */
    iconName?: string;
    /** Search-friendly tags. */
    tags?: string[];
    /** manifest `default: true`. */
    isDefault: boolean;
    /** manifest `featured: true`. */
    featured: boolean;
    /** production | beta | placeholder — placeholders are non-selectable. */
    status: WorkBlueprintStatus;
    /** Parsed from `template.repo` (null for placeholder rows). */
    templateRepoOwner: string | null;
    templateRepoName: string | null;
    /** `sha` ?? `ref` (null when neither is set). */
    templateRef: string | null;
    /** → `CreateWorkDto.organization`. */
    isOrganization: boolean;
    gitProvider?: string;
    storageProvider?: string;
    deployProvider?: string;
}

/**
 * Built-in blueprint fallback — the hardcoded `classic` / `minimal` website
 * templates typed as blueprints. Mirrors `packages/agent` `WEBSITE_TEMPLATES`
 * so the Create-Work chips + selector never render empty when the manifest
 * catalog is cold / rate-limited / unreachable. Additive: these are the same
 * offline fallback that ships today.
 */
const BUILTIN_WORK_BLUEPRINTS: WorkBlueprintEntry[] = [
    {
        slug: 'classic',
        name: 'Classic',
        title: 'Classic Directory',
        description: 'The standard Next.js directory template with categories, search, and items.',
        chipType: 'website',
        kind: 'website',
        category: 'web',
        iconName: 'LayoutTemplate',
        tags: ['nextjs', 'directory'],
        isDefault: true,
        featured: true,
        status: 'production',
        templateRepoOwner: 'ever-works',
        templateRepoName: 'directory-web-template',
        templateRef: null,
        isOrganization: false,
    },
    {
        slug: 'minimal',
        name: 'Minimal',
        title: 'Minimal Directory',
        description: 'A lightweight, minimal directory template for a faster, simpler site.',
        chipType: 'website',
        kind: 'website',
        category: 'web',
        iconName: 'Minimize2',
        tags: ['minimal', 'directory'],
        isDefault: false,
        featured: false,
        status: 'production',
        templateRepoOwner: 'ever-works',
        templateRepoName: 'directory-web-minimal-template',
        templateRef: null,
        isOrganization: false,
    },
];

/**
 * Returns the built-in blueprint fallback, optionally filtered by chipType.
 * Isomorphic + synchronous — safe from client components.
 */
export function listBuiltinWorkBlueprints(chipType?: string): WorkBlueprintEntry[] {
    if (!chipType) return BUILTIN_WORK_BLUEPRINTS;
    return BUILTIN_WORK_BLUEPRINTS.filter((b) => b.chipType === chipType);
}
