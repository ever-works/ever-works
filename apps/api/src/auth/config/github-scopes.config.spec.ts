import * as localBarrel from './github-scopes.config';
import {
    GITHUB_SCOPES as PluginGithubScopes,
    GITHUB_LOGIN_SCOPES as PluginGithubLoginScopes,
    GITHUB_FULL_SCOPES as PluginGithubFullScopes,
} from '@ever-works/plugin';

describe('github-scopes.config (re-export of @ever-works/plugin)', () => {
    it('re-exports the plugin-package GITHUB_SCOPES under the same name', () => {
        // Identity check: we forward the same array reference, not a copy.
        expect(localBarrel.GITHUB_SCOPES).toBe(PluginGithubScopes);
    });

    it('re-exports GITHUB_LOGIN_SCOPES and GITHUB_FULL_SCOPES', () => {
        expect(localBarrel.GITHUB_LOGIN_SCOPES).toBe(PluginGithubLoginScopes);
        expect(localBarrel.GITHUB_FULL_SCOPES).toBe(PluginGithubFullScopes);
    });

    it('GITHUB_SCOPES is a non-empty readonly array of strings', () => {
        expect(Array.isArray(localBarrel.GITHUB_SCOPES)).toBe(true);
        expect(localBarrel.GITHUB_SCOPES.length).toBeGreaterThan(0);
        for (const scope of localBarrel.GITHUB_SCOPES) {
            expect(typeof scope).toBe('string');
            expect(scope.length).toBeGreaterThan(0);
        }
    });

    it('contains the documented core scopes the auth flow relies on (full set)', () => {
        // The GitHub plugin's capability OAuth flow still requests:
        //   - user:email   (resolveGitHubAccountEmail fallback to /user/emails)
        //   - read:user    (basic profile)
        //   - repo         (full repo access — required by the GitHub-based plugin)
        //   - workflow     (write to .github/workflows for deploys)
        // Pin these literally so a silent removal would break the capability paths.
        expect(localBarrel.GITHUB_SCOPES).toContain('user:email');
        expect(localBarrel.GITHUB_SCOPES).toContain('read:user');
        expect(localBarrel.GITHUB_SCOPES).toContain('repo');
        expect(localBarrel.GITHUB_SCOPES).toContain('workflow');
    });

    it('GITHUB_LOGIN_SCOPES is the narrow identity-only set (M-02 / M-22)', () => {
        // Login must NOT grant admin-class write scopes. The login redirect
        // sees only profile + email.
        expect([...localBarrel.GITHUB_LOGIN_SCOPES]).toEqual(['read:user', 'user:email']);
        expect(localBarrel.GITHUB_LOGIN_SCOPES).not.toContain('repo');
        expect(localBarrel.GITHUB_LOGIN_SCOPES).not.toContain('delete_repo');
        expect(localBarrel.GITHUB_LOGIN_SCOPES).not.toContain('workflow');
        expect(localBarrel.GITHUB_LOGIN_SCOPES).not.toContain('write:repo_hook');
        expect(localBarrel.GITHUB_LOGIN_SCOPES).not.toContain('project');
    });

    it('GITHUB_SCOPES is the backward-compatible alias for GITHUB_FULL_SCOPES', () => {
        expect(localBarrel.GITHUB_SCOPES).toBe(localBarrel.GITHUB_FULL_SCOPES);
    });

    it('all entries are unique', () => {
        const set = new Set<string>(localBarrel.GITHUB_SCOPES);
        expect(set.size).toBe(localBarrel.GITHUB_SCOPES.length);
    });

    it('matches the plugin-package source-of-truth array element-for-element (same order)', () => {
        expect([...localBarrel.GITHUB_SCOPES]).toEqual([...PluginGithubScopes]);
    });
});
