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

const CLAUDE_CODE_ENV_PREFIXES = ['ANTHROPIC_', 'CLAUDE_CODE_'] as const;

export function buildSubprocessEnv(overrides: Record<string, string> = {}): Record<string, string> {
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
		HOME: process.env.HOME ?? os.homedir(),
		TMPDIR: process.env.TMPDIR ?? os.tmpdir()
	};

	// `USERPROFILE` is the Windows equivalent of `HOME`; some Anthropic SDK
	// versions look it up. Forward when present so the runner works on
	// Windows dev boxes without leaking other host vars.
	if (process.env.USERPROFILE) {
		env.USERPROFILE = process.env.USERPROFILE;
	}
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

	// Allow through Anthropic-/Claude-Code-prefixed vars only. The caller is
	// expected to set the actual auth token via `overrides` (CLAUDE_CODE_OAUTH_TOKEN
	// or ANTHROPIC_API_KEY) — passing them through here too is harmless and
	// preserves manual overrides in dev (e.g. ANTHROPIC_BASE_URL pointed at a
	// local proxy).
	for (const [key, value] of Object.entries(process.env)) {
		if (typeof value !== 'string') continue;
		if (CLAUDE_CODE_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
			env[key] = value;
		}
	}

	for (const [key, value] of Object.entries(overrides)) {
		env[key] = value;
	}

	return env;
}
