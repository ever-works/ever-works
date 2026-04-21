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
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
		HOME: process.env.HOME ?? os.homedir(),
		TMPDIR: process.env.TMPDIR ?? os.tmpdir()
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
