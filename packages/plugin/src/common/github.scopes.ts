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

/**
 * Every scope the broad set can carry, `delete_repo` included. Only for
 * typing ({@link GitHubFullScope}); what is actually requested is
 * {@link GITHUB_FULL_SCOPES}.
 */
const GITHUB_FULL_SCOPES_ALL = [
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
 * `delete_repo` lets the token delete ANY repository its user administers,
 * in every org they own. The platform only needs it for the opt-in
 * "delete the repositories too" choice when a Work is deleted, and that
 * path already logs and carries on when the delete is refused. So it is
 * requested only when `GITHUB_OAUTH_DELETE_REPO_SCOPE_ENABLED=true`
 * (read once, at module load); otherwise a deleted Work leaves its
 * repositories in place for the owner to remove by hand.
 */
export const GITHUB_DELETE_REPO_SCOPE = 'delete_repo';

export function isGithubDeleteRepoScopeEnabled(
	env: Record<string, string | undefined> | undefined = readEnv()
): boolean {
	return (env?.GITHUB_OAUTH_DELETE_REPO_SCOPE_ENABLED ?? '').trim().toLowerCase() === 'true';
}

function readEnv(): Record<string, string | undefined> | undefined {
	return typeof process !== 'undefined' ? process.env : undefined;
}

export const GITHUB_FULL_SCOPES: readonly (typeof GITHUB_FULL_SCOPES_ALL)[number][] = Object.freeze(
	GITHUB_FULL_SCOPES_ALL.filter((scope) => scope !== GITHUB_DELETE_REPO_SCOPE || isGithubDeleteRepoScopeEnabled())
);

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
export type GitHubFullScope = (typeof GITHUB_FULL_SCOPES_ALL)[number];
export type GitHubScope = GitHubFullScope;
