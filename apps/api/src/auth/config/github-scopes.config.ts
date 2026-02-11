/**
 * GitHub OAuth scopes for Ever Works
 * https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps
 */
export const GITHUB_SCOPES = [
    'user:email',
    'read:user',
    'repo',
    'delete_repo',
    'workflow',
    'write:repo_hook',
    'read:org',
    'project',
] as const;

export type GitHubScope = (typeof GITHUB_SCOPES)[number];
