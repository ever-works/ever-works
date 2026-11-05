/**
 * The HOST's own credentials — env var names an acceptance check (or any
 * other user-authored command) must not be able to grant itself through its
 * `envPassthrough`.
 *
 * ## Why one shared list
 *
 * A check command runs in two places: on the platform's worker
 * (`buildCheckEnv` in `@ever-works/agent`) and on a fleet node, which is an
 * operator's PC (`buildNodeCheckEnv` in `ever-works-node`). Both build the
 * child env from scratch, and in both a name the check lists in its own
 * `envPassthrough` BYPASSES the secret-name sweep — a listed name is the
 * grant. So a name that is not refused here is a name any check author can
 * read from the machine. The two runtimes used to keep separate lists and
 * drifted (the node learned `KUBECONFIG` / `GITHUB_TOKEN` / `NPM_TOKEN`, the
 * platform did not); both now compose their platform-owned refusal with THIS
 * pattern, so they cannot disagree about what a host credential is.
 *
 * ## How names are classified (same rule as the node's original list)
 *
 *   - A PREFIX only where the whole namespace is credentials or
 *     infrastructure control (`CLOUDFLARE_`, `VAULT_`, `AZURE_`, …).
 *   - An EXACT name, anchored at its END, where a prefix would also catch
 *     harmless context: `GITHUB_TOKEN` but not `GITHUB_ACTIONS`;
 *     `GITHUB_PAT` but not Actions' `GITHUB_PATH`; `DOCKER_CONFIG` but not
 *     `DOCKER_HOST`; `NPM_TOKEN` but not `NPM_CONFIG_REGISTRY`.
 *
 * It covers three kinds of carrier:
 *
 *   1. a credential VALUE (`GITHUB_TOKEN`, `GITLAB_TOKEN`, `VERCEL_TOKEN`,
 *      `AZURE_CLIENT_SECRET`, `CARGO_REGISTRY_TOKEN`, a CI job's
 *      `CI_JOB_TOKEN` / `ACTIONS_ID_TOKEN_REQUEST_TOKEN`, …);
 *   2. a live credential CHANNEL — a socket or helper that answers with a
 *      credential on request: `SSH_AUTH_SOCK` (every key in the ssh-agent),
 *      `GPG_AGENT_INFO`, `GIT_ASKPASS` / `SSH_ASKPASS`, and `VSCODE_GIT_*`
 *      (the editor's git-credential IPC, present when a node is started from
 *      an editor terminal);
 *   3. a POINTER to a credential file kept somewhere other than the default
 *      location: `KUBECONFIG`, `DOCKER_CONFIG` (its `config.json` holds the
 *      registry auths), `DOCKER_CERT_PATH` (the client key for a remote
 *      daemon), `NPM_CONFIG_USERCONFIG`, `GNUPGHOME`, `CLOUDSDK_CONFIG`,
 *      `AZURE_CONFIG_DIR`.
 *
 * ## What this does NOT close (known gap, stated rather than hidden)
 *
 * Credential FILES at their default locations under the user's home —
 * `~/.ssh/id_*`, `~/.npmrc`, `~/.docker/config.json`, `~/.kube/config`,
 * `~/.aws/credentials`, `~/.config/gh/hosts.yml`, `~/.git-credentials`,
 * `%APPDATA%\npm\…` — stay readable. A check runs as the same OS user with
 * `HOME` / `USERPROFILE` / `APPDATA` / `XDG_CONFIG_HOME` on the allowlist
 * (toolchains cannot resolve their stores without them), and a command can
 * name an absolute path without any env var at all, so no env-name rule can
 * close this. Refusing the POINTER variables above only stops a host that
 * keeps a credential at a non-default path from advertising that path. The
 * fix is containment, not naming: run the check with a redirected home (as
 * the fleet node already does for the model step, self-build slice AK) or as
 * a separate OS user / sandbox — tracked as a follow-up, not done here,
 * because redirecting the home of the setup and check phases turns every
 * run into a cold install (see `establishModelContainment` in the node).
 *
 * The node lets an operator re-open one EXACT name per repository (a
 * private-registry `NPM_TOKEN`, say); the platform has no such grant and
 * refuses these outright, because on the platform's own worker every one of
 * them would be the platform's credential.
 */
