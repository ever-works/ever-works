import * as os from 'os';

const PASSTHROUGH_ENV_KEYS = [
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

export function buildSubprocessEnv(overrides: Record<string, string> = {}): Record<string, string> {
	const tmpdir = process.env.TMPDIR ?? os.tmpdir();

	// Security: when Codex runs with an explicit CODEX_HOME (every prompt-injectable
	// generation run and the device-auth login flow always set it), point HOME at the
	// isolated tmpdir instead of the server user's real home. Codex resolves its own
	// config/credentials from CODEX_HOME, not HOME, so legitimate runs are unaffected,
	// while a hostile work prompt can no longer coax the agent into reading and
	// exfiltrating ~/.aws, ~/.ssh, ~/.npmrc, etc. from the API user's home directory.
	// The no-CODEX_HOME path (the `login status` check) keeps the real HOME so the
	// Codex CLI's ~/.codex fallback still resolves and auth detection is unchanged.
	const home = overrides.CODEX_HOME ? tmpdir : (process.env.HOME ?? os.homedir());

	const env: Record<string, string> = {
		PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
		HOME: home,
		TMPDIR: tmpdir
	};

	for (const key of PASSTHROUGH_ENV_KEYS) {
		const value = process.env[key];
		if (value) {
			env[key] = value;
		}
	}

	if (process.env.CODEX_HOME) {
		env.CODEX_HOME = process.env.CODEX_HOME;
	}

	for (const [key, value] of Object.entries(overrides)) {
		env[key] = value;
	}

	return env;
}
