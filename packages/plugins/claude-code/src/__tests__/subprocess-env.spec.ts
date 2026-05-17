import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildSubprocessEnv } from '../utils/subprocess-env';

/**
 * C-10 — claude-code subprocess env must NOT inherit the host `process.env`.
 *
 * Before this fix the runner spawned the CLI with `env: { ...process.env, ... }`
 * plus `--dangerously-skip-permissions`, which gave the model `DATABASE_PASSWORD`,
 * `AUTH_SECRET`, `TRIGGER_INTERNAL_SECRET`, every plugin API key, etc. A single
 * prompt-injected web page could `printenv` + `curl` them out.
 *
 * These tests pin the new behavior: only an explicit allow-list of keys passes
 * through; everything else is dropped.
 */
describe('buildSubprocessEnv (C-10)', () => {
	const ORIGINAL_ENV = { ...process.env };

	beforeEach(() => {
		// Reset to a controlled baseline so individual tests can set just what
		// they need without leakage from the real host env.
		process.env = {};
	});

	afterEach(() => {
		process.env = { ...ORIGINAL_ENV };
	});

	it('drops sensitive host env vars (DATABASE_PASSWORD, AUTH_SECRET, etc.)', () => {
		process.env.DATABASE_PASSWORD = 'pg-secret-xyz';
		process.env.AUTH_SECRET = 'auth-secret-very-long';
		process.env.TRIGGER_INTERNAL_SECRET = 'trigger-secret';
		process.env.PLUGIN_OPENROUTER_API_KEY = 'openrouter-key';
		process.env.RESEND_APIKEY = 'resend-key';
		process.env.PATH = '/usr/local/bin:/usr/bin';

		const env = buildSubprocessEnv();

		expect(env.DATABASE_PASSWORD).toBeUndefined();
		expect(env.AUTH_SECRET).toBeUndefined();
		expect(env.TRIGGER_INTERNAL_SECRET).toBeUndefined();
		expect(env.PLUGIN_OPENROUTER_API_KEY).toBeUndefined();
		expect(env.RESEND_APIKEY).toBeUndefined();
		// PATH is on the allow-list — must still be present.
		expect(env.PATH).toBe('/usr/local/bin:/usr/bin');
	});

	it('forwards Anthropic / Claude Code-prefixed vars (allow-list by prefix)', () => {
		process.env.ANTHROPIC_BASE_URL = 'https://proxy.local';
		process.env.ANTHROPIC_API_KEY = 'sk-from-env';
		process.env.CLAUDE_CODE_CONFIG_DIR = '/tmp/cfg';
		process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-token';
		// Negative case: a var that just contains "ANTHROPIC" but doesn't START with the prefix
		// must NOT pass through.
		process.env.MY_ANTHROPIC_HELPER = 'should-be-dropped';

		const env = buildSubprocessEnv();

		expect(env.ANTHROPIC_BASE_URL).toBe('https://proxy.local');
		expect(env.ANTHROPIC_API_KEY).toBe('sk-from-env');
		expect(env.CLAUDE_CODE_CONFIG_DIR).toBe('/tmp/cfg');
		expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-token');
		expect(env.MY_ANTHROPIC_HELPER).toBeUndefined();
	});

	it('forwards proxy / TLS / CA cert vars from host (corporate network plumbing)', () => {
		process.env.HTTPS_PROXY = 'http://corp-proxy:3128';
		process.env.NO_PROXY = 'localhost,127.0.0.1';
		process.env.NODE_EXTRA_CA_CERTS = '/etc/ssl/internal-ca.pem';
		process.env.CURL_CA_BUNDLE = '/etc/ssl/ca-bundle.crt';

		const env = buildSubprocessEnv();

		expect(env.HTTPS_PROXY).toBe('http://corp-proxy:3128');
		expect(env.NO_PROXY).toBe('localhost,127.0.0.1');
		expect(env.NODE_EXTRA_CA_CERTS).toBe('/etc/ssl/internal-ca.pem');
		expect(env.CURL_CA_BUNDLE).toBe('/etc/ssl/ca-bundle.crt');
	});

	it('applies overrides last (caller can inject CLAUDE_CODE_OAUTH_TOKEN, DISABLE_TELEMETRY, etc.)', () => {
		process.env.CLAUDE_CODE_OAUTH_TOKEN = 'env-token';

		const env = buildSubprocessEnv({
			CLAUDE_CODE_OAUTH_TOKEN: 'override-token',
			DISABLE_TELEMETRY: '1',
			DISABLE_AUTOUPDATER: '1'
		});

		expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('override-token');
		expect(env.DISABLE_TELEMETRY).toBe('1');
		expect(env.DISABLE_AUTOUPDATER).toBe('1');
	});

	it('always provides safe defaults for PATH / HOME / TMPDIR even when host env is empty', () => {
		// process.env is wiped by beforeEach
		const env = buildSubprocessEnv();

		expect(typeof env.PATH).toBe('string');
		expect(env.PATH.length).toBeGreaterThan(0);
		expect(typeof env.HOME).toBe('string');
		expect(env.HOME.length).toBeGreaterThan(0);
		expect(typeof env.TMPDIR).toBe('string');
		expect(env.TMPDIR.length).toBeGreaterThan(0);
	});

	it('the resulting env never contains keys that were not explicitly allowed', () => {
		// Set every kind of "noise" var we'd expect to see in a real host process.
		process.env.DATABASE_URL = 'postgres://x';
		process.env.REDIS_URL = 'redis://x';
		process.env.STRIPE_SECRET_KEY = 'sk_live_x';
		process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role';
		process.env.GITHUB_TOKEN = 'gh-tok';
		process.env.PATH = '/bin';

		const env = buildSubprocessEnv();

		// Allow-list: PATH/HOME/TMPDIR (and possibly Windows-only USERPROFILE etc.,
		// none of which were set above). No secret values should appear.
		const values = Object.values(env);
		expect(values).not.toContain('postgres://x');
		expect(values).not.toContain('redis://x');
		expect(values).not.toContain('sk_live_x');
		expect(values).not.toContain('service-role');
		expect(values).not.toContain('gh-tok');
	});
});
