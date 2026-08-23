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

	it('forwards the non-credential ANTHROPIC_BASE_URL but never a host credential', () => {
		process.env.ANTHROPIC_BASE_URL = 'https://proxy.local';
		process.env.ANTHROPIC_API_KEY = 'sk-from-env';
		process.env.ANTHROPIC_AUTH_TOKEN = 'anthropic-auth-token';
		process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-token';
		// Negative case: a var that just contains "ANTHROPIC" but doesn't START with the prefix
		// must NOT pass through.
		process.env.MY_ANTHROPIC_HELPER = 'should-be-dropped';

		const env = buildSubprocessEnv();

		expect(env.ANTHROPIC_BASE_URL).toBe('https://proxy.local');
		expect(env.MY_ANTHROPIC_HELPER).toBeUndefined();

		// Credentials are supplied by resolved plugin settings, never inherited.
		expect(env.ANTHROPIC_API_KEY).toBeUndefined();
		expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
		expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
	});

	it('does not let a host ANTHROPIC_API_KEY hijack a subscription-mode run', () => {
		// Regression guard for silent mis-billing. Claude Code resolves
		// ANTHROPIC_API_KEY (rank 3) ahead of CLAUDE_CODE_OAUTH_TOKEN (rank 5),
		// and in `-p` mode "the key is always used when present". A stray host
		// API key would therefore bill the Console org for an agent the operator
		// pinned to their Claude subscription — with no error and no warning.
		process.env.ANTHROPIC_API_KEY = 'sk-from-env';
		process.env.ANTHROPIC_AUTH_TOKEN = 'anthropic-auth-token';

		const env = buildSubprocessEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'subscription-token' }, { authMode: 'subscription' });

		expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('subscription-token');
		expect(env.ANTHROPIC_API_KEY).toBeUndefined();
		expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
	});

	it('strips the subscription token when the agent is pinned to api-key mode', () => {
		process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-from-env';

		const env = buildSubprocessEnv({ ANTHROPIC_API_KEY: 'sk-configured' }, { authMode: 'api-key' });

		expect(env.ANTHROPIC_API_KEY).toBe('sk-configured');
		expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
	});

	it('never inherits a provider-selection var that would outrank the chosen credential', () => {
		// CLAUDE_CODE_USE_BEDROCK and friends sit above every credential in the
		// CLI's resolution order, so a stray one on the host would silently move
		// a subscription-mode agent onto a cloud provider account.
		process.env.CLAUDE_CODE_USE_BEDROCK = '1';
		process.env.CLAUDE_CODE_USE_VERTEX = '1';
		process.env.ANTHROPIC_PROFILE = 'some-profile';

		const env = buildSubprocessEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'subscription-token' }, { authMode: 'subscription' });

		expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
		expect(env.CLAUDE_CODE_USE_VERTEX).toBeUndefined();
		expect(env.ANTHROPIC_PROFILE).toBeUndefined();
		expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('subscription-token');
	});

	it('isolates HOME and USERPROFILE when a config dir is pinned', () => {
		// The CLI runs with --dangerously-skip-permissions over scraped web content,
		// so a hostile prompt must not be able to walk `~` into ~/.aws or ~/.ssh.
		process.env.HOME = '/home/appuser';
		process.env.USERPROFILE = 'C:\\Users\\appuser';
		process.env.TMPDIR = '/tmp/isolated';

		const env = buildSubprocessEnv({ CLAUDE_CONFIG_DIR: '/tmp/cc-run-1' });

		expect(env.HOME).toBe('/tmp/isolated');
		expect(env.USERPROFILE).toBe('/tmp/isolated');
		expect(env.HOME).not.toBe('/home/appuser');
	});

	it('keeps the real HOME when no config dir is pinned, so auth probes still resolve ~/.claude', () => {
		process.env.HOME = '/home/appuser';
		process.env.USERPROFILE = 'C:\\Users\\appuser';
		process.env.TMPDIR = '/tmp/isolated';

		const env = buildSubprocessEnv();

		expect(env.HOME).toBe('/home/appuser');
		expect(env.USERPROFILE).toBe('C:\\Users\\appuser');
	});

	it('treats an empty CLAUDE_CONFIG_DIR as not pinned rather than isolating on a blank path', () => {
		process.env.HOME = '/home/appuser';
		process.env.TMPDIR = '/tmp/isolated';

		const env = buildSubprocessEnv({ CLAUDE_CONFIG_DIR: '' });

		expect(env.HOME).toBe('/home/appuser');
	});

	it('drops arbitrary ANTHROPIC_*/CLAUDE_CODE_*-prefixed vars not on the allow-list', () => {
		// Regression guard: the env was previously built by matching any key that
		// merely STARTED WITH `ANTHROPIC_` or `CLAUDE_CODE_`, which silently
		// forwarded any future/custom var with those prefixes into the model's
		// subprocess. Only the exact-name allow-list may pass through.
		process.env.ANTHROPIC_BASE_URL = 'https://proxy.local';
		process.env.ANTHROPIC_CUSTOM_VAR = 'should-be-dropped';
		process.env.ANTHROPIC_SECRET_PROXY_TOKEN = 'leak-me';
		process.env.CLAUDE_CODE_INTERNAL_DEBUG = 'leak-me-too';

		const env = buildSubprocessEnv();

		// Allow-listed var still forwarded.
		expect(env.ANTHROPIC_BASE_URL).toBe('https://proxy.local');
		// Arbitrary prefixed vars are NOT forwarded.
		expect(env.ANTHROPIC_CUSTOM_VAR).toBeUndefined();
		expect(env.ANTHROPIC_SECRET_PROXY_TOKEN).toBeUndefined();
		expect(env.CLAUDE_CODE_INTERNAL_DEBUG).toBeUndefined();
		expect(Object.values(env)).not.toContain('leak-me');
		expect(Object.values(env)).not.toContain('leak-me-too');
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
