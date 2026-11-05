import { describe, expect, it } from 'vitest';

import { HOST_CREDENTIAL_ENV_PATTERN, isHostCredentialEnvName } from '../check-env-host-credentials.types.js';

/**
 * The host's own credentials, shared by the platform's `buildCheckEnv` and
 * the fleet node's `buildNodeCheckEnv`. Pinned name by name so a careless
 * edit of the shared pattern shows up here, not on an operator's PC.
 */

/** The fleet node's original list (#3051) — must stay refused. */
const ORIGINAL_NODE_NAMES = [
	'KUBECONFIG',
	'GITHUB_TOKEN',
	'GITHUB_PAT',
	'GITHUB_APP_PRIVATE_KEY',
	'NPM_TOKEN',
	'NODE_AUTH_TOKEN',
	'CLOUDFLARE_API_TOKEN',
	'CF_API_KEY',
	'VAULT_TOKEN',
	'BAO_TOKEN',
	'DIGITALOCEAN_ACCESS_TOKEN',
	'DOCKER_AUTH_CONFIG',
	'PROXMOX_TOKEN_SECRET',
	'PVE_TOKEN'
];

/** Added after the 2026-11-03 sweep: channels, pointers, cloud SDKs, registries. */
const ADDED_NAMES = [
	'SSH_AUTH_SOCK',
	'SSH_ASKPASS',
	'GIT_ASKPASS',
	'GPG_AGENT_INFO',
	'GNUPGHOME',
	'VSCODE_GIT_IPC_HANDLE',
	'VSCODE_GIT_ASKPASS_MAIN',
	'DOCKER_CONFIG',
	'DOCKER_CERT_PATH',
	'GITLAB_TOKEN',
	'GITLAB_ACCESS_TOKEN',
	'GITLAB_PRIVATE_TOKEN',
	'GITHUB_ENTERPRISE_TOKEN',
	'AZURE_CLIENT_SECRET',
	'AZURE_CLIENT_CERTIFICATE_PATH',
	'AZURE_CONFIG_DIR',
	'AZURE_DEVOPS_EXT_PAT',
	'ARM_CLIENT_SECRET',
	'CLOUDSDK_CONFIG',
	'CLOUDSDK_AUTH_ACCESS_TOKEN_FILE',
	'GCLOUD_KEYFILE_JSON',
	'GCP_SERVICE_ACCOUNT_KEY',
	'TF_TOKEN_app_terraform_io',
	'TFE_TOKEN',
	'NPM_CONFIG__AUTH',
	'npm_config__authToken',
	'npm_config_userconfig',
	'YARN_NPM_AUTH_TOKEN',
	'CARGO_REGISTRY_TOKEN',
	'CARGO_REGISTRIES_PRIVATE_TOKEN',
	'cargo_registries_my_corp_token',
	'TWINE_PASSWORD',
	'CI_JOB_TOKEN',
	'CI_JOB_JWT',
	'CI_JOB_JWT_V2',
	'CI_REGISTRY_PASSWORD',
	'CI_DEPLOY_PASSWORD',
	'CI_DEPENDENCY_PROXY_PASSWORD',
	'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
	'ACTIONS_RUNTIME_TOKEN',
	'GEM_HOST_API_KEY',
	'HOMEBREW_GITHUB_API_TOKEN',
	'VERCEL_TOKEN',
	'NETLIFY_AUTH_TOKEN',
	'HEROKU_API_KEY',
	'FLY_API_TOKEN',
	'SUPABASE_ACCESS_TOKEN',
	'HCLOUD_TOKEN',
	'CONSUL_HTTP_TOKEN',
	'NOMAD_TOKEN'
];

/** Harmless context a check legitimately passes — must stay passable. */
const NEIGHBOURS = [
	'GITHUB_ACTIONS',
	'GITHUB_PATH',
	'GITHUB_SHA',
	'GITHUB_TOKEN_SCOPES_NOTE',
	'DOCKER_HOST',
	'DOCKER_CONTEXT',
	'DOCKER_CONFIG_EXTRA',
	'DOCKER_BUILDKIT',
	'NPM_CONFIG_REGISTRY',
	'npm_config_registry',
	'NPM_TOKEN_FILE_HINT',
	'GITLAB_CI',
	'SSH_CONNECTION',
	'VSCODE_PID',
	'CARGO_HOME',
	'CARGO_TARGET_DIR',
	// Registry settings that are URLs, not credentials (CodeRabbit on #3073).
	'CARGO_REGISTRIES_PRIVATE_INDEX',
	'CARGO_REGISTRIES_TOKEN_INDEX_NOTE',
	'TWINE_REPOSITORY_URL',
	'TWINE_USERNAME',
	'CI_JOB_ID',
	'CI_REGISTRY',
	'CI_REGISTRY_USER',
	'ACTIONS_ID_TOKEN_REQUEST_URL',
	'ACTIONS_CACHE_URL',
	'TF_VAR_region',
	'VERCEL_ENV',
	'KUBECONFIG_BACKUP',
	'CUSTOM_BUILD_FLAG',
	'PATH',
	'HOME'
];

describe('HOST_CREDENTIAL_ENV_PATTERN', () => {
	it.each([...ORIGINAL_NODE_NAMES, ...ADDED_NAMES])('refuses %s', (name) => {
		expect(isHostCredentialEnvName(name)).toBe(true);
	});

	it('is case-insensitive (Windows env names are)', () => {
		expect(isHostCredentialEnvName('ssh_auth_sock')).toBe(true);
		expect(isHostCredentialEnvName('Docker_Config')).toBe(true);
	});

	it.each(NEIGHBOURS)('leaves the harmless neighbour %s passable', (name) => {
		expect(isHostCredentialEnvName(name)).toBe(false);
	});

	it('anchors exact names at BOTH ends (no infix match)', () => {
		expect(isHostCredentialEnvName('MY_GITHUB_TOKEN')).toBe(false);
		expect(isHostCredentialEnvName('XSSH_AUTH_SOCK')).toBe(false);
	});

	it('is stateless across calls (no global/sticky flag)', () => {
		expect(HOST_CREDENTIAL_ENV_PATTERN.global).toBe(false);
		expect(HOST_CREDENTIAL_ENV_PATTERN.sticky).toBe(false);
		expect(isHostCredentialEnvName('GITHUB_TOKEN')).toBe(true);
		expect(isHostCredentialEnvName('GITHUB_TOKEN')).toBe(true);
	});
});