export const HOST_CREDENTIAL_ENV_PATTERN = new RegExp(
	'^(?:' +
		[
			// Namespaces that are credentials / infrastructure control end to end.
			'GITHUB_APP_',
			'CLOUDFLARE_',
			'CF_API_',
			'VAULT_',
			'BAO_',
			'DIGITALOCEAN_',
			'PROXMOX_',
			'PVE_',
			// Cloud SDKs (`AWS_` and `GOOGLE_` are already platform-owned in
			// both runtimes): Azure SDK / CLI, Terraform's azurerm provider,
			// the Google Cloud SDK and its common informal spellings.
			'AZURE_',
			'ARM_',
			'CLOUDSDK_',
			'GCLOUD_',
			'GCP_',
			// Terraform Cloud / Enterprise host tokens (`TF_TOKEN_app_terraform_io`).
			'TF_TOKEN_',
			// The editor's git-credential IPC (VS Code's askpass bridge).
			'VSCODE_GIT_',
			// Exact names, anchored at their END so a neighbour stays passable.
			'(?:' +
				[
					// Kubernetes / forge / registry tokens.
					'KUBECONFIG',
					'GITHUB_TOKEN',
					'GITHUB_PAT',
					'GITHUB_ENTERPRISE_TOKEN',
					'GITLAB_TOKEN',
					'GITLAB_ACCESS_TOKEN',
					'GITLAB_PRIVATE_TOKEN',
					'NPM_TOKEN',
					'NODE_AUTH_TOKEN',
					'NPM_CONFIG__AUTH',
					'NPM_CONFIG__AUTHTOKEN',
					'NPM_CONFIG_USERCONFIG',
					'YARN_NPM_AUTH_TOKEN',
					'CARGO_REGISTRY_TOKEN',
					// `CARGO_REGISTRIES_<NAME>_TOKEN` only — `…_INDEX` is a URL.
					'CARGO_REGISTRIES_[A-Z0-9_]+_TOKEN',
					// `TWINE_PASSWORD` only — `TWINE_REPOSITORY_URL` is a URL.
					'TWINE_PASSWORD',
					'GEM_HOST_API_KEY',
					'HOMEBREW_GITHUB_API_TOKEN',
					// CI job credentials, present when the host itself runs inside
					// a CI job (a GitLab runner, a self-hosted Actions runner):
					// the job token, and Actions' OIDC-mint and cache/artifact tokens.
					'CI_JOB_TOKEN',
					'CI_JOB_JWT',
					'CI_JOB_JWT_V2',
					'CI_REGISTRY_PASSWORD',
					'CI_DEPLOY_PASSWORD',
					'CI_DEPENDENCY_PROXY_PASSWORD',
					'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
					'ACTIONS_RUNTIME_TOKEN',
					// Container registries / remote Docker daemons.
					'DOCKER_AUTH_CONFIG',
					'DOCKER_CONFIG',
					'DOCKER_CERT_PATH',
					// Live credential channels.
					'SSH_AUTH_SOCK',
					'SSH_ASKPASS',
					'GIT_ASKPASS',
					'GPG_AGENT_INFO',
					'GNUPGHOME',
					// Deploy platforms and infrastructure CLIs.
					'VERCEL_TOKEN',
					'NETLIFY_AUTH_TOKEN',
					'HEROKU_API_KEY',
					'FLY_API_TOKEN',
					'SUPABASE_ACCESS_TOKEN',
					'HCLOUD_TOKEN',
					'TFE_TOKEN',
					'CONSUL_HTTP_TOKEN',
					'NOMAD_TOKEN'
				].join('|') +
				')$'
		].join('|') +
		')',
	'i'
);

/**
 * `true` when `name` is one of the host's own credentials (see
 * {@link HOST_CREDENTIAL_ENV_PATTERN}). Case-insensitive, because Windows env
 * names are.
 */
export function isHostCredentialEnvName(name: string): boolean {
	return HOST_CREDENTIAL_ENV_PATTERN.test(name);
}
