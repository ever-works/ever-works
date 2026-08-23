import * as os from 'os';

/**
 * Environment variables we allow into the Claude Code subprocess.
 *
 * Security note (audit C-10): we used to spawn the CLI with the entire host
 * `process.env`, which gave the model `DATABASE_PASSWORD`, `AUTH_SECRET`,
 * `TRIGGER_INTERNAL_SECRET`, every plugin API key, etc. — a single
 * prompt-injected web page could exfiltrate all of it via `printenv` + `curl`.
 *
 * Mirror the codex / gemini / opencode pattern: build the env from scratch
 * and only let through the values the CLI actually needs.
 */

const PASSTHROUGH_ENV_KEYS = [
	// Proxy / TLS plumbing — needed for the CLI to reach the Anthropic API
	// from inside corporate networks and behind self-signed CAs.
	'HTTP_PROXY',
	'HTTPS_PROXY',
	'ALL_PROXY',
	'NO_PROXY',
	'http_proxy',
	'https_proxy',
	'all_proxy',
	'no_proxy',
	'SSL_CERT_FILE',
	'SSL_CERT_DIR',
	'NODE_EXTRA_CA_CERTS',
	'REQUESTS_CA_BUNDLE',
	'CURL_CA_BUNDLE'
] as const;

// Non-credential Anthropic vars that are safe to inherit from the host. Listed
// by exact name rather than by prefix so a future/custom var that merely starts
// with ANTHROPIC_ or CLAUDE_CODE_ is NOT silently forwarded into the subprocess
// (audit: prefix forwarding leaks any such var to the model).
//
// 🛑 Credentials are deliberately NOT in this list — see AUTH_ENV_KEYS below.
const PASSTHROUGH_ANTHROPIC_KEYS = ['ANTHROPIC_BASE_URL'] as const;

/**
 * Which credential this run is supposed to authenticate with.
 *
 * - `subscription` → `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`), billed
 *   against a Claude Pro/Max/Team/Enterprise plan.
 * - `api-key` → `ANTHROPIC_API_KEY`, billed per token against the Console org.
 */
export type ClaudeAuthMode = 'subscription' | 'api-key';

/**
 * Every environment variable Claude Code will accept as a credential, in the
 * CLI's own resolution order (highest priority first).
 *
 * 🛑 This ordering is why credentials must never be inherited from the host.
 * Claude Code resolves `ANTHROPIC_AUTH_TOKEN` (rank 2) and `ANTHROPIC_API_KEY`
 * (rank 3) ahead of `CLAUDE_CODE_OAUTH_TOKEN` (rank 5), and the docs are
 * explicit that "in non-interactive mode (-p), the key is always used when
 * present". So an agent configured for subscription billing that inherits a
 * stray `ANTHROPIC_API_KEY` from the server environment would silently bill the
 * API key instead of the subscription — no error, no warning, just an unexpected
 * Console invoice. We therefore accept credentials ONLY from the caller's
 * explicit overrides (i.e. resolved plugin settings) and strip any credential
 * that does not match the selected mode.
 *
 * https://code.claude.com/docs/en/authentication
 */
const AUTH_ENV_KEYS = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'] as const;

/** The single credential variable each mode is allowed to set. */
const AUTH_ENV_KEY_FOR_MODE: Record<ClaudeAuthMode, (typeof AUTH_ENV_KEYS)[number]> = {
	subscription: 'CLAUDE_CODE_OAUTH_TOKEN',
	'api-key': 'ANTHROPIC_API_KEY'
};

/**
 * Variables that move the session onto a different inference provider entirely
 * and outrank every credential in AUTH_ENV_KEYS. Never inherited — a stray
 * `CLAUDE_CODE_USE_BEDROCK` on the host would silently redirect a
 * subscription-mode agent onto a cloud provider account.
 */
const PROVIDER_SELECTION_KEYS = [
	'CLAUDE_CODE_USE_BEDROCK',
	'CLAUDE_CODE_USE_VERTEX',
	'CLAUDE_CODE_USE_FOUNDRY',
	'ANTHROPIC_PROFILE',
	'ANTHROPIC_FEDERATION_RULE_ID',
	'ANTHROPIC_ORGANIZATION_ID'
] as const;

