import * as os from 'os';

export function buildSubprocessEnv(overrides: Record<string, string> = {}): Record<string, string> {
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
		HOME: process.env.HOME ?? os.homedir(),
		TMPDIR: process.env.TMPDIR ?? os.tmpdir()
	};

	for (const [key, value] of Object.entries(overrides)) {
		env[key] = value;
	}

	return env;
}
