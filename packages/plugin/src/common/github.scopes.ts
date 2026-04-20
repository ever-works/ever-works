/**
 * GitHub OAuth scopes shared by auth and the GitHub plugin.
 */
export const GITHUB_SCOPES = [
	'user:email',
	'read:user',
	'repo',
	'delete_repo',
	'workflow',
	'write:repo_hook',
	'read:org',
	'project'
] as const;

export type GitHubScope = (typeof GITHUB_SCOPES)[number];
