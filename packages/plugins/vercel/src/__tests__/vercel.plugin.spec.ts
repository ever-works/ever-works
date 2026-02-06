import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VercelPlugin } from '../vercel.plugin';
import type { PluginContext } from '@ever-works/plugin';

describe('VercelPlugin', () => {
	let plugin: VercelPlugin;

	beforeEach(() => {
		vi.clearAllMocks();
		plugin = new VercelPlugin();
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
			expect(manifest.description).toBe('Publish your directory as a live website on Vercel');
			expect(manifest.builtIn).toBe(true);
			expect(manifest.autoEnable).toBe(true);
			expect(manifest.visibility).toBe('public');
			expect(manifest.defaultForCapabilities).toContain('deployment');
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
			expect(apiTokenSchema['x-writeOnly']).toBe(true);
		});

		it('should have optional defaultTeamScope field', () => {
			expect(plugin.settingsSchema.properties).toHaveProperty('defaultTeamScope');
			expect(plugin.settingsSchema.required).not.toContain('defaultTeamScope');
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

		it('should enable successfully', async () => {
			const mockContext = createMockContext();
			await plugin.onEnable?.(mockContext);
			expect(mockContext.logger.log).toHaveBeenCalledWith('Vercel Plugin enabled');
		});

		it('should disable successfully', async () => {
			const mockContext = createMockContext();
			await plugin.onDisable?.(mockContext);
			expect(mockContext.logger.log).toHaveBeenCalledWith('Vercel Plugin disabled');
		});

		it('should unload successfully', async () => {
			const mockContext = createMockContext();
			await plugin.onLoad?.(mockContext);
			await plugin.onUnload?.();
			// After unload, context should be cleared
		});
	});

	describe('validateSettings', () => {
		it('should return valid when apiToken is provided', async () => {
			const result = await plugin.validateSettings({ apiToken: 'valid-token' });
			expect(result.valid).toBe(true);
			expect(result.errors).toBeUndefined();
		});

		it('should return invalid when apiToken is missing', async () => {
			const result = await plugin.validateSettings({});
			expect(result.valid).toBe(false);
			expect(result.errors).toBeDefined();
			expect(result.errors?.[0]?.path).toBe('apiToken');
		});

		it('should return invalid when apiToken is empty string', async () => {
			const result = await plugin.validateSettings({ apiToken: '' });
			expect(result.valid).toBe(false);
		});

		it('should accept optional defaultTeamScope', async () => {
			const result = await plugin.validateSettings({
				apiToken: 'valid-token',
				defaultTeamScope: 'my-team'
			});
			expect(result.valid).toBe(true);
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
			const result = await plugin.deploy({ projectName: 'test-project', teamScope: 'team-1' }, 'token');
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
});
