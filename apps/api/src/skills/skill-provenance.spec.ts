import { AGENT_PLUGIN_PROVIDER_ID } from '@ever-works/agent/agent-plugins';
import { provenanceOf, resolveSkillProvenanceSources } from './skill-provenance';

/**
 * Skills shelf — provenance is derived from columns a Skill already has and
 * from what the plugin registry already knows. No plugin id is written in the
 * mapper: first-party is the skills-provider that declares itself the
 * capability default in its own manifest.
 */
const registry = {
    getByCapability: jest.fn(() => [
        { manifest: { id: 'default-provider', defaultForCapabilities: ['skills-provider'] } },
        { manifest: { id: 'third-party', defaultForCapabilities: [] } },
        { manifest: { id: 'other-default', defaultForCapabilities: ['search'] } },
    ]),
};

describe('resolveSkillProvenanceSources', () => {
    it('asks the registry for skills-provider plugins and keeps the capability default', () => {
        const sources = resolveSkillProvenanceSources(registry);
        expect(registry.getByCapability).toHaveBeenCalledWith('skills-provider');
        expect(sources).toEqual({
            firstPartyProviderIds: ['default-provider'],
            packageProviderIds: [AGENT_PLUGIN_PROVIDER_ID],
        });
    });

    it('claims no first-party origin when there is no registry or it throws', () => {
        expect(resolveSkillProvenanceSources(undefined).firstPartyProviderIds).toEqual([]);
        const broken = {
            getByCapability: () => {
                throw new Error('registry not ready');
            },
        };
        expect(resolveSkillProvenanceSources(broken).firstPartyProviderIds).toEqual([]);
    });
});

describe('provenanceOf', () => {
    const sources = resolveSkillProvenanceSources(registry);

    it.each([
        ['authored (no catalogue slug)', { sourceCatalogSlug: null, sourcePath: null }, 'authored'],
        [
            'authored even with a stray source path',
            { sourceCatalogSlug: null, sourcePath: 'default-provider' },
            'authored',
        ],
        [
            'first-party',
            { sourceCatalogSlug: 'plan', sourcePath: 'default-provider' },
            'firstParty',
        ],
        ['package', { sourceCatalogSlug: 'plan', sourcePath: AGENT_PLUGIN_PROVIDER_ID }, 'package'],
        [
            'another provider plugin',
            { sourceCatalogSlug: 'plan', sourcePath: 'third-party' },
            'plugin',
        ],
        [
            'a catalogue Skill with no recorded provider',
            { sourceCatalogSlug: 'plan', sourcePath: null },
            'plugin',
        ],
    ])('%s', (_label, skill, expected) => {
        expect(provenanceOf(skill, sources)).toBe(expected);
    });
});
