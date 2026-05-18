/**
 * GitHub OAuth scopes shared by auth and the GitHub plugin.
 *
 * Two scope sets are exported:
 *
 *   - {@link GITHUB_LOGIN_SCOPES} — the **minimum** scopes required to
 *     identify a user during sign-in-with-GitHub. Profile + email only. No
 *     repo / workflow / hook access. This is what
 *     `apps/api/src/auth/config/social-auth.providers.ts` wires up for the
 *     login flow (M-02 / M-22: principle of least privilege — login should
 *     not grant repo-write).
 *
 *   - {@link GITHUB_FULL_SCOPES} — the **broad** scope set required by the
 *     GitHub plugin's capability flows (creating repos, pushing workflow
 *     files, installing webhooks, etc.). The user grants these explicitly
 *     when they wire a work to GitHub, NOT at login.
 *
 * `GITHUB_SCOPES` is retained as an alias for `GITHUB_FULL_SCOPES` for
 * backward compatibility — the GitHub plugin's `getAuthorizationUrl()` still
 * reads it as the default-scope fallback when no caller-supplied scope list
 * is provided.
 */

export const GITHUB_LOGIN_SCOPES = ['read:user', 'user:email'] as const;

export const GITHUB_FULL_SCOPES = [
	'user:email',
	'read:user',
	'repo',
	'delete_repo',
	'workflow',
	'write:repo_hook',
	'read:org',
	'project'
] as const;

/**
 * Backward-compatible alias for the broad scope set. Existing callers (the
 * GitHub plugin's capability OAuth flow, the github-scopes.config re-export
 * in the API, and any external consumers) keep working unchanged.
 *
 * New code should pick {@link GITHUB_LOGIN_SCOPES} or
 * {@link GITHUB_FULL_SCOPES} explicitly based on intent.
 */
export const GITHUB_SCOPES = GITHUB_FULL_SCOPES;

export type GitHubLoginScope = (typeof GITHUB_LOGIN_SCOPES)[number];
export type GitHubFullScope = (typeof GITHUB_FULL_SCOPES)[number];
export type GitHubScope = GitHubFullScope;
