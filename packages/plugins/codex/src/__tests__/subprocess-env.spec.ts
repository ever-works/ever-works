import { afterEach, describe, expect, it } from 'vitest';

import { buildSubprocessEnv } from '../utils/subprocess-env.js';

const ORIGINAL_ENV = { ...process.env };

describe('subprocess-env', () => {
	afterEach(() => {
		for (const key of Object.keys(process.env)) {
			if (!(key in ORIGINAL_ENV)) {
				delete process.env[key];
			}
		}

		for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	});

	it('preserves proxy and certificate environment variables for spawned Codex processes', () => {
		process.env.HTTPS_PROXY = 'http://proxy.internal:8443';
		process.env.NO_PROXY = 'localhost,127.0.0.1,.internal';
		process.env.SSL_CERT_FILE = '/etc/ssl/certs/custom.pem';
		process.env.UNRELATED_ENV = 'drop-me';

		const env = buildSubprocessEnv({ CODEX_HOME: '/tmp/codex-home' });

		expect(env.HTTPS_PROXY).toBe('http://proxy.internal:8443');
		expect(env.NO_PROXY).toBe('localhost,127.0.0.1,.internal');
		expect(env.SSL_CERT_FILE).toBe('/etc/ssl/certs/custom.pem');
		expect(env.CODEX_HOME).toBe('/tmp/codex-home');
		expect(env.UNRELATED_ENV).toBeUndefined();
	});
});
