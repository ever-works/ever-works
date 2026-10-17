jest.mock('@ever-works/agent/facades', () => ({ OAuthFacadeService: class {} }));
jest.mock('@ever-works/agent/database', () => ({
    AuthAccountRepository: class {},
    PLUGIN_PROVIDER_PREFIX: 'plugin:',
    buildPluginProviderId: (id: string) => `plugin:${id}`,
}));
jest.mock('@ever-works/agent/plugins', () => ({ PluginSettingsService: class {} }));
jest.mock('@ever-works/agent/config', () => ({
    config: { everWorks: { apps: { worksEnabled: jest.fn(() => true) } } },
}));

import { config } from '@ever-works/agent/config';
import { withAppWorksScopes } from './oauth.service';

/**
 * 2026-10-17 (lane aw-builds-2) — an App Work's Build commits a workflow file,
 * which GitHub only lets an OAuth token do with the `workflow` scope. An
 * operator-configured GitHub scope list that lacks it gets it appended while App
 * Works is on; nothing is ever removed.
 */

const worksEnabled = (config as unknown as { everWorks: { apps: { worksEnabled: jest.Mock } } })
    .everWorks.apps.worksEnabled;

describe('withAppWorksScopes', () => {
    beforeEach(() => worksEnabled.mockReturnValue(true));

    it('appends `workflow` (and `repo`) to a configured GitHub list that lacks them', () => {
        expect(withAppWorksScopes('github', ['read:user'])).toEqual(['read:user', 'repo', 'workflow']);
        expect(withAppWorksScopes('github', ['repo', 'read:org'])).toEqual(['repo', 'read:org', 'workflow']);
    });

    it('leaves a list that already has both, no list, and other providers untouched', () => {
        const full = ['repo', 'workflow', 'read:user'];
        expect(withAppWorksScopes('github', full)).toBe(full);
        // No configured list: the plugin default (GITHUB_FULL_SCOPES) applies, and it has `workflow`.
        expect(withAppWorksScopes('github', undefined)).toBeUndefined();
        expect(withAppWorksScopes('gitlab', ['api'])).toEqual(['api']);
    });

    it('changes nothing while App Works is off', () => {
        worksEnabled.mockReturnValue(false);
        expect(withAppWorksScopes('github', ['read:user'])).toEqual(['read:user']);
    });
});
