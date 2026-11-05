/**
 * The env var names an acceptance check (or any other user-authored command)
 * must not be able to grant itself through its `envPassthrough`: the
 * PLATFORM's own configuration and the HOST's own credentials.
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
 * drifted (the node learned `KUBECONFIG` / `GITHUB_TOKEN` / `NPM_TOKEN` and
 * `FLEET_`, the platform did not); both now build their refusal from the two
 * patterns in this file, so they cannot disagree about it.
 *
 * The node's un-grantable CORE (`FLEET_`, `EVER_WORKS_`, `PLUGIN_`, `AUTH_`,
 * `BETTER_AUTH_`, `PLATFORM_`) deliberately stays a local literal in the node
 * (`NODE_UNGRANTABLE_ENV_PATTERN`) — see `FLEET_RUN_ENV_UNGRANTABLE_PATTERN`.
 */

/**
 * The platform's own configuration namespaces (its database, auth, job
 * runtime, plugin keys, mail, billing, telemetry, storage and the fleet's own
 * settings). Refused in a check's passthrough on both runtimes.
 */
export const PLATFORM_OWNED_ENV_NAMESPACE_PATTERN =
	/^(DATABASE_|PLATFORM_|PLUGIN_|TRIGGER_|AUTH_|BETTER_AUTH_|EVER_WORKS_|FLEET_|SMTP_|RESEND_|MAILER_|STRIPE_|SENTRY_|POSTHOG_|JITSU_|TWENTY_CRM_|K8S_|STORAGE_|AWS_|REDIS_|S3_|MINIO_|GH_|GOOGLE_|FACEBOOK_|LINKEDIN_)/i;

