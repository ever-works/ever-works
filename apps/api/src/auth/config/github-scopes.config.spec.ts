import * as localBarrel from './github-scopes.config';
import { GITHUB_SCOPES as PluginGithubScopes } from '@ever-works/plugin';

describe('github-scopes.config (re-export of @ever-works/plugin)', () => {
    it('re-exports the plugin-package GITHUB_SCOPES under the same name', () => {
        // Identity check: we forward the same array reference, not a copy.
        expect(localBarrel.GITHUB_SCOPES).toBe(PluginGithubScopes);
    });

    it('GITHUB_SCOPES is a non-empty readonly array of strings', () => {
        expect(Array.isArray(localBarrel.GITHUB_SCOPES)).toBe(true);
        expect(localBarrel.GITHUB_SCOPES.length).toBeGreaterThan(0);
        for (const scope of localBarrel.GITHUB_SCOPES) {
            expect(typeof scope).toBe('string');
            expect(scope.length).toBeGreaterThan(0);
        }
    });

    it('contains the documented core scopes the auth flow relies on', () => {
        // SocialAuthService and the GitHub plugin both rely on at least these four scopes:
        //   - user:email   (resolveGitHubAccountEmail fallback to /user/emails)
        //   - read:user    (basic profile)
        //   - repo         (full repo access — required by the GitHub-based plugin)
        //   - workflow     (write to .github/workflows for deploys)
        // Pin these literally so a silent removal would break the auth + deploy paths.
        expect(localBarrel.GITHUB_SCOPES).toContain('user:email');
        expect(localBarrel.GITHUB_SCOPES).toContain('read:user');
        expect(localBarrel.GITHUB_SCOPES).toContain('repo');
        expect(localBarrel.GITHUB_SCOPES).toContain('workflow');
    });

    it('all entries are unique', () => {
        const set = new Set<string>(localBarrel.GITHUB_SCOPES);
        expect(set.size).toBe(localBarrel.GITHUB_SCOPES.length);
    });

    it('matches the plugin-package source-of-truth array element-for-element (same order)', () => {
        expect([...localBarrel.GITHUB_SCOPES]).toEqual([...PluginGithubScopes]);
    });
});