export interface BuildSubprocessEnvOptions {
	/**
	 * Pin the run to one credential. When set, any credential variable that
	 * does not belong to this mode is dropped from the resulting environment,
	 * so the CLI cannot resolve a higher-precedence credential we did not choose.
	 */
	readonly authMode?: ClaudeAuthMode;
}

export function buildSubprocessEnv(
	overrides: Record<string, string> = {},
	options: BuildSubprocessEnvOptions = {}
): Record<string, string> {
	const tmpdir = process.env.TMPDIR ?? os.tmpdir();

	// Security: when the caller pins an explicit `CLAUDE_CONFIG_DIR` — which every
	// prompt-injectable run does — point the home directory at the isolated tmpdir
	// instead of the server user's real home. Claude Code resolves its settings,
	// session state and credentials from `CLAUDE_CONFIG_DIR`, and this runner
	// supplies the credential through the environment besides, so a legitimate run
	// loses nothing. What it does lose is the ability of a hostile work prompt to
	// walk `~` and exfiltrate `~/.aws`, `~/.ssh`, `~/.npmrc`, `~/.kube` — the CLI
	// runs with `--dangerously-skip-permissions` on scraped web content and
	// community-PR text, so that is not a hypothetical.
	//
	// Mirrors the codex plugin's `CODEX_HOME` handling, with one addition: on
	// Windows `~` resolves from `USERPROFILE`, not `HOME`, so repointing only
	// `HOME` would leave the hardening a no-op there.
	//
	// Runs without a pinned config dir (e.g. an auth probe) keep the real home so
	// the CLI's `~/.claude` fallback still resolves and auth detection is unchanged.
	const isolateHome = typeof overrides.CLAUDE_CONFIG_DIR === 'string' && overrides.CLAUDE_CONFIG_DIR !== '';
	const home = isolateHome ? tmpdir : (process.env.HOME ?? os.homedir());

	const env: Record<string, string> = {
		PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
		HOME: home,
		TMPDIR: tmpdir
	};

	// `USERPROFILE` is the Windows equivalent of `HOME`; some Anthropic SDK
	// versions look it up. Forward when present so the runner works on
	// Windows dev boxes without leaking other host vars.
	if (isolateHome) {
		env.USERPROFILE = tmpdir;
	} else if (process.env.USERPROFILE) {
		env.USERPROFILE = process.env.USERPROFILE;
	}
	// `APPDATA` / `LOCALAPPDATA` stay pointed at the real profile even when the
	// home is isolated: Node and the package managers the agent shells out to read
	// their own machine config from there, and breaking that would fail runs rather
	// than harden them. They are a known residual on Windows — `%APPDATA%\npm` can
	// hold an npm token — but the deployed runner is Linux, where these are unset.
	if (process.env.APPDATA) {
		env.APPDATA = process.env.APPDATA;
	}
	if (process.env.LOCALAPPDATA) {
		env.LOCALAPPDATA = process.env.LOCALAPPDATA;
	}

	for (const key of PASSTHROUGH_ENV_KEYS) {
		const value = process.env[key];
		if (value) {
			env[key] = value;
		}
	}

	for (const key of PASSTHROUGH_ANTHROPIC_KEYS) {
		const value = process.env[key];
		if (value) {
			env[key] = value;
		}
	}

	for (const [key, value] of Object.entries(overrides)) {
		env[key] = value;
	}

	// A provider-selection variable outranks every credential, so it can only
	// ever arrive deliberately, from the caller — never from the host.
	for (const key of PROVIDER_SELECTION_KEYS) {
		if (!(key in overrides)) {
			delete env[key];
		}
	}

	// Enforce exactly one credential so the CLI's precedence order cannot pick a
	// different one than the mode we resolved from plugin settings.
	if (options.authMode) {
		const allowed = AUTH_ENV_KEY_FOR_MODE[options.authMode];
		for (const key of AUTH_ENV_KEYS) {
			if (key !== allowed) {
				delete env[key];
			}
		}
	}

	return env;
}

/**
 * Names of every credential variable, exported so callers and tests can assert
 * that nothing else leaked into a subprocess environment.
 */
export const CLAUDE_AUTH_ENV_KEYS: readonly string[] = AUTH_ENV_KEYS;