/**
 * The HOST's own credentials.
 *
 * ## How names are classified (same rule as the node's original list, #3051)
 *
 *   - A PREFIX only where the whole namespace is credentials or
 *     infrastructure control (`CLOUDFLARE_`, `VAULT_`, `OP_SESSION_`, …).
 *   - An EXACT name, anchored at its END, where a prefix would also catch
 *     harmless context: `GITHUB_TOKEN` but not `GITHUB_ACTIONS`;
 *     `GITHUB_PAT` but not Actions' `GITHUB_PATH`; `DOCKER_CONFIG` but not
 *     `DOCKER_HOST`; `NPM_TOKEN` but not `NPM_CONFIG_REGISTRY`;
 *     `AZURE_CLIENT_SECRET` but not `AZURE_OPENAI_ENDPOINT`.
 *   - A name-shaped wildcard (`[A-Z0-9_]+`) only inside an exact name whose
 *     tool puts a user-chosen registry name in the middle
 *     (`CARGO_REGISTRIES_<NAME>_TOKEN`, `UV_INDEX_<NAME>_PASSWORD`).
 *
 * Model-provider API keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
 * `AZURE_OPENAI_API_KEY`, …) are NOT here on purpose: they are what a fleet
 * node's model step is handed through the same passthrough
 * (`FLEET_AGENT_CREDENTIAL_FAMILIES`), so they are governed there.
 *
 * It covers three kinds of carrier:
 *
 *   1. a credential VALUE (`GITHUB_TOKEN`, `GITLAB_TOKEN`, `VERCEL_TOKEN`,
 *      `AZURE_CLIENT_SECRET`, `CARGO_REGISTRY_TOKEN`, a CI job's
 *      `CI_JOB_TOKEN` / `ACTIONS_ID_TOKEN_REQUEST_TOKEN`, a password
 *      manager's `BW_SESSION` / `OP_SESSION_*`, …);
 *   2. a live credential CHANNEL — a socket or helper that answers with a
 *      credential on request: `SSH_AUTH_SOCK` (every key in the ssh-agent),
 *      `GPG_AGENT_INFO`, `GIT_ASKPASS` / `SSH_ASKPASS`, and `VSCODE_GIT_*`
 *      (the editor's git-credential IPC, present when a node is started from
 *      an editor terminal);
 *   3. a POINTER to a credential file kept somewhere other than the default
 *      location, or git config that can carry an auth header:
 *      `KUBECONFIG` / `KUBE_CONFIG_PATH(S)`, `DOCKER_CONFIG` (its
 *      `config.json` holds the registry auths), `REGISTRY_AUTH_FILE`,
 *      `DOCKER_CERT_PATH` (the client key for a remote daemon),
 *      `NPM_CONFIG_USERCONFIG`, `GNUPGHOME`, `CLOUDSDK_CONFIG`,
 *      `AZURE_CONFIG_DIR`, `GIT_SSH_COMMAND`, `GIT_CONFIG_PARAMETERS` /
 *      `GIT_CONFIG_VALUE_<n>` (an `http.extraHeader`).
 *
 * ## What this does NOT close (known gap, stated rather than hidden)
 *
 * Credential FILES at their default locations under the user's home —
 * `~/.ssh/id_*`, `~/.npmrc`, `~/.docker/config.json`, `~/.kube/config`,
 * `~/.aws/credentials`, `~/.config/gh/hosts.yml`, `~/.git-credentials`,
 * `%APPDATA%\npm\…` — stay readable, and so does a mounted Kubernetes
 * service-account token on the platform. A check runs as the same OS user
 * with `HOME` / `USERPROFILE` / `APPDATA` / `XDG_CONFIG_HOME` on the
 * allowlist (toolchains cannot resolve their stores without them), and a
 * command can name an absolute path without any env var at all, so no
 * env-name rule can close this. Refusing the POINTER variables above only
 * stops a host that keeps a credential at a non-default path from
 * advertising that path. The fix is containment, not naming: run the check
 * with a redirected home (as the fleet node already does for the model step,
 * self-build slice AK) or as a separate OS user / sandbox — tracked as a
 * follow-up, not done here, because redirecting the home of the setup and
 * check phases turns every run into a cold install (see
 * `establishModelContainment` in the node). Likewise a deny-list is never
 * complete: a secret-shaped name that is on neither list is still grantable
 * by the check that lists it, by design (`envPassthrough` IS the opt-in).
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
			// Terraform Cloud / Enterprise host tokens (`TF_TOKEN_app_terraform_io`).
			'TF_TOKEN_',
			// 1Password CLI sessions (`OP_SESSION_<account>`): a whole unlocked vault.
			'OP_SESSION_',
			// The editor's git-credential IPC (VS Code's askpass bridge).
			'VSCODE_GIT_',
			// git config passed through the environment (`GIT_CONFIG_KEY_<n>` /
			// `GIT_CONFIG_VALUE_<n>`); a value can be an `http.extraHeader`.
			'GIT_CONFIG_VALUE_',
			// Exact names, anchored at their END so a neighbour stays passable.
			'(?:' +
				[
					// Kubernetes.
					'KUBECONFIG',
					'KUBE_CONFIG_PATH',
					'KUBE_CONFIG_PATHS',
					// Forges.
					'GITHUB_TOKEN',
					'GITHUB_PAT',
					'GITHUB_ENTERPRISE_TOKEN',
					'GITLAB_TOKEN',
					'GITLAB_ACCESS_TOKEN',
					'GITLAB_PRIVATE_TOKEN',
					// Package registries.
					'NPM_TOKEN',
					'NODE_AUTH_TOKEN',
					'NPM_CONFIG__AUTH',
					'NPM_CONFIG__AUTHTOKEN',
					'NPM_CONFIG_USERCONFIG',
					'YARN_NPM_AUTH_TOKEN',
					'YARN_NPM_AUTH_IDENT',
					'CARGO_REGISTRY_TOKEN',
					// `CARGO_REGISTRIES_<NAME>_TOKEN` only — `…_INDEX` is a URL.
					'CARGO_REGISTRIES_[A-Z0-9_]+_TOKEN',
					// `TWINE_PASSWORD` only — `TWINE_REPOSITORY_URL` is a URL.
					'TWINE_PASSWORD',
					'POETRY_PYPI_TOKEN_[A-Z0-9_]+',
					'POETRY_HTTP_BASIC_[A-Z0-9_]+_PASSWORD',
					'UV_PUBLISH_TOKEN',
					'UV_PUBLISH_PASSWORD',
					'UV_INDEX_[A-Z0-9_]+_PASSWORD',
					'COMPOSER_AUTH',
					'NUGET_AUTH_TOKEN',
					'VSS_NUGET_EXTERNAL_FEED_ENDPOINTS',
					'GEM_HOST_API_KEY',
					'HOMEBREW_GITHUB_API_TOKEN',
					// Container registries / remote Docker daemons.
					'DOCKER_AUTH_CONFIG',
					'DOCKER_CONFIG',
					'DOCKER_CERT_PATH',
					'REGISTRY_AUTH_FILE',
					// Cloud SDKs (`AWS_` and `GOOGLE_` are whole platform-owned
					// namespaces above). Azure SDK / CLI and Terraform's azurerm
					// provider: the secret-bearing names only, so
					// `AZURE_OPENAI_ENDPOINT` / `ARM_SUBSCRIPTION_ID` stay passable.
					'AZURE_CLIENT_SECRET',
					'AZURE_CLIENT_CERTIFICATE_PATH',
					'AZURE_CLIENT_CERTIFICATE_PASSWORD',
					'AZURE_PASSWORD',
					'AZURE_FEDERATED_TOKEN_FILE',
					'AZURE_ACCESS_TOKEN',
					'AZURE_DEVOPS_EXT_PAT',
					'AZURE_STORAGE_KEY',
					'AZURE_STORAGE_ACCESS_KEY',
					'AZURE_STORAGE_CONNECTION_STRING',
					'AZURE_STORAGE_SAS_TOKEN',
					'AZURE_CONFIG_DIR',
					'ARM_CLIENT_SECRET',
					'ARM_CLIENT_CERTIFICATE_PATH',
					'ARM_CLIENT_CERTIFICATE_PASSWORD',
					'ARM_ACCESS_KEY',
					'ARM_SAS_TOKEN',
					'ARM_OIDC_TOKEN',
					'ARM_OIDC_REQUEST_TOKEN',
					// Google Cloud SDK and the usual informal key spellings.
					'CLOUDSDK_CONFIG',
					'CLOUDSDK_AUTH_ACCESS_TOKEN_FILE',
					'CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE',
					'GCLOUD_KEYFILE_JSON',
					'GCLOUD_SERVICE_KEY',
					'GCP_SERVICE_ACCOUNT_KEY',
					'GCP_SA_KEY',
					'GCP_CREDENTIALS',
					// CI job credentials, present when the host itself runs inside
					// a CI job (a GitLab runner, a self-hosted Actions runner, an
					// Azure Pipelines agent).
					'CI_JOB_TOKEN',
					'CI_JOB_JWT',
					'CI_JOB_JWT_V2',
					'CI_REGISTRY_PASSWORD',
					'CI_DEPLOY_PASSWORD',
					'CI_DEPENDENCY_PROXY_PASSWORD',
					'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
					'ACTIONS_RUNTIME_TOKEN',
					'SYSTEM_ACCESSTOKEN',
					// Live credential channels and git's own credential carriers.
					'SSH_AUTH_SOCK',
					'SSH_ASKPASS',
					'GIT_ASKPASS',
					'GIT_SSH',
					'GIT_SSH_COMMAND',
					'GIT_CONFIG_PARAMETERS',
					'GPG_AGENT_INFO',
					'GNUPGHOME',
					// Password managers.
					'BW_SESSION',
					'OP_SERVICE_ACCOUNT_TOKEN',
					'OP_CONNECT_TOKEN',
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

/**
 * `true` when a check must not be able to grant itself `name` through its own
 * `envPassthrough`: platform-owned configuration or a host credential. Both
 * runtimes build their refusal from exactly these two patterns.
 */
export function isCheckEnvRefusedName(name: string): boolean {
	return PLATFORM_OWNED_ENV_NAMESPACE_PATTERN.test(name) || HOST_CREDENTIAL_ENV_PATTERN.test(name);
}
