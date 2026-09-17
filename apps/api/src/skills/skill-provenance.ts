import type { Skill, SkillProvenanceSources } from '@ever-works/agent/skills';
import { AGENT_PLUGIN_PROVIDER_ID } from '@ever-works/agent/agent-plugins';
import { PLUGIN_CAPABILITIES } from '@ever-works/plugin';
import type { SkillProvenance } from '@ever-works/contracts';

/** The slice of the plugin registry provenance needs. */
export interface SkillProvenanceRegistry {
    getByCapability(capability: string): Array<{
        manifest: { id: string; defaultForCapabilities?: readonly string[] };
    }>;
}

/**
 * Skills shelf — which catalogue provider ids count as first-party and which
 * as packages. Derived from what the registry already knows, never a plugin
 * id written here: first-party is whichever skills-provider plugin declares
 * itself the default for that capability in its own manifest; packages are
 * the Agent Plugins package source. A registry that cannot answer yields no
 * first-party ids, so those Skills read as "From a plugin" rather than
 * claiming an origin nobody confirmed.
 */
export function resolveSkillProvenanceSources(
    registry?: SkillProvenanceRegistry | null,
): SkillProvenanceSources {
    const capability = PLUGIN_CAPABILITIES.SKILLS_PROVIDER;
    let firstPartyProviderIds: string[] = [];
    try {
        firstPartyProviderIds = (registry?.getByCapability(capability) ?? [])
            .filter((plugin) => plugin.manifest.defaultForCapabilities?.includes(capability))
            .map((plugin) => plugin.manifest.id);
    } catch {
        firstPartyProviderIds = [];
    }
    return { firstPartyProviderIds, packageProviderIds: [AGENT_PLUGIN_PROVIDER_ID] };
}

/**
 * Where a Skill came from, derived from columns it already has (no new
 * column): written here when it carries no catalogue slug; otherwise by the
 * provider id `installFromCatalog` recorded in `sourcePath`.
 */
export function provenanceOf(
    skill: Pick<Skill, 'sourceCatalogSlug' | 'sourcePath'>,
    sources: SkillProvenanceSources,
): SkillProvenance {
    if (!skill.sourceCatalogSlug) return 'authored';
    const providerId = skill.sourcePath ?? '';
    if (sources.packageProviderIds.includes(providerId)) return 'package';
    if (sources.firstPartyProviderIds.includes(providerId)) return 'firstParty';
    return 'plugin';
}
