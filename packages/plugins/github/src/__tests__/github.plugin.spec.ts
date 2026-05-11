import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PluginContext } from '@ever-works/plugin';

// libsodium-wrappers loads native modules that vitest cannot resolve under
// Node ESM in the test runner. The plugin only uses it via the actions service
// for secret encryption, which is exercised in integration tests, not here.
vi.mock('libsodium-wrappers', () => ({
	default: {
		ready: Promise.resolve(),
		from_base64: vi.fn(),
		crypto_box_seal: vi.fn(),
		to_base64: vi.fn()
	}
}));

const { GitHubPlugin } = await import('../github.plugin.js');

const buildContext = (settings: Record<string, unknown> = {}): PluginContext =>
	({
		pluginId: 'github',
		logger: {
			log: vi.fn(),
			debug: vi.fn(),
			warn: vi.fn(),
			error: vi.fn()
		},
		getSettings: vi.fn().mockResolvedValue(settings)
	}) as unknown as PluginContext;

const okJsonResponse = (body: unknown): Response =>
	({
		ok: true,
		status: 200,
		json: () => Promise.resolve(body),
		text: () => Promise.resolve(JSON.stringify(body))
	}) as unknown as Response;

describe('GitHubPlugin', () => {
	let plugin: GitHubPlugin;

	beforeEach(() => {
		plugin = new GitHubPlugin();
	});

	describe('metadata', () => {
		it('exposes stable identity fields', () => {
			expect(plugin.id).toBe('github');
			expect(plugin.name).toBe('GitHub');
			expect(plugin.version).toBe('1.0.0');
			expect(plugin.category).toBe('git-provider');
			expect(plugin.providerName).toBe('github');
		});

		it('declares git-provider and oauth capabilities', () => {
			expect(plugin.capabilities).toEqual(['git-provider', 'oauth']);
		});

		it('uses admin-only configuration mode', () => {
			expect(plugin.configurationMode).toBe('admin-only');
		});
	});

	describe('settingsSchema', () => {
		it('exposes clientId, clientSecret, and apiBaseUrl', () => {
			const props = plugin.settingsSchema.properties as Record<string, Record<string, unknown>>;
			expect(props.clientId['x-envVar']).toBe('PLUGIN_GITHUB_CLIENT_ID');
			expect(props.clientId['x-adminOnly']).toBe(true);
			expect(props.clientSecret['x-secret']).toBe(true);
			expect(props.clientSecret['x-envVar']).toBe('PLUGIN_GITHUB_CLIENT_SECRET');
			expect(props.apiBaseUrl.default).toBe('https://api.github.com');
			expect(props.apiBaseUrl['x-hidden']).toBe(true);
		});

		it('exposes readPackagesPat as a user-scoped secret for GHCR private pulls from k8s', () => {
			const props = plugin.settingsSchema.properties as Record<string, Record<string, unknown>>;
			expect(props.readPackagesPat).toBeDefined();
			expect(props.readPackagesPat['x-secret']).toBe(true);
			expect(props.readPackagesPat['x-scope']).toBe('user');
			expect(props.readPackagesPat['x-widget']).toBe('github-packages-oauth');
		});
	});

	describe('IGitProviderPlugin pure helpers', () => {
		it('getAuth returns x-access-token + token tuple', () => {
			const auth = plugin.getAuth('tok123');
			expect(auth).toEqual({ username: 'x-access-token', password: 'tok123' });
		});

		it('getCloneUrl builds the canonical https clone URL', () => {
			expect(plugin.getCloneUrl('octo', 'repo')).toBe('https://github.com/octo/repo.git');
		});

		it('getWebUrl builds the canonical web URL', () => {
			expect(plugin.getWebUrl('octo', 'repo')).toBe('https://github.com/octo/repo');
		});

		it('getRawFileUrl delegates through to a github.com style URL', () => {
			const url = plugin.getRawFileUrl('octo', 'repo', 'main', 'README.md');
			expect(url).toContain('octo');
			expect(url).toContain('repo');
			expect(url).toContain('main');
			expect(url).toContain('README.md');
		});
	});

	describe('IOAuthPlugin — getAuthorizationUrl', () => {
		it('throws when clientId is missing', () => {
			expect(() => plugin.getAuthorizationUrl('state')).toThrow(/client ID not configured/i);
		});

		it('builds the canonical GitHub OAuth URL with state, scope, redirect', () => {
			const url = plugin.getAuthorizationUrl('xyz', {
				clientId: 'cid',
				redirectUri: 'https://app/cb',
				scopes: ['repo', 'user:email']
			});
			expect(url.startsWith('https://github.com/login/oauth/authorize?')).toBe(true);
			const u = new URL(url);
			expect(u.searchParams.get('client_id')).toBe('cid');
			expect(u.searchParams.get('redirect_uri')).toBe('https://app/cb');
			expect(u.searchParams.get('state')).toBe('xyz');
			expect(u.searchParams.get('scope')).toBe('repo user:email');
		});

		it('appends prompt=consent when forceConsent is true', () => {
			const url = plugin.getAuthorizationUrl('s', {
				clientId: 'cid',
				redirectUri: 'https://r',
				scopes: ['repo'],
				forceConsent: true
			});
			expect(new URL(url).searchParams.get('prompt')).toBe('consent');
		});

		it('falls back to GITHUB_SCOPES default when no scopes are passed', () => {
			const url = plugin.getAuthorizationUrl('s', { clientId: 'cid', redirectUri: 'https://r' });
			const scope = new URL(url).searchParams.get('scope');
			expect(typeof scope).toBe('string');
			expect((scope as string).length).toBeGreaterThan(0);
		});
	});

	describe('IOAuthPlugin — exchangeCodeForToken', () => {
		const originalFetch = globalThis.fetch;
		let fetchMock: ReturnType<typeof vi.fn>;

		beforeEach(() => {
			fetchMock = vi.fn();
			globalThis.fetch = fetchMock as unknown as typeof fetch;
		});

		afterEach(() => {
			globalThis.fetch = originalFetch;
		});

		it('throws when clientId or clientSecret is missing', async () => {
			await expect(plugin.exchangeCodeForToken('code')).rejects.toThrow(/credentials not configured/i);
			await expect(plugin.exchangeCodeForToken('code', { clientId: 'cid' })).rejects.toThrow(
				/credentials not configured/i
			);
		});

		it('exchanges code for an access token on success', async () => {
			fetchMock.mockResolvedValueOnce(
				okJsonResponse({
					access_token: 'tok',
					token_type: 'bearer',
					scope: 'repo,user:email',
					refresh_token: 'rtok'
				})
			);
			const t = await plugin.exchangeCodeForToken('code', {
				clientId: 'cid',
				clientSecret: 'csec',
				redirectUri: 'https://r'
			});
			expect(t).toEqual({
				accessToken: 'tok',
				tokenType: 'bearer',
				scope: 'repo,user:email',
				refreshToken: 'rtok'
			});
			const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
			expect(url).toBe('https://github.com/login/oauth/access_token');
			const body = JSON.parse(init.body as string);
			expect(body).toMatchObject({
				client_id: 'cid',
				client_secret: 'csec',
				code: 'code',
				redirect_uri: 'https://r'
			});
		});

		it('throws when GitHub returns an error payload', async () => {
			fetchMock.mockResolvedValueOnce(
				okJsonResponse({ error: 'bad_verification_code', error_description: 'Code invalid' })
			);
			await expect(plugin.exchangeCodeForToken('bad', { clientId: 'cid', clientSecret: 'csec' })).rejects.toThrow(
				/Code invalid/
			);
		});

		it('defaults tokenType to "bearer" when missing', async () => {
			fetchMock.mockResolvedValueOnce(okJsonResponse({ access_token: 'tok' }));
			const t = await plugin.exchangeCodeForToken('code', {
				clientId: 'cid',
				clientSecret: 'csec'
			});
			expect(t.tokenType).toBe('bearer');
		});
	});

	describe('lifecycle', () => {
		it('logs on load and clears context on unload', async () => {
			const ctx = buildContext();
			await plugin.onLoad(ctx);
			expect(ctx.logger.log).toHaveBeenCalledWith('GitHub Plugin loaded');
			await plugin.onUnload();
		});
	});

	describe('healthCheck + manifest', () => {
		it('reports healthy', async () => {
			const h = await plugin.healthCheck();
			expect(h.status).toBe('healthy');
			expect(h.checkedAt).toBeTypeOf('number');
		});

		it('returns a manifest aligned with plugin metadata', () => {
			const m = plugin.getManifest();
			expect(m.id).toBe('github');
			expect(m.category).toBe('git-provider');
			expect(m.capabilities).toEqual(['git-provider', 'oauth']);
			expect(m.builtIn).toBe(true);
			expect(m.systemPlugin).toBe(true);
			expect(m.autoEnable).toBe(true);
			expect(m.visibility).toBe('user-only');
		});

		it('exposes onboarding ui hints', () => {
			const m = plugin.getManifest();
			expect(m.uiHints?.includeInOnboarding).toBe(true);
			expect(m.uiHints?.organizationSettings).toBe(true);
		});
	});
});
