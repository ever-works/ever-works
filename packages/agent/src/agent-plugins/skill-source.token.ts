import type { FacadeOptions, SkillCatalogEntry } from '@ever-works/plugin';

/**
 * The seam by which Agent Plugins packages contribute to the skills catalog.
 *
 * A token rather than a direct import, and a leaf file with type-only imports,
 * for three reasons that each bit someone before:
 *
 * 1. `SkillsFacadeService` must behave **identically** when nothing is bound.
 *    An `@Optional()` token gives that for free; a direct dependency would
 *    make the facade require a module it does not need.
 * 2. Binding the implementation into the `FACADES` provider array would turn
 *    `facades.module.spec.ts` red — it asserts that array's length exactly.
 *    A token bound by its own leaf module extends only `imports`, which is
 *    asserted by containment.
 * 3. Type-only imports keep this file out of the dependency cycle that
 *    concrete imports between facades and feature modules would create.
 *
 * The implementation lives in the agent-plugins module and is deliberately
 * NOT a native plugin: plugins are instantiated bare with no repository
 * access, and the skills-provider capability is scope-blind, so a plugin
 * could neither read a tenant-scoped registry nor scope it.
 */
export const AGENT_PLUGIN_SKILL_SOURCE = 'AGENT_PLUGIN_SKILL_SOURCE' as const;

/**
 * What the facade asks of a package source.
 *
 * Note both methods exist. `listEntries` and `getEntry` are separate code
 * paths in the facade, and wiring only the first produces a catalog card
 * whose Install button 404s — the install route resolves through `getEntry`.
 */
export interface AgentPluginSkillSource {
    /**
     * Every skill from every installed package, already shaped as catalog
     * entries. Returns an empty array when the feature is off.
     *
     * The facade merges these LAST, so the existing first-wins slug dedupe
     * guarantees a package can never displace a provider plugin's entry.
     */
    listEntries(options: AgentPluginSkillSourceOptions): Promise<SkillCatalogEntry[]>;

    /** One entry by slug, or null. Must agree with `listEntries` about slugs. */
    getEntry(
        slug: string,
        options: AgentPluginSkillSourceOptions,
    ): Promise<{ entry: SkillCatalogEntry; providerId: string } | null>;
}

/** Scope and filters passed through from the facade call. */
export interface AgentPluginSkillSourceOptions {
    readonly facadeOptions: FacadeOptions;
    readonly tags?: string[];
    readonly search?: string;
}

/** Provider id reported for package-sourced entries, so install can route back here. */
export const AGENT_PLUGIN_PROVIDER_ID = 'agent-plugins' as const;
