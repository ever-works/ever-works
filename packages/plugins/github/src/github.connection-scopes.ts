import { GITHUB_FULL_SCOPES, GITHUB_LOGIN_SCOPES } from '@ever-works/plugin';
import type { ConnectionScopePreset } from '@ever-works/plugin';

/**
 * GitHub's access levels for the `connection-scopes` capability.
 *
 * The agent tools a GitHub account serves today are the two repository
 * writes the git facade performs through the Work's git provider:
 * `commitToRepo` and `openPullRequest`. "Read only" therefore unlocks no
 * mutating tool, and "Read and write" adds exactly those two.
 *
 * Provider permissions are listed so the platform can tell whether widening
 * to "Read and write" needs the owner to re-approve the connected account.
 * They reuse the scope sets this package family already requests
 * (`GITHUB_LOGIN_SCOPES` / `GITHUB_FULL_SCOPES`) so there is one source for
 * GitHub scope strings. GitHub has no read-only permission for private
 * repositories, which is why `repo` appears in both levels — the tool list,
 * not the token, is what keeps "Read only" from writing.
 */

/** Agent tools that change a repository on GitHub's side. */
export const GITHUB_MUTATING_AGENT_TOOLS = ['commitToRepo', 'openPullRequest'] as const;

export const GITHUB_READ_PROVIDER_SCOPES: readonly string[] = Object.freeze([
	...GITHUB_LOGIN_SCOPES,
	'repo',
	'read:org'
]);

export const GITHUB_CONNECTION_SCOPE_PRESETS: readonly ConnectionScopePreset[] = Object.freeze([
	{
		id: 'read',
		providerScopes: GITHUB_READ_PROVIDER_SCOPES,
		toolPatterns: []
	},
	{
		id: 'write',
		providerScopes: [...GITHUB_FULL_SCOPES],
		toolPatterns: [...GITHUB_MUTATING_AGENT_TOOLS]
	}
]);
