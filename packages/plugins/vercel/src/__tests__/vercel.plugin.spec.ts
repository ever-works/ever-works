import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VercelPlugin } from '../vercel.plugin';
import type { PluginContext } from '@ever-works/plugin';

const okJsonResponse = (body: unknown): Response =>
	({
		ok: true,
		status: 200,
		json: () => Promise.resolve(body)
	}) as unknown as Response;

describe('VercelPlugin', () => {
	let plugin: VercelPlugin;

	beforeEach(() => {
		vi.clearAllMocks();
		// Ensure OAuth env is unset by default so the capability stays gated off.
		vi.stubEnv('VERCEL_OAUTH_CLIENT_ID', '');
		vi.stubEnv('VERCEL_OAUTH_CLIENT_SECRET', '');
		vi.stubEnv('VERCEL_INTEGRATION_SLUG', '');
		plugin = new VercelPlugin();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	describe('metadata', () => {
		it('should have correct plugin id and name', () => {
			expect(plugin.id).toBe('vercel');
			expect(plugin.name).toBe('Vercel');
			expect(plugin.version).toBe('1.0.0');
		});

		it('should have deployment category and capability', () => {
			expect(plugin.category).toBe('deployment');
			expect(plugin.capabilities).toContain('deployment');
		});

		it('should have user-required configuration mode', () => {
			expect(plugin.configurationMode).toBe('user-required');
		});

		it('should have correct manifest', () => {
			const manifest = plugin.getManifest();
			expect(manifest.id).toBe('vercel');
			expect(manifest.name).toBe('Vercel');
			expect(manifest.description).toBe('Publish your work as a live website on Vercel');
			expect(manifest.builtIn).toBe(true);
			expect(manifest.autoEnable).toBe(true);
			expect(manifest.defaultForCapabilities).toContain('deployment');
		});
	});

	describe('OAuth capability gating', () => {
		it('does NOT advertise oauth when the integration env vars are unset', () => {
			expect(plugin.capabilities).toEqual(['deployment']);
			expect(plugin.getManifest().capabilities).toEqual(['deployment']);
		});

		it('advertises oauth once client id + secret + slug are configured via env', () => {
			vi.stubEnv('VERCEL_OAUTH_CLIENT_ID', 'cid');
			vi.stubEnv('VERCEL_OAUTH_CLIENT_SECRET', 'csec');
			vi.stubEnv('VERCEL_INTEGRATION_SLUG', 'ever-works');
			const configured = new VercelPlugin();
			expect(configured.capabilities).toEqual(['deployment', 'oauth']);
			expect(configured.getManifest().capabilities).toEqual(['deployment', 'oauth']);
		});

		it('stays gated off when the slug is missing (URL cannot be built)', () => {
			vi.stubEnv('VERCEL_OAUTH_CLIENT_ID', 'cid');
			vi.stubEnv('VERCEL_OAUTH_CLIENT_SECRET', 'csec');
			// slug intentionally left empty
			const configured = new VercelPlugin();
			expect(configured.capabilities).toEqual(['deployment']);
		});
	});

	describe('settingsSchema', () => {
		it('should have required apiToken field', () => {
			expect(plugin.settingsSchema).toBeDefined();
			expect(plugin.settingsSchema.type).toBe('object');
			expect(plugin.settingsSchema.properties).toHaveProperty('apiToken');
			expect(plugin.settingsSchema.required).toContain('apiToken');
		});

		it('should have apiToken as secret and user-scoped', () => {
			const apiTokenSchema = plugin.settingsSchema.properties?.apiToken as any;
			expect(apiTokenSchema).toBeDefined();
			expect(apiTokenSchema['x-secret']).toBe(true);
			expect(apiTokenSchema['x-scope']).toBe('user');
		});

		it('keeps apiToken as the only required field and adds OAuth integration settings', () => {
			expect(Object.keys(plugin.settingsSchema.properties || {})).toEqual([
				'apiToken',
				'clientId',
				'clientSecret',
				'integrationSlug'
			]);
			expect(plugin.settingsSchema.required).toEqual(['apiToken']);
		});

		it('binds the OAuth settings to their env vars (x-envVar)', () => {
			const props = plugin.settingsSchema.properties as Record<string, Record<string, unknown>>;
			expect(props.clientId['x-envVar']).toBe('VERCEL_OAUTH_CLIENT_ID');
			expect(props.clientId['x-adminOnly']).toBe(true);
			expect(props.clientSecret['x-envVar']).toBe('VERCEL_OAUTH_CLIENT_SECRET');
			expect(props.clientSecret['x-secret']).toBe(true);
			expect(props.integrationSlug['x-envVar']).toBe('VERCEL_INTEGRATION_SLUG');
		});
	});

	describe('IOAuthPlugin — getAuthorizationUrl', () => {
		it('throws when the integration slug is not configured', () => {
			expect(() => plugin.getAuthorizationUrl('state', { clientId: 'cid' })).toThrow(/VERCEL_INTEGRATION_SLUG/);
		});

		it('throws when the client id is missing', () => {
			vi.stubEnv('VERCEL_INTEGRATION_SLUG', 'ever-works');
			expect(() => plugin.getAuthorizationUrl('state')).toThrow(/client ID not configured/i);
		});

		it('builds the classic integration install URL with state, scope, redirect_uri', () => {
			vi.stubEnv('VERCEL_INTEGRATION_SLUG', 'ever-works');
			const url = plugin.getAuthorizationUrl('xyz', {
				clientId: 'cid',
				redirectUri: 'https://app.ever.works/api/oauth/vercel/callback/plugins',
				scopes: ['user', 'project']
			});
			expect(url.startsWith('https://vercel.com/integrations/ever-works/new?')).toBe(true);
			const u = new URL(url);
			expect(u.searchParams.get('client_id')).toBe('cid');
			expect(u.searchParams.get('state')).toBe('xyz');
			expect(u.searchParams.get('scope')).toBe('user project');
			expect(u.searchParams.get('redirect_uri')).toBe('https://app.ever.works/api/oauth/vercel/callback/plugins');
		});

		it('falls back to the client id + slug env vars when config omits them', () => {
			vi.stubEnv('VERCEL_OAUTH_CLIENT_ID', 'env-cid');
			vi.stubEnv('VERCEL_INTEGRATION_SLUG', 'ever-works');
			const url = plugin.getAuthorizationUrl('s');
			const u = new URL(url);
			expect(u.pathname).toBe('/integrations/ever-works/new');
			expect(u.searchParams.get('client_id')).toBe('env-cid');
			// default scopes applied when none supplied
			expect((u.searchParams.get('scope') as string).length).toBeGreaterThan(0);
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

		it('throws when client id or secret is missing', async () => {
			await expect(plugin.exchangeCodeForToken('code')).rejects.toThrow(/credentials not configured/i);
			await expect(plugin.exchangeCodeForToken('code', { clientId: 'cid' })).rejects.toThrow(
				/credentials not configured/i
			);
		});

		it('posts form-encoded credentials to the Vercel token endpoint', async () => {
			fetchMock.mockResolvedValueOnce(
				okJsonResponse({ access_token: 'tok', token_type: 'Bearer', scope: 'user project' })
			);
			const t = await plugin.exchangeCodeForToken('code', {
				clientId: 'cid',
				clientSecret: 'csec',
				redirectUri: 'https://r/cb'
			});
			expect(t).toEqual({ accessToken: 'tok', tokenType: 'Bearer', scope: 'user project' });
			const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
			expect(url).toBe('https://api.vercel.com/v2/oauth/access_token');
			expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/x-www-form-urlencoded');
			const body = new URLSearchParams(init.body as string);
			expect(body.get('client_id')).toBe('cid');
			expect(body.get('client_secret')).toBe('csec');
			expect(body.get('code')).toBe('code');
			expect(body.get('redirect_uri')).toBe('https://r/cb');
		});

		it('defaults tokenType to "bearer" when the response omits it', async () => {
			fetchMock.mockResolvedValueOnce(okJsonResponse({ access_token: 'tok' }));
			const t = await plugin.exchangeCodeForToken('code', { clientId: 'cid', clientSecret: 'csec' });
			expect(t.tokenType).toBe('bearer');
		});

		it('throws a sanitized error when Vercel returns an error payload', async () => {
			fetchMock.mockResolvedValueOnce(
				okJsonResponse({ error: 'invalid_grant', error_description: 'Code invalid' })
			);
			await expect(plugin.exchangeCodeForToken('bad', { clientId: 'cid', clientSecret: 'csec' })).rejects.toThrow(
				/Code invalid/
			);
		});

		it('throws when the HTTP response is not ok', async () => {
			fetchMock.mockResolvedValueOnce({
				ok: false,
				status: 401,
				json: () => Promise.resolve({})
			} as unknown as Response);
			await expect(plugin.exchangeCodeForToken('bad', { clientId: 'cid', clientSecret: 'csec' })).rejects.toThrow(
				/Vercel OAuth error/
			);
		});
	});

	describe('IOAuthPlugin — getAuthenticatedUser', () => {
		it('maps a resolved Vercel user to the OAuthUser shape', async () => {
			const apiService = (plugin as any).apiService;
			vi.spyOn(apiService, 'validateToken').mockResolvedValueOnce({
				id: 'usr_1',
				email: 'dev@ever.works',
				name: 'Dev',
				username: 'dever'
			});
			const user = await plugin.getAuthenticatedUser('tok');
			expect(user).toEqual({
				id: 'usr_1',
				username: 'dever',
				email: 'dev@ever.works',
				name: 'Dev'
			});
		});

		it('throws when the token resolves to no user (OAuth contract)', async () => {
			const apiService = (plugin as any).apiService;
			vi.spyOn(apiService, 'validateToken').mockResolvedValueOnce(null);
			await expect(plugin.getAuthenticatedUser('bad')).rejects.toThrow(/Failed to resolve Vercel user/);
		});
	});

	describe('lifecycle hooks', () => {
		const createMockContext = (): PluginContext =>
			({
				logger: {
					log: vi.fn(),
					debug: vi.fn(),
					warn: vi.fn(),
					error: vi.fn()
				},
				getSettings: vi.fn().mockResolvedValue({}),
				getService: vi.fn(),
				emit: vi.fn()
			}) as unknown as PluginContext;

		it('should load successfully', async () => {
			const mockContext = createMockContext();
			await plugin.onLoad?.(mockContext);
			expect(mockContext.logger.log).toHaveBeenCalledWith('Vercel Plugin loaded');
		});

		it('should unload successfully', async () => {
			const mockContext = createMockContext();
			await plugin.onLoad?.(mockContext);
			await plugin.onUnload?.();
			// After unload, context should be cleared
		});
	});

	describe('healthCheck', () => {
		it('should return healthy status', async () => {
			const health = await plugin.healthCheck();
			expect(health.status).toBe('healthy');
			expect(health.message).toBe('Vercel plugin is ready');
			expect(health.checkedAt).toBeDefined();
		});
	});

	describe('deployment methods', () => {
		it('should return pending result from deploy', async () => {
			const result = await plugin.deploy({ projectName: 'test-project', teamScope: 'team-1' } as any, 'token');
			expect(result.status).toBe('pending');
			expect(result.id).toBeDefined();
			expect(result.createdAt).toBeDefined();
		});

		it('should return pending status from getDeploymentStatus', async () => {
			const result = await plugin.getDeploymentStatus('deploy-123', 'token');
			expect(result.id).toBe('deploy-123');
			expect(result.status).toBe('pending');
		});
	});

	describe('getApiService', () => {
		it('should expose the API service', () => {
			const apiService = plugin.getApiService();
			expect(apiService).toBeDefined();
			expect(typeof apiService.validateToken).toBe('function');
			expect(typeof apiService.getTeams).toBe('function');
		});
	});

	describe('domain management methods', () => {
		it('should have getDomains method', () => {
			expect(typeof plugin.getDomains).toBe('function');
		});

		it('should have addDomain method', () => {
			expect(typeof plugin.addDomain).toBe('function');
		});

		it('should have removeDomain method', () => {
			expect(typeof plugin.removeDomain).toBe('function');
		});

		it('should have verifyDomain method', () => {
			expect(typeof plugin.verifyDomain).toBe('function');
		});
	});
});
